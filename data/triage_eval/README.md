# Citizen Report Triage Evaluation Dataset Protocol

## Overview
This directory contains the human-annotated ground truth evaluation dataset for the VayuDrishti AI-assisted citizen report triage module (Phase 5 f3b).

The evaluation is designed to produce honest, reproducible performance benchmarks across the 6 advisory triage classes without fabricated metrics.

## Label Taxonomy & Definitions

| Class Label | Description | Real-World Context (Indian Urban & Regional) | Minimum Target Samples |
| :--- | :--- | :--- | :--- |
| `smoke` | Industrial chimneys, diesel exhaust plumes, garbage burning smoke plumes. | Brick kilns in NCR/UP, industrial emissions, waste dumping grounds. | ≥ 15 (Target: 25) |
| `fire` | Open flames, active biomass combustion, agricultural residue burning. | Post-harvest paddy/wheat stubble fires (Punjab, Haryana), landfill fires (Ghazipur/Bhalswa). | ≥ 15 (Target: 25) |
| `haze_fog` | Ambient smog, low-visibility regional air pollution, inversion layer haze. | Winter atmospheric smog in Indo-Gangetic Plain, Delhi-NCR winter haze. | ≥ 15 (Target: 30) |
| `dust` | Construction dust, unpaved road dust, airborne loose silt, dust storm. | Road resurfacing, metro construction corridors, dry pre-monsoon dust. | ≥ 15 (Target: 25) |
| `clear_normal` | Clean blue sky, high-visibility landscape, daylight outdoor scene with low PM2.5. | Post-monsoon clear days, hill stations, clean coastal days. | ≥ 15 (Target: 25) |
| `not_relevant` | Non-pollution scenes: indoor rooms, selfies, documents, computer screenshots, memes, receipts. | Erroneous, accidental, or spam citizen uploads. | ≥ 15 (Target: 25) |

**Total Target Size:** 100–200 photos across all 6 classes.

## How to Assemble the Dataset

1. **Lawful & Ethical Image Sources:**
   - Real, lawfully acquired photographs taken in Indian urban or rural environments.
   - Do NOT scrape copyright-restricted images or private citizen photos without authorization.
   - Public open-domain wildfire datasets (e.g. D-Fire: Dilemma-Fire / wildfire aerial datasets) may be referenced for secondary fire/smoke validation, but standard wildfire datasets are NOT representative of Indian urban winter smog.
2. **Directory Structure:**
   - Save your JPEG/PNG/WebP photos into `data/triage_eval/` (e.g. `data/triage_eval/delhi_haze_001.jpg`).
   - Copy `labels_TEMPLATE.csv` to `data/triage_eval/labels.csv`.
   - Add a row for each image:
     ```csv
     filename,label
     delhi_haze_001.jpg,haze_fog
     kiln_smoke_002.jpg,smoke
     stubble_fire_003.jpg,fire
     metro_dust_004.jpg,dust
     shimla_sky_005.jpg,clear_normal
     indoor_office_006.jpg,not_relevant
     ```
3. **Execution:**
   Run the evaluation script from the repository root:
   ```bash
   npx -y vite-node scripts/eval_triage.ts
   ```
   This script:
   - Processes each image using the local zero-shot CLIP provider.
   - Generates the confusion matrix, per-class precision and recall, and overall accuracy.
   - Writes `reports/triage_evaluation.md`.
   - Automatically unlocks the "EVALUATED" badge in the Moderator Review Queue.

4. **Git Hygiene:**
   - All image binaries in `data/triage_eval/` are git-ignored.
   - Only `README.md` and `labels_TEMPLATE.csv` are tracked in version control.
