# AI-Assisted Citizen Report Triage Evaluation

> **STATUS: NOT EVALUATED**
>
> Generated: 2026-10-01T09:46:26.810Z
> Model: `LocalCLIP(Xenova/clip-vit-base-patch32)` (Version: `1.0.0-vit-b32`)

## Status Notice
Ground-truth label file not found at C:\Users\Akshay\OneDrive\Desktop\ML\data\triage_eval\labels.csv. To evaluate, assemble labeled photos and labels.csv per data/triage_eval/README.md.

Per strict project policy:
- No synthetic data, web scraping, or fabricated accuracy figures are ever published.
- The moderator UI persistently displays the **"Unvalidated Model"** badge until a genuine evaluation is executed on real local data.
- Please refer to [`data/triage_eval/README.md`](../data/triage_eval/README.md) for instructions on assembling the 100–200 photo Indian urban evaluation benchmark across the 6 advisory classes.

## Evaluated Classes & Natural Language Prompts
| Class | Natural Language Prompt |
| :--- | :--- |
| `smoke` | a photo of thick smoke rising from a chimney, factory, vehicle exhaust, or outdoor burning |
| `fire` | a photo of visible fire, flames, open burning, or agricultural crop residue burning |
| `haze_fog` | a photo of hazy foggy smoggy sky, low visibility urban atmosphere, or air pollution haze |
| `dust` | a photo of dust storm, blowing sand, loose soil, or construction dust in the air |
| `clear_normal` | a photo of clear blue sky, clean air, bright daylight, and normal outdoor visibility |
| `not_relevant` | an indoor scene, selfie, screenshot, text document, diagram, receipt, or unrelated object |
