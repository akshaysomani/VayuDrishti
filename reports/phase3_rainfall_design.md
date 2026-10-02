# Phase 3: Rainfall and Heavy-Rain Hazard Architecture & Specification Report

**Document Version:** 1.0.0  
**Phase:** Phase 3a (Audit and Technical Design)  
**Project:** VayuDrishti (India Air Quality & Environmental Hazard Observatory)  
**Status:** Design Proposal & Pre-Implementation Audit  
**Author:** Senior Software Architect  

---

## 1. Executive Summary & Boundaries

Phase 3 introduces automated rainfall monitoring, climatological heavy-rain hazard indexing, and spatial population exposure mapping to VayuDrishti.

### Strict Architectural Boundaries (Invariants)
1. **Total Decoupling from Air Quality Model:**
   - The Phase 1/2 acute air-quality spike model (calibrated logistic regression, features $[\text{PM}_{2.5}, \text{pm25\_lag1}, \text{pm25\_rolling3}, \text{pm25\_ratio\_90} = \text{PM}_{2.5}/90.0]$, risk tiers `Nominal`, `Watch`, `Elevated`, `High`, alert threshold $p \ge 0.05$) is **frozen and untouched**.
   - Rainfall features will **never** be injected into the air-quality feature store or model pipeline.
   - The rainfall module maintains its own taxonomy and tier terminology to eliminate semantic ambiguity.
2. **Honest Meteorological Framing ("Heavy-Rain Hazard", NOT "Flood Forecast"):**
   - Satellite precipitation grids at $0.1^\circ \times 0.1^\circ$ ($\sim 10\text{ km} \times 10\text{ km}$) cannot resolve municipal drainage backups, culvert clogging, or localized street waterlogging.
   - The module produces an **Unvalidated Heavy-Rain Hazard Index** based on cumulative precipitation and historical percentiles, clearly distinguished from hydraulic inundation forecasting.
3. **Zero Secrets in Code:**
   - NASA Earthdata credentials reside exclusively in `.env` loaded at runtime.
   - Tests execute against `TEST_DATABASE_URL` only.

---

## 2. Repo Audit: Existing Data, Geometries & Terrains

### 2.1 Location of Existing Phase 2 Data & Exposure Models
- **Precomputed Exposure Assets:**
  - `src/data/alert_data.json` (4.39 MB) and `src/data/dashboard_data.json` (351 KB): Contain `stations` (107 reporting monitors across 26 cities) and `city_exposure` records.
  - `reports/phase2_exposure.md`: Documents the population baseline, geodesic buffer methodology, and station coordinate audit.
- **TypeScript Type Definitions:**
  - `src/types/alert.ts`: Defines `StationExposureRecord` and `CityExposureSummary`.
  - `src/types/liveAlert.ts`: Defines `LiveExposureContext` (`station_population_5km`, `city_population_5km_union`).
  - `src/types/alertDelivery.ts`: Carries exposure metadata in the transactional delivery outbox.
- **Relational Tables in PostgreSQL:**
  - `alert_outbox`: Contains `expected_people_exposed`, `coord_quality`, `station_id`, and `city`.
  - `recipients`, `alert_deliveries`: Handle fan-out alerting without modifying underlying exposure math.

### 2.2 City Geometries & Population Buffer Representation
- **Buffer Geometry:**
  - 107 active air quality stations across 26 Indian cities.
  - 82 stations matched to exact CPCB coordinates (`coord_quality = "station"`).
  - 25 stations mapped to municipal city centroids (`coord_quality = "city_point"`).
  - Exposure is computed over circular geodesic buffers of **2 km** and **5 km** around active monitors.
- **Spatial Union (Zero Double-Counting):**
  - In multi-station cities (e.g. Delhi with 37 stations, Mumbai with 10, Bengaluru with 8, Kolkata with 7), population is calculated via the **spatial union of all station buffers**.
  - A raster cell covered by multiple station radii is counted **exactly once** in the city total (`population_within_5km_of_monitors`).
- **Population Rasters in Project:**
  - `ind_ppp_2017_1km_Aggregated_UNadj.tif` (18.29 MB): WorldPop 2017 UN-adjusted 1 km grid covering all of India. This is the **shipped Phase 2 reference raster**.
  - `ind_ppp_2015.tif` (1.85 GB): WorldPop 2015 unaggregated raster.
  - `population/WorldPop Population/ind_pop_202X_CN_100m_R2025A_v1.tif`: Four 100 m rasters for years 2022, 2023, 2024, 2025 ($\sim 767\text{ MB} - 778\text{ MB}$ each, $34,507 \times 35,040$ grid cells).
  - `gadm41_IND.gpkg` (51.99 MB): GeoPackage containing official administrative boundaries for India (Levels 0, 1, 2, 3).

### 2.3 Existing Rainfall, Weather, Terrain & Flood Data Audit
A complete scan of the repository was conducted for elevation, terrain, drainage, rainfall, and flood datasets:

| Dataset Category | Files Present in Workspace | Size | Assessment / Usability for Phase 3 |
| :--- | :--- | :--- | :--- |
| **Rainfall (IMD OGD)** | `rainfall/IMD  India OGD Rainfall/Sub_Division_IMD_2017.csv` | 445 KB | Monthly subdivision-level historical averages (1901–2017). Too coarse for city-level daily spike tracking. |
| **Rainfall (CHIRPS)** | `ERA5-Land/CHIRPS_INDIA/1998/` to `2001/` (`.nc` monthly daily files) | $\sim 10 - 19\text{ MB}$ / file | Daily gridded precipitation ($0.05^\circ$) for India from 1998 to 2001. Useful historical reference but truncated at 2001. |
| **Rainfall (ERA5-Land)** | `ERA5-Land/ERA5_Land_Rainfall/` (GRIB and NetCDF files for 1998) | $\sim 130\text{ MB}$ | Single-year reanalysis slice (1998). |
| **Weather (ERA5)** | `weather/ERA5 Hourly/*.zip` | 3 files $\sim 395\text{ MB}$ each | Historical atmospheric reanalysis slices. |
| **Weather (Current)** | `data/owm_current_weather.csv` | 137 bytes | Single sample OpenWeatherMap observation. |
| **Elevation / DEM** | **None** | 0 bytes | **Zero elevation rasters** (no SRTM 30m, ASTER, or Copernicus DEM) exist in the project. |
| **Drainage / Hydrology** | **None** | 0 bytes | **Zero hydrography layers** (no HydroSHEDS, stream networks, or catchment polygons). |
| **Flood Events** | **None** | 0 bytes | **Zero ground-truth flood inventories** (no DFO polygons, CWC flood reports, or inundation masks). |

---

## 3. NASA GPM IMERG Rainfall Data Options

All dataset specifications, product names, versions, resolutions, and access mechanisms below were verified directly against official NASA Goddard Earth Sciences Data and Information Services Center (GES DISC) documentation.

### 3.1 IMERG Product Matrix (Version 07 / V07B)

The Global Precipitation Measurement (GPM) Integrated Multi-satellitE Retrievals for GPM (IMERG) Version 07 is processed across three operational runs:

| Product Dimension | IMERG Early Run | IMERG Late Run | IMERG Final Run |
| :--- | :--- | :--- | :--- |
| **Product Identifier** | `GPM_3IMERGDE` (Daily) / `GPM_3IMERGHE` (Half-Hourly) | `GPM_3IMERGDL` (Daily) / `GPM_3IMERGHHL` (Half-Hourly) | `GPM_3IMERGDF` (Daily) / `GPM_3IMERGHH` (Half-Hourly) |
| **Nominal Latency** | **$\sim 4$ hours** | **$\sim 14$ hours** | **$\sim 3.5$ months** |
| **Morphing Algorithm** | Forward extrapolation only | Forward & backward interpolation | Forward & backward interpolation |
| **Gauge Calibration** | Climatological gauge ratio only | Climatological gauge ratio only | **GPCC monthly surface gauge analysis** |
| **Spatial Resolution** | $0.1^\circ \times 0.1^\circ$ ($\sim 10\text{ km} \times 10\text{ km}$) | $0.1^\circ \times 0.1^\circ$ ($\sim 10\text{ km} \times 10\text{ km}$) | $0.1^\circ \times 0.1^\circ$ ($\sim 10\text{ km} \times 10\text{ km}$) |
| **Temporal Granularity** | Native 30-min; aggregated daily | Native 30-min; aggregated daily | Native 30-min; aggregated daily |
| **Global Grid Dimensions**| $3600 \times 1800$ grid cells | $3600 \times 1800$ grid cells | $3600 \times 1800$ grid cells |
| **Temporal Span** | 2000–present | 2000–present | June 2000 – $\sim 3.5$ months ago |
| **Primary Purpose** | Real-time flash hazard flagging | Operational daily hazard tracking | **Climatological baseline & percentiles** |

### 3.2 Programmatic Access Architecture
- **Authentication:** NASA Earthdata Login (EDL) via `urs.earthdata.nasa.gov`.
- **Application Authorization:** User's Earthdata profile must authorize "NASA GESDISC DATA ARCHIVE" and "Hyrax OPeNDAP".
- **Access Protocols:**
  1. **OPeNDAP Spatial Subsetting (Recommended):** GES DISC Hyrax server allows HTTP requests with bounding box coordinate slices (e.g. `?precipitationCal[0:1:0][lat_idx_min:1:lat_idx_max][lon_idx_min:1:lon_idx_max]`). This extracts only target pixels without transferring global grids.
  2. **GES DISC Subsetter / CMR Harmony API:** Subsets and converts to GeoTIFF or NetCDF on the fly.
  3. **Direct HTTPS via `_netrc`:** Standard authenticated curl/fetch with cookiejar management.
- **Licensing & Terms:** Unrestricted open data under NASA Open Data Policy. Free for educational, research, and operational applications with citation.

### 3.3 Storage Volume & Bandwidth Optimization Plan
- **The Global Problem:** A single global daily NetCDF file is $\sim 18\text{ MB}$.
  - Downloading 23 years (2001–2023) of global daily files = $8,400 \times 18\text{ MB} \approx \mathbf{151\text{ GB}}$. This is completely unacceptable.
- **The Bounding-Box Solution:**
  - India National Bounding Box: Lat $6.0^\circ\text{N} - 38.0^\circ\text{N}$, Lon $68.0^\circ\text{E} - 98.0^\circ\text{E}$ ($320 \times 300$ grid cells = $96,000$ points $\approx 384\text{ KB}$ per day).
  - 26 Cities Bounding Boxes: Extracting a $0.3^\circ \times 0.3^\circ$ cluster around each of our 26 city centroids requires only $3 \times 3 = 9$ cells per city $\times 26\text{ cities} = 234\text{ cells} \approx \mathbf{1\text{ KB}}$ per day!
- **Estimated Storage Footprint:**
  - 23-Year Historical Daily Climatology (2001–2023, 26 cities): **$< 10\text{ MB}$** total extracted storage.
  - Operational Ingestion (Daily Late Run): **$\sim 1\text{ KB}$ / day** ($< 500\text{ KB}$ / year).
- **Required `.env` Keys (Names Only):**
  - `EARTHDATA_USERNAME`
  - `EARTHDATA_PASSWORD`
  - `EARTHDATA_TOKEN` (optional for Bearer token auth)
  - `IMERG_CACHE_DIR` (local filesystem directory for raw subset cache)

### 3.4 Product Recommendation & Rationale
1. **For Historical Baseline & Percentile Distribution:**  
   **Recommendation: `GPM_3IMERGDF` (Daily Final Run V07B)**  
   *Rationale:* Includes GPCC monthly ground gauge adjustments. Ground calibration eliminates satellite microwave bias over peninsular and mountain terrains, ensuring accurate historical quantile thresholds ($P_{80}, P_{90}, P_{95}, P_{98}$).
2. **For Near-Real-Time Ingestion:**  
   **Recommendation: `GPM_3IMERGDL` (Daily Late Run V07B)**  
   *Rationale:* 14-hour latency aligns perfectly with a once-daily morning ingestion scheduler. Incorporates both forward and backward satellite track interpolation, providing significantly superior spatial coherence over the 4-hour Early Run.

---

## 4. Heavy-Rain Hazard Index & Ground Truth Validation

### 4.1 Hazard Index Formulation (Meteorological, Not Hydraulic)
We propose a three-component empirical hazard metric computed per city:

1. **Short-Term Intensity ($R_{24}$):**
   $$R_{24} = \text{Cumulative precipitation over past 24 hours (mm)}$$
2. **Multi-Day Accumulation ($R_{72}$):**
   $$R_{72} = \text{Cumulative precipitation over past 72 hours (mm)}$$
3. **Antecedent Precipitation Index ($API$):**
   $$API_t = R_t + k \cdot API_{t-1} \quad (k = 0.85, \text{ window } = 14\text{ days})$$
   Represents antecedent soil moisture saturation and catchment priming.
4. **Historical Percentile Framing ($Q_{\text{cell}}$):**
   To account for the vast climatic variance between arid regions (Jaipur, Amritsar) and heavy monsoon zones (Mumbai, Kolkata, Guwahati), $R_{24}$ and $R_{72}$ are evaluated against the cell's historical non-zero rainfall distribution (2001–2023):
   - $P_{80}$: 80th percentile of wet days
   - $P_{90}$: 90th percentile of wet days
   - $P_{95}$: 95th percentile of wet days
   - $P_{98}$: 98th percentile of wet days

### 4.2 Hazard Classification Scheme (Separate from Air Quality)
To prevent confusion with Phase 1/2's `Nominal`, `Watch`, `Elevated`, and `High` air quality tiers, rainfall hazard uses an independent taxonomy harmonized with India Meteorological Department (IMD) conventions:

| Heavy-Rain Hazard Level | IMD Conventional Benchmark ($R_{24}$) | Empirical Percentile Condition | Meaning |
| :--- | :--- | :--- | :--- |
| **Normal** | $< 35.5\text{ mm}$ | $< P_{80}$ | Typical ambient rainfall; negligible surface runoff stress. |
| **Advisory** | $35.5 - 64.4\text{ mm}$ (Moderate) | $\ge P_{80}$ or $API$ elevated | Sustained wet conditions; potential local drainage delay. |
| **Severe** | $64.5 - 115.5\text{ mm}$ (Heavy Rain) | $\ge P_{90}$ or $R_{72} \ge P_{95}$ | Heavy rainfall hazard; high runoff rate in impervious urban zones. |
| **Extreme** | $> 115.5\text{ mm}$ (Very Heavy to Extremely Heavy) | $\ge P_{98}$ | Extreme meteorological accumulation; widespread stormwater stress. |

### 4.3 Ground Truth Validation Architecture
To evaluate whether this index has empirical diagnostic value, we evaluate against real historical flood databases:
1. **Dartmouth Flood Observatory (DFO) Global Active Archive of Large Flood Events:**
   - License: Creative Commons Zero (CC0) / Public Domain.
   - Coverage: 1985–present. Records start date, end date, centroid coordinates, affected polygon, and estimated magnitude.
2. **Evaluation Metrics:**
   - **Probability of Detection (Hit Rate):**
     $$\text{POD} = \frac{\text{Hits}}{\text{Hits} + \text{Misses}}$$
   - **False Alarm Ratio:**
     $$\text{FAR} = \frac{\text{False Alarms}}{\text{Hits} + \text{False Alarms}}$$
   - **Critical Success Index (Threat Score):**
     $$\text{CSI} = \frac{\text{Hits}}{\text{Hits} + \text{Misses} + \text{False Alarms}}$$
   - **Baseline Benchmark:** Comparison against a trivial persistence baseline and a fixed uncalibrated 50 mm threshold.
3. **The "Unvalidated" Honesty Invariant:**
   - If DFO matching reveals that macro-satellite flood records lack urban granularity for specific cities, the UI and API must prominently label all outputs:  
     **`"Unvalidated Heavy-Rain Hazard Index — Meteorological Estimate, Not an Inundation Forecast"`**  
   - This directly mirrors the advisory standard established in Phase 5 f3b triage.

---

## 5. Exposure Link: Combining Hazard with WorldPop

### 5.1 Reusing the Union-of-Buffers Methodology
Phase 2 established the **spatial union of geodesic buffers** around monitors to calculate population exposure without double counting. We extend this exact method to rainfall hazard:

```
[City Monitor Coordinates] (98 unique points across 26 cities)
         │
         ▼
[5 km Geodesic Buffers] ───> [Spatial Union Polygon per City]
                                      │
                                      ▼
[IMERG 0.1° Rainfall Grid Cell] ───> [Heavy-Rain Hazard Level: Normal / Advisory / Severe / Extreme]
                                      │
                                      ▼
[WorldPop 2017 1 km UN-adj Raster] ─> [Intersect Raster Cells within Hazard Zone]
                                      │
                                      ▼
"N people in monitoring footprint under Severe/Extreme Heavy Rain Hazard"
```

- For each city, if the rainfall cell intersecting the city's monitoring footprint reaches `Severe` or `Extreme`, the affected population is reported as:
  $$\text{Population under Severe Hazard} = \sum_{c \in \text{Union } \cap \text{ Severe}} \text{WorldPop}_c$$
- Because the union footprint is already calculated in Phase 2 for all 26 cities (e.g. Delhi: 18.6M, Mumbai: 8.86M, Kolkata: 7.83M, Bengaluru: 7.45M), rainfall exposure calculations execute in under 5 milliseconds per city via lookup tables.

### 5.2 Required Layers for True Flood Exposure (Optional Future Work)
True flood inundation exposure requires physical hydrologic routing beyond rainfall and population:
1. **Digital Elevation Model (DEM):** SRTM 30 m or Copernicus GLO-30 DEM to compute slope, flow direction, and depression storage.
2. **Topographic Wetness Index (TWI):** $\ln(a / \tan \beta)$ to identify natural pooling basins.
3. **Hydrology & Drainage Networks:** HydroSHEDS river channels and distance-to-waterway buffers.
4. **Impervious Surface Fraction:** High-resolution land cover (e.g. ESA WorldCover 10 m) to determine runoff coefficients.

---

## 6. System Architecture & Technical Specification

```
                                  NASA GES DISC
                           (GPM IMERG V07 OPeNDAP API)
                                        │
                                        ▼ (Daily Late / Final Run)
                            [rainfallIngestionWorker]
                       (Bounded timeout, Earthdata Auth,
                        City Bounding Box Subsetter)
                                        │
                                        ▼
                            PostgreSQL Database
                     ├── rainfall_cells (Spatial Metadata)
                     ├── rainfall_climatology (P80, P90, P95, P98)
                     ├── rainfall_observations (Daily Time Series)
                     └── city_rainfall_exposure (WorldPop Union Intersect)
                                        │
                                        ▼
                            [Rainfall HTTP Handlers]
                     ├── GET /api/rainfall/status
                     ├── GET /api/rainfall/city/:city
                     └── GET /api/rainfall/exposure
                                        │
                                        ▼
                            Observatory UI Dashboard
                    [RainfallHazardCard.tsx] (Cyan/Indigo Palette,
                     Honest Disclaimers, Zero Air-Quality Interference)
```

### 6.1 Database Schema (`006_create_rainfall_hazard.sql`)

```sql
-- 1. Reference grid cells covering the 26 monitoring cities
CREATE TABLE IF NOT EXISTS rainfall_cells (
  id VARCHAR(64) PRIMARY KEY, -- e.g. 'imerg_lat28.6_lon77.2'
  city VARCHAR(64) NOT NULL,
  latitude NUMERIC(6, 3) NOT NULL,
  longitude NUMERIC(6, 3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Precomputed climatological rainfall percentiles (2001-2023)
CREATE TABLE IF NOT EXISTS rainfall_climatology (
  cell_id VARCHAR(64) PRIMARY KEY REFERENCES rainfall_cells(id) ON DELETE CASCADE,
  p80_mm NUMERIC(6, 2) NOT NULL,
  p90_mm NUMERIC(6, 2) NOT NULL,
  p95_mm NUMERIC(6, 2) NOT NULL,
  p98_mm NUMERIC(6, 2) NOT NULL,
  baseline_years VARCHAR(32) NOT NULL DEFAULT '2001-2023',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Daily / sub-daily ingested precipitation observations
CREATE TABLE IF NOT EXISTS rainfall_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cell_id VARCHAR(64) NOT NULL REFERENCES rainfall_cells(id) ON DELETE CASCADE,
  city VARCHAR(64) NOT NULL,
  observation_date DATE NOT NULL,
  rain_24h_mm NUMERIC(6, 2) NOT NULL,
  rain_72h_mm NUMERIC(6, 2) NOT NULL,
  api_index NUMERIC(6, 2) NOT NULL,
  hazard_tier VARCHAR(16) NOT NULL CHECK (hazard_tier IN ('Normal', 'Advisory', 'Severe', 'Extreme')),
  source_product VARCHAR(32) NOT NULL, -- 'GPM_3IMERGDL_07' or 'DEMO'
  is_stale BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_rainfall_cell_date UNIQUE (cell_id, observation_date)
);

-- 4. Linked population exposure
CREATE TABLE IF NOT EXISTS city_rainfall_exposure (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city VARCHAR(64) NOT NULL,
  observation_date DATE NOT NULL,
  hazard_tier VARCHAR(16) NOT NULL CHECK (hazard_tier IN ('Normal', 'Advisory', 'Severe', 'Extreme')),
  population_under_hazard INTEGER NOT NULL,
  total_monitoring_population INTEGER NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_city_rainfall_exposure_date UNIQUE (city, observation_date)
);

CREATE INDEX IF NOT EXISTS idx_rainfall_obs_city_date ON rainfall_observations(city, observation_date);
```

### 6.2 Ingestion Job & Worker Pattern
- Reuses the robust pattern established in `ingestionScheduler.ts`:
  - Dedicated runner function `pollRainfallIngestionCycle()`.
  - Runs once every 24 hours at 06:00 UTC (capturing the previous day's IMERG Late run).
  - Wrap external network requests in `Promise.race` with a 15-second timeout.
  - Safe credential handling: `.env` secrets loaded via `ensureServerEnvLoaded()`, never printed to logs.
  - Fallback to synthetic offline fixtures (`DEMO_RAINFALL`) when `EARTHDATA_USERNAME` is missing or network fails.
- **Stale Data Convention:**
  - If latest available IMERG observation is $> 48\text{ hours}$ old, row is tagged `is_stale = true` and UI presents amber stale badge.

### 6.3 REST API Endpoints
1. `GET /api/rainfall/status`: Returns runner state, last fetched date, data source (`LIVE` vs `DEMO`), and freshness flag.
2. `GET /api/rainfall/city/:city`: Returns current 24h/72h rainfall, climatological percentile, hazard tier (`Normal`/`Advisory`/`Severe`/`Extreme`), and population exposed.
3. `GET /api/rainfall/exposure`: Returns network-wide exposure summary across all 26 cities.

### 6.4 UI Placement & Styling
- Implemented as a dedicated, self-contained component: `src/components/rainfall/RainfallHazardCard.tsx`.
- **Visual Distinction:**
  - Air quality card: Deep slate background, orange/rose/purple tier accents (`#f59e0b`, `#f43f5e`, `#a855f7`).
  - Rainfall hazard card: Deep navy background, cyan/indigo/blue accents (`#06b6d4`, `#3b82f6`, `#6366f1`).
- Prominent advisory disclaimer:
  *"Meteorological rainfall hazard estimate based on NASA GPM IMERG satellite observations. Not a hydrodynamic flood inundation or street-waterlogging model."*

### 6.5 Risk Register & Mitigation

| Risk | Impact | Probability | Architectural Mitigation |
| :--- | :--- | :---: | :--- |
| **Coarse Resolution ($10\text{ km}$)** | Cannot resolve localized urban waterlogging | High | Explicit framing as "Heavy-Rain Hazard Index", never "Flood Forecast". |
| **Late Run Latency ($\sim 14\text{ h}$)** | Flash floods happen faster than 14 hours | High | Document latency plainly; reserve half-hourly Early Run ($4\text{ h}$) for future alert notification. |
| **Missing Earthdata Credentials** | Ingestion pipeline fails in local development | High | Graceful fallback to cached fixture data with `source_product = 'DEMO'` indicator. |
| **Validation Gaps** | Macro flood events (DFO) do not match city rain events | Medium | Explicitly label outputs as "Unvalidated" unless empirical CSI benchmarks are met. |

---

## 7. Sliced Build Plan & Acceptance Criteria

```
┌────────────────────────────────────────────────────────────────────────┐
│ SLICE 1: Database Migration 006 & Climatology Extraction Script        │
│          - Schema migration 006 (tables & check constraints)           │
│          - Python/TS script to subset 2001-2023 IMERG Final percentiles│
│          - Idempotency tests on scratch DB                             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ SLICE 2: Heavy-Rain Hazard Engine & Population Exposure Integration    │
│          - Pure functions for R24, R72, API, and percentile tiers      │
│          - Mapping IMERG cells to WorldPop 2017 1km union buffers      │
│          - Comprehensive unit test suite                               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ SLICE 3: NASA GES DISC Client & Scheduler Ingestion Worker             │
│          - Authenticated OPeNDAP client with Earthdata login           │
│          - Bounded timeout, offline DEMO fallback, credential scrubber │
│          - Isolation tests (rainfall failure cannot crash air quality) │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ SLICE 4: HTTP Handlers & API Integration                               │
│          - Endpoints: /status, /city/:city, /exposure                  │
│          - Integration tests with real local HTTP server               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ SLICE 5: Dashboard Visualization (RainfallHazardCard.tsx)              │
│          - Cool-toned cyan/indigo styling distinct from air quality    │
│          - Unvalidated disclaimer banner and exposure counters         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ SLICE 6: Validation Benchmark vs DFO Archive                           │
│          - Script checking POD, FAR, CSI against DFO India records     │
│          - Generate reports/phase3_validation.md                       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Exact Decisions Required from Akshay Before Phase 3b

Before implementation code is written in Phase 3b, Akshay must decide on the following 4 architectural options:

1. **IMERG Ingestion Latency Trade-Off:**
   - **Option A (Recommended):** Use `GPM_3IMERGDL` (Daily Late, $\sim 14\text{ h}$ latency). Highly reliable, forward/backward morphed, computationally minimal ($< 5\text{ KB}$/day).
   - **Option B:** Use `GPM_3IMERGHE` (Half-Hourly Early, $\sim 4\text{ h}$ latency). Faster for flash alerts, but noisier (forward morphing only, no backward interpolation) and requires 48 downloads per day.
2. **Geographic City Scope:**
   - **Option A (Recommended):** Include all **26 Phase 2 cities** for uniform national coverage.
   - **Option B:** Restrict initial rollout to the **7 major flood-vulnerable metros** (Mumbai, Chennai, Kolkata, Delhi, Bengaluru, Patna, Guwahati).
3. **Climatological Baseline Window:**
   - **Option A (Recommended):** **2001–2023 (23 years)**. Spans TRMM V7 + GPM V07 combined records, providing robust extreme percentiles ($P_{95}, P_{98}$).
   - **Option B:** **2014–2023 (10 years)**. Pure GPM-era observations only (avoids TRMM inter-satellite calibration shifts).
4. **Validation Strategy:**
   - **Option A (Recommended):** Download Dartmouth Flood Observatory (DFO) CC0 archive, run macro-event validation, and document empirical POD/FAR. If urban correlation is low, label index as "Unvalidated Heavy-Rain Hazard Index".
   - **Option B:** Skip external flood event validation entirely; classify the module strictly as a "Meteorological Heavy-Rain Accumulation Indicator" without validation claims.
