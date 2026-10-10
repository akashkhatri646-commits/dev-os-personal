# 3-minute demo pitch: Trust at the Edge

One idea to land: **the system only acts on its own after it has proven it is right, and every step is on record.**

## Stage this before the audience arrives (10 minutes)
- Signed in as admin on the live site. System check has no "Broken" items.
- Auto-commit is on system-wide. The demo source has reviewed records (enough for the evaluation to run), and its evaluation is **not yet run** (or run it fresh: change any threshold to clear an old pass).
- Tab 1: **Records**, with one record in **Needs review** ready to open (call it Record A).
- Tab 2: **Ingest**, with a fresh, never-uploaded synthetic PDF selected and the patient filled in, ready to press Submit.
- Tab 3: the demo source's **Evaluation** tab.
- Spare: one record already **Auto-committed** and its Audit page, in case live processing is slow. Screenshots of a good run on your desktop.

## The narrative with the exact steps

**0:00 – 0:25 | The problem (no clicking)**
> "Hospitals send us discharge summaries as PDFs, scans and notes. Turning those into structured health data is slow and error-prone, but letting software write into a clinical record unchecked is dangerous. Trust at the Edge solves both: software reads and codes the document, and it only acts alone once it has earned that right."

**Step: in Tab 2, press Submit on the fresh PDF.** (It processes while you talk.)
> "I've just sent a new document. While it runs, here is one that's already been processed."

**0:25 – 1:05 | Grounded extraction (Tab 1, open Record A)**
1. Show the pipeline row: consent, reading, extracting, mapping, validation, scoring, routing.
2. **Fields tab:** point to a date and a medication, and the **Cited text** column.
3. Point to one tag, "Inferred, not stated", and its capped score.
> "Every value comes with the exact sentence it was taken from. If the system can't quote it, it isn't written. A value the model only inferred is marked and scored lower."
4. Open the **Decision tab** (or "Why this outcome").
> "Each part of the record gets a score and is compared with a threshold. This one needs a person, and it says why."

**1:05 – 1:45 | Human review (Review queue)**
1. **Review queue** -> open Record A -> claim.
2. Accept one field, correct one value, press **Approve**.
> "Reviewers do the work humans are good at. And every click is also a measurement: right, fixed, or rejected."

**1:45 – 2:30 | The evidence gate (Tab 3, Evaluation)**
1. Show the counts and the six checks under "The bar".
2. Point at one result: "9 of 9 right, but only 76.9% sure."
> "Nine out of nine isn't proof, so the system works out how sure it can be. A few perfect results can't earn trust."
3. Show the calibration table: "do high scores mean right?"
4. Press **Run evaluation** -> choose **Synthetic** -> add a note -> confirm. The badge becomes **Eval passed (synthetic)**.
> "The bar is higher in production: fifty reviewed records and 99% on medications. For today's demo it is lowered, and it's labelled synthetic so no one mistakes it."
5. **Safety tab** -> **Enable auto-commit**.
> "Only now can this source commit on its own. There's no way to switch it on by hand."

**2:30 – 3:00 | It commits itself, with proof (Tab 2, then Audit)**
1. Go back to the record from Tab 2. It should read **Auto-committed**.
2. Open **Decision**, then **Audit**.
> "No human touched it. Every score, decision and commit is in a tamper-evident audit trail. And a slice of clean records is still randomly sent to a reviewer, so we keep measuring."

**Close (one sentence)**
> "Software reads and codes the document, a rule-based router decides whether it needs a person, and the evidence says when it can act alone."

## If something goes wrong
- **Record still in "Received" at 2:30:** say "this is the safety-net worker, it runs each minute", then open your spare auto-committed record instead.
- **The record went to review instead of committing:** open **Why this outcome** and say "this is the system being careful: it found a value it wasn't sure of, and it asks a person". That is the point of the product.
- **Anything errors:** switch to the screenshots and continue the story.

## Say it if asked
- It's synthetic data only. Real data needs licensed medical terminology, real consent integration, scanned-document reading and a safety review first.
- The model reads and suggests. Scoring, routing and committing are plain code that no model can override.
