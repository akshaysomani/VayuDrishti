# Phase 3: Rainfall & Heavy-Rain Hazard Architecture & Specification Report

**Document Version:** 2.0.0 (Amended for Open-Meteo Primary Data Source)  
**Phase:** Phase 3a & 3b-1 (Technical Design, Open-Meteo Ingestion & Climatology)  
**Project:** VayuDrishti (India Air Quality & Environmental Hazard Observatory)  
**Status:** Architecture Specification & Climatology Design  
**Author:** Senior Software Architect  

---

## 1. Executive Summary & Architectural Boundaries

Phase 3 introduces automated rainfall monitoring, historical climatological baseline calculation (WMO standard normal 1991–2020), and spatial population exposure estimation to VayuDrishti.

### Strict Architectural Invariants
1. **Total Decoupling from Air Quality Model:**
   - The Phase 1/2 acute air-quality spike model (calibrated logistic regression, features $[\text{PM}_{2.5}, \text{pm25\_lag1}, \text{pm25\_rolling3}, \text{pm25\_ratio\_90} = \text{PM}_{2.5}/90.0]$, risk tiers `Nominal`, `Watch`, `Elevated`, `High`, alert threshold $p \ge 0.05$) is **frozen and untouched**.
   - Rainfall features will **never** be injected into the air-quality feature store or model pipeline.
   - The rainfall module uses its own independent classification and terminology (aligned with official India Meteorological Department standards) to prevent any semantic confusion.
2. **Honest Meteorological Framing ("Heavy-Rain Hazard", NOT "Flood Forecast"):**
   - Reanalysis and forecast precipitation grids at $0.1^\circ$ ($\sim 9-11\text{ km}$) or $0.25^\circ$ ($\sim 25\text{ km}$) cannot resolve municipal drainage backups, localized culvert blockages, or street underpass waterlogging.
   - Every output is strictly and prominently labeled:  
     **`"Unvalidated Heavy-Rain Hazard Index — model-based estimate, not an inundation forecast"`**
3. **Zero Secrets in Code:**
   - The primary data source (Open-Meteo API) requires **no API keys** and zero credentials for non-commercial open research.
   - NASA Earthdata credentials are removed from required environment variables (retained only as an optional future cross-check).

---

## 2. Primary Data Source: Open-Meteo APIs

### 2.1 API Endpoints & Served Models

All facts, product names, versions, resolutions, and access terms below are verified from official Open-Meteo documentation pages (*Open-Meteo Historical Weather API*, *Open-Meteo Weather Forecast API*, and *Open-Meteo Terms & Pricing*).

| Attribute | Historical Climatology API | Near-Real-Time & Forecast API |
| :--- | :--- | :--- |
| **Endpoint URL** | `https://archive-api.open-meteo.com/v1/archive` | `https://api.open-meteo.com/v1/forecast` |
| **Underlying Models** | **ERA5-Land** ($0.1^\circ \approx 9-11\text{ km}$) & **ERA5** ($0.25^\circ \approx 25\text{ km}$) from ECMWF Copernicus Climate Change Service (C3S). | Seamless multi-model operational blend (ECMWF IFS 0.25°/0.4°, GFS 0.25°, DWD ICON). |
| **Primary Variable** | `daily=precipitation_sum` (Daily sum in millimeters, mm) | `daily=precipitation_sum` (Daily sum in millimeters, mm) |
| **Auxiliary Variables** | `rain_sum`, `precipitation_hours`, hourly `precipitation` | `rain_sum`, `precipitation_hours`, hourly `precipitation` |
| **Historical Temporal Start** | ERA5: **1940** to present; ERA5-Land: **1950** to present. | Past archive access via `past_days` (up to 92 days past). |
| **Archive Latency ($T$-Minus)**| **$\sim 2-5$ days** lag (typically 5 days for certified ECMWF reanalysis). | **Near-zero latency** for yesterday/today's analysis blend. |
| **Forecast Horizon** | N/A (reanalysis archive only) | Up to **16 days** into the future (default: 7 days). |
| **Spatial Resolution** | ERA5-Land: $0.1^\circ \times 0.1^\circ$ ($\sim 9-11\text{ km}$ across Indian latitudes). | Typically $0.25^\circ \times 0.25^\circ$ ($\sim 25\text{ km}$) blended. |

### 2.2 Model Selection: ERA5-Land vs ERA5
- **ERA5-Land ($0.1^\circ \approx 9-11\text{ km}$)**: Downscaled reanalysis specifically dedicated to land surface hydrology and thermodynamics.
- **ERA5 ($0.25^\circ \approx 25\text{ km}$)**: Atmospheric reanalysis at coarser spatial scale.
- **Decision:** **ERA5-Land** is selected as the primary climatology model for Indian cities because its $0.1^\circ$ resolution captures urban/peri-urban topographical gradients with over $6\times$ higher spatial density than standard ERA5, matching the spatial scale of NASA IMERG.

### 2.3 Licensing, Terms of Use & Mandatory Attribution
- **Non-Commercial Free Tier:**
  - Up to **10,000 API calls per day**.
  - Hourly rate limit: 5,000 calls/hour; Minute rate limit: 600 calls/minute.
  - Free for open research, educational, and non-commercial open-source applications.
  - Zero API key or registration required.
- **Commercial Triggers:**
  - Any commercial monetization, revenue-generating service, or usage exceeding 10,000 calls/day requires a paid commercial subscription using `customer-api.open-meteo.com` with an API key.
- **Mandatory Attribution (CC BY 4.0):**
  - Weather data is provided under **Creative Commons Attribution 4.0 International (CC BY 4.0)**.
  - Mandatory credit line: *"Weather data by Open-Meteo.com"* (with hyperlink to `https://open-meteo.com/`).
  - Defined in codebase as constant:
    ```typescript
    export const OPEN_METEO_ATTRIBUTION = {
      text: 'Weather data by Open-Meteo.com',
      url: 'https://open-meteo.com/',
      license: 'CC BY 4.0',
    } as const;
    ```

### 2.4 NASA GPM IMERG Status
- NASA GPM IMERG is transitioned to an **OPTIONAL secondary cross-check source**.
- All Earthdata credentials (`EARTHDATA_USERNAME`, `EARTHDATA_PASSWORD`) are **removed from required environment variables**. No `.env` credentials are required for Phase 3.

---

## 3. Official IMD Rainfall Classification Standards

To maintain meteorological integrity across India, VayuDrishti strictly adopts the official **India Meteorological Department (IMD)** 24-hour rainfall classification table:

| IMD Category Name | Official 24-Hour Rainfall Range ($R_{24}$) | VayuDrishti Internal Tier | Guidance & Operational Meaning |
| :--- | :--- | :--- | :--- |
| **No Rain / Dry** | $0.0\text{ mm}$ | `Dry` | Zero precipitation. |
| **Very Light Rain** | Trace to $2.4\text{ mm}$ | `Very Light` | Superficial ground wetting. |
| **Light Rain** | $2.5 - 15.5\text{ mm}$ | `Light` | Normal ambient precipitation; minor runoff. |
| **Moderate Rain** | $15.6 - 64.4\text{ mm}$ | `Moderate` | Significant rainfall; urban drainage handles with normal flow. |
| **Heavy Rain** | $64.5 - 115.5\text{ mm}$ | `Heavy` | Elevated surface runoff; low-lying road waterlogging advisory. |
| **Very Heavy Rain** | $115.6 - 204.4\text{ mm}$ | `Very Heavy` | Severe runoff; significant urban waterlogging hazard. |
| **Extremely Heavy Rain** | $\ge 204.5\text{ mm}$ | `Extremely Heavy` | Extreme inundation hazard; widespread municipal stormwater failure. |

*Note on IMD Exceptionally Heavy Rain*: The IMD additionally designates rainfall as *"Exceptionally Heavy"* when an observation exceeds 120 mm and breaks or approaches the all-time station record for that month/season.

---

## 4. Honest Framing & Physical Limitations

1. **Model Estimates, Not Ground Truth Gauges:**
   - Both ERA5-Land reanalysis and forecast models are numerical weather models. While they incorporate satellite observations and surface stations, they are smoothed numerical fields.
2. **Spatial Scale vs Urban Hydrology:**
   - A $0.1^\circ$ cell ($\approx 100\text{ km}^2$) averages localized convective cells ("cloudbursts") across an entire district. A localized 100 mm cloudburst over a 2 km neighborhood will be smoothed to a ~20 mm grid average.
3. **Exposure Footprint Representation:**
   - Phase 2 population exposure covers the **spatial union of 5 km buffers around air quality monitors**, representing populations near active municipal monitoring centers, not entire administrative city territories.
   - The rainfall module provides a **city-level meteorological heavy-rain advisory**, linking regional accumulation to the monitoring population footprint.
4. **Strict Separation of Observed vs Forecast Telemetry:**
   - The data model and UI must maintain complete segregation:
     - **Observed / Reanalysis**: Past days (from archive or `past_days`), labeled `type = "observed"`.
     - **Forecast**: Future days ($T+1$ to $T+7$), labeled `type = "forecast"`.
     - Forecasts and observations are **never aggregated into the same unflagged series**.

---

## 5. Refresh Schedules, Stale Rules & Call Budget

### 5.1 Refresh Schedule & Stale Rules
- **Daily Ingestion Job:**
  - Scheduled daily at 06:30 UTC.
  - Queries `https://api.open-meteo.com/v1/forecast?past_days=7&forecast_days=7&daily=precipitation_sum`.
  - Captures 7 days of recent observations (bridging the ERA5-Land 5-day lag) and a 7-day forward outlook.
- **Stale Rules:**
  - If the latest available forecast/observation payload is $> 36\text{ hours}$ old, the record is flagged `is_stale = true` (following the existing VayuDrishti stale telemetry convention).

### 5.2 Call Budget for 26 Phase 2 Cities

| Operation | Frequency | API Calls per City | Total Calls for 26 Cities | % of Daily Free Limit (10,000) |
| :--- | :--- | :---: | :---: | :---: |
| **Historical Baseline (1991–2020)** | One-time acquisition (cached permanently) | 1 call | **26 calls** | **0.26%** |
| **Operational Forecast Refresh** | Daily at 06:30 UTC | 1 call / day | **26 calls / day** | **0.26%** |
| **Manual Admin Test / Refresh** | Occasional / On-demand | 1 call | 1–5 calls | < 0.05% |
| **Total Daily Operating Budget** | Ongoing production | 1 call / day | **26 calls / day** | **< 0.3%** |

### 5.3 Polite Client Architecture
- Concurrency capped strictly at $\le 2$ parallel HTTP requests.
- Inter-request pacing delay of **300–500 ms**.
- Exponential backoff retry handler (1s, 2s, 4s, 8s) that honors HTTP 429 (`Retry-After`).
- Local filesystem caching with SHA-256 integrity hashing to prevent redundant queries.

---

## 6. City Centroid Extraction & Climatology Plan

### 6.1 Deriving 26 City Centroids from Phase 2 Monitors
Each city's coordinate is derived strictly as the geographic centroid (mean latitude and longitude) of all matched and city-point monitors in `src/data/dashboard_data.json`:

$$\text{lat}_{\text{city}} = \frac{1}{N} \sum_{i=1}^N \text{lat}_i, \quad \text{lon}_{\text{city}} = \frac{1}{N} \sum_{i=1}^N \text{lon}_i$$

### 6.2 Climatology Metric Definitions (WMO 1991–2020 Normal)
For each city over the 30-year period (1991-01-01 to 2020-12-31, 10,957 days):
1. **Wet-Day Definition:** A day is classified as a "wet day" if and only if $\text{precipitation\_sum} \ge 1.0\text{ mm}$ (WMO standard threshold).
2. **Wet-Day Count ($N_{\text{wet}}$):** Total number of wet days in the 30-year period.
3. **Daily Accumulation Quantiles:** Computed over the sample of wet days:
   - $P_{80}$: 80th percentile of wet-day precipitation (mm).
   - $P_{90}$: 90th percentile of wet-day precipitation (mm).
   - $P_{95}$: 95th percentile of wet-day precipitation (mm).
   - $P_{98}$: 98th percentile of wet-day precipitation (mm).
4. **Rolling 3-Day Accumulation Quantiles:**
   - Evaluated on a 3-day backward rolling sum: $R_{3\text{d}, t} = \sum_{k=0}^2 R_{t-k}$.
   - Computed for non-zero rolling sums ($R_{3\text{d}} \ge 1.0\text{ mm}$): $P_{80, 3\text{d}}, P_{90, 3\text{d}}, P_{95, 3\text{d}}, P_{98, 3\text{d}}$.
5. **Annual Maximum Daily Precipitation:** Maximum single-day rainfall recorded per year, averaged over 1991–2020.
6. **Monsoon Season Partition (June–September):**
   - Separate climatological quantiles evaluated strictly on days in months June, July, August, and September (JJAS), capturing the South Asian summer monsoon dynamics.

---

## 7. Storage & File Organization

```
ML/
├── data/
│   └── rainfall_climatology/
│       ├── climatology_summary.json       (Git-tracked, compact < 100 KB summary table)
│       └── manifest.json                  (Git-tracked, download manifest with SHA-256)
├── cache/
│   └── open_meteo_rainfall/               (GIT-IGNORED: raw per-city 1991-2020 daily JSONs)
│       ├── Delhi_1991_2020.json
│       ├── Mumbai_1991_2020.json
│       └── ...
```

---

## 8. Sliced Build Plan (Phases 3b & 3c)

```
┌────────────────────────────────────────────────────────────────────────┐
│ STEP 1 & 2: Design Doc Amendment & 3-City Model Pilot (Complete)       │
│             - ERA5 vs ERA5-Land validation (Pilot on Delhi/Mumbai/Kol) │
│             - Verified Open-Meteo & IMD specifications                 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ STEP 3 & 4: Acquisition & 1991-2020 Climatology Extraction             │
│             - Centroid derivation for all 26 cities                    │
│             - Resumable download of 1991-2020 ERA5-Land daily data     │
│             - Compute wet-day P80/P90/P95/P98, R3d, & Monsoon metrics  │
│             - Generate compact git-tracked summary JSON                │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ STEP 5 & 6: CHIRPS Cross-Check & Test Suite Verification               │
│             - Honest correlation against local CHIRPS_INDIA NetCDF     │
│             - scripts/test_rainfall_data.ts in test runner             │
│             - Regression verification (479 AQ assertions intact)       │
└────────────────────────────────────────────────────────────────────────┘
```
