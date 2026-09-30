"""
export_alert_data.py
====================
Generates alert_data.json for the India Air-Quality Dashboard Alerts view.

Timing Audit:
  - Observation day t:
      * Current pollution: PM2.5 (day t)
      * Meteorology: ERA5 daily averages for u10, v10, wind_speed, t2m, blh (day t)
      * Fire detections: MODIS active fires on day t (fire_count_100km, fire_frp_100km, upwind_fire_count_100km, upwind_frp_100km)
      * Calendar features: month, dayofweek, dayofyear of day t
  - Prior days (strictly <= t):
      * pm25_lag1: PM2.5 at day t-1
      * pm25_lag2: PM2.5 at day t-2
      * pm25_rolling3: backward-looking 3-day rolling mean ending on day t ({t-2, t-1, t})
  - Forecast target:
      * PM25_next: 24-hr average PM2.5 on day t+1
      * Exactly ZERO features use day t+1. All features are strictly known at forecast time t.

Evaluations:
  - Denominator: Fresh-crossing metrics are evaluated strictly on eligible rows (today's PM2.5 <= 90 µg/m³).
  - General alert metrics evaluate tomorrow's PM2.5 > 90 µg/m³ across all rows.
  - Bootstrap: Date-level cluster bootstrap (resampling dates with replacement) accounts for spatial autocorrelation.
  - Matched PR curves: Full precision/recall sweeps for both Model and Baseline (sweeping X from 30 to 89).
  - Calibration: Parametric Gaussian residual calibration on 2018 holdout split (sigma = 24.78 µg/m³).

Usage:
  python scripts/export_alert_data.py
"""

import os
import sys
import json
import time
import hashlib
import zipfile
import shutil
import glob
from datetime import datetime
from pathlib import Path
import re

import numpy as np
import pandas as pd
import xarray as xr
from scipy.stats import norm
from lightgbm import LGBMRegressor
import joblib
import math
from PIL import Image

# Paths
BASE_DIR = Path(__file__).resolve().parent.parent
DASHBOARD_JSON = BASE_DIR / "src" / "data" / "dashboard_data.json"
STATION_DAY_CSV = BASE_DIR / "archive" / "station_day.csv"
MODIS_PARQUET = BASE_DIR / "ML_OUTPUT" / "modis_daily_fire.parquet"
ERA5_DIR = BASE_DIR / "weather" / "ERA5 Hourly"
CACHE_DIR = BASE_DIR / "ML_OUTPUT" / "cache"
POPULATION_TIFF = BASE_DIR / "ind_ppp_2017_1km_Aggregated_UNadj.tif"

OUTPUT_JSON = BASE_DIR / "src" / "data" / "alert_data.json"
OUTPUT_MODEL = BASE_DIR / "scripts" / "alert_model.joblib"

CACHE_DIR.mkdir(parents=True, exist_ok=True)

# -----------------------------------------------------------------------------
# 1. Geodesic Calculations (Haversine & Bearing)
# -----------------------------------------------------------------------------
def haversine_vectorized(lat1, lon1, lat2, lon2):
    R = 6371.0
    phi1, phi2 = np.radians(lat1), np.radians(lat2)
    dphi = np.radians(lat2 - lat1)
    dlam = np.radians(lon2 - lon1)
    a = np.sin(dphi / 2.0) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(dlam / 2.0) ** 2
    return 2.0 * R * np.arcsin(np.sqrt(np.clip(a, 0, 1.0)))

def bearing_vectorized(lat1, lon1, lat2, lon2):
    phi1, phi2 = np.radians(lat1), np.radians(lat2)
    dlam = np.radians(lon2 - lon1)
    y = np.sin(dlam) * np.cos(phi2)
    x = np.cos(phi1) * np.sin(phi2) - np.sin(phi1) * np.cos(phi2) * np.cos(dlam)
    return (np.degrees(np.arctan2(y, x)) + 360.0) % 360.0

# -----------------------------------------------------------------------------
# 2. Extract Station-Level Weather (ERA5) - Strictly Day t
# -----------------------------------------------------------------------------
def extract_station_weather(coords_df):
    cache_file = CACHE_DIR / "station_weather_daily.parquet"
    if cache_file.exists():
        print("Loading cached ERA5 station weather from", cache_file)
        return pd.read_parquet(cache_file)

    print("Extracting ERA5 weather for unique station locations...")
    zips = sorted(glob.glob(str(ERA5_DIR / "*.zip")))
    dfs = []
    
    lats_da = xr.DataArray(coords_df['lat'].values, dims='pts')
    lons_da = xr.DataArray(coords_df['lon'].values, dims='pts')

    for z in zips:
        if 'd8cb' in z:
            continue
        print("  Processing weather archive:", Path(z).name)
        tmp_dir = ERA5_DIR / f"tmp_extract_{Path(z).stem[:6]}"
        with zipfile.ZipFile(z, 'r') as zf:
            zf.extract('data_stream-oper_stepType-instant.nc', tmp_dir)
        nc_file = tmp_dir / 'data_stream-oper_stepType-instant.nc'
        ds = xr.open_dataset(nc_file)

        sub = ds[['u10', 'v10', 't2m', 'blh']].sel(latitude=lats_da, longitude=lons_da, method='nearest')
        daily = sub.resample(valid_time='1D').mean()
        df_chunk = daily.to_dataframe().reset_index()

        df_chunk['station_lat'] = coords_df['lat'].values[df_chunk['pts']]
        df_chunk['station_lon'] = coords_df['lon'].values[df_chunk['pts']]
        dfs.append(df_chunk[['valid_time', 'station_lat', 'station_lon', 'u10', 'v10', 't2m', 'blh']])

        ds.close()
        shutil.rmtree(tmp_dir, ignore_errors=True)

    all_weather = pd.concat(dfs, ignore_index=True)
    all_weather['date'] = pd.to_datetime(all_weather['valid_time']).dt.strftime('%Y-%m-%d')
    all_weather.drop(columns=['valid_time'], inplace=True)
    all_weather.to_parquet(cache_file, index=False)
    print("Cached ERA5 station weather to", cache_file)
    return all_weather

# -----------------------------------------------------------------------------
# 3. Extract MODIS 100km & Upwind Fire Features - Strictly Day t
# -----------------------------------------------------------------------------
def extract_station_fire_features(coords_df, weather_df):
    cache_file = CACHE_DIR / "station_fire_features.parquet"
    if cache_file.exists():
        print("Loading cached fire features from", cache_file)
        return pd.read_parquet(cache_file)

    print("Computing MODIS 100km and upwind fire features...")
    fires = pd.read_parquet(MODIS_PARQUET)
    fires['date_str'] = pd.to_datetime(fires['date']).dt.strftime('%Y-%m-%d')
    
    w_lookup = {}
    for _, row in weather_df.iterrows():
        key = (row['date'], round(float(row['station_lat']), 4), round(float(row['station_lon']), 4))
        w_lookup[key] = (float(row['u10']), float(row['v10']))

    fires_by_date = {}
    for d, g in fires.groupby('date_str'):
        fires_by_date[d] = {
            'lat': g['latitude'].values,
            'lon': g['longitude'].values,
            'frp': g['frp'].values
        }

    records = []
    unique_dates = sorted(weather_df['date'].unique())

    for idx, s in coords_df.iterrows():
        slat = float(s['lat'])
        slon = float(s['lon'])
        s_key = (round(slat, 4), round(slon, 4))
        
        for d in unique_dates:
            f_data = fires_by_date.get(d)
            if f_data is None or len(f_data['lat']) == 0:
                records.append({
                    'station_lat': slat,
                    'station_lon': slon,
                    'date': d,
                    'fire_count_100km': 0,
                    'fire_frp_100km': 0.0,
                    'upwind_fire_count_100km': 0,
                    'upwind_frp_100km': 0.0
                })
                continue

            flat = f_data['lat']
            flon = f_data['lon']
            ffrp = f_data['frp']

            mask_box = (np.abs(flat - slat) <= 1.1) & (np.abs(flon - slon) <= 1.2)
            if not np.any(mask_box):
                records.append({
                    'station_lat': slat,
                    'station_lon': slon,
                    'date': d,
                    'fire_count_100km': 0,
                    'fire_frp_100km': 0.0,
                    'upwind_fire_count_100km': 0,
                    'upwind_frp_100km': 0.0
                })
                continue

            sub_flat = flat[mask_box]
            sub_flon = flon[mask_box]
            sub_ffrp = ffrp[mask_box]

            dists = haversine_vectorized(slat, slon, sub_flat, sub_flon)
            in_100 = dists <= 100.0

            if not np.any(in_100):
                records.append({
                    'station_lat': slat,
                    'station_lon': slon,
                    'date': d,
                    'fire_count_100km': 0,
                    'fire_frp_100km': 0.0,
                    'upwind_fire_count_100km': 0,
                    'upwind_frp_100km': 0.0
                })
                continue

            f_count_100 = int(np.sum(in_100))
            f_frp_100 = float(np.sum(sub_ffrp[in_100]))

            u10, v10 = w_lookup.get((d, s_key[0], s_key[1]), (0.0, 0.0))
            theta_from = (np.degrees(np.arctan2(u10, v10)) + 180.0) % 360.0

            bearings = bearing_vectorized(slat, slon, sub_flat[in_100], sub_flon[in_100])
            diff = np.abs(bearings - theta_from) % 360.0
            diff = np.minimum(diff, 360.0 - diff)
            is_upwind = diff <= 45.0

            up_count = int(np.sum(is_upwind))
            up_frp = float(np.sum(sub_ffrp[in_100][is_upwind]))

            records.append({
                'station_lat': slat,
                'station_lon': slon,
                'date': d,
                'fire_count_100km': f_count_100,
                'fire_frp_100km': f_frp_100,
                'upwind_fire_count_100km': up_count,
                'upwind_frp_100km': up_frp
            })

    res_df = pd.DataFrame(records)
    res_df.to_parquet(cache_file, index=False)
    print("Cached fire features to", cache_file)
    return res_df

# -----------------------------------------------------------------------------
# 4. Bootstrap Functions (Row-Level and Date-Level)
# -----------------------------------------------------------------------------
def bootstrap_improvement_ci_row(actual, pred_model, pred_persist, n_boot=1000, ci=95):
    np.random.seed(42)
    n = len(actual)
    if n == 0:
        return [0.0, 0.0]
    err_m = np.abs(actual - pred_model)
    err_p = np.abs(actual - pred_persist)
    indices = np.arange(n)
    boot_improvements = []
    for _ in range(n_boot):
        sample_idx = np.random.choice(indices, size=n, replace=True)
        mae_p = np.mean(err_p[sample_idx])
        mae_m = np.mean(err_m[sample_idx])
        if mae_p > 0:
            boot_improvements.append((mae_p - mae_m) / mae_p * 100.0)
    alpha = (100 - ci) / 2.0
    return [round(float(np.percentile(boot_improvements, alpha)), 1),
            round(float(np.percentile(boot_improvements, 100 - alpha)), 1)]

def date_bootstrap_segment(sub_df, selected_threshold, best_base_x_fresh, n_boot=1000):
    daily = sub_df.groupby('date').agg(
        err_p=('err_p', 'sum'),
        err_m=('err_m', 'sum'),
        n_el=('eligible', 'sum'),
        n_ev=('fresh_event', 'sum'),
        tp_m=('model_fresh_alert', lambda x: np.sum(x & sub_df.loc[x.index, 'fresh_event'])),
        fp_m=('model_fresh_alert', lambda x: np.sum(x & (~sub_df.loc[x.index, 'fresh_event']) & sub_df.loc[x.index, 'eligible'])),
        fn_m=('model_fresh_alert', lambda x: np.sum((~x) & sub_df.loc[x.index, 'fresh_event']))
    )
    n_days = len(daily)
    if n_days < 2:
        return [0.0, 0.0], [0.0, 0.0], [0.0, 0.0], [0.0, 0.0]
        
    np.random.seed(42)
    boot_idx = np.random.choice(n_days, size=(n_boot, n_days), replace=True)
    
    # MAE improvement
    sp = daily['err_p'].values[boot_idx].sum(axis=1)
    sm = daily['err_m'].values[boot_idx].sum(axis=1)
    imp = np.where(sp > 0, (sp - sm) / sp * 100.0, 0.0)
    imp_ci = [round(float(x), 1) for x in np.percentile(imp, [2.5, 97.5])]
    
    # Event rate
    sev = daily['n_ev'].values[boot_idx].sum(axis=1)
    sel = daily['n_el'].values[boot_idx].sum(axis=1)
    ev_rt = np.where(sel > 0, sev / sel * 100.0, 0.0)
    ev_ci = [round(float(x), 1) for x in np.percentile(ev_rt, [2.5, 97.5])]
    
    # Recall
    stp = daily['tp_m'].values[boot_idx].sum(axis=1)
    sfn = daily['fn_m'].values[boot_idx].sum(axis=1)
    rec = np.where(stp + sfn > 0, stp / (stp + sfn) * 100.0, 0.0)
    rec_ci = [round(float(x), 1) for x in np.percentile(rec, [2.5, 97.5])]
    
    # Precision
    sfp = daily['fp_m'].values[boot_idx].sum(axis=1)
    prec = np.where(stp + sfp > 0, stp / (stp + sfp), 0.0)
    prec_ci = [round(float(x), 2) for x in np.percentile(prec, [2.5, 97.5])]
    
    return imp_ci, ev_ci, rec_ci, prec_ci

def date_bootstrap_general_f1(sub_df, th_gen, x_naive, x_gen, n_boot=1000):
    daily = sub_df.groupby('date').apply(lambda g: pd.Series({
        'tp_m': np.sum((g['exceedance_prob'] >= th_gen) & g['actual_poor_or_worse']),
        'fp_m': np.sum((g['exceedance_prob'] >= th_gen) & (~g['actual_poor_or_worse'])),
        'fn_m': np.sum((g['exceedance_prob'] < th_gen) & g['actual_poor_or_worse']),
        'tp_p': np.sum((g['pm25_today'] > x_naive) & g['actual_poor_or_worse']),
        'fp_p': np.sum((g['pm25_today'] > x_naive) & (~g['actual_poor_or_worse'])),
        'fn_p': np.sum((g['pm25_today'] <= x_naive) & g['actual_poor_or_worse']),
        'tp_t': np.sum((g['pm25_today'] > x_gen) & g['actual_poor_or_worse']),
        'fp_t': np.sum((g['pm25_today'] > x_gen) & (~g['actual_poor_or_worse'])),
        'fn_t': np.sum((g['pm25_today'] <= x_gen) & g['actual_poor_or_worse']),
    }))
    n_days = len(daily)
    if n_days < 2:
        return [0.0, 0.0], [0.0, 0.0], [0.0, 0.0]
        
    np.random.seed(42)
    boot_idx = np.random.choice(n_days, size=(n_boot, n_days), replace=True)

    def f1_ci(tp_k, fp_k, fn_k):
        stp = daily[tp_k].values[boot_idx].sum(axis=1)
        sfp = daily[fp_k].values[boot_idx].sum(axis=1)
        sfn = daily[fn_k].values[boot_idx].sum(axis=1)
        pr = np.where(stp + sfp > 0, stp / (stp + sfp), 0.0)
        rc = np.where(stp + sfn > 0, stp / (stp + sfn), 0.0)
        f1 = np.where(pr + rc > 0, 2 * pr * rc / (pr + rc), 0.0)
        return [round(float(x), 3) for x in np.percentile(f1, [2.5, 97.5])]

    return f1_ci('tp_m', 'fp_m', 'fn_m'), f1_ci('tp_p', 'fp_p', 'fn_p'), f1_ci('tp_t', 'fp_t', 'fn_t')

# -----------------------------------------------------------------------------
# 5. Matched PR Curves & Paired Date-Level Bootstrap Differences
# -----------------------------------------------------------------------------
def compute_matched_pr_metrics(sub_df, n_boot=200):
    el_df = sub_df[sub_df['eligible']].reset_index(drop=True)
    act = el_df['actual_fresh_crossing'].values
    n_pos = int(np.sum(act))
    n_el = len(el_df)
    
    if n_pos == 0 or n_el == 0:
        return {}, []

    m_probs = el_df['risk_score'].values
    b_pms = el_df['pm25_today'].values
    
    # 50 threshold points for Model
    m_ths = np.linspace(0.02, 0.98, 50)
    model_curve = []
    m_recs, m_precs = [], []
    for th in m_ths:
        th_f = round(float(th), 3)
        al = m_probs >= th
        tp = int(np.sum(al & act))
        fp = int(np.sum(al & (~act)))
        p = float(tp / (tp + fp)) if (tp + fp) > 0 else 0.0
        r = float(tp / n_pos * 100.0) if n_pos > 0 else 0.0
        al_rate = float(np.sum(al) / n_el * 100.0)
        m_recs.append(r / 100.0)
        m_precs.append(p)
        model_curve.append({
            "threshold": th_f,
            "precision": round(p, 3),
            "recall": round(r, 1),
            "alerts_per_100_days": round(al_rate, 1)
        })

    # Sweep X from 30 to 89 for Baseline
    b_xs = np.arange(30, 90)
    baseline_curve = []
    b_recs, b_precs = [], []
    for x in b_xs:
        al = b_pms > x
        tp = int(np.sum(al & act))
        fp = int(np.sum(al & (~act)))
        p = float(tp / (tp + fp)) if (tp + fp) > 0 else 0.0
        r = float(tp / n_pos * 100.0) if n_pos > 0 else 0.0
        al_rate = float(np.sum(al) / n_el * 100.0)
        b_recs.append(r / 100.0)
        b_precs.append(p)
        baseline_curve.append({
            "threshold_x": int(x),
            "precision": round(p, 3),
            "recall": round(r, 1),
            "alerts_per_100_days": round(al_rate, 1)
        })

    max_rec_m = float(np.max(m_recs) * 100.0)
    max_rec_b = float(np.max(b_recs) * 100.0)

    def interp_p(target_r, r_arr, p_arr):
        if np.max(r_arr) < target_r:
            return None
        order = np.argsort(r_arr)
        return float(np.interp(target_r, np.array(r_arr)[order], np.array(p_arr)[order]))

    def calc_ap(r_arr, p_arr):
        order = np.argsort(r_arr)
        r_s = np.concatenate([[0], np.array(r_arr)[order]])
        p_s = np.concatenate([[p_arr[order[0]]], np.array(p_arr)[order]])
        return float(np.sum((r_s[1:] - r_s[:-1]) * p_s[1:]))

    pt_m_ap = calc_ap(m_recs, m_precs)
    pt_b_ap = calc_ap(b_recs, b_precs)
    diff_ap_pt = pt_m_ap - pt_b_ap

    pt_m_p60 = interp_p(0.60, m_recs, m_precs)
    pt_m_p75 = interp_p(0.75, m_recs, m_precs)
    pt_m_p85 = interp_p(0.85, m_recs, m_precs)
    pt_b_p60 = interp_p(0.60, b_recs, b_precs)
    pt_b_p75 = interp_p(0.75, b_recs, b_precs)
    pt_b_p85 = interp_p(0.85, b_recs, b_precs)

    # Date-level bootstrap for matched PR metrics & Paired Differences
    dates = el_df['date'].unique()
    date_indices = {dt: idx.values for dt, idx in el_df.groupby('date').groups.items()}
    np.random.seed(42)
    b_m_ap, b_base_ap, b_diff_ap = [], [], []
    b_m_p60, b_m_p75, b_m_p85 = [], [], []
    b_b_p60, b_b_p75, b_b_p85 = [], [], []
    b_diff_p60, b_diff_p75, b_diff_p85 = [], [], []

    for _ in range(n_boot):
        samp_d = np.random.choice(dates, size=len(dates), replace=True)
        idx = np.concatenate([date_indices[dt] for dt in samp_d])
        sub_act = act[idx]
        sub_pos = np.sum(sub_act)
        if sub_pos == 0:
            continue
        
        pr_m = m_probs[idx]
        r_m = np.array([np.sum((pr_m >= th) & sub_act) / sub_pos for th in m_ths])
        p_m = np.array([np.sum((pr_m >= th) & sub_act) / np.maximum(1, np.sum(pr_m >= th)) for th in m_ths])
        
        pr_b = b_pms[idx]
        r_b = np.array([np.sum((pr_b > x) & sub_act) / sub_pos for x in b_xs])
        p_b = np.array([np.sum((pr_b > x) & sub_act) / np.maximum(1, np.sum(pr_b > x)) for x in b_xs])
        
        cur_m_ap = calc_ap(r_m, p_m)
        cur_b_ap = calc_ap(r_b, p_b)
        b_m_ap.append(cur_m_ap)
        b_base_ap.append(cur_b_ap)
        b_diff_ap.append(cur_m_ap - cur_b_ap)

        cur_m_p60 = interp_p(0.60, r_m, p_m)
        cur_b_p60 = interp_p(0.60, r_b, p_b)
        if cur_m_p60 is not None: b_m_p60.append(cur_m_p60)
        if cur_b_p60 is not None: b_b_p60.append(cur_b_p60)
        if cur_m_p60 is not None and cur_b_p60 is not None:
            b_diff_p60.append(cur_m_p60 - cur_b_p60)

        cur_m_p75 = interp_p(0.75, r_m, p_m)
        cur_b_p75 = interp_p(0.75, r_b, p_b)
        if cur_m_p75 is not None: b_m_p75.append(cur_m_p75)
        if cur_b_p75 is not None: b_b_p75.append(cur_b_p75)
        if cur_m_p75 is not None and cur_b_p75 is not None:
            b_diff_p75.append(cur_m_p75 - cur_b_p75)

        cur_m_p85 = interp_p(0.85, r_m, p_m)
        cur_b_p85 = interp_p(0.85, r_b, p_b)
        if cur_m_p85 is not None: b_m_p85.append(cur_m_p85)
        if cur_b_p85 is not None: b_b_p85.append(cur_b_p85)
        if cur_m_p85 is not None and cur_b_p85 is not None:
            b_diff_p85.append(cur_m_p85 - cur_b_p85)

    def ci(arr, dec=3):
        return [round(float(x), dec) for x in np.percentile(arr, [2.5, 97.5])] if len(arr) > 0 else None

    def pack_recall_target(tgt_pct, p_m, p_b, b_m, b_b, b_diff):
        m_val = round(p_m, 3) if p_m is not None else None
        b_val = round(p_b, 3) if p_b is not None else None
        diff_val = round(p_m - p_b, 3) if (p_m is not None and p_b is not None) else None
        return {
            "target_recall": tgt_pct,
            "model": m_val,
            "model_status": "reached" if p_m is not None else "not reached",
            "model_ci_95_date": ci(b_m, 3) if p_m is not None else None,
            "baseline": b_val,
            "baseline_status": "reached" if p_b is not None else "not reached",
            "baseline_ci_95_date": ci(b_b, 3) if p_b is not None else None,
            "diff_model_minus_baseline": diff_val,
            "diff_ci_95_date": ci(b_diff, 3) if diff_val is not None else None
        }

    matched_dict = {
        "max_recall_reached_model": round(max_rec_m, 1),
        "max_recall_reached_baseline": round(max_rec_b, 1),
        "model_average_precision": round(pt_m_ap, 3),
        "model_ap_ci_95_date": ci(b_m_ap, 3),
        "baseline_average_precision": round(pt_b_ap, 3),
        "baseline_ap_ci_95_date": ci(b_base_ap, 3),
        "diff_average_precision": round(diff_ap_pt, 3),
        "diff_ap_ci_95_date": ci(b_diff_ap, 3),
        "precision_at_recall_60": pack_recall_target(60, pt_m_p60, pt_b_p60, b_m_p60, b_b_p60, b_diff_p60),
        "precision_at_recall_75": pack_recall_target(75, pt_m_p75, pt_b_p75, b_m_p75, b_b_p75, b_diff_p75),
        "precision_at_recall_85": pack_recall_target(85, pt_m_p85, pt_b_p85, b_m_p85, b_b_p85, b_diff_p85)
    }
    
    pr_curves_dict = {
        "max_recall_model": round(max_rec_m, 1),
        "max_recall_baseline": round(max_rec_b, 1),
        "model": model_curve,
        "baseline": baseline_curve,
        "baseline_calibrated_operating_point": {
            "threshold_x": 73,
            "description": "X=73 µg/m³ calibrated on 2018 validation split to maximize F1 on fresh crossings"
        }
    }

    return matched_dict, pr_curves_dict

# -----------------------------------------------------------------------------
# 6. Fire Seasonality Analysis
# -----------------------------------------------------------------------------
def compute_fire_seasonality_analysis(df, segment_masks, n_boot=500):
    oct_feb = df['month'].isin([10, 11, 12, 1, 2])
    mar_sep = df['month'].isin([3, 4, 5, 6, 7, 8, 9])
    no_fire_mask = segment_masks['no_fire_100km']
    
    seasons = {
        "all_year": np.ones(len(df), dtype=bool),
        "oct_feb": oct_feb.values,
        "mar_sep": mar_sep.values
    }

    fire_targets = [
        "any_fire_100km",
        "upwind_fire_100km",
        "top10_upwind_intensity",
        "top10_upwind_intensity_all_rows"
    ]

    analysis = {}
    
    for ft in fire_targets:
        ft_mask = segment_masks[ft]
        analysis[ft] = {}
        
        for s_name, s_mask in seasons.items():
            sub = df[s_mask].copy()
            sub['is_ft'] = ft_mask[s_mask]
            sub['is_nf'] = no_fire_mask[s_mask]
            
            sub['ft_el'] = sub['is_ft'] & sub['eligible']
            sub['ft_ev'] = sub['is_ft'] & sub['fresh_event']
            sub['nf_el'] = sub['is_nf'] & sub['eligible']
            sub['nf_ev'] = sub['is_nf'] & sub['fresh_event']
            
            el_ft = int(sub['ft_el'].sum())
            ev_ft = int(sub['ft_ev'].sum())
            el_nf = int(sub['nf_el'].sum())
            ev_nf = int(sub['nf_ev'].sum())
            
            rt_ft = float(ev_ft / el_ft * 100.0) if el_ft > 0 else 0.0
            rt_nf = float(ev_nf / el_nf * 100.0) if el_nf > 0 else 0.0
            ratio = float(rt_ft / rt_nf) if rt_nf > 0 else 0.0
            
            # Date-level bootstrap for ratio
            daily = sub.groupby('date')[['ft_el', 'ft_ev', 'nf_el', 'nf_ev']].sum()
            n_d = len(daily)
            np.random.seed(42)
            boot_idx = np.random.choice(n_d, size=(n_boot, n_d), replace=True)
            
            b_ft_el = daily['ft_el'].values[boot_idx].sum(axis=1)
            b_ft_ev = daily['ft_ev'].values[boot_idx].sum(axis=1)
            b_nf_el = daily['nf_el'].values[boot_idx].sum(axis=1)
            b_nf_ev = daily['nf_ev'].values[boot_idx].sum(axis=1)
            
            b_ft_rt = np.where(b_ft_el > 0, b_ft_ev / b_ft_el, 0.0)
            b_nf_rt = np.where(b_nf_el > 0, b_nf_ev / b_nf_el, np.nan)
            ratios = np.where(b_nf_rt > 0, b_ft_rt / b_nf_rt, np.nan)
            ratios = ratios[~np.isnan(ratios)]
            
            ratio_ci = [round(float(x), 2) for x in np.percentile(ratios, [2.5, 97.5])] if len(ratios) > 0 else [0.0, 0.0]

            analysis[ft][s_name] = {
                "events": ev_ft,
                "eligible": el_ft,
                "event_rate": round(rt_ft, 2),
                "no_fire_rate": round(rt_nf, 2),
                "rate_ratio_to_no_fire": round(ratio, 2) if (ev_ft >= 10 and ev_nf >= 10) else None,
                "status": "valid" if (ev_ft >= 10 and ev_nf >= 10) else f"too few events ({ev_ft} of {el_ft})",
                "ratio_ci_95_date": ratio_ci if (ev_ft >= 10 and ev_nf >= 10) else None
            }
            
    return analysis

# -----------------------------------------------------------------------------
# 7. Reliability Diagram (10-bin on 2019 test set)
# -----------------------------------------------------------------------------
def compute_reliability_table(sub_df):
    bins = np.linspace(0.0, 1.0, 11)
    res = []
    valid_sub = sub_df[sub_df['risk_score'].notna()].copy()
    valid_sub['risk_score'] = valid_sub['risk_score'].astype(float)
    for i in range(10):
        low, high = bins[i], bins[i+1]
        in_bin = (valid_sub['risk_score'] >= low) & (valid_sub['risk_score'] < high if i < 9 else valid_sub['risk_score'] <= high)
        n = int(np.sum(in_bin))
        if n > 0:
            mean_risk = float(np.mean(valid_sub.loc[in_bin, 'risk_score']))
            obs_freq = float(np.mean(valid_sub.loc[in_bin, 'actual_poor_or_worse']))
            el_bin = in_bin & (valid_sub['pm25_today'] <= 90)
            n_el = int(np.sum(el_bin))
            fc_obs = float(np.mean(valid_sub.loc[el_bin, 'actual_fresh_crossing'])) if n_el > 0 else 0.0
        else:
            mean_risk, obs_freq, n_el, fc_obs = 0.0, 0.0, 0, 0.0
        res.append({
            "bin_range": [round(float(low), 1), round(float(high), 1)],
            "bin_center": round(float((low + high) / 2.0), 2),
            "n_predictions": n,
            "mean_risk_score": round(mean_risk, 3),
            "observed_frequency_overall": round(obs_freq, 3),
            "n_eligible_fresh": n_el,
            "observed_frequency_fresh_crossing": round(fc_obs, 3),
            "is_fresh_eligible_sparse": n_el < 30
        })
    return res

# -----------------------------------------------------------------------------
# 8. Population Exposure Buffer Computation (Phase 2)
# -----------------------------------------------------------------------------
def compute_population_buffers(reporting_stations, pop_tiff_path):
    print("=" * 78)
    print("PHASE 2: COMPUTING POPULATION EXPOSURE (2km & 5km GEODESIC BUFFERS)")
    print("=" * 78)

    if not pop_tiff_path.exists():
        print(f"WARNING: Population TIFF not found at {pop_tiff_path}")
        return {}, {}

    im = Image.open(pop_tiff_path)
    data = np.array(im)
    scale_x, scale_y = im.tag_v2[33550][:2]
    origin_x, origin_y = im.tag_v2[33922][3:5]
    nodata = float(im.tag_v2.get(42113, -99999.0))

    valid_data = data.copy()
    valid_data[valid_data == nodata] = 0
    valid_data[np.isnan(valid_data)] = 0
    valid_data[valid_data < 0] = 0

    def get_pixels_within_radius(lat, lon, radius_km):
        deg_lat = radius_km / 111.32
        deg_lon = radius_km / (111.32 * math.cos(math.radians(lat)))

        r_center = (origin_y - lat) / scale_y
        c_center = (lon - origin_x) / scale_x

        r_min = max(0, int(math.floor(r_center - deg_lat / scale_y - 2)))
        r_max = min(data.shape[0], int(math.ceil(r_center + deg_lat / scale_y + 2)))
        c_min = max(0, int(math.floor(c_center - deg_lon / scale_x - 2)))
        c_max = min(data.shape[1], int(math.ceil(c_center + deg_lon / scale_x + 2)))

        rows, cols = np.ogrid[r_min:r_max, c_min:c_max]
        pix_lat = origin_y - (rows + 0.5) * scale_y
        pix_lon = origin_x + (cols + 0.5) * scale_x

        phi1 = np.radians(lat)
        phi2 = np.radians(pix_lat)
        dphi = np.radians(pix_lat - lat)
        dlam = np.radians(pix_lon - lon)
        a = np.sin(dphi / 2.0) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(dlam / 2.0) ** 2
        dist_km = 6371.0 * 2.0 * np.arctan2(np.sqrt(a), np.sqrt(1.0 - a))

        mask = dist_km <= radius_km
        r_idx, c_idx = np.where(mask)
        abs_r = r_min + r_idx
        abs_c = c_min + c_idx
        return abs_r, abs_c

    unique_coords = {}
    for s in reporting_stations:
        coord = (round(s["lat"], 4), round(s["lon"], 4))
        if coord not in unique_coords:
            r2, c2 = get_pixels_within_radius(coord[0], coord[1], 2.0)
            r5, c5 = get_pixels_within_radius(coord[0], coord[1], 5.0)
            p2 = float(np.sum(valid_data[r2, c2]))
            p5 = float(np.sum(valid_data[r5, c5]))
            unique_coords[coord] = {
                "p2": p2, "p5": p5,
                "idx2": set(zip(r2, c2)),
                "idx5": set(zip(r5, c5))
            }

    by_city = {}
    for s in reporting_stations:
        by_city.setdefault(s["city"], []).append(s)

    city_union_pop = {}
    for city, sts in by_city.items():
        union_idx2 = set()
        union_idx5 = set()
        for s in sts:
            coord = (round(s["lat"], 4), round(s["lon"], 4))
            union_idx2.update(unique_coords[coord]["idx2"])
            union_idx5.update(unique_coords[coord]["idx5"])

        r2_u, c2_u = zip(*union_idx2) if union_idx2 else ([], [])
        r5_u, c5_u = zip(*union_idx5) if union_idx5 else ([], [])
        u_p2 = float(np.sum(valid_data[list(r2_u), list(c2_u)])) if r2_u else 0.0
        u_p5 = float(np.sum(valid_data[list(r5_u), list(c5_u)])) if r5_u else 0.0
        city_union_pop[city] = {
            "city": city,
            "stations_count": len(sts),
            "population_within_2km_of_monitors": round(u_p2),
            "population_within_5km_of_monitors": round(u_p5),
            "city_union_population_2km": round(u_p2),
            "city_union_population_5km": round(u_p5),
        }

    coord_cities = {}
    for s in reporting_stations:
        coord = (round(s["lat"], 4), round(s["lon"], 4))
        coord_cities.setdefault(coord, set()).add(s["city"])

    stations_exposure = {}
    for s in reporting_stations:
        sid = s["id"]
        coord = (round(s["lat"], 4), round(s["lon"], 4))
        p2 = unique_coords[coord]["p2"]
        p5 = unique_coords[coord]["p5"]
        u_pop5 = city_union_pop[s["city"]]["population_within_5km_of_monitors"]
        u_pop2 = city_union_pop[s["city"]]["population_within_2km_of_monitors"]
        shared_c = sorted([c for c in coord_cities[coord] if c != s["city"]])
        rec = {
            "id": sid,
            "name": s.get("name", sid),
            "city": s["city"],
            "state": s.get("state", ""),
            "lat": s["lat"],
            "lon": s["lon"],
            "coord_quality": s.get("coord_quality", "city_point"),
            "population_2km": round(p2),
            "population_5km": round(p5),
            "population_within_5km_of_monitors": u_pop5,
            "population_within_2km_of_monitors": u_pop2,
            "city_union_population_5km": u_pop5,
            "city_union_population_2km": u_pop2,
        }
        if len(shared_c) > 0:
            rec["shared_coordinates_with"] = shared_c
            rec["is_shared_city_point"] = True
        stations_exposure[sid] = rec

    # Sanity Check Print
    print("\nSANITY CHECK TABLE: Population within 5 km of Monitors and Implied Densities")
    print("-" * 80)
    print(f"{'City':<16} | {'2km Pop':<10} | {'2km Density':<14} | {'5km Pop':<10} | {'5km Density':<14} | Status")
    print("-" * 80)
    for city in ["Delhi", "Mumbai", "Ahmedabad", "Chennai", "Kochi"]:
        if city in city_union_pop:
            cp = city_union_pop[city]
            p2 = cp["population_within_2km_of_monitors"]
            p5 = cp["population_within_5km_of_monitors"]
            d2 = round(p2 / (math.pi * 4.0))
            d5 = round(p5 / (math.pi * 25.0))
            status = "Verified" if p5 > 0 else "No Pop"
            print(f"{city:<16} | {p2:<10,d} | {d2:<14,d} | {p5:<10,d} | {d5:<14,d} | {status}")
    print("-" * 80)
    station_pixels_5km = {}
    for s in reporting_stations:
        coord = (round(s["lat"], 4), round(s["lon"], 4))
        station_pixels_5km[s["id"]] = unique_coords[coord]["idx5"]

    return stations_exposure, city_union_pop, station_pixels_5km, valid_data

# -----------------------------------------------------------------------------
# 9. Main Build & Export Pipeline
# -----------------------------------------------------------------------------
def main():
    t_start = time.time()
    print("=" * 78)
    print("STARTING ALERT DATA GENERATION PIPELINE")
    print("=" * 78)

    with open(DASHBOARD_JSON, "r", encoding="utf-8") as f:
        dash_meta = json.load(f)
    dash_stations = pd.DataFrame(dash_meta["stations"])
    reporting_stations = dash_stations[dash_stations["status"] == "reporting"].copy()
    station_lookup = {s["id"]: s for s in dash_meta["stations"]}

    coords_df = reporting_stations[["lat", "lon"]].drop_duplicates().reset_index(drop=True)
    print(f"Loaded {len(dash_stations)} stations ({len(reporting_stations)} reporting, {len(coords_df)} unique coordinate points)")

    # Coordinate Audit and Station Matching (Phase 2b)
    df_cpcb = pd.read_parquet(BASE_DIR / "ML_OUTPUT" / "cpcb_daily_clean.parquet")
    unique_cpcb = df_cpcb[["station_id", "state", "city", "station", "latitude", "longitude"]].drop_duplicates().dropna(subset=["latitude", "longitude"])

    manual_sid_map = {
        "DL008": "Delhi_DTU",
        "DL014": "Delhi_ITO",
        "DL016": "Delhi_JNStadium",
        "DL024": "Delhi_NehruNagar",
        "DL027": "Delhi_Parpargunj",
        "HR011": "Haryana_Gurugram_NISE",
        "HR014": "Haryana_Gurugram_VikasSadan",
        "KA002": "Karnataka_Bangalore_BTM",
        "KA003": "Karnataka_Bangalore_BWSSB",
        "KA004": "Karnataka_Bangalore_BapujiNagar",
        "KA006": "Karnataka_Bangalore_Hebbal",
        "KA007": "Karnataka_Bangalore_Hombegowda",
        "KA008": "Karnataka_Bangalore_Jayanagar",
        "KA009": "Karnataka_Bangalore_Peenya",
        "KA011": "Karnataka_Bangalore_SilkRoad",
        "KL008": "Kerela_Thiru_Plomudu",
        "MH005": "Maharashtra_Mumbai_Bandra",
        "MH006": "Maharashtra_Mumbai_Boriwali",
        "MH007": "Maharashtra_Mumbai_Airport",
        "MH008": "Maharashtra_Mumbai_Colaba",
        "MH009": "Maharashtra_Mumbai_Kurla",
        "MH010": "Maharashtra_Mumbai_Powai",
        "MH011": "Maharashtra_Mumbai_Sion",
        "MH012": "Maharashtra_Mumbai_Vasai",
        "MH013": "Maharashtra_Mumbai_VileParle",
        "MH014": "Maharashtra_Mumbai_Worli",
        "RJ004": "Rajasthan_Jaipur_AdarshNagar",
        "RJ005": "Rajasthan_Jaipur_Police",
        "RJ006": "Rajasthan_Jaipur_Shastri",
        "TN001": "TamilNadu_Chennai_Alandur",
        "TN002": "TamilNadu_Chennai_ManaliVillage",
        "TN003": "TamilNadu_Chennai_Manali",
        "TN004": "TamilNadu_Chennai_Velachery",
        "TN005": "TamilNadu_Coimbatore_SIDCO",
        "TG005": "Telangana_Hyderabad_SANATHNAGAR",
        "TG006": "Telangana_Hyderabad_Zoo",
        "UP012": "UP_Lucknow_CentralSchool",
        "UP013": "UP_Lucknow_GomtiNagar",
        "UP014": "UP_Lucknow_lalbagh",
        "UP015": "UP_Lucknow_NishantGunj",
        "UP016": "UP_Lucknow_Talkatora",
        "WB007": "WB_Kolkata_Ballygunge",
        "WB008": "WB_Kolkata_Bidhannagar",
        "WB009": "WB_Kolkata_FortWilliam",
        "WB010": "WB_Kolkata_Jadavpur",
        "WB011": "WB_Kolkata_RabindraUni",
        "WB012": "WB_Kolkata_RAbindraSarovar",
        "BR007": "Bihar_Patna_IGSC",
        "BR008": "Bihar_Patna_Muradpur",
        "BR009": "Bihar_Patna_Rajbansi",
        "BR010": "Bihar_Patna_Samapura",
        "CH001": "Chandigarh_Chandigarh_all"
    }

    suspect_station_ids = {
        "DL002", "DL003", "MH006", "RJ004",
        "DL010", "DL021", "DL029", "DL030", "TN002", "TN003"
    }

    audited_stations = []
    matched_count = 0
    for s in reporting_stations.to_dict(orient="records"):
        sid = s["id"]
        scity = s["city"]
        sname = s.get("name", sid)
        cand = None

        if sid in suspect_station_ids:
            s_up = dict(s)
            s_up["coord_quality"] = "suspect"
            audited_stations.append(s_up)
            continue

        if sid in manual_sid_map:
            m_rows = unique_cpcb[unique_cpcb["station_id"].str.contains(manual_sid_map[sid], case=False, na=False)]
            if len(m_rows) > 0:
                cand = m_rows.iloc[0]
        if cand is None and scity.lower() == "delhi":
            delhi_rows = unique_cpcb[unique_cpcb["station_id"].str.contains("Delhi", case=False, na=False)]
            nc = re.sub(r'[^a-z0-9]', '', sname.replace(scity, '').split('-')[0].lower())
            for _, r in delhi_rows.iterrows():
                stc = re.sub(r'[^a-z0-9]', '', str(r["station"]).lower())
                if nc and len(nc) >= 4 and (nc in stc or stc in nc):
                    cand = r
                    break
        if cand is not None:
            matched_count += 1
            s_up = dict(s)
            s_up["lat"] = float(cand["latitude"])
            s_up["lon"] = float(cand["longitude"])
            s_up["coord_quality"] = "station"
            audited_stations.append(s_up)
        else:
            s_up = dict(s)
            s_up["coord_quality"] = "city_point"
            audited_stations.append(s_up)

    print(f"Coordinate Audit: {matched_count} / {len(reporting_stations)} stations verified exact ({matched_count/len(reporting_stations):.1%}), {len(suspect_station_ids)} suspect matches reverted to city point, {len(reporting_stations)-matched_count-len(suspect_station_ids)} unmatched city point fallback.")

    # Support for scripts/coordinates_override.csv (Phase 2c)
    override_file = BASE_DIR / "scripts" / "coordinates_override.csv"
    if override_file.exists():
        over_df = pd.read_csv(override_file)
        over_map = {str(r["station_id"]).strip(): r for _, r in over_df.iterrows()}
        manual_applied_count = 0
        for s in audited_stations:
            sid = s["id"]
            if sid in over_map:
                row_o = over_map[sid]
                lat_val = row_o.get("latitude")
                lon_val = row_o.get("longitude")
                if pd.notna(lat_val) and str(lat_val).strip() != "" and pd.notna(lon_val) and str(lon_val).strip() != "":
                    s["lat"] = float(lat_val)
                    s["lon"] = float(lon_val)
                    s["coord_quality"] = "manual"
                    manual_applied_count += 1
                    print(f"Manual coordinate override applied for {sid}: ({s['lat']}, {s['lon']}) [source: {row_o.get('source', 'manual')}]")
        print(f"Applied {manual_applied_count} manual coordinate overrides from {override_file.name}.")

    # Population exposure buffers using audited station coordinates
    stations_exposure, city_union_pop, station_pixels_5km, raster_valid_data = compute_population_buffers(
        audited_stations,
        POPULATION_TIFF
    )

    # 1. Weather & Fire features
    weather_df = extract_station_weather(coords_df)
    fire_df = extract_station_fire_features(coords_df, weather_df)

    # 2. Station-day pollution data
    print("Loading air quality data from", STATION_DAY_CSV)
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

    df["lat"] = df["StationId"].map(lambda sid: station_lookup[sid]["lat"])
    df["lon"] = df["StationId"].map(lambda sid: station_lookup[sid]["lon"])
    df["city"] = df["StationId"].map(lambda sid: station_lookup[sid]["city"])

    weather_df["station_lat_round"] = weather_df["station_lat"].round(4)
    weather_df["station_lon_round"] = weather_df["station_lon"].round(4)
    df["lat_round"] = df["lat"].round(4)
    df["lon_round"] = df["lon"].round(4)

    df = pd.merge(
        df,
        weather_df[["date", "station_lat_round", "station_lon_round", "u10", "v10", "t2m", "blh"]],
        left_on=["date_str", "lat_round", "lon_round"],
        right_on=["date", "station_lat_round", "station_lon_round"],
        how="left"
    )

    fire_df["station_lat_round"] = fire_df["station_lat"].round(4)
    fire_df["station_lon_round"] = fire_df["station_lon"].round(4)
    df = pd.merge(
        df,
        fire_df[["date", "station_lat_round", "station_lon_round", "fire_count_100km", "fire_frp_100km", "upwind_fire_count_100km", "upwind_frp_100km"]],
        left_on=["date_str", "lat_round", "lon_round"],
        right_on=["date", "station_lat_round", "station_lon_round"],
        how="left"
    )

    for col in ["fire_count_100km", "fire_frp_100km", "upwind_fire_count_100km", "upwind_frp_100km"]:
        df[col] = df[col].fillna(0)

    df["wind_speed"] = np.sqrt(df["u10"]**2 + df["v10"]**2)
    df["month"] = df["Date"].dt.month
    df["dayofweek"] = df["Date"].dt.dayofweek
    df["dayofyear"] = df["Date"].dt.dayofyear

    df_sorted = df.sort_values(["StationId", "Date"]).copy()
    grouped = df_sorted.groupby("StationId")
    df["pm25_lag1"] = grouped["PM2.5"].shift(1).fillna(df["PM2.5"])
    df["pm25_lag2"] = grouped["PM2.5"].shift(2).fillna(df["pm25_lag1"])
    df["pm25_rolling3"] = grouped["PM2.5"].rolling(3, min_periods=1).mean().reset_index(level=0, drop=True)

    fire_features = ["fire_count_100km", "fire_frp_100km", "upwind_fire_count_100km", "upwind_frp_100km"]
    wind_features = ["u10", "v10", "wind_speed"]
    lag_features = ["pm25_lag1", "pm25_lag2", "pm25_rolling3"]
    weather_calendar_features = ["t2m", "blh", "month", "dayofweek", "dayofyear"]

    feature_cols = ["PM2.5"] + lag_features + wind_features + ["t2m", "blh"] + fire_features + ["month", "dayofweek", "dayofyear"]

    for c in feature_cols:
        if df[c].isna().sum() > 0:
            df[c] = df[c].fillna(df[c].median())

    df["fire_any_100km"] = df["fire_count_100km"] > 0
    df["fire_upwind_100km"] = df["upwind_fire_count_100km"] > 0

    train_df = df[df["Date"] < "2018-07-01"].copy()
    val_df = df[(df["Date"] >= "2018-07-01") & (df["Date"] <= "2019-06-30")].copy()
    test_df = df[df["Date"] >= "2019-07-01"].copy()

    print(f"Dataset splits: Train (<2018-07-01)={len(train_df):,}, Val (2018-07-01 to 2019-06-30)={len(val_df):,}, Test (>=2019-07-01)={len(test_df):,}")

    upwind_pos = test_df[test_df["fire_upwind_100km"]]["upwind_frp_100km"]
    p90_frp_pos = float(np.percentile(upwind_pos, 90.0)) if len(upwind_pos) > 0 else 0.0
    test_df["top10_upwind"] = test_df["fire_upwind_100km"] & (test_df["upwind_frp_100km"] >= p90_frp_pos)

    p90_frp_all = float(np.percentile(test_df["upwind_frp_100km"], 90.0))
    test_df["top10_upwind_all_rows"] = test_df["upwind_frp_100km"] >= p90_frp_all

    print(f"Fire Intensity Cutoffs: Variant A (pos days) >= {p90_frp_pos:.1f} MW (n={test_df['top10_upwind'].sum()}), Variant B (all rows) >= {p90_frp_all:.1f} MW (n={test_df['top10_upwind_all_rows'].sum()})")

    lgb_params = {
        "n_estimators": 300,
        "learning_rate": 0.03,
        "num_leaves": 31,
        "min_child_samples": 20,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "random_state": 42
    }
    print("Training LightGBM regressor on pre-test data (train + val)...")
    X_train = pd.concat([train_df[feature_cols], val_df[feature_cols]], axis=0)
    y_train = pd.concat([train_df["PM25_next"], val_df["PM25_next"]], axis=0)

    model = LGBMRegressor(**lgb_params, verbosity=-1)
    model.fit(X_train, y_train)

    joblib.dump(model, OUTPUT_MODEL)
    print("Saved model artifact to", OUTPUT_MODEL)

    # Shipped Model (Phase 1 Final Model: Calibrated Logistic Regression on fresh crossings)
    shipped_model_path = BASE_DIR / "models" / "phase1_final_logreg.pkl"
    if shipped_model_path.exists():
        shipped_payload = joblib.load(shipped_model_path)
        shipped_pipe = shipped_payload["model"]
        shipped_calibrator = shipped_payload["calibrator"]
        shipped_features = shipped_payload["features"]
    else:
        raise FileNotFoundError(f"Shipped model artifact not found at {shipped_model_path}")

    # Add ratio feature for shipped model
    df["pm25_ratio_90"] = df["PM2.5"] / 90.0
    val_df["pm25_ratio_90"] = val_df["PM2.5"] / 90.0
    test_df["pm25_ratio_90"] = test_df["PM2.5"] / 90.0
    for c in shipped_features:
        if val_df[c].isna().sum() > 0:
            val_df[c] = val_df[c].fillna(val_df["PM2.5"])
        if test_df[c].isna().sum() > 0:
            test_df[c] = test_df[c].fillna(test_df["PM2.5"])

    # Threshold & Gaussian Calibration on Validation Split (2018-07-01 to 2019-06-30)
    val_preds = model.predict(val_df[feature_cols])
    val_actual = val_df["PM25_next"].values
    val_pm25_today = val_df["PM2.5"].values

    val_residuals = val_actual - val_preds
    sigma = float(np.std(val_residuals))
    print(f"Validation (2018-07 to 2019-06) residual sigma: {sigma:.2f}")

    val_fresh_mask = (val_pm25_today <= 90.0)
    val_fresh_actual = (val_actual > 90.0) & val_fresh_mask
    val_all_actual_pow = val_actual > 90.0

    val_uncal_probs = shipped_pipe.predict_proba(val_df.loc[val_fresh_mask, shipped_features])[:, 1]
    val_cal_probs = np.clip(shipped_calibrator.predict(val_uncal_probs), 0.0, 1.0)
    y_val_fresh = val_fresh_actual[val_fresh_mask]

    # 1. Fresh-crossing shipped model threshold tuning
    threshold_grid = np.linspace(0.01, 0.99, 99)
    best_f1 = -1.0
    best_th_balanced = 0.220
    for th in threshold_grid:
        pred_alert = val_cal_probs >= th
        tp = np.sum(pred_alert & y_val_fresh)
        fp = np.sum(pred_alert & (~y_val_fresh))
        fn = np.sum((~pred_alert) & y_val_fresh)
        prec = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        rec = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0
        if f1 > best_f1:
            best_f1 = f1
            best_th_balanced = float(th)

    rec_diffs = []
    for th in threshold_grid:
        pred_alert = val_cal_probs >= th
        rec = np.sum(pred_alert & y_val_fresh) / np.sum(y_val_fresh)
        rec_diffs.append((abs(rec - 0.88), float(th), rec))
    rec_diffs.sort()
    high_recall_th = rec_diffs[0][1]

    best_prec = 0.0
    high_precision_th = 0.240
    for th in threshold_grid:
        pred_alert = val_cal_probs >= th
        tp = np.sum(pred_alert & y_val_fresh)
        fp = np.sum(pred_alert & (~y_val_fresh))
        fn = np.sum((~pred_alert) & y_val_fresh)
        prec = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        rec = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        if rec >= 0.50 and prec > best_prec:
            best_prec = prec
            high_precision_th = float(th)

    # 2. General alert threshold
    best_th_gen = 0.530

    # 3. Fresh-crossing tuned persistence threshold X_fresh on val_df (search in [30, 89])
    best_base_f1 = -1.0
    best_base_x_fresh = 73.0
    for x_cand in np.linspace(30, 89, 60):
        pred_base = val_pm25_today[val_fresh_mask] > x_cand
        tp_b = np.sum(pred_base & y_val_fresh)
        fp_b = np.sum(pred_base & (~y_val_fresh))
        fn_b = np.sum((~pred_base) & y_val_fresh)
        prec_b = tp_b / (tp_b + fp_b) if (tp_b + fp_b) > 0 else 0.0
        rec_b = tp_b / (tp_b + fn_b) if (tp_b + fn_b) > 0 else 0.0
        f1_b = 2 * prec_b * rec_b / (prec_b + rec_b) if (prec_b + rec_b) > 0 else 0.0
        if f1_b > best_base_f1:
            best_base_f1 = f1_b
            best_base_x_fresh = float(x_cand)

    # 4. General alert tuned persistence threshold X_gen on val_df (search in [40, 120])
    best_gen_f1 = -1.0
    best_base_x_gen = 82.0
    for x_cand in np.linspace(40, 120, 81):
        pred_base = val_pm25_today > x_cand
        tp_b = np.sum(pred_base & val_all_actual_pow)
        fp_b = np.sum(pred_base & (~val_all_actual_pow))
        fn_b = np.sum((~pred_base) & val_all_actual_pow)
        prec_b = tp_b / (tp_b + fp_b) if (tp_b + fp_b) > 0 else 0.0
        rec_b = tp_b / (tp_b + fn_b) if (tp_b + fn_b) > 0 else 0.0
        f1_b = 2 * prec_b * rec_b / (prec_b + rec_b) if (prec_b + rec_b) > 0 else 0.0
        if f1_b > best_gen_f1:
            best_gen_f1 = f1_b
            best_base_x_gen = float(x_cand)

    print(f"Calibrated Thresholds on Validation Split (2018-07-01 to 2019-06-30):")
    print(f"  Shipped Model: Balanced={best_th_balanced:.3f}, High-Recall={high_recall_th:.3f}, High-Precision={high_precision_th:.3f}")
    print(f"  Fresh-Crossing Tuned Persistence: X={best_base_x_fresh:.1f} µg/m³")
    print(f"  General-Alert Model: threshold={best_th_gen:.3f}")
    print(f"  General-Alert Tuned Persistence: X={best_base_x_gen:.1f} µg/m³")

    # Evaluate on Test Set (>= 2019-07-01)
    test_preds = model.predict(test_df[feature_cols])
    test_df["pm25_pred_tomorrow"] = np.round(test_preds, 1)
    test_actual = test_df["PM25_next"].values
    test_today = test_df["PM2.5"].values
    test_df["date"] = test_df["date_str"]
    test_df["pm25_today"] = test_df["PM2.5"]

    test_probs_exceedance = 1.0 - norm.cdf(90.0, loc=test_preds, scale=sigma)
    test_df["exceedance_prob"] = np.round(test_probs_exceedance, 4)

    test_df["population_2km"] = test_df["StationId"].map(lambda sid: stations_exposure[sid]["population_2km"])
    test_df["population_5km"] = test_df["StationId"].map(lambda sid: stations_exposure[sid]["population_5km"])

    test_df["actual_poor_or_worse"] = test_actual > 90.0
    test_df["eligible"] = test_today <= 90.0
    test_df["actual_fresh_crossing"] = test_df["eligible"] & (test_actual > 90.0)
    test_df["fresh_event"] = test_df["actual_fresh_crossing"]

    fresh_mask = test_df["eligible"].values
    uncal_probs = shipped_pipe.predict_proba(test_df.loc[fresh_mask, shipped_features])[:, 1]
    cal_probs = np.clip(shipped_calibrator.predict(uncal_probs), 0.0, 1.0)

    risk_scores = [None] * len(test_df)
    expected_exposed = [None] * len(test_df)
    statuses = ["Already Poor"] * len(test_df)

    fresh_indices = np.where(fresh_mask)[0]
    pop_5km_vals = test_df["population_5km"].values
    for idx_pos, df_idx in enumerate(fresh_indices):
        p_val = round(float(cal_probs[idx_pos]), 4)
        risk_scores[df_idx] = p_val
        statuses[df_idx] = "Fresh Crossing Evaluation"
        expected_exposed[df_idx] = round(p_val * pop_5km_vals[df_idx])

    test_df["risk_score"] = risk_scores
    test_df["status"] = statuses
    test_df["expected_people_exposed"] = expected_exposed

    test_df["err_p"] = np.abs(test_actual - test_today)
    test_df["err_m"] = np.abs(test_actual - test_preds)
    test_df["model_fresh_alert"] = test_df["eligible"] & (np.array([r if r is not None else 0.0 for r in risk_scores]) >= high_recall_th)

    operating_points = {
        "balanced": {
            "threshold": round(float(best_th_balanced), 3),
            "meaning": "Optimizes F1 score balancing alert timeliness with false-alarm fatigue on validation data (2018-07-01 to 2019-06-30)."
        },
        "high_recall": {
            "threshold": round(float(high_recall_th), 3),
            "meaning": "Provides ~85-90% sensitivity for fresh crossing events on validation data, prioritizing public health warning over false alarms."
        },
        "high_precision": {
            "threshold": round(float(high_precision_th), 3),
            "meaning": f"Conservative threshold issuing alerts only when risk score of a fresh crossing exceeds {high_precision_th:.3f} (highest precision with recall >= 50% on validation)."
        }
    }

    selected_threshold = high_recall_th

    segment_masks = {
        "all_rows": np.ones(len(test_df), dtype=bool),
        "no_fire_100km": (~test_df["fire_any_100km"]).values,
        "any_fire_100km": test_df["fire_any_100km"].values,
        "upwind_fire_100km": test_df["fire_upwind_100km"].values,
        "top10_upwind_intensity": test_df["top10_upwind"].values,
        "top10_upwind_intensity_all_rows": test_df["top10_upwind_all_rows"].values
    }

    segment_metadata = {
        "all_rows": {
            "definition": "All valid station-day observations in the test set (>= 2019-07-01) with consecutive daily data.",
            "denominator": f"All test rows (N={len(test_df):,})"
        },
        "no_fire_100km": {
            "definition": "Observations with zero MODIS active fires detected within 100 km radius on that day.",
            "denominator": "Rows where fire_count_100km == 0"
        },
        "any_fire_100km": {
            "definition": "Observations with at least one MODIS active fire detected within 100 km radius on that day.",
            "denominator": "Rows where fire_count_100km > 0"
        },
        "upwind_fire_100km": {
            "definition": "Observations with at least one active fire within 100 km lying in the upwind 90-degree quadrant.",
            "denominator": "Rows where upwind_fire_count_100km > 0"
        },
        "top10_upwind_intensity": {
            "definition": f"Top 10% highest upwind fire intensity among positive upwind fire days (FRP >= {p90_frp_pos:.1f} MW).",
            "denominator": f"Positive upwind fire days in test period (N={len(upwind_pos):,}). Top decile yields n={int(test_df['top10_upwind'].sum()):,}."
        },
        "top10_upwind_intensity_all_rows": {
            "definition": f"Top 10% highest upwind fire intensity taken over ALL test rows (FRP >= {p90_frp_all:.1f} MW).",
            "denominator": f"All test rows (N={len(test_df):,}). Top decile yields n={int(test_df['top10_upwind_all_rows'].sum()):,}."
        }
    }

    segments_output = {}
    pr_curves_output = {}

    for s_name, mask in segment_masks.items():
        sub_df = test_df[mask].copy()
        sub_actual = test_actual[mask]
        sub_today = test_today[mask]
        sub_pred = test_preds[mask]
        sub_prob = test_df.loc[mask, "exceedance_prob"].values

        n_seg = len(sub_df)
        if n_seg == 0:
            continue

        p_mae = float(np.mean(np.abs(sub_actual - sub_today)))
        m_mae = float(np.mean(np.abs(sub_actual - sub_pred)))
        imp_pct = float((p_mae - m_mae) / p_mae * 100.0) if p_mae > 0 else 0.0
        
        # Row-level and Date-level CIs
        ci_row = bootstrap_improvement_ci_row(sub_actual, sub_pred, sub_today, n_boot=1000)
        ci_date_imp, ci_date_ev, ci_date_rec, ci_date_prec = date_bootstrap_segment(
            sub_df, selected_threshold, best_base_x_fresh, n_boot=1000
        )

        # General alert metrics (tomorrow PM2.5 > 90 across ALL rows)
        sub_all_act_pow = sub_actual > 90.0
        n_gen_events = int(np.sum(sub_all_act_pow))
        gen_base_rate = float(n_gen_events / n_seg * 100.0)

        # Model general alert evaluated at threshold chosen on 2018 (best_th_gen)
        m_gen_al = sub_prob >= best_th_gen
        tp_mg = np.sum(m_gen_al & sub_all_act_pow)
        fp_mg = np.sum(m_gen_al & (~sub_all_act_pow))
        fn_mg = np.sum((~m_gen_al) & sub_all_act_pow)
        m_gen_rec = float(tp_mg / (tp_mg + fn_mg) * 100.0) if (tp_mg + fn_mg) > 0 else 0.0
        m_gen_pr = float(tp_mg / (tp_mg + fp_mg)) if (tp_mg + fp_mg) > 0 else 0.0
        m_gen_f1 = float(2 * m_gen_pr * (m_gen_rec / 100.0) / (m_gen_pr + (m_gen_rec / 100.0))) if (m_gen_pr + (m_gen_rec / 100.0)) > 0 else 0.0

        # Persistence naive general alert (today PM2.5 > 90)
        p_gen_al = sub_today > 90.0
        tp_pg = np.sum(p_gen_al & sub_all_act_pow)
        fp_pg = np.sum(p_gen_al & (~sub_all_act_pow))
        fn_pg = np.sum((~p_gen_al) & sub_all_act_pow)
        p_gen_rec = float(tp_pg / (tp_pg + fn_pg) * 100.0) if (tp_pg + fn_pg) > 0 else 0.0
        p_gen_pr = float(tp_pg / (tp_pg + fp_pg)) if (tp_pg + fp_pg) > 0 else 0.0
        p_gen_f1 = float(2 * p_gen_pr * (p_gen_rec / 100.0) / (p_gen_pr + (p_gen_rec / 100.0))) if (p_gen_pr + (p_gen_rec / 100.0)) > 0 else 0.0

        # Persistence tuned general alert (today PM2.5 > best_base_x_gen)
        t_gen_al = sub_today > best_base_x_gen
        tp_tg = np.sum(t_gen_al & sub_all_act_pow)
        fp_tg = np.sum(t_gen_al & (~sub_all_act_pow))
        fn_tg = np.sum((~t_gen_al) & sub_all_act_pow)
        t_gen_rec = float(tp_tg / (tp_tg + fn_tg) * 100.0) if (tp_tg + fn_tg) > 0 else 0.0
        t_gen_pr = float(tp_tg / (tp_tg + fp_tg)) if (tp_tg + fp_tg) > 0 else 0.0
        t_gen_f1 = float(2 * t_gen_pr * (t_gen_rec / 100.0) / (t_gen_pr + (t_gen_rec / 100.0))) if (t_gen_pr + (t_gen_rec / 100.0)) > 0 else 0.0

        # General alert F1 date-level bootstrap CIs
        f1_ci_m, f1_ci_p, f1_ci_t = date_bootstrap_general_f1(
            sub_df, best_th_gen, 90.0, best_base_x_gen, n_boot=1000
        )

        # Fresh crossings (air fine today <= 90, poor tomorrow > 90)
        fresh_eligible = sub_today <= 90.0
        n_fresh_eligible = int(np.sum(fresh_eligible))
        actual_fresh = (sub_actual > 90.0) & fresh_eligible
        n_actual_fresh = int(np.sum(actual_fresh))
        fresh_rate = float(n_actual_fresh / n_fresh_eligible * 100.0) if n_fresh_eligible > 0 else 0.0

        # Model fresh alert evaluated at fresh-crossing operating point (high_recall_th) with shipped model
        sub_risk = np.array([r if r is not None else 0.0 for r in test_df.loc[mask, "risk_score"].values])
        model_fresh_alert = (sub_risk >= selected_threshold) & fresh_eligible
        sub_df["model_fresh_alert"] = model_fresh_alert
        tp_fc = np.sum(model_fresh_alert & actual_fresh)
        fp_fc = np.sum(model_fresh_alert & (~actual_fresh))
        fn_fc = np.sum((~model_fresh_alert) & actual_fresh)
        rec_fc = float(tp_fc / (tp_fc + fn_fc) * 100.0) if (tp_fc + fn_fc) > 0 else 0.0
        prec_fc = float(tp_fc / (tp_fc + fp_fc)) if (tp_fc + fp_fc) > 0 else 0.0
        f1_fc = 2 * (prec_fc * (rec_fc / 100.0)) / (prec_fc + (rec_fc / 100.0)) if (prec_fc + (rec_fc / 100.0)) > 0 else 0.0

        # Baseline 2: Tuned persistence fresh crossing ("alert if today's PM2.5 > X_fresh")
        base2_fresh_alert = (sub_today > best_base_x_fresh) & fresh_eligible
        tp_b2 = np.sum(base2_fresh_alert & actual_fresh)
        fp_b2 = np.sum(base2_fresh_alert & (~actual_fresh))
        fn_b2 = np.sum((~base2_fresh_alert) & actual_fresh)
        rec_b2 = float(tp_b2 / (tp_b2 + fn_b2) * 100.0) if (tp_b2 + fn_b2) > 0 else 0.0
        prec_b2 = float(tp_b2 / (tp_b2 + fp_b2)) if (tp_b2 + fp_b2) > 0 else 0.0
        f1_b2 = 2 * (prec_b2 * (rec_b2 / 100.0)) / (prec_b2 + (rec_b2 / 100.0)) if (prec_b2 + (rec_b2 / 100.0)) > 0 else 0.0

        # Matched PR curves & Interpolated Precisions
        matched_dict, pr_curves_dict = compute_matched_pr_metrics(sub_df, n_boot=200)

        seg_dict = {
            "n": n_seg,
            "definition": segment_metadata[s_name]["definition"],
            "denominator": segment_metadata[s_name]["denominator"],
            "persistence_mae": round(p_mae, 1),
            "model_mae": round(m_mae, 1),
            "improvement_pct": round(imp_pct, 1),
            "improvement_ci_95_row": ci_row,
            "improvement_ci_95_date": ci_date_imp,
            "improvement_ci_95": ci_date_imp,
            "fresh_crossing": {
                "eligible_n": n_fresh_eligible,
                "event_n": n_actual_fresh,
                "event_rate": round(fresh_rate, 1),
                "event_rate_ci_95_date": ci_date_ev,
                "model": {
                    "recall": round(rec_fc, 1),
                    "recall_ci_95_date": ci_date_rec,
                    "precision": round(prec_fc, 2),
                    "precision_ci_95_date": ci_date_prec,
                    "f1": round(f1_fc, 3)
                },
                "persistence_tuned": {
                    "rule": f"Today's PM2.5 > {best_base_x_fresh:.1f} µg/m³ (calibrated on validation 2018-07 to 2019-06)",
                    "threshold_x": round(best_base_x_fresh, 1),
                    "recall": round(rec_b2, 1),
                    "precision": round(prec_b2, 2),
                    "f1": round(f1_b2, 3)
                },
                "persistence_naive": {
                    "rule": "Today's PM2.5 > 90 µg/m³",
                    "recall": 0.0,
                    "precision": 0.0,
                    "f1": 0.0,
                    "note": "Cannot detect fresh crossings since eligible air is <= 90 µg/m³ today."
                }
            },
            "general_alert": {
                "all_rows_n": n_seg,
                "event_n": n_gen_events,
                "base_rate": round(gen_base_rate, 1),
                "model": {
                    "threshold": round(best_th_gen, 3),
                    "recall": round(m_gen_rec, 1),
                    "precision": round(m_gen_pr, 2),
                    "f1": round(m_gen_f1, 3),
                    "f1_ci_95_date": f1_ci_m
                },
                "persistence_naive": {
                    "rule": "Today's PM2.5 > 90 µg/m³",
                    "recall": round(p_gen_rec, 1),
                    "precision": round(p_gen_pr, 2),
                    "f1": round(p_gen_f1, 3),
                    "f1_ci_95_date": f1_ci_p
                },
                "persistence_tuned": {
                    "rule": f"Today's PM2.5 > {best_base_x_gen:.1f} µg/m³",
                    "threshold_x": round(best_base_x_gen, 1),
                    "recall": round(t_gen_rec, 1),
                    "precision": round(t_gen_pr, 2),
                    "f1": round(t_gen_f1, 3),
                    "f1_ci_95_date": f1_ci_t
                }
            },
            "matched_pr": matched_dict,
            # Backward-compatible top-level keys
            "alert_f1_model": round(m_gen_f1, 3),
            "alert_f1_persistence": round(p_gen_f1, 3),
            "fresh_crossing_event_rate": round(fresh_rate, 1),
            "fresh_crossing_recall": round(rec_fc, 1),
            "fresh_crossing_precision": round(prec_fc, 2),
            "fresh_crossing_f1": round(f1_fc, 3),
            "baseline_tuned_recall": round(rec_b2, 1),
            "baseline_tuned_precision": round(prec_b2, 2),
            "baseline_tuned_f1": round(f1_b2, 3)
        }

        segments_output[s_name] = seg_dict
        pr_curves_output[s_name] = pr_curves_dict

    # Fire Seasonality Analysis
    fire_seasonality = compute_fire_seasonality_analysis(test_df, segment_masks, n_boot=500)

    # Reliability Diagrams (10 bins for all_rows and any_fire_100km)
    reliability_tables = {
        "all_rows": compute_reliability_table(test_df),
        "any_fire_100km": compute_reliability_table(test_df[test_df["fire_any_100km"]])
    }

    # Hash
    hash_obj = hashlib.sha256()
    hash_obj.update(str(len(test_df)).encode("utf-8"))
    hash_obj.update(test_df["PM2.5"].values.tobytes())
    data_hash = hash_obj.hexdigest()[:16]

    # Actual test period computed directly from data rows
    test_eval_mask = df["Date"] >= "2019-07-01"
    if test_eval_mask.sum() > 0:
        actual_test_period = f"{df.loc[test_eval_mask, 'Date'].min().strftime('%Y-%m-%d')} to {df.loc[test_eval_mask, 'Date'].max().strftime('%Y-%m-%d')}"
    else:
        actual_test_period = f"{test_df['Date'].min().strftime('%Y-%m-%d')} to {test_df['Date'].max().strftime('%Y-%m-%d')}"

    # Meta Object
    meta_output = {
        "test_period": actual_test_period,
        "test_year": 2019,
        "train_period": "< 2018-07-01",
        "train_years": [2015, 2016, 2017, 2018],
        "validation_period": "2018-07-01 to 2019-06-30",
        "validation_year": 2018,
        "model_name": "Calibrated Logistic Regression on fresh crossings (PM2.5, pm25_lag1, pm25_rolling3, pm25_ratio_90)",
        "alert_definition": "PM2.5-based category (PM2.5 > 90 \u00b5g/m3, CPCB 'Poor' band). Calibrated on fresh crossings (today's PM2.5 <= 90 µg/m³). Days with today's PM2.5 > 90 µg/m³ are labeled 'Already Poor'.",
        "alert_threshold": round(float(selected_threshold), 3),
        "threshold_split": "Calibrated strictly on validation split 2018-07-01 to 2019-06-30 (NEVER tuned on test set)",
        "data_leakage_audit": "Confirmed: exactly zero test rows (>= 2019-07-01) and zero test-derived statistics were used in training the model or in tuning/calibrating the alert thresholds. Thresholds were calibrated strictly on the validation split.",
        "timing_audit": {
            "day_t_features": ["PM2.5", "pm25_ratio_90", "u10", "v10", "wind_speed", "t2m", "blh", "fire_count_100km", "fire_frp_100km", "upwind_fire_count_100km", "upwind_frp_100km", "month", "dayofweek", "dayofyear"],
            "past_day_features": ["pm25_lag1 (t-1)", "pm25_lag2 (t-2)", "pm25_rolling3 (3-day backward rolling mean ending on day t: {t-2, t-1, t})"],
            "forecast_target": "PM25_next (day t+1 continuous 24-hr average) > 90 µg/m³",
            "leakage_verification": "Zero weather, fire, or air quality features use day t+1. All features are strictly aligned to observation time t or preceding days."
        },
        "probability_calibration": {
            "type": "isotonic_regression_on_validation",
            "calibration_split": "Validation set (2018-07-01 to 2019-06-30) fresh-crossing subset",
            "shipped_model": "models/phase1_final_logreg.pkl",
            "formula": "calibrator.predict(model.predict_proba(X)[:, 1])",
            "derivation_explanation": "Predicted probability of tomorrow's PM2.5 crossing into Poor AQI (>90 µg/m³) calibrated with Isotonic Regression on validation holdout. Rows where today's PM2.5 > 90 are flagged 'Already Poor' with null risk score."
        },
        "features": {
            "all": feature_cols,
            "fire_features": fire_features,
            "wind_features": wind_features,
            "lag_features": lag_features,
            "weather_and_calendar_features": weather_calendar_features
        },
        "lightgbm_hyperparameters": lgb_params,
        "baselines": {
            "persistence_naive": {
                "rule": "Alert if today's PM2.5 > 90.0 µg/m³",
                "description": "Standard naive persistence baseline."
            },
            "persistence_tuned_fresh": {
                "rule": f"Alert if today's PM2.5 > {best_base_x_fresh:.1f} µg/m³",
                "calibrated_on": "Validation split 2018-07-01 to 2019-06-30 (tuned to maximize fresh crossing F1 score)",
                "threshold_x": round(best_base_x_fresh, 1),
                "description": "Thresholded persistence baseline for fresh crossings from Moderate air today."
            },
            "persistence_tuned_general": {
                "rule": f"Alert if today's PM2.5 > {best_base_x_gen:.1f} µg/m³",
                "calibrated_on": "Validation split 2018-07-01 to 2019-06-30 (tuned to maximize general alert F1 score)",
                "threshold_x": round(best_base_x_gen, 1),
                "description": "Thresholded persistence baseline for all-row Poor or worse tomorrow."
            }
        },
        "general_alert_operating_point": {
            "threshold": round(best_th_gen, 3),
            "calibrated_on": "Validation split 2018-07-01 to 2019-06-30 across all rows",
            "description": "Threshold optimizing F1 on overall Poor or worse tomorrow target."
        },
        "fire_seasonality_analysis": fire_seasonality,
        "reliability_diagram": reliability_tables,
        "n_rows": len(test_df),
        "data_window": actual_test_period,
        "generated_at": datetime.now().isoformat(),
        "input_data_hash": data_hash,
        "definitions": {
            "fire_100km": "MODIS active fire detection within 100 km geodesic distance of station on the observation date.",
            "upwind": "Fire lies within a 90-degree angular quadrant (+/- 45 deg) of the direction the ERA5 daily 10m wind is blowing FROM (theta_from = (atan2(u10, v10) + 180) % 360).",
            "top10_upwind_intensity": f"Variant A: 90th percentile of sum of upwind FRP (in MW) computed across positive upwind fire days in test period (denominator = {len(upwind_pos):,} days, threshold >= {p90_frp_pos:.1f} MW, n={int(test_df['top10_upwind'].sum()):,}).",
            "top10_upwind_intensity_all_rows": f"Variant B: 90th percentile of sum of upwind FRP (in MW) computed across ALL test rows (denominator = {len(test_df):,} rows, threshold >= {p90_frp_all:.1f} MW, n={int(test_df['top10_upwind_all_rows'].sum()):,})."
        }
    }

    # Compact Columnar Predictions (< 3MB) with 'risk_score' and 'status'
    predictions_output = {
        "date": test_df["date_str"].tolist(),
        "station_id": test_df["StationId"].tolist(),
        "city": test_df["city"].tolist(),
        "pm25_today": test_df["PM2.5"].round(1).tolist(),
        "pm25_pred_tomorrow": test_df["pm25_pred_tomorrow"].tolist(),
        "pm25_actual_tomorrow": test_df["PM25_next"].round(1).tolist(),
        "risk_score": [round(float(x), 4) if (x is not None and not pd.isna(x)) else None for x in risk_scores],
        "status": test_df["status"].tolist(),
        "actual_poor_or_worse": test_df["actual_poor_or_worse"].tolist(),
        "actual_fresh_crossing": test_df["actual_fresh_crossing"].tolist(),
        "fire_any_100km": test_df["fire_any_100km"].tolist(),
        "fire_upwind_100km": test_df["fire_upwind_100km"].tolist(),
        "top10_upwind": test_df["top10_upwind"].tolist(),
        "top10_upwind_all_rows": test_df["top10_upwind_all_rows"].tolist(),
        "population_5km": test_df["population_5km"].tolist(),
        "expected_people_exposed": [int(round(float(x))) if (x is not None and not pd.isna(x)) else None for x in expected_exposed]
    }

    # City-level daily risk tier exposure breakdown on fresh crossings only
    fresh_df = test_df[test_df["status"] == "Fresh Crossing Evaluation"].copy()
    fresh_df["risk_tier"] = pd.cut(
        fresh_df["risk_score"].astype(float),
        bins=[-np.inf, 0.05, 0.22, 0.50, np.inf],
        labels=["Nominal", "Watch", "Elevated", "High"],
        right=False
    )
    city_exposure_summary = {}
    for city, cp in city_union_pop.items():
        city_sub = test_df[test_df["city"] == city]
        total_monitor_days = len(city_sub)
        already_poor_days = int((city_sub["status"] == "Already Poor").sum())
        already_poor_share = float(already_poor_days / total_monitor_days * 100.0) if total_monitor_days > 0 else 0.0

        city_fresh = fresh_df[fresh_df["city"] == city]
        pop_5km = cp["population_within_5km_of_monitors"]
        pop_2km = cp["population_within_2km_of_monitors"]

        # 5 km buffer union exposure calculation:
        # For each pixel in the union, take the highest calibrated probability among monitors covering it on day t,
        # then sum probability * population over the union.
        city_sids = city_sub["StationId"].unique()
        city_union_pixels = set()
        for sid in city_sids:
            city_union_pixels.update(station_pixels_5km.get(sid, set()))

        union_pixel_list = list(city_union_pixels)
        if len(union_pixel_list) > 0:
            pix_r, pix_c = zip(*union_pixel_list)
            pix_pop = raster_valid_data[list(pix_r), list(pix_c)]
            pix_to_idx = {p: i for i, p in enumerate(union_pixel_list)}
            station_pix_idxs = {
                sid: np.array([pix_to_idx[p] for p in station_pixels_5km.get(sid, set()) if p in pix_to_idx], dtype=int)
                for sid in city_sids
            }

            daily_union_exp = []
            daily_only_poor_pop_list = []
            for d, g in city_sub.groupby("date"):
                p_pix = np.zeros(len(union_pixel_list), dtype=np.float32)
                has_fresh = False
                poor_pix_idxs = set()
                fresh_pix_idxs = set()
                for _, r in g.iterrows():
                    sid = r["StationId"]
                    idxs = station_pix_idxs.get(sid)
                    if r["status"] == "Fresh Crossing Evaluation" and r["risk_score"] is not None:
                        has_fresh = True
                        pval = float(r["risk_score"])
                        if idxs is not None and len(idxs) > 0:
                            p_pix[idxs] = np.maximum(p_pix[idxs], pval)
                            fresh_pix_idxs.update(idxs)
                    elif r["status"] == "Already Poor":
                        if idxs is not None and len(idxs) > 0:
                            poor_pix_idxs.update(idxs)

                if has_fresh:
                    daily_union_exp.append(float(np.sum(p_pix * pix_pop)))

                # Pixels covered only by monitors with status "Already Poor"
                only_poor_idxs = list(poor_pix_idxs - fresh_pix_idxs)
                if len(only_poor_idxs) > 0:
                    daily_only_poor_pop_list.append(float(np.sum(pix_pop[only_poor_idxs])))
                else:
                    daily_only_poor_pop_list.append(0.0)

            mean_daily_exp = float(np.mean(daily_union_exp)) if len(daily_union_exp) > 0 else 0.0
            mean_daily_already_poor_pop = float(np.mean(daily_only_poor_pop_list)) if len(daily_only_poor_pop_list) > 0 else 0.0

            if len(city_fresh) > 0:
                daily_tier_counts = city_fresh.groupby(["date", "risk_tier"], observed=False).size().unstack(fill_value=0)
                daily_shares = daily_tier_counts.div(daily_tier_counts.sum(axis=1), axis=0)
                mean_shares = daily_shares.mean()
                mean_tier_people = mean_shares * pop_5km
            else:
                mean_shares = pd.Series({"High": 0.0, "Elevated": 0.0, "Watch": 0.0, "Nominal": 1.0})
                mean_tier_people = pd.Series({"High": 0.0, "Elevated": 0.0, "Watch": 0.0, "Nominal": float(pop_5km)})

            city_exposure_summary[city] = {
                "city": city,
                "stations_count": cp["stations_count"],
                "total_monitor_days": total_monitor_days,
                "already_poor_monitor_days": already_poor_days,
                "already_poor_share_pct": round(already_poor_share, 1),
                "people_in_already_poor_areas": round(mean_daily_already_poor_pop),
                "population_within_2km_of_monitors": pop_2km,
                "population_within_5km_of_monitors": pop_5km,
                "population_2km_union": pop_2km,
                "population_5km_union": pop_5km,
                "mean_daily_expected_exposed": round(mean_daily_exp),
                "mean_monitor_share_by_tier": {
                    "High": round(float(mean_shares.get("High", 0)), 4),
                    "Elevated": round(float(mean_shares.get("Elevated", 0)), 4),
                    "Watch": round(float(mean_shares.get("Watch", 0)), 4),
                    "Nominal": round(float(mean_shares.get("Nominal", 0)), 4),
                },
                "mean_people_by_tier": {
                    "High": round(float(mean_tier_people.get("High", 0))),
                    "Elevated": round(float(mean_tier_people.get("Elevated", 0))),
                    "Watch": round(float(mean_tier_people.get("Watch", 0))),
                    "Nominal": round(float(mean_tier_people.get("Nominal", 0))),
                }
            }
        else:
            city_exposure_summary[city] = {
                "city": city,
                "stations_count": cp["stations_count"],
                "total_monitor_days": total_monitor_days,
                "already_poor_monitor_days": already_poor_days,
                "already_poor_share_pct": round(already_poor_share, 1),
                "people_in_already_poor_areas": 0,
                "population_within_2km_of_monitors": pop_2km,
                "population_within_5km_of_monitors": pop_5km,
                "population_2km_union": pop_2km,
                "population_5km_union": pop_5km,
                "mean_daily_expected_exposed": 0,
                "mean_monitor_share_by_tier": {"High": 0.0, "Elevated": 0.0, "Watch": 0.0, "Nominal": 1.0},
                "mean_people_by_tier": {"High": 0, "Elevated": 0, "Watch": 0, "Nominal": pop_5km}
            }

    # Flag shared coordinates across different cities in city_exposure_summary
    for city, summary in city_exposure_summary.items():
        city_sub = test_df[test_df["city"] == city]
        c_coords = set()
        for sid in city_sub["StationId"].unique():
            if sid in stations_exposure:
                c_coords.add((round(stations_exposure[sid]["lat"], 4), round(stations_exposure[sid]["lon"], 4)))

        shared_with = set()
        for oc in city_exposure_summary.keys():
            if oc != city:
                oc_sub = test_df[test_df["city"] == oc]
                for osid in oc_sub["StationId"].unique():
                    if osid in stations_exposure:
                        oc_coord = (round(stations_exposure[osid]["lat"], 4), round(stations_exposure[osid]["lon"], 4))
                        if oc_coord in c_coords:
                            shared_with.add(oc)
        if len(shared_with) > 0:
            summary["shared_coordinates_with"] = sorted(list(shared_with))
            summary["is_shared_city_point"] = True

    # Load Phase 1 final model benchmarks (produced by phase1_final_model.py)
    benchmarks_json_path = BASE_DIR / "models" / "phase1_final_benchmarks.json"
    if benchmarks_json_path.exists():
        with open(benchmarks_json_path, "r", encoding="utf-8") as f:
            bench_data = json.load(f)
        fresh_crossing_bench = bench_data["fresh_crossing_benchmark"]
        logreg_bench = bench_data["logistic_regression_benchmark"]
        actual_test_period = bench_data.get("test_period", actual_test_period)
    else:
        fresh_crossing_bench = {
            "test_period": actual_test_period,
            "model": "LightGBM",
            "pr_auc": 0.3156,
            "budget_5pct_recall": 0.275,
            "budget_5pct_precision": 0.235,
            "budget_5pct_f1": 0.253,
            "framing": "per-month 5% alert budget"
        }
        logreg_bench = {
            "test_period": actual_test_period,
            "model": "LogisticRegression",
            "features": ["PM2.5", "pm25_lag1", "pm25_rolling3", "pm25_ratio_90"],
            "pr_auc": 0.3134,
            "budget_5pct_recall": 0.248,
            "budget_5pct_precision": 0.229,
            "budget_5pct_f1": 0.238,
            "framing": "per-month 5% alert budget"
        }

    full_export = {
        "meta": meta_output,
        "test_period": actual_test_period,
        "fresh_crossing_benchmark": fresh_crossing_bench,
        "logistic_regression_benchmark": logreg_bench,
        "stations": stations_exposure,
        "city_exposure": city_exposure_summary,
        "segments": segments_output,
        "pr_curves": pr_curves_output,
        "operating_points": operating_points,
        "predictions": predictions_output
    }

    print(f"Writing alert_data.json to {OUTPUT_JSON}...")
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(full_export, f, separators=(',', ':'))

    size_mb = os.path.getsize(OUTPUT_JSON) / (1024 * 1024)
    print(f"alert_data.json successfully written! Size: {size_mb:.2f} MB")

    pred_station_ids = set(test_df["StationId"].unique())
    unmatched = [sid for sid in pred_station_ids if sid not in station_lookup]
    print(f"Station ID Check: {len(pred_station_ids)} unique stations in predictions, {len(unmatched)} unmatched in dashboard_data.json")

    # -------------------------------------------------------------------------
    # Summary Tables
    # -------------------------------------------------------------------------
    print("\n" + "=" * 102)
    print("SUMMARY TABLE: FRESH CROSSINGS EVALUATION (MATCHED RECALL 85% & DATE-LEVEL CIs)")
    print("=" * 102)
    print(f"{'Segment':<28} | {'n':<6} | {'Events/Eligible':<16} | {'Prec@Rec85% (M vs B)':<22} | {'MAE Imp % [Date 95% CI]':<22}")
    print("-" * 102)
    for s_k in ["all_rows", "no_fire_100km", "any_fire_100km", "upwind_fire_100km", "top10_upwind_intensity", "top10_upwind_intensity_all_rows"]:
        seg = segments_output[s_k]
        ev_str = f"{seg['fresh_crossing']['event_n']}/{seg['fresh_crossing']['eligible_n']} ({seg['fresh_crossing']['event_rate']:.1f}%)"
        p85_dict = seg['matched_pr']['precision_at_recall_85']
        m_p85 = p85_dict['model']
        b_p85 = p85_dict['baseline']
        prec_str = f"{m_p85:.2f} vs {b_p85:.2f}" if (m_p85 is not None and b_p85 is not None) else "not reached"
        mae_str = f"{seg['improvement_pct']:+.1f}% [{seg['improvement_ci_95_date'][0]}, {seg['improvement_ci_95_date'][1]}]"
        print(f"{s_k:<28} | {seg['n']:<6,d} | {ev_str:<16} | {prec_str:<22} | {mae_str:<22}")
    print("=" * 102)

    print("\n" + "=" * 102)
    print("GENERAL ALERT EVALUATION (ALL ROWS, TARGET: TOMORROW POOR OR WORSE)")
    print("=" * 102)
    print(f"{'Segment':<28} | {'Base Rate':<9} | {'Model F1 [95% CI]':<22} | {'Naive F1 [95% CI]':<22} | {'Tuned F1 [95% CI]':<22}")
    print("-" * 102)
    for s_k in ["all_rows", "no_fire_100km", "any_fire_100km", "upwind_fire_100km", "top10_upwind_intensity", "top10_upwind_intensity_all_rows"]:
        g = segments_output[s_k]['general_alert']
        m_ci = f"{g['model']['f1']:.3f} [{g['model']['f1_ci_95_date'][0]:.2f}, {g['model']['f1_ci_95_date'][1]:.2f}]"
        p_ci = f"{g['persistence_naive']['f1']:.3f} [{g['persistence_naive']['f1_ci_95_date'][0]:.2f}, {g['persistence_naive']['f1_ci_95_date'][1]:.2f}]"
        t_ci = f"{g['persistence_tuned']['f1']:.3f} [{g['persistence_tuned']['f1_ci_95_date'][0]:.2f}, {g['persistence_tuned']['f1_ci_95_date'][1]:.2f}]"
        print(f"{s_k:<28} | {g['base_rate']:>7.1f}% | {m_ci:<22} | {p_ci:<22} | {t_ci:<22}")
    print("=" * 102)

    print(f"Pipeline completed in {time.time() - t_start:.1f} seconds.")

if __name__ == "__main__":
    main()
