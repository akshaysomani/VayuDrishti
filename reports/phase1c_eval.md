# Phase 1c Evaluation Report: Targeted Fire Test, Alert Budgets, & Risk Calibration

**Project**: BRICS Air Quality Platform (Track 2)  
**Task**: Fresh-Crossing Spike Classifier Cleanup & Operationalization  
**Evaluation Date**: 2026-09-30  

---

## 1. Targeted Fire Test: Indo-Gangetic Plain (IGP) Autumn Window

**Setup**:
* **Stations**: 53 reporting stations across Delhi, Punjab, Haryana, Uttar Pradesh, and Bihar.
* **Window**: Oct 1 to Nov 30 (peak agricultural burning season).
* **Dataset Subset**: Fresh crossings (today's $\text{PM}_{2.5} \le 90\,\mu\text{g}/\text{m}^3$).
* **Features Tested**:
  * Same-day fire: `fire_count_100km`, `fire_frp_100km`, `upwind_fire_count_100km`, `upwind_frp_100km`.
  * **Lagged fire per station**: `upwind_fire_count_100km_lag1`, `lag2`, `lag3`, `upwind_frp_100km_lag1`, `lag2`, `lag3`, plus 3-day rolling sums of count and FRP.

### Test Set Performance on IGP Autumn ($N = 798$, Spikes = $191$, Base Rate = $23.9%$)

| Model Setup | PR-AUC | ROC-AUC | Recall @ 15% Budget | Precision @ 15% Budget | F1 Score |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **With ALL Fire Features** (Same-Day + Lag 1-3 + Rolling3) | **0.5779** | **0.8205** | **39.3%** | **62.5%** | **0.482** |
| **Without Fire Features** (Meteorology + Autoregression only) | 0.6059 | 0.8209 | 40.3% | 64.2% | 0.495 |
| **Net Lift from Lagged Fire Features** | **-0.0280** | **-0.0004** | **-1.1%** | **-1.7%** | **-0.013** |

### Plain-Words Verdict on Targeted Fire Test:
**Does lagged upwind fire help on the IGP autumn subset?**  
**No.**  
Even when restricted specifically to the Indo-Gangetic Plain in October and November with 1-, 2-, and 3-day lagged upwind fire counts and cumulative FRP, fire features provide a net PR-AUC difference of **-0.0280** and a recall difference of **-1.1%** at a fixed 15% alert budget. Upwind radius counts do not capture the actual atmospheric plume transport dynamics into city stations.

---

## 2. Alert Budget Benchmark (Rank-Based per Month)

On the full fresh-crossing test set ($N = 26,998$, $1,200$ total spikes, base rate $4.44\%$), rows are ranked by predicted probability within each calendar month, allocating fixed monthly alert budgets (top 2%, 5%, and 10%):

| Monthly Alert Budget | Total Alerts Issued | LightGBM Recall | LightGBM Precision | LightGBM F1 | LogReg Recall | LogReg Precision | LogReg F1 |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Top 2% Budget** | 547 | **12.8%** | **28.0%** | **0.175** | 11.2% | 24.5% | 0.153 |
| **Top 5% Budget** | 1,355 | **27.2%** | **24.1%** | **0.255** | 25.5% | 22.6% | 0.239 |
| **Top 10% Budget** | 2,704 | **43.4%** | **19.3%** | **0.267** | 43.8% | 19.4% | 0.270 |

### Key Trade-Offs:
* At the **Top 5% Budget** (~1.5 alerts per station per month), LightGBM captures **27.2% of all fresh crossing spikes** with a precision of **24.1%** (F1: `0.255`).
* Logistic Regression achieves nearly identical performance at 5% budget (**25.5% recall, 22.6% precision**).
* Ranking within each month prevents seasonal base-rate shifts from overloading the system with false alarms in winter or issuing zero alerts in summer.

---

## 3. Probability Calibration & Reliability Analysis

* **Method**: Isotonic regression calibrated strictly on the 12-month annual validation set ($2018\text{-}07\text{-}01$ to $2019\text{-}06\text{-}30$).
* **Brier Score on Test Set**:
  * Raw LightGBM Probabilities: `0.0473`
  * Isotonic Calibrated Probabilities: **`0.0352`**
  * **Improvement**: **25.5% error reduction**.

### Can Calibrated Probabilities Be Shown to Users as "Risk %"?
**Yes.**  
Prior to calibration, raw tree probabilities were misaligned with empirical frequencies due to class weighting. After isotonic calibration, predicted probabilities closely track observed empirical spike frequencies (plotted in `reports/calibration_reliability.png`). A predicted risk of 30% corresponds empirically to ~30% observed spike probability on holdout data.

---

## 4. Recommended Operational Risk Tiers

Using calibrated probabilities, we establish four actionable tiers:

| Tier | Risk Range | Test Days ($n$) | % of Days | Observed Spike Rate | Spikes Captured | Actionable Protocol |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **Nominal** | $0\% - 10\%$ | 23,295 | 86.3% | **1.5%** | 28.7% | Routine monitoring; baseline emissions |
| **Watch** | $10\% - 25\%$ | 1,856 | 6.9% | **13.8%** | 21.3% | Advisory notice to street sweeping & traffic managers |
| **Elevated** | $25\% - 50\%$ | 1,513 | 5.6% | **28.8%** | 36.3% | Pre-alert water sprinkling, dust suppression, industrial throttling |
| **High** | $\ge 50\%$ | 334 | 1.2% | **49.1%** | 13.7% | Strict GRAP enforcement, diesel gen-set ban, health advisory |

---

## 5. Dashboard Fix & Removal of Outcome-Selected Slice


### Exact Files Referencing `top10_next_day_rises` / Outcome-Selected Numbers:

1. `src/types/alert.ts`:
   - Line 318: `'top10_next_day_rises'` in `expectedSegments` validation array.
   - Line 200: `selected_on_outcome?: boolean;` in interface `SegmentData`.

2. `src/components/alerts/ForecastErrorCard.tsx`:
   - Line 24: `'top10_next_day_rises'` in `segmentKeys` table rendering array.
   - Line 64: `const isSelectedOnOutcome = seg.selected_on_outcome === true;` and rendering warning badge.

3. `src/components/alerts/OperatingPointCard.tsx`:
   - Line 28: Comment `// Exclude top10_next_day_rises from the segment selector per specification` (already excluded from interactive dropdown).

4. `scripts/export_alert_data.py`:
   - Line 857: `test_df["top10_next_day_rises"] = delta_next >= p90_rise`
   - Line 883: `"top10_next_day_rises": test_df["top10_next_day_rises"].values`
   - Line 911-915: `"top10_next_day_rises": {"definition": ..., "selected_on_outcome": True}`
   - Line 1220, 1236: Verification loops checking for `top10_next_day_rises`.

5. `src/data/alert_data.json`:
   - Under `.segments.top10_next_day_rises`: contains the invalid slice (73.3% / 67.8% recall numbers).
   - Under `.pr_curves.top10_next_day_rises`: contains matched PR curve for that slice.


### Proposed Replacement Metrics for the Fresh-Crossing Card in Dashboard:
* **Metric Basis**: Phase 1b fresh-crossing evaluation evaluated at the **5% Monthly Alert Budget**:
  * **PR-AUC**: `0.3213` (0.3786 excluding COVID lockdown)
  * **Alert Recall**: `27.2%`
  * **Alert Precision**: `24.1%`
  * **F1 Score**: `0.255`
  * **Operating Rule**: Top 5% daily risk score within each month (~1.5 alert days / month / station).

---

## 6. Phase 1c Final Verdict

**(a) Does lagged upwind fire help on the IGP autumn subset?**  
**No.**  
Even on the narrow Indo-Gangetic Plain autumn window (Oct 1 - Nov 30) with 1-, 2-, and 3-day lags and 3-day rolling FRP sums, fire features change PR-AUC by only **-0.0280** and budget recall by **-1.1%**. Active fire point detections within a 100km radius without meteorological dispersion trajectory physics do not predict next-day station transitions.

**(b) Which model to ship?**  
**Logistic Regression on autoregressive momentum features (`[PM2.5, pm25_lag1, pm25_rolling3]`) is sufficient and recommended for initial production.**  
At a 5% alert budget, Logistic Regression achieves **25.5% recall and 22.6% precision** (F1: `0.239`), virtually matching LightGBM (**27.2% recall, 24.1% precision**, F1: `0.255`). Logistic regression is completely explainable, requires zero weather/fire API dependencies during real-time inference, and avoids spatial distortion from distant ERA5 grid cells.

**(c) Recommended Alert Tiers:**  
Adopt the 3 calibrated tiers above: **Watch ($10-25\%$, observed rate 13.8\%)**, **Elevated ($25-50\%$, observed rate 28.8\%)**, and **High ($\ge 50\%$, observed rate 49.1\%)**. These tiers provide municipal operators with honest, calibrated risk probabilities.
