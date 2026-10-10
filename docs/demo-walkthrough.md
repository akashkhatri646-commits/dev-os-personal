# Demo walkthrough: from document to automatic commit

About 20 minutes. Synthetic documents only. Show the loop: **review builds evidence, evidence unlocks auto-commit, auto-commit stays checked.**

## Before you start (once)
- Production or staging site is up, you are signed in as admin, System check shows no "Broken" items.
- A source exists and a test consent covers your test patient (Admin -> Consent).
- For a short demo only, set these Netlify variables and redeploy, and remove them afterwards:
  `EVAL_MIN_RECORDS=3`, `EVAL_MIN_FIELDS=15`, `EVAL_TARGET_ACCURACY=0.5`, `EVAL_TARGET_ACCURACY_OTHER=0.5`.
  Say out loud that the real bar is 50 records and 99% accuracy; the low bar is only to save time.
- Have 4 to 5 synthetic discharge summaries ready, each with a slightly different value so none is a duplicate.

## 1. A record comes in (3 min)
Ingest -> choose the source, enter the patient, upload a typed PDF. Open the record.
Point out: the pipeline row moving, **every value quotes the document line it came from**, codes next to diagnoses and drugs, a score per field, and "Inferred, not stated" tags with their 80% cap.
Message: the system never writes a value it cannot quote.

## 2. Why it went to a person (2 min)
On the record: **Why this outcome** and the Decision tab. Auto-commit is off, so everything is reviewed.
Message: automation has to earn trust, and the first stage is people checking it.

## 3. Reviewers build the evidence (5 min)
Review queue -> claim the record. Accept most fields, correct one value, reject one. Approve. Do the same quickly for 2 or 3 more records.
Message: every click is a measurement. Nobody labels data separately.

## 4. The report card (3 min)
Sources -> your source -> **Evaluation**. Show:
- the counts, and the red "of 50 needed" lines if you did not lower the bar;
- accuracy by kind of value, and the calibration table ("do high scores mean right?");
- the lower bound: "9 of 9 right, but only 76.9% sure" is the app refusing to overclaim;
- the suggested threshold per resource type.
Message: a few perfect results are not proof, and the app says so.

## 5. The gate (3 min)
Press **Run evaluation** (admin), choose "Synthetic", add a note. The source shows **Eval passed (synthetic)**.
Show what the gate does: Safety tab -> **Enable auto-commit** is now available (it was greyed out before). Optionally show that changing a threshold clears the pass and switches auto-commit off.
Set the medication threshold to 0.95 (the lowest allowed) on the Thresholds tab first, then enable auto-commit.
Message: auto-commit cannot be switched on by hand; it needs evidence, and a pass is always labelled synthetic or real.

## 6. A record commits by itself (3 min)
Set `SYSTEM_AUTOCOMMIT_ENABLED=true` and redeploy beforehand (the amber banner disappears). Ingest a new clean synthetic summary.
It should reach **Auto-committed** with no human. Open the Decision tab (scores against thresholds) and the Audit page (the full trail and the hash chain).
Be ready for: about 5 to 10% of clean records are randomly sent to review anyway. That is the audit sample, and it is shown as its own accuracy figure on the Evaluation tab.
Message: even when it acts alone, a slice is still checked, and every step is on record.

## What not to claim
- It measures mechanics on synthetic data. It is not a measure of accuracy on real hospital documents.
- Scanned PDFs and faxes need OCR, which is not set up.
- Nothing yet watches a source after the pass: someone must re-run the evaluation to catch drift.
- The consent ledger is a stand-in, and the terminology is sample data.

## Afterwards
Remove the four temporary evaluation variables, set `SYSTEM_AUTOCOMMIT_ENABLED=false` again unless you want it on, and redeploy.
