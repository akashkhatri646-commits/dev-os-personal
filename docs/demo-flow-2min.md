# 2-minute click-by-click demo flow

Message in one line: **it reads and codes the record with proof, a person checks what it is unsure of, and it commits alone only after the evidence says it may.**

The live upload runs in the background while you show the rest, so nothing waits on the worker.

## Stage before you start (10 minutes, not part of the 2)
- Signed in as admin. System check has no "Broken" item.
- One source that **has already passed its evaluation** ("Eval passed (synthetic)"), with auto-commit **on** for the source and `SYSTEM_AUTOCOMMIT_ENABLED=true`. Medication threshold set to 0.95.
- Five browser tabs, in this order:
  1. **Ingest**: source chosen, patient filled in, a **fresh, never-uploaded** clean synthetic PDF (for example the pneumonia or COPD sample with a changed date) selected, **not yet submitted**. A consent exists for that patient.
  2. **Record A**: a record already in **Needs review** (the hypertension sample works well), open on its Fields tab.
  3. **Review queue**.
  4. The source's **Evaluation** tab.
  5. **Records** list.
- A spare record that is already **Auto-committed**, and its Audit page, in case the live upload is slow.
- Rehearse once the day before to know how long a record takes to process.

## The flow

| Time | Where | Click or action | Say |
|---|---|---|---|
| 0:00 | Tab 1 Ingest | Click **Submit** | "I have just sent a new discharge summary. While it processes, here is one that is waiting for a person." |
| 0:10 | Tab 2 Record A | Point at the pipeline row, then the **Cited text** column | "Every value comes with the exact sentence it was read from. If it cannot be quoted, it is not written." |
| 0:20 | Tab 2 | Point at one **Inferred, not stated** tag and its score | "A value the model had to infer is marked and capped, so it cannot sneak through." |
| 0:30 | Tab 2 | Click the **Decision** tab | "Each part of the record is scored against its threshold. This one is below, so it goes to a person, and it says why." |
| 0:45 | Tab 3 Review queue | Click the record, then **Claim** | "The reviewer sees the document, the draft and the scores side by side." |
| 0:55 | Review screen | Press **A** (Accept) on two fields, **C** on one field and fix the value | "Accept what is right, fix what is not. Each click is also a measurement." |
| 1:10 | Review screen | Click **Approve** | "Approved and committed, with the reviewer on record." |
| 1:15 | Tab 4 Evaluation | Show the verdict banner, then the six checks under "The bar" | "Those clicks are the evidence. The source has to meet a bar before it may act alone: enough reviewed records, 99% on medications, and no value missing from the document." |
| 1:30 | Tab 4 | Point at one tile: "9 of 9 right, but only 76.9% sure" | "Nine of nine is not proof, so it is judged by what we can be 95% sure of." |
| 1:40 | Tab 5 Records | Refresh. Open the record from Tab 1 (**Auto-committed**) | "This one passed every check, so no person touched it." |
| 1:50 | Record page | Click **Decision**, then **Audit** | "Every score, decision and commit is in a tamper-evident trail. A slice of clean records still goes to a reviewer, so it keeps being measured." |
| 2:00 | | Stop | One-line close: "Software reads and codes, a rule-based router decides, and the evidence says when it may act alone." |

## If something goes wrong
- **The upload is still processing at 1:40:** say "the worker picks it up within a minute", and open the spare auto-committed record instead. Keep your narration going.
- **The new record went to review instead of committing:** open **Decision** and say "this is the system being careful; it found something it was not sure of". That is the product working.
- **Anything errors:** switch to screenshots of a good run.

## If you have an extra minute
- Press **Run evaluation** on a second, not-yet-evaluated source, choose Synthetic, confirm, and show the badge change. Then **Safety -> Enable auto-commit**.
- Show the **Why this outcome** panel for a record, or the calibration table ("does a high score mean it is right?").

## Say it if asked
- It runs on synthetic data. Real data needs licensed medical terminology, real consent integration, scanned-document reading and a safety review first.
- The model reads and suggests. Scoring, routing and committing are plain code that no model can override.
