# Phase 1 Final Model Report
**Shipped Model**: Isotonic-calibrated Logistic Regression on `[PM2.5, pm25_lag1, pm25_rolling3, pm25_ratio_90]` (`models/phase1_final_logreg.pkl`).
**Test Period**: 2019-07-01 to 2020-06-30 (26,998 station-days with today's PM2.5 <= 90 µg/m³; base spike rate: 4.44%).
**Overall Test Metrics**: PR-AUC = 0.3134 [95% CI: 0.2864, 0.3446], ROC-AUC = 0.9042, test Brier score: 0.0348 (uncalibrated) vs 0.0350 (isotonic-calibrated).
**Operating Point (5% Monthly Alert Budget)**: Recall = 24.8%, Precision = 22.9%, F1 = 0.238 (Challenger LightGBM: Rec=27.5%, Prec=23.5%, F1=0.253).
**Challenger Comparison**: LightGBM PR-AUC = 0.3156 [95% CI: 0.2888, 0.3460]; difference Delta = +0.0019 [95% CI: -0.0206, +0.0234] is not statistically significant.
**Risk Tiers (Observed Test Spike Rates)**: Nominal (<10% risk, 84.9% days): 1.3% spike rate; Watch (10-25% risk, 8.1% days): 13.5% spike rate.
**High-Risk Tiers**: Elevated (25-50% risk, 6.1% days): 30.3% spike rate; High (>=50% risk, 1.0% days): 45.8% spike rate.
**Limitation 1 (Precision/Recall Tradeoff)**: Under a monthly budget, reaching ~60% recall dilutes precision to ~14-16%; under Phase 1b fixed-threshold tuning, 57.8% recall yielded 30.6% precision.
**Limitation 2 (Evaluation Window)**: The test window is 12 months (Jul 2019 - Jun 2020), about 41% of it COVID lockdown, with one winter and one post-monsoon season.
**Limitation 3 (Fire Features Lift)**: MODIS fire features (same-day and lagged 1-3d) provided no measurable lift over local PM2.5 autoregression on fresh crossings.
