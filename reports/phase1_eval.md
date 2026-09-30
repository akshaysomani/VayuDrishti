# Phase 1 Final Evaluation Report: LightGBM Spike Classifier

**Project**: BRICS Air Quality Platform (Track 2)  
**Task**: Predict whether tomorrow's $\text{PM}_{2.5}$ crosses into the CPCB "Poor" AQI category ($> 90\,\mu\text{g}/\text{m}^3$)  
**Evaluation Date**: 2026-09-30  
**Model**: LightGBM Classifier (`class_weight='balanced'`, fixed `random_state=42`)  
**Threshold Calibration**: Calibrated strictly on the validation split ($2019\text{-}01\text{-}01$ to $2019\text{-}08\text{-}31$) to achieve maximum precision subject to $\text{recall} \ge 0.80$.  
**Chosen Threshold**: `0.601` (Validation Recall: `80.0%`, Validation Precision: `72.5%`)

---

## 1. Dataset Splits & Row Counts

| Split | Date Range | Total Rows | Spikes ($>90$) | Spike Share |
| :--- | :--- | :---: | :---: | :---: |
| **Train** | $< 2019-01-01$ | 37,779 | 13,554 | 35.9% |
| **Validation** | $2019-01-01$ to $2019-08-31$ | 18,700 | 4,134 | 22.1% |
| **Test** | $\ge 2019-09-01$ | 28,652 | 6,792 | 23.7% |
| *Test (Excl. Lockdown)* | Excl. $2020\text{-}03\text{-}01$ to $2020\text{-}06\text{-}30$ | 17,001 | 6,297 | 37.0% |
| *Lockdown Window* | $2020-03-01$ to $2020-06-30$ | 11,651 | 495 | 4.2% |

*Leakage Verification*: All features are computed strictly from day $t$ or prior ($t-1, t-2$). Lags (`pm25_lag1`, `pm25_lag2`) and 3-day backward rolling mean (`pm25_rolling3`) are computed strictly per station group.

---

## 2. Weather & Distance Audit (Data Quality Warning)

* **Distance to ERA5 Weather Grid Points**:
  * Weather features (`u10`, `v10`, `t2m`, `blh`) originate from 25 ERA5 coordinate cells.
  * For the 107 reporting stations evaluated in the primary dashboard pipeline, coordinates map **1-to-1** with the 25 weather grid points, resulting in **0.00% missing rows** for all meteorology and fire features.
  * **Critical Spatial Discrepancy Across Full 189 Stations**: When evaluating all 189 stations present in `ML_OUTPUT/training_dataset.parquet`, stations are geographically dispersed:
    * **Min Distance**: 0.11 km
    * **Median Distance**: 15.64 km
    * **Mean Distance**: 61.99 km
    * **Max Distance**: 393.47 km
    * **Stations within 5 km**: 36 / 188 (19.1%)
    * **Stations within 25 km**: 107 / 188 (56.9%)
    * **Stations > 50 km away**: **64 / 188 (34.0%)**
  * **Weakness Flag**: 34% of stations nationwide are $> 50$ km from their nearest ERA5 weather point (up to 393 km away). Any platform expansion to all 189 stations without fine-grained local weather will introduce substantial meteorological distortion.

---

## 3. Side-by-Side Test Set Performance

Decision threshold fixed at `th = 0.601` (calibrated on Validation ONLY).

### Full Test Period (2019-09-01 to 2020-06-30, N = 28,652)

| Model / Baseline | Recall | Precision | F1 Score | ROC-AUC | PR-AUC |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **LightGBM Classifier** | **87.2%** | **80.2%** | **0.835** | **0.9692** | **0.9188** |
| **Baseline 1: Naive Persistence** (`Today > 90`) | 82.9% | 82.9% | 0.829 | 0.9647 | 0.9019 |
| **Baseline 2: Strong Persistence** (`Today > 90` OR `Rolling3 > 90`) | 86.9% | 77.1% | 0.817 | 0.9615 | 0.8830 |

### Excluding COVID-19 Lockdown Period (Excluding 2020-03-01 to 2020-06-30, N = 17,001)

| Model / Baseline | Recall | Precision | F1 Score | ROC-AUC | PR-AUC |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **LightGBM Classifier** | **89.8%** | **83.5%** | **0.865** | **0.9638** | **0.9401** |
| **Baseline 1: Naive Persistence** (`Today > 90`) | 85.9% | 86.0% | 0.859 | 0.9583 | 0.9277 |
| **Baseline 2: Strong Persistence** (`Today > 90` OR `Rolling3 > 90`) | 89.7% | 80.3% | 0.848 | 0.9498 | 0.9066 |

### Fresh Crossing Sub-Problem (Today $\le 90\,\mu\text{g}/\text{m}^3$, N = 21,857, Spikes = 1,160)
* **LightGBM Performance**: ROC-AUC = `0.9064`, PR-AUC = `0.3801`, Recall = `30.8%`, Precision = `44.8%`, F1 = `0.365`.
* *Note on Benchmark Reconciliation*: This explains the historical "76% recall / 0.90 ROC-AUC" discrepancy: across ALL rows, raw PM2.5 autocorrelation yields an apparent ROC-AUC of 0.9647. It is specifically on **fresh crossing transitions** (predicting a spike out of clean air) where ROC-AUC is ~0.90 and precision drops steeply to 44.8%.

---

## 4. Test Set Breakdowns

| Segment | Total Rows | Spikes ($>90$) | Spike Rate | Recall | Precision |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Winter** (Dec, Jan, Feb) | 8,690 | 3,938 | 45.3% | 89.7% | 82.5% |
| **Pre-Monsoon** (Mar, Apr, May) | 8,738 | 450 | 5.1% | 56.4% | 43.6% |
| **Monsoon** (Jun, Jul, Aug, Sep) | 5,582 | 64 | 1.1% | 25.0% | 38.1% |
| **Post-Monsoon** (Oct, Nov) | 5,642 | 2,340 | 41.5% | 90.5% | 85.5% |
| **Fire-Affected Days** (`fire_count_100km > 0`) | 9,607 | 3,302 | 34.4% | 90.8% | 83.1% |
| **Non-Fire Days** (`fire_count_100km == 0`) | 19,045 | 3,490 | 18.3% | 83.7% | 77.3% |
| **10 Highest-Spike Stations** | 3,005 | 1,549 | 51.5% | 91.2% | 87.5% |
| **Remaining Stations** | 25,647 | 5,243 | 20.4% | 86.0% | 78.1% |
| **COVID Lockdown Window** ($2020\text{-}03\text{-}01$ to $2020\text{-}06\text{-}30$) | 11,651 | 495 | 4.2% | 54.1% | 43.3% |

---

## 5. Station-Level Recall Audit (Stations with Recall < 50%)

Out of **107 evaluated reporting stations** in the test set, **17 stations (15.9%)** exhibit recall **below 50%**:

| Station ID | City | Station Name | Total Days | Spike Days | Model Recall | Model Precision |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| `AP001` | Amaravati | Secretariat, Amaravati - APPCB | 263 | 1 | **0.0%** | 0.0% |
| `KA009` | Bengaluru | Peenya, Bengaluru - CPCB | 288 | 1 | **0.0%** | 0.0% |
| `KA008` | Bengaluru | Jayanagar 5th Block, Bengaluru - KSPCB | 289 | 1 | **0.0%** | 0.0% |
| `KA007` | Bengaluru | Hombegowda Nagar, Bengaluru - KSPCB | 268 | 1 | **0.0%** | 0.0% |
| `RJ004` | Jaipur | Adarsh Nagar, Jaipur - RSPCB | 304 | 1 | **0.0%** | 0.0% |
| `MH006` | Mumbai | Borivali East, Mumbai - MPCB | 221 | 1 | **0.0%** | 0.0% |
| `KL008` | Thiruvananthapuram | Plammoodu, Thiruvananthapuram - Kerala PCB | 296 | 1 | **0.0%** | 0.0% |
| `KL004` | Kochi | Vyttila, Kochi - Kerala PCB | 161 | 1 | **0.0%** | 0.0% |
| `KA003` | Bengaluru | BWSSB Kadabesanahalli, Bengaluru - CPCB | 268 | 12 | **16.7%** | 22.2% |
| `TN002` | Chennai | Manali Village, Chennai - TNPCB | 294 | 4 | **25.0%** | 25.0% |
| `KA002` | Bengaluru | BTM Layout, Bengaluru - CPCB | 289 | 6 | **33.3%** | 50.0% |
| `TN003` | Chennai | Manali, Chennai - CPCB | 261 | 14 | **35.7%** | 71.4% |
| `OD001` | Brajrajnagar | GM Office, Brajrajnagar - OSPCB | 254 | 27 | **40.7%** | 27.5% |
| `GJ001` | Ahmedabad | Maninagar, Ahmedabad - GPCB | 300 | 21 | **42.9%** | 45.0% |
| `AP005` | Visakhapatnam | GVM Corporation, Visakhapatnam - APPCB | 297 | 11 | **45.5%** | 50.0% |
| `WB010` | Kolkata | Jadavpur, Kolkata - WBPCB | 300 | 33 | **45.5%** | 40.5% |
| `TN001` | Chennai | Alandur Bus Depot, Chennai - CPCB | 304 | 13 | **46.2%** | 66.7% |

*Failure Mode*: These underperforming stations are predominantly in coastal or southern Indian cities (e.g. Visakhapatnam, Hyderabad, Chennai, Thiruvananthapuram) where background pollution is low, air is typically moderate, and spikes are isolated micro-events. Because the model relies heavily on regional persistence, it systematically fails to alert when clean coastal air abruptly spikes.

---

## 6. SHAP Feature Attribution Analysis

Top 10 features ranked by mean absolute SHAP value on the test set:

| Rank | Feature | Mean $|\text{SHAP}|$ | Feature Family | Interpretation |
| :---: | :--- | :---: | :---: | :--- |
| 1 | `PM2.5` | **1.8914** | Pollution / Autoregressive | Dominant driver |
| 2 | `pm25_rolling3` | **0.4667** | Pollution / Autoregressive | Dominant driver |
| 3 | `pm25_lag2` | **0.2683** | Pollution / Autoregressive | Dominant driver |
| 4 | `pm25_lag1` | **0.2077** | Pollution / Autoregressive | Dominant driver |
| 5 | `blh` | **0.1803** | Meteorology | Secondary modifier |
| 6 | `u10` | **0.1277** | Meteorology | Secondary modifier |
| 7 | `v10` | **0.1101** | Meteorology | Secondary modifier |
| 8 | `dayofyear` | **0.1032** | Calendar | Secondary modifier |
| 9 | `t2m` | **0.0824** | Meteorology | Secondary modifier |
| 10 | `dayofweek` | **0.0596** | Calendar | Secondary modifier |

### Plain-Words Verdict on Fire and Wind Drivers:
* **Wind & Meteorology Features**: Boundary layer height (`blh`, rank 5), zonal wind (`u10`, rank 6), and meridional wind (`v10`, rank 7) are secondary modifiers, capturing regional atmospheric stagnation, ventilation breakdown, and boundary-layer compression. Scalar `wind_speed` ranks 11th.
* **Fire Features**: **Fires are NOT among the primary drivers**. No fire feature appears in the top 10 features (`fire_frp_100km` ranks 12, `fire_count_100km` ranks 14, `upwind_frp_100km` ranks 15, and `upwind_fire_count_100km` ranks 16). The model is overwhelmingly driven by autoregressive inertia (`PM2.5`, `pm25_rolling3`, `pm25_lag2`, `pm25_lag1`) and seasonal calendar terms (`dayofyear`).

Plots saved:
* Bar plot: `reports/shap_bar.png`
* Summary plot: `reports/shap_summary.png`

---

## 7. One-Paragraph Final Verdict

**Is Phase 1 solid enough to move on?**  
**Verdict: Phase 1 is functionally usable as an operational persistence-smoothing filter, but it is NOT yet a true predictive fire-and-meteorology forecaster, and moving to Phase 2 requires acknowledging three major weaknesses:**  
First, the LightGBM classifier **barely outperforms the stronger persistence baseline**: on the full test set, the GBM achieves an F1 of **0.835** vs **0.817** for Strong Persistence (`Today > 90` OR `Rolling3 > 90`), delivering an F1 improvement of less than 0.018. Second, SHAP attribution reveals that active fire features (MODIS/VIIRS counts and upwind FRP) exert virtually negligible influence on predictions compared to lagged PM2.5 and boundary layer height, meaning the platform is not yet capturing true agricultural fire plume transport. Third, **17 stations (primarily in coastal and southern non-attainment cities) suffer recall below 50%**, failing precisely when clean air experiences sudden episodic spikes. Finally, 34% of stations across the wider 189-station network sit over 50 km from the nearest ERA5 weather cell, meaning spatial interpolation is currently too coarse for city-level federation. Phase 1 confirms that high ROC-AUC (~0.97 across all rows) is an artifact of high PM2.5 autocorrelation rather than genuine next-day forecasting power; Phase 2 must explicitly address fresh transition modeling and localized wind trajectory transport.
