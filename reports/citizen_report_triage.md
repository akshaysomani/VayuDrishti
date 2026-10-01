# VayuDrishti AI-Assisted Citizen Report Triage (Phase 5 f3b)

## 1. Architectural Purpose & Boundaries

The **AI-Assisted Citizen Report Triage** module provides internal, automated, advisory-only classification suggestions for photographs submitted through the VayuDrishti citizen reporting pipeline.

### Core Invariants
- **Advisory Only:** Triage suggestions are strictly internal hints displayed exclusively to human moderators within the authenticated review queue.
- **Zero Predictive Coupling:** Triage outputs **never** feed into the predictive risk model, feature vectors (`PM2.5`, `pm25_lag1`, `pm25_rolling3`, `pm25_ratio_90`), risk probabilities, tier assignments, or authority alert delivery pipelines (f4).
- **Zero Autonomous Moderation:** Triage results **never** approve, reject, hide, promote, or reorder public reports. All public state transitions require an explicit human moderator click.
- **Public Isolation:** Public endpoints (`GET /api/reports`, `GET /api/reports/images/:key`) contain zero triage fields, headers, or metadata.
- **Privacy & Local Execution:** Classification is executed **strictly locally** within the Node runtime using an ONNX runtime engine. No images are ever transmitted to third-party vision or LLM APIs.
- **EXIF Stripping First:** Only the Sharp re-encoded, EXIF/GPS-stripped, dimension-normalized image buffer (`mainBuffer`) is passed to the classifier.

---

## 2. Queue Architecture & State Transitions

Triage uses an asynchronous transactional outbox/queue pattern backed by PostgreSQL as the single source of truth.

```
Citizen Upload (POST /api/reports)
      │
      ├──> Re-encode & Strip EXIF (Sharp)
      ├──> Insert citizen_reports (status: PENDING)
      ├──> Enqueue report_triage (status: PENDING)
      └──> Return 201 Created IMMEDIATELY (Upload never blocked)

Background Queue Worker (TriageWorker)
      │
      ├──> SELECT ... FOR UPDATE SKIP LOCKED (Concurrency-safe claims)
      ├──> Status -> RUNNING (Lease timeout set)
      ├──> Fetch re-encoded mainBuffer from image storage
      ├──> Execute Local CLIP Classification (Promise.race timeout: 15s)
      │       ├── Success -> Status: DONE, suggested_label, confidence, mismatch
      │       ├── Model Missing / Offline -> Status: UNAVAILABLE
      │       └── Timeout / Crash -> Status: FAILED (Bounded retries: 3)
      └──> Stuck Lease Reclamation (Periodic sweep recovers stalled workers)
```

### Table Schema: `report_triage` (Migration 003)

| Column | Type | Constraints / Details |
| :--- | :--- | :--- |
| `id` | `UUID` | Primary Key, `DEFAULT gen_random_uuid()` |
| `report_id` | `UUID` | Unique Foreign Key `REFERENCES citizen_reports(id) ON DELETE CASCADE` |
| `status` | `VARCHAR(20)` | `NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'UNAVAILABLE'))` |
| `model_name` | `VARCHAR(100)` | Name of model (e.g. `LocalCLIP(Xenova/clip-vit-base-patch32)`) |
| `model_version` | `VARCHAR(50)` | Model version tag |
| `suggested_label` | `VARCHAR(50)` | `CHECK (suggested_label IN ('smoke', 'fire', 'haze_fog', 'dust', 'clear_normal', 'not_relevant'))` |
| `confidence` | `DOUBLE PRECISION` | Normalized score `CHECK (confidence >= 0.0 AND confidence <= 1.0)` |
| `scores` | `JSONB` | Normalized probability distribution across all 6 classes (sums to ~1.0) |
| `category_mismatch`| `BOOLEAN` | Flag indicating conflict between citizen category and model suggestion |
| `error` | `TEXT` | Credential-scrubbed failure diagnostics |
| `attempts` | `INT` | Retry attempt counter (bounded at 3) |
| `lease_timeout_at` | `TIMESTAMPTZ` | Timestamp when active lease expires for stuck worker recovery |
| `created_at` | `TIMESTAMPTZ` | Queue enqueue timestamp |
| `completed_at` | `TIMESTAMPTZ` | Classification completion or final failure timestamp |
| `updated_at` | `TIMESTAMPTZ` | Record last touch timestamp |

---

## 3. Label Taxonomy & Natural Language Prompts

The classifier evaluates 6 mutually exclusive classes using zero-shot semantic prompts:

| Class Label | Target Scope | Natural Language Prompt |
| :--- | :--- | :--- |
| `smoke` | Industrial chimneys, vehicle exhaust plumes, garbage burning. | `"a photo of thick smoke rising from a chimney, factory, vehicle exhaust, or outdoor burning"` |
| `fire` | Open flames, active biomass combustion, agricultural stubble fires. | `"a photo of visible fire, flames, open burning, or agricultural crop residue burning"` |
| `haze_fog` | Low-visibility urban smog, atmospheric particulate haze, fog. | `"a photo of hazy foggy smoggy sky, low visibility urban atmosphere, or air pollution haze"` |
| `dust` | Construction site dust, unpaved road dust, airborne loose earth. | `"a photo of dust storm, blowing sand, loose soil, or construction dust in the air"` |
| `clear_normal` | Clean atmosphere, bright blue sky, normal outdoor visibility. | `"a photo of clear blue sky, clean air, bright daylight, and normal outdoor visibility"` |
| `not_relevant` | Indoor rooms, selfies, documents, screenshots, memes, receipts. | `"an indoor scene, selfie, screenshot, text document, diagram, receipt, or unrelated object"` |

---

## 4. Category Mismatch Decision Table

A category mismatch is flagged (`category_mismatch = true`) **only** when all three conditions are met:
1. `confidence >= TRIAGE_MISMATCH_MIN_CONFIDENCE` (default: 0.60)
2. `confidence >= TRIAGE_UNCERTAIN_BELOW` (default: 0.40; low confidence is classified as "uncertain", never a mismatch)
3. The citizen-selected category conflicts with the model's suggested label per the compatibility matrix:

| Citizen Category | Compatible Model Suggestions (No Mismatch) | Conflicting Suggestions (Triggers Mismatch if Conf ≥ 0.60) |
| :--- | :--- | :--- |
| `smoke` | `smoke`, `fire`, `haze_fog` | `clear_normal`, `not_relevant`, `dust` |
| `burning` | `fire`, `smoke` | `clear_normal`, `not_relevant`, `dust`, `haze_fog` |
| `dust` | `dust`, `haze_fog` | `clear_normal`, `not_relevant`, `fire` |
| `construction_dust` | `dust`, `haze_fog` | `clear_normal`, `not_relevant`, `fire` |
| `industrial_emission` | `smoke`, `dust`, `haze_fog` | `clear_normal`, `not_relevant` |
| `other` | `smoke`, `fire`, `haze_fog`, `dust`, `clear_normal` | `not_relevant` |

---

## 5. Security, Credential Scrubbing & Privacy

1. **Local Model Isolation:**
   - Package: `@huggingface/transformers@3.3.3` pinned.
   - Cache Directory: `.model_cache/` (git-ignored).
   - If model assets are absent or Node runtime cannot access weights, triage safely records `UNAVAILABLE`. Uploads and report creation never fail.
2. **Credential Scrubbing:**
   - Database connection strings, passwords, authorization tokens, and API keys are scrubbed before writing to `report_triage.error`:
     - `://user:password@` -> `://user:[SCRUBBED]@`
     - `?token=...` -> `?token=[SCRUBBED]`
3. **Test Database Isolation:**
   - Automated tests strictly connect via `TEST_DATABASE_URL` (database name must end in `_test`).
   - Development database row count is verified unchanged before and after tests.

---

## 6. Moderator Interface & Read-Only Context

The `ModerationPanel` React component incorporates:
- **AI Suggestion Chip:** Compact semantic badge showing label and confidence percentage (e.g. `AI: Smoke (85%)`).
- **Uncertain State:** When confidence is below 40%, shows `AI: Uncertain (32%)` with subtle neutral styling.
- **Mismatch Warning:** Highlighted amber/rose banner detailing the discrepancy between citizen declaration and model prediction.
- **Queue Filter Toolbar:** Allows moderators to filter the queue by specific suggestions (e.g. isolating `not_relevant` items for bulk rejection review or `MISMATCH` items).
- **Model Limitations Notice:** Explicit disclaimer banner:
  > *"Trained for general scenes, not validated on Indian urban smog; treat as a hint. Final decision is always the moderator's click."*
- **Persistent Unvalidated Badge:** Displayed whenever `reports/triage_evaluation.md` indicates `NOT EVALUATED`.
- **Nearest Monitor Context (Read-Only):** Displays the nearest monitoring station's latest PM2.5 reading, timestamp, and staleness flag (>6h stale indicator, aligned with live-alert threshold) as background context without writing to history or feeding models.

---

## 7. Evaluation Procedure

To maintain scientific integrity and prevent fabricated claims:
1. **Script:** `scripts/eval_triage.ts` (runnable via `npm run eval:triage`).
2. **Protocol:** Reads human-annotated photos from `data/triage_eval/` and labels from `data/triage_eval/labels.csv`.
3. **Absent Set Policy:** If the dataset is absent or empty, the script prints `NOT EVALUATED`, exits cleanly with code 0, and writes `reports/triage_evaluation.md` stating `STATUS: NOT EVALUATED`.
4. **Metrics Generated:** Precision, recall, F1, support counts per class, 6x6 confusion matrix, and macro accuracy.

---

---

## 8. Known Domain Limitations

1. **Training Domain Divergence:** General CLIP models and wildfire smoke datasets are pre-trained on rural, forest, and brushfire settings. They cannot learn the nuances of Indian urban scenes:
   - **Fog vs Haze/Smog:** Wildfire datasets contain zero examples of winter radiation fog or agricultural stubble smog in Indo-Gangetic plains.
   - **Construction Dust:** High-albedo construction dust and fugitive road dust in Indian cities are absent from forest fire datasets.
   - **Local Research Only:** Local wildfire datasets (`smoke/`, `D-Fire`, `AI for Mankind`, `DataCluster`) are strictly for offline research exploration, unredistributed, and never used as claims of system accuracy.
   - **Satellite Data Exclusion:** The `fire/` folder contains satellite and geospatial tabular hotspot data (BHUVAN, NASA FIRMS, NASA MODIS), NOT citizen photo imagery. It is 100% excluded from triage vision models.
2. **Lighting & Haze Ambiguity:** Overcast daylight or high-humidity morning haze can visually mimic particulate pollution haze.
3. **Advisory Posture:** The model must remain an advisory hint for human review, never an automated gatekeeper.

---

## 9. Local Dataset & Probe Tooling

1. **Dataset Inventory:** `python scripts/inventory_smoke_datasets.py`
   - Scans local `smoke/` and `fire/` folders without modifying or copying files.
   - Reports file counts, image formats, annotation formats, and license statuses.
2. **Wildfire Sanity Check (Arm 0):** `npx -y vite-node scripts/sanity_check_wildfire.ts`
   - Evaluates a seeded sample of wildfire photos against Zero-Shot CLIP.
   - Labeled strictly as: *"wildfire-domain sanity check, not representative of Indian urban scenes"*.
3. **Linear Probe Trainer (Arm B):** `python scripts/train_linear_probe.py`
   - Governed by strict rules: only executes if `>= 100` human-annotated photos exist in `data/triage_eval/`.
   - Splits `data/triage_eval/` ONCE with fixed seed into `probe_train` and `heldout_test`.
   - Content-hash deduplication asserts zero leakage/overlap between train and test splits.
   - Evaluated side-by-side on `heldout_test` only. Adopted only if Arm B beats Arm 0 on smoke recall without sacrificing smoke/fire precision.
4. **Unit Tests for Split/Dedupe:** `npm run test:probe` (`scripts/test_dataset_split_dedupe.ts`)
   - Verifies stratified partitioning arithmetic, PRNG reproducibility, and cryptographic hash leakage detection on synthetic fixtures.

---

## 10. Recommended Sources for Indian Urban Haze/Smog Benchmark

To assemble a genuine 100–200 photo Indian urban evaluation benchmark across the 6 advisory classes (`smoke`, `fire`, `haze_fog`, `dust`, `clear_normal`, `not_relevant`), Akshay may review and license-check the following recommended sources:
- **OpenAQ Community Photo Archive:** Citizen and sensor-adjacent photography documenting ambient air conditions across Indian cities.
- **UrbanAirGlance / CPCB Public Portals:** Photographic archives attached to ground monitoring stations in Delhi-NCR, Kanpur, Lucknow, and Patna.
- **Academic Datasets on Asian Urban Air Quality:**
  - *Delhi Haze Dataset (DHD):* Research benchmark specifically compiled for outdoor visibility and dehazing evaluation.
  - *O-HAZE / I-HAZE Benchmarks:* Real hazy outdoor scene benchmarks.
  - *Indian Driving Dataset (IDD) & BDD100K:* Driving imagery under smoggy/dusty conditions in Indian metros (requires manual classification into triage labels).
- **Wikimedia Commons / Creative Commons Indian Urban Photography:** Curated collections of verified CC-BY / CC0 photos tagged with Delhi smog, crop stubble burning (Punjab/Haryana), or Diwali ambient smoke.

---

## 11. Production Deployment Requirements

- **Runtime:** Requires persistent Node.js runtime (matching `ingestionScheduler` and `alertDispatcher`). Static Vite CDN hosting cannot execute the background triage queue worker.
- **Memory & Storage:** Allocate ~500MB RAM for the ONNX CPU inference session and ~350MB persistent disk for the local model cache directory.

