# Synthetic demo records

Five made-up discharge summaries, in the style of the reference sample. No real person, patient identifier or hospital. Each exists as text (`*.txt`, paste into Ingest) and as a typed PDF with a real text layer (`pdf/*.pdf`, upload; no OCR needed).

To rebuild the PDFs after editing a text file: `node scripts/make-demo-pdfs.mjs` from `nextjs-app`.

Upload each one with a different patient identifier if you like (for example `TEST-0001` ... `TEST-0005`) and add a stub consent for each (Admin -> Consent) covering "DischargeSummary". Each document is different, so none is treated as a duplicate.

| File | Story | What it exercises | Likely outcome |
|---|---|---|---|
| `demo-01-hypertension` | Hypertension, two tablets | Natural wording like the reference: class and phase are not stated outright, so they are tagged "inferred" (score capped at 80%) | Review: inferred values hold the resource under its threshold |
| `demo-02-heart-failure` | Heart failure with kidney disease | Two diagnoses (primary and secondary code), a lab value with a date, two high-risk medications | Review, with the lab and medications shown against their 0.99 and 0.95 floors |
| `demo-03-pneumonia` | Pneumonia with a peanut allergy | Facility name, allergy with reaction and severity, a lab, class stated explicitly | The best candidate for automatic commit |
| `demo-04-atrial-fibrillation` | Atrial fibrillation on warfarin | A high-risk drug with "at bedtime" timing | Review: the strictest case, a good one to correct a field on |
| `demo-05-copd` | COPD with anaemia | Dates written as "12 August 2025" instead of ISO, a lab in g/dL, class stated explicitly | Candidate for automatic commit; shows the date checker handling other formats |

Outcomes depend on the model's confidence and your thresholds, so treat the last column as a guide. Terminology matches `supabase/seed/terminology-sample.sql` (hypertension, heart failure, chronic kidney disease, pneumonia, atrial fibrillation, COPD, the listed drugs, peanut, creatinine and haemoglobin). All five labs and drugs are in the sample set (including the British spelling "Haemoglobin" and "White blood cell count" as synonyms), so each should be coded; if one is not, the record flags it as uncoded, which is the behaviour to show.
