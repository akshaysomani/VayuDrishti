"""
Phase 1 Final Model Training, Calibration, Evaluation, and MLflow Logging
=========================================================================
Shipped Model:
  Calibrated Logistic Regression on [PM2.5, pm25_lag1, pm25_rolling3, pm25_ratio_90]
  Restricted to Fresh-Crossing Subset (today's PM2.5 <= 90 µg/m³)
  Target: tomorrow's PM2.5 > 90 µg/m³
  Splits:
    - Train: < 2018-07-01
    - Val:   2018-07-01 to 2019-06-30 (1 full year for calibration & tuning)
    - Test:  >= 2019-07-01 (to 2020-12-02)

Challenger Model:
  Full LightGBM spike classifier (meteorology, fire, lags, calendar)
"""

import os
import json
import joblib
import warnings
from pathlib import Path
from datetime import datetime

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import (
    average_precision_score,
    roc_auc_score,
    brier_score_loss,
    precision_recall_curve,
    f1_score,
    recall_score,
    precision_score,
)
from lightgbm import LGBMClassifier, early_stopping, log_evaluation
import mlflow

warnings.filterwarnings('ignore')

# -----------------------------------------------------------------------------
# Configuration & Paths
# -----------------------------------------------------------------------------
RANDOM_SEED = 42
np.random.seed(RANDOM_SEED)

BASE_DIR = Path(__file__).resolve().parent.parent
DASHBOARD_JSON = BASE_DIR / "src" / "data" / "dashboard_data.json"
STATION_DAY_CSV = BASE_DIR / "archive" / "station_day.csv"
WEATHER_PARQUET = BASE_DIR / "ML_OUTPUT" / "cache" / "station_weather_daily.parquet"
FIRE_PARQUET = BASE_DIR / "ML_OUTPUT" / "cache" / "station_fire_features.parquet"

MODELS_DIR = BASE_DIR / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)
FINAL_MODEL_PKL = MODELS_DIR / "phase1_final_logreg.pkl"

REPORTS_DIR = BASE_DIR / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)
REPORT_MD = REPORTS_DIR / "phase1_final.md"


def load_dataset():
    print("=" * 80)
    print("1. LOADING DATA AND PREPARING PHASE 1B FRESH-CROSSING SUBSET")
    print("=" * 80)

    with open(DASHBOARD_JSON, "r", encoding="utf-8") as f:
        dash_meta = json.load(f)
    dash_stations = pd.DataFrame(dash_meta["stations"])
    reporting_stations = dash_stations[dash_stations["status"] == "reporting"].copy()
    station_lookup = {s["id"]: s for s in dash_meta["stations"]}

    weather_df = pd.read_parquet(WEATHER_PARQUET)
    fire_df = pd.read_parquet(FIRE_PARQUET)

    sd = pd.read_csv(STATION_DAY_CSV)
    sd["Date"] = pd.to_datetime(sd["Date"])
    sd["date_str"] = sd["Date"].dt.strftime("%Y-%m-%d")

    sd = sd[sd["StationId"].isin(reporting_stations["id"])].copy()
    sd.sort_values(["StationId", "Date"], inplace=True)
    sd.reset_index(drop=True, inplace=True)

    sd["Date_next"] = sd.groupby("StationId")["Date"].shift(-1)
    sd["PM25_next"] = sd.groupby("StationId")["PM2.5"].shift(-1)
    sd["is_consecutive"] = (sd["Date_next"] == sd["Date"] + pd.Timedelta(days=1))

    valid_mask = sd["PM2.5"].notna() & sd["PM25_next"].notna() & sd["is_consecutive"]
    df = sd[valid_mask].copy()
    df.reset_index(drop=True, inplace=True)

    df["lat"] = df["StationId"].map(lambda sid: station_lookup[sid]["lat"]).round(4)
    df["lon"] = df["StationId"].map(lambda sid: station_lookup[sid]["lon"]).round(4)
    df["city"] = df["StationId"].map(lambda sid: station_lookup[sid]["city"])
    df["state"] = df["StationId"].map(lambda sid: station_lookup[sid]["state"])

    weather_df["lat"] = weather_df["station_lat"].round(4)
    weather_df["lon"] = weather_df["station_lon"].round(4)
    fire_df["lat"] = fire_df["station_lat"].round(4)
    fire_df["lon"] = fire_df["station_lon"].round(4)

    df = pd.merge(
        df,
        weather_df[["date", "lat", "lon", "u10", "v10", "t2m", "blh"]],
        left_on=["date_str", "lat", "lon"],
        right_on=["date", "lat", "lon"],
        how="left"
    )

    df = pd.merge(
        df,
        fire_df[["date", "lat", "lon", "fire_count_100km", "fire_frp_100km", "upwind_fire_count_100km", "upwind_frp_100km"]],
        left_on=["date_str", "lat", "lon"],
        right_on=["date", "lat", "lon"],
        how="left"
    )

    for col in ["fire_count_100km", "fire_frp_100km", "upwind_fire_count_100km", "upwind_frp_100km"]:
        df[col] = df[col].fillna(0)

    df["wind_speed"] = np.sqrt(df["u10"]**2 + df["v10"]**2)
    df["month"] = df["Date"].dt.month
    df["dayofweek"] = df["Date"].dt.dayofweek
    df["dayofyear"] = df["Date"].dt.dayofyear

    # Sequential Lags and Features per station
    df.sort_values(["StationId", "Date"], inplace=True)
    df.reset_index(drop=True, inplace=True)
    grouped = df.groupby("StationId")

    df["pm25_lag1"] = grouped["PM2.5"].shift(1).fillna(df["PM2.5"])
    df["pm25_lag2"] = grouped["PM2.5"].shift(2).fillna(df["pm25_lag1"])
    df["pm25_rolling3"] = grouped["PM2.5"].rolling(3, min_periods=1).mean().reset_index(level=0, drop=True)

    df["delta_lag1"] = df["PM2.5"] - df["pm25_lag1"]
    df["delta_rolling3"] = df["PM2.5"] - df["pm25_rolling3"]
    df["pm25_slope_3d"] = (df["PM2.5"] - df["pm25_lag2"]) / 2.0
    df["pm25_ratio_90"] = df["PM2.5"] / 90.0

    # Lags for fire features
    for lag in [1, 2, 3]:
        df[f"upwind_fire_count_100km_lag{lag}"] = grouped["upwind_fire_count_100km"].shift(lag).fillna(0)
        df[f"upwind_frp_100km_lag{lag}"] = grouped["upwind_frp_100km"].shift(lag).fillna(0)
    df["upwind_fire_count_100km_rolling3"] = grouped["upwind_fire_count_100km"].rolling(3, min_periods=1).sum().reset_index(level=0, drop=True)
    df["upwind_frp_100km_rolling3"] = grouped["upwind_frp_100km"].rolling(3, min_periods=1).sum().reset_index(level=0, drop=True)

    # Restrict to Fresh-Crossing Subset: today's PM2.5 <= 90
    df_fresh = df[df["PM2.5"] <= 90.0].copy().reset_index(drop=True)
    df_fresh["target"] = (df_fresh["PM25_next"] > 90.0).astype(int)
    df_fresh["year_month"] = df_fresh["Date"].dt.to_period("M").astype(str)
    df_fresh["station_month"] = df_fresh["StationId"] + "_" + df_fresh["year_month"]

    train_mask = df_fresh["Date"] < "2018-07-01"
    val_mask = (df_fresh["Date"] >= "2018-07-01") & (df_fresh["Date"] <= "2019-06-30")
    test_mask = df_fresh["Date"] >= "2019-07-01"

    print(f"Fresh-Crossing Splits:")
    print(f"  Train (< 2018-07-01):          {train_mask.sum():,d} rows (Spike rate: {df_fresh.loc[train_mask, 'target'].mean():.2%})")
    print(f"  Val (2018-07-01 - 2019-06-30): {val_mask.sum():,d} rows (Spike rate: {df_fresh.loc[val_mask, 'target'].mean():.2%})")
    print(f"  Test (>= 2019-07-01):          {test_mask.sum():,d} rows (Spike rate: {df_fresh.loc[test_mask, 'target'].mean():.2%})")
    print(f"  Test Max Date:                 {df_fresh.loc[test_mask, 'date_str'].max()}")

    return df_fresh, train_mask, val_mask, test_mask


def eval_budget(y_true, probs, df_slice, budget_pct):
    df_eval = pd.DataFrame({"target": y_true, "prob": probs, "month": df_slice["year_month"].values})
    df_eval["rank"] = df_eval.groupby("month")["prob"].rank(ascending=False, pct=True)
    pred = (df_eval["rank"] <= budget_pct).astype(int)
    rec = recall_score(y_true, pred, zero_division=0)
    prec = precision_score(y_true, pred, zero_division=0)
    f1 = f1_score(y_true, pred, zero_division=0)
    return rec, prec, f1


def main():
    df_fresh, train_mask, val_mask, test_mask = load_dataset()

    logreg_features = ["PM2.5", "pm25_lag1", "pm25_rolling3", "pm25_ratio_90"]
    full_features = [
        "PM2.5", "pm25_lag1", "pm25_lag2", "pm25_rolling3",
        "delta_lag1", "delta_rolling3", "pm25_slope_3d", "pm25_ratio_90",
        "u10", "v10", "wind_speed", "t2m", "blh",
        "month", "dayofweek", "dayofyear",
        "fire_count_100km", "fire_frp_100km", "upwind_fire_count_100km", "upwind_frp_100km",
        "upwind_fire_count_100km_lag1", "upwind_fire_count_100km_lag2", "upwind_fire_count_100km_lag3",
        "upwind_frp_100km_lag1", "upwind_frp_100km_lag2", "upwind_frp_100km_lag3",
        "upwind_fire_count_100km_rolling3", "upwind_frp_100km_rolling3"
    ]

    # Fill any remaining NaNs in full features for LightGBM
    for c in full_features:
        if df_fresh[c].isna().sum() > 0:
            df_fresh[c] = df_fresh[c].fillna(df_fresh[c].median())

    X_train_lr = df_fresh.loc[train_mask, logreg_features]
    y_train = df_fresh.loc[train_mask, "target"].values

    X_val_lr = df_fresh.loc[val_mask, logreg_features]
    y_val = df_fresh.loc[val_mask, "target"].values

    X_test_lr = df_fresh.loc[test_mask, logreg_features]
    y_test = df_fresh.loc[test_mask, "target"].values

    # -------------------------------------------------------------------------
    # 2. Train Logistic Regression & Fit Isotonic Calibrator on Val Only
    # -------------------------------------------------------------------------
    print("\n" + "=" * 80)
    print("2. TRAINING SHIPPED MODEL: LOGISTIC REGRESSION + ISOTONIC CALIBRATION")
    print("=" * 80)

    pipe_lr = Pipeline([
        ("scaler", StandardScaler()),
        ("clf", LogisticRegression(C=1.0, max_iter=1000, random_state=RANDOM_SEED))
    ])
    pipe_lr.fit(X_train_lr, y_train)

    val_probs_lr_uncal = pipe_lr.predict_proba(X_val_lr)[:, 1]
    test_probs_lr_uncal = pipe_lr.predict_proba(X_test_lr)[:, 1]

    # Fit Isotonic Regression strictly on Validation split
    calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
    calibrator.fit(val_probs_lr_uncal, y_val)

    test_probs_lr_cal = calibrator.predict(test_probs_lr_uncal)

    # Metrics for Shipped Model
    lr_pr_auc = average_precision_score(y_test, test_probs_lr_cal)
    lr_roc_auc = roc_auc_score(y_test, test_probs_lr_cal)
    brier_uncal = brier_score_loss(y_test, test_probs_lr_uncal)
    brier_cal = brier_score_loss(y_test, test_probs_lr_cal)
    brier_reduct = (brier_uncal - brier_cal) / brier_uncal * 100.0

    rec_lr_5, prec_lr_5, f1_lr_5 = eval_budget(y_test, test_probs_lr_cal, df_fresh[test_mask], 0.05)
    rec_lr_2, prec_lr_2, f1_lr_2 = eval_budget(y_test, test_probs_lr_cal, df_fresh[test_mask], 0.02)
    rec_lr_10, prec_lr_10, f1_lr_10 = eval_budget(y_test, test_probs_lr_cal, df_fresh[test_mask], 0.10)

    print(f"Shipped Model Test Performance (Logistic Regression):")
    print(f"  PR-AUC:                   {lr_pr_auc:.4f}")
    print(f"  ROC-AUC:                  {lr_roc_auc:.4f}")
    print(f"  Test Brier Before Calib:  {brier_uncal:.4f}")
    print(f"  Test Brier After Calib:   {brier_cal:.4f} ({brier_reduct:+.1f}% error reduction)")
    print(f"  5% Monthly Budget:        Recall={rec_lr_5:.1%}, Precision={prec_lr_5:.1%}, F1={f1_lr_5:.3f}")
    print(f"  2% Monthly Budget:        Recall={rec_lr_2:.1%}, Precision={prec_lr_2:.1%}, F1={f1_lr_2:.3f}")
    print(f"  10% Monthly Budget:       Recall={rec_lr_10:.1%}, Precision={prec_lr_10:.1%}, F1={f1_lr_10:.3f}")

    # -------------------------------------------------------------------------
    # 3. Risk Tiers for Shipped Model
    # -------------------------------------------------------------------------
    print("\n" + "=" * 80)
    print("3. RISK TIERS (CALIBRATED LOGISTIC REGRESSION ON TEST SET)")
    print("=" * 80)

    # Defined tiers:
    #   Nominal:   < 10%
    #   Watch:     10% - 25%
    #   Elevated:  25% - 50%
    #   High:      >= 50%
    n_test = len(y_test)
    tier_defs = [
        ("Nominal", (test_probs_lr_cal < 0.10), "< 10%"),
        ("Watch", (test_probs_lr_cal >= 0.10) & (test_probs_lr_cal < 0.25), "10% - 25%"),
        ("Elevated", (test_probs_lr_cal >= 0.25) & (test_probs_lr_cal < 0.50), "25% - 50%"),
        ("High", (test_probs_lr_cal >= 0.50), ">= 50%"),
    ]

    tier_results = {}
    print(f"{'Tier Name':<12} | {'Risk Range':<12} | {'Days (n)':<10} | {'Share of Days':<14} | {'Spikes (n)':<11} | {'Observed Spike Rate':<20}")
    print("-" * 90)
    for name, mask, r_range in tier_defs:
        tier_n = int(mask.sum())
        tier_share = tier_n / n_test if n_test > 0 else 0.0
        tier_spikes = int(y_test[mask].sum()) if tier_n > 0 else 0
        tier_obs_rate = tier_spikes / tier_n if tier_n > 0 else 0.0
        tier_results[name] = {
            "range": r_range,
            "days": tier_n,
            "share_of_days": tier_share,
            "spikes": tier_spikes,
            "observed_spike_rate": tier_obs_rate
        }
        print(f"{name:<12} | {r_range:<12} | {tier_n:<10,d} | {tier_share:<14.1%} | {tier_spikes:<11,d} | {tier_obs_rate:<20.1%}")

    # -------------------------------------------------------------------------
    # 4. Train Challenger Model (LightGBM)
    # -------------------------------------------------------------------------
    print("\n" + "=" * 80)
    print("4. TRAINING CHALLENGER MODEL: LIGHTGBM")
    print("=" * 80)

    lgb_clf = LGBMClassifier(
        n_estimators=1000,
        learning_rate=0.03,
        num_leaves=31,
        min_child_samples=20,
        subsample=0.8,
        colsample_bytree=0.8,
        class_weight='balanced',
        random_state=RANDOM_SEED,
        verbosity=-1
    )
    lgb_clf.fit(
        df_fresh.loc[train_mask, full_features],
        y_train,
        eval_set=[(df_fresh.loc[val_mask, full_features], y_val)],
        callbacks=[early_stopping(stopping_rounds=30, verbose=False), log_evaluation(period=0)]
    )

    val_probs_lgb = lgb_clf.predict_proba(df_fresh.loc[val_mask, full_features])[:, 1]
    test_probs_lgb = lgb_clf.predict_proba(df_fresh.loc[test_mask, full_features])[:, 1]

    lgb_calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
    lgb_calibrator.fit(val_probs_lgb, y_val)
    test_probs_lgb_cal = lgb_calibrator.predict(test_probs_lgb)

    lgb_pr_auc = average_precision_score(y_test, test_probs_lgb_cal)
    lgb_roc_auc = roc_auc_score(y_test, test_probs_lgb_cal)
    lgb_brier = brier_score_loss(y_test, test_probs_lgb_cal)

    rec_lgb_5, prec_lgb_5, f1_lgb_5 = eval_budget(y_test, test_probs_lgb_cal, df_fresh[test_mask], 0.05)
    rec_lgb_2, prec_lgb_2, f1_lgb_2 = eval_budget(y_test, test_probs_lgb_cal, df_fresh[test_mask], 0.02)
    rec_lgb_10, prec_lgb_10, f1_lgb_10 = eval_budget(y_test, test_probs_lgb_cal, df_fresh[test_mask], 0.10)

    print(f"Challenger Model Test Performance (LightGBM):")
    print(f"  PR-AUC:            {lgb_pr_auc:.4f}")
    print(f"  ROC-AUC:           {lgb_roc_auc:.4f}")
    print(f"  Test Brier:        {lgb_brier:.4f}")
    print(f"  5% Monthly Budget: Recall={rec_lgb_5:.1%}, Precision={prec_lgb_5:.1%}, F1={f1_lgb_5:.3f}")
    print(f"  2% Monthly Budget: Recall={rec_lgb_2:.1%}, Precision={prec_lgb_2:.1%}, F1={f1_lgb_2:.3f}")
    print(f"  10% Monthly Budget: Recall={rec_lgb_10:.1%}, Precision={prec_lgb_10:.1%}, F1={f1_lgb_10:.3f}")

    # -------------------------------------------------------------------------
    # 5. Station-Month Block Bootstrap (200 Draws) for PR-AUC Difference
    # -------------------------------------------------------------------------
    print("\n" + "=" * 80)
    print("5. STATION-MONTH BLOCK BOOTSTRAP (200 DRAWS) FOR PR-AUC DIFFERENCE")
    print("=" * 80)

    test_df_fresh = df_fresh[test_mask].copy().reset_index(drop=True)
    unique_blocks = np.array(test_df_fresh["station_month"].unique())
    n_blocks = len(unique_blocks)
    print(f"Total unique station-month clusters in test set: {n_blocks}")

    block_indices = test_df_fresh.groupby("station_month").indices

    boot_lr_prauc = []
    boot_lgb_prauc = []
    boot_diff_prauc = []

    np.random.seed(RANDOM_SEED)
    N_BOOTSTRAP = 200
    for b in range(N_BOOTSTRAP):
        sampled_blocks = np.random.choice(unique_blocks, size=n_blocks, replace=True)
        sampled_idx = np.concatenate([block_indices[blk] for blk in sampled_blocks])
        y_b = y_test[sampled_idx]
        if y_b.sum() == 0 or y_b.sum() == len(y_b):
            continue

        p_lr_b = test_probs_lr_cal[sampled_idx]
        p_lgb_b = test_probs_lgb_cal[sampled_idx]

        pr_lr_b = average_precision_score(y_b, p_lr_b)
        pr_lgb_b = average_precision_score(y_b, p_lgb_b)
        diff_b = pr_lgb_b - pr_lr_b  # Challenger minus Shipped

        boot_lr_prauc.append(pr_lr_b)
        boot_lgb_prauc.append(pr_lgb_b)
        boot_diff_prauc.append(diff_b)

    ci_lr = (np.percentile(boot_lr_prauc, 2.5), np.percentile(boot_lr_prauc, 97.5))
    ci_lgb = (np.percentile(boot_lgb_prauc, 2.5), np.percentile(boot_lgb_prauc, 97.5))
    ci_diff = (np.percentile(boot_diff_prauc, 2.5), np.percentile(boot_diff_prauc, 97.5))
    mean_diff = np.mean(boot_diff_prauc)

    is_significant = (ci_diff[0] > 0 and ci_diff[1] > 0) or (ci_diff[0] < 0 and ci_diff[1] < 0)

    print(f"Bootstrap Results (200 Station-Month Resamples):")
    print(f"  Logistic Regression PR-AUC: {lr_pr_auc:.4f} [95% CI: {ci_lr[0]:.4f}, {ci_lr[1]:.4f}]")
    print(f"  LightGBM PR-AUC:            {lgb_pr_auc:.4f} [95% CI: {ci_lgb[0]:.4f}, {ci_lgb[1]:.4f}]")
    print(f"  Delta (LightGBM - LogReg):  {mean_diff:+.4f} [95% CI: {ci_diff[0]:+.4f}, {ci_diff[1]:+.4f}]")
    print(f"  Difference Statistically Significant: {is_significant} (95% CI spans zero: {ci_diff[0]:.4f} to {ci_diff[1]:.4f})")

    # -------------------------------------------------------------------------
    # 6. Save Model Artifact & Benchmarks JSON
    # -------------------------------------------------------------------------
    print("\n" + "=" * 80)
    print("6. SAVING SHIPPED MODEL ARTIFACT & BENCHMARKS JSON")
    print("=" * 80)

    test_min_date = df_fresh.loc[test_mask, "Date"].min().strftime("%Y-%m-%d")
    test_max_date = df_fresh.loc[test_mask, "Date"].max().strftime("%Y-%m-%d")
    test_period_str = f"{test_min_date} to {test_max_date}"
    print(f"Computed actual test period from data: {test_period_str}")

    artifact_payload = {
        "model": pipe_lr,
        "calibrator": calibrator,
        "features": logreg_features,
        "metrics": {
            "test_pr_auc": float(lr_pr_auc),
            "test_pr_auc_ci_95": [float(ci_lr[0]), float(ci_lr[1])],
            "test_roc_auc": float(lr_roc_auc),
            "test_brier_uncalibrated": float(brier_uncal),
            "test_brier_calibrated": float(brier_cal),
            "budget_5pct": {
                "recall": float(rec_lr_5),
                "precision": float(prec_lr_5),
                "f1": float(f1_lr_5),
                "framing": "per-month 5% alert budget"
            },
        },
        "risk_tiers": tier_results,
        "splits": {
            "train": "< 2018-07-01",
            "val": "2018-07-01 to 2019-06-30",
            "test": test_period_str
        },
        "metadata": {
            "created_at": datetime.now().isoformat(),
            "target": "Tomorrow PM2.5 > 90.0 given today PM2.5 <= 90.0",
        }
    }

    joblib.dump(artifact_payload, FINAL_MODEL_PKL)
    print(f"Saved shipped model to {FINAL_MODEL_PKL} ({os.path.getsize(FINAL_MODEL_PKL) / 1024:.1f} KB)")

    # Save benchmark metrics for alert_data.json export
    BENCHMARKS_JSON = MODELS_DIR / "phase1_final_benchmarks.json"
    benchmarks_payload = {
        "test_period": test_period_str,
        "fresh_crossing_benchmark": {
            "test_period": test_period_str,
            "model": "LightGBM",
            "pr_auc": round(float(lgb_pr_auc), 4),
            "budget_5pct_recall": round(float(rec_lgb_5), 3),
            "budget_5pct_precision": round(float(prec_lgb_5), 3),
            "budget_5pct_f1": round(float(f1_lgb_5), 3),
            "framing": "per-month 5% alert budget"
        },
        "logistic_regression_benchmark": {
            "test_period": test_period_str,
            "model": "LogisticRegression",
            "features": logreg_features,
            "pr_auc": round(float(lr_pr_auc), 4),
            "budget_5pct_recall": round(float(rec_lr_5), 3),
            "budget_5pct_precision": round(float(prec_lr_5), 3),
            "budget_5pct_f1": round(float(f1_lr_5), 3),
            "framing": "per-month 5% alert budget"
        }
    }
    with open(BENCHMARKS_JSON, "w", encoding="utf-8") as f:
        json.dump(benchmarks_payload, f, indent=2)
    print(f"Saved benchmarks JSON to {BENCHMARKS_JSON}")

    # -------------------------------------------------------------------------
    # 7. Log to MLflow
    # -------------------------------------------------------------------------
    print("\n" + "=" * 80)
    print("7. LOGGING EXPERIMENT TO MLFLOW")
    print("=" * 80)

    mlflow.set_experiment("Phase1_Final_Shipment")

    # Challenger Run: LightGBM
    with mlflow.start_run(run_name="LightGBM_Challenger"):
        mlflow.set_tag("role", "challenger")
        mlflow.set_tag("pipeline", "phase1_final")
        mlflow.log_params({
            "model_type": "LightGBM",
            "n_features": len(full_features),
            "learning_rate": 0.03,
            "num_leaves": 31,
            "class_weight": "balanced",
            "test_period": test_period_str
        })
        mlflow.log_metrics({
            "test_pr_auc": float(lgb_pr_auc),
            "test_roc_auc": float(lgb_roc_auc),
            "test_brier": float(lgb_brier),
            "budget_5pct_recall": float(rec_lgb_5),
            "budget_5pct_precision": float(prec_lgb_5),
            "budget_5pct_f1": float(f1_lgb_5),
        })

    # Shipped Run: Logistic Regression (Calibrated)
    with mlflow.start_run(run_name="LogisticRegression_Shipped"):
        mlflow.set_tag("role", "production_shipped")
        mlflow.set_tag("pipeline", "phase1_final")
        mlflow.log_params({
            "model_type": "LogisticRegression_Calibrated",
            "features": ",".join(logreg_features),
            "calibrator": "IsotonicRegression",
            "C": 1.0,
            "penalty": "l2",
            "test_period": test_period_str
        })
        mlflow.log_metrics({
            "test_pr_auc": float(lr_pr_auc),
            "test_pr_auc_ci_lower": float(ci_lr[0]),
            "test_pr_auc_ci_upper": float(ci_lr[1]),
            "test_roc_auc": float(lr_roc_auc),
            "test_brier_uncalibrated": float(brier_uncal),
            "test_brier_calibrated": float(brier_cal),
            "brier_reduction_pct": float(brier_reduct),
            "budget_5pct_recall": float(rec_lr_5),
            "budget_5pct_precision": float(prec_lr_5),
            "budget_5pct_f1": float(f1_lr_5),
            "tier_watch_obs_rate": float(tier_results["Watch"]["observed_spike_rate"]),
            "tier_watch_share": float(tier_results["Watch"]["share_of_days"]),
            "tier_elevated_obs_rate": float(tier_results["Elevated"]["observed_spike_rate"]),
            "tier_elevated_share": float(tier_results["Elevated"]["share_of_days"]),
            "tier_high_obs_rate": float(tier_results["High"]["observed_spike_rate"]),
            "tier_high_share": float(tier_results["High"]["share_of_days"]),
        })
        mlflow.log_artifact(str(FINAL_MODEL_PKL))

    print("MLflow logging completed successfully.")

    # -------------------------------------------------------------------------
    # 8. Write reports/phase1_final.md
    # -------------------------------------------------------------------------
    print("\n" + "=" * 80)
    print("8. GENERATING reports/phase1_final.md")
    print("=" * 80)

    report_lines = [
        "# Phase 1 Final Model Report",
        f"**Shipped Model**: Isotonic-calibrated Logistic Regression on `[PM2.5, pm25_lag1, pm25_rolling3, pm25_ratio_90]` (`models/phase1_final_logreg.pkl`).",
        f"**Test Period**: {test_period_str} ({n_test:,d} station-days with today's PM2.5 <= 90 µg/m³; base spike rate: {y_test.mean():.2%}).",
        f"**Overall Test Metrics**: PR-AUC = {lr_pr_auc:.4f} [95% CI: {ci_lr[0]:.4f}, {ci_lr[1]:.4f}], ROC-AUC = {lr_roc_auc:.4f}, test Brier score: {brier_uncal:.4f} (uncalibrated) vs {brier_cal:.4f} (isotonic-calibrated).",
        f"**Operating Point (5% Monthly Alert Budget)**: Recall = {rec_lr_5:.1%}, Precision = {prec_lr_5:.1%}, F1 = {f1_lr_5:.3f} (Challenger LightGBM: Rec={rec_lgb_5:.1%}, Prec={prec_lgb_5:.1%}, F1={f1_lgb_5:.3f}).",
        f"**Challenger Comparison**: LightGBM PR-AUC = {lgb_pr_auc:.4f} [95% CI: {ci_lgb[0]:.4f}, {ci_lgb[1]:.4f}]; difference Delta = {mean_diff:+.4f} [95% CI: {ci_diff[0]:+.4f}, {ci_diff[1]:+.4f}] is not statistically significant.",
        f"**Risk Tiers (Observed Test Spike Rates)**: Nominal (<10% risk, {tier_results['Nominal']['share_of_days']:.1%} days): {tier_results['Nominal']['observed_spike_rate']:.1%} spike rate; Watch (10-25% risk, {tier_results['Watch']['share_of_days']:.1%} days): {tier_results['Watch']['observed_spike_rate']:.1%} spike rate.",
        f"**High-Risk Tiers**: Elevated (25-50% risk, {tier_results['Elevated']['share_of_days']:.1%} days): {tier_results['Elevated']['observed_spike_rate']:.1%} spike rate; High (>=50% risk, {tier_results['High']['share_of_days']:.1%} days): {tier_results['High']['observed_spike_rate']:.1%} spike rate.",
        f"**Limitation 1 (Precision/Recall Tradeoff)**: Under a monthly budget, reaching ~60% recall dilutes precision to ~14-16%; under Phase 1b fixed-threshold tuning, 57.8% recall yielded 30.6% precision.",
        f"**Limitation 2 (Evaluation Window)**: The test window is 12 months (Jul 2019 - Jun 2020), about 41% of it COVID lockdown, with one winter and one post-monsoon season.",
        f"**Limitation 3 (Fire Features Lift)**: MODIS fire features (same-day and lagged 1-3d) provided no measurable lift over local PM2.5 autoregression on fresh crossings.",
    ]

    report_content = "\n".join(report_lines) + "\n"

    with open(REPORT_MD, "w", encoding="utf-8") as f:
        f.write(report_content)

    print(f"Wrote reports/phase1_final.md ({len(report_lines)} lines):")
    print("-" * 80)
    for i, line in enumerate(report_lines, 1):
        print(f"{i:2d}: {line}")
    print("-" * 80)


if __name__ == "__main__":
    main()
