---
id: "pipeline-spec"
type: "technical-specification"
version: 1
created: 2026-04-12
owner: "saqib"
---

# Pipeline Specification — OutcomeLogic

This file is the technical reference for the extraction pipeline, Phase 0 validation study design, and future pipeline extensions. Read on demand (not at session start).

---

## Current 3-Node Pipeline (V2)

### Node 1 + 2: Sequential Extractors

**Model:** `gemini-2.5-flash-lite` (both) — see note below
**Concurrency:** Sequential (A then B) — parallel calls cause concurrency 503s on the API key

**⚠️ GEMINI API CONSTRAINTS (confirmed 2026-04-13 via systematic curl testing):**
- **No SDK** — `@google/generative-ai` and `@google/genai` both cause 503s. Use raw `fetch()` only.
- **`thinkingBudget: 512`** — always required. 0 = 503 on flash, 400 on pro. Missing = TPM exhaustion.
- **flash-lite not flash** — `gemini-2.5-flash` has persistent ~50% 503 rate. flash-lite is stable.
- **Sequential only** — `Promise.all` with 2 simultaneous calls → one 503s every time.
- **5 retries with exponential backoff** — built into `callGemini()` in pipeline.js.

**Extractor A prompt priority (required modification):**
```
EXTRACTION PRIORITY: Prefer adjusted estimates over unadjusted.
If multiple effect sizes are reported, select the primary analysis result
as pre-specified in the methods section. If ITT and per-protocol results
both appear, extract ITT. Always cite exact sentence/table location.
```

**Extractor B prompt priority (required modification):**
```
EXTRACTION PRIORITY: Prefer the primary reported outcome exactly as
labelled in the results section, regardless of statistical adjustment.
If multiple effect sizes appear, extract the first one reported in the
abstract results. Do not infer primacy from methods — extract what is
presented first. Always cite exact sentence/table location.
```

**Source citation requirement (add to both):**
```
For every extracted value, you MUST include a source_citation field:
- "text": verbatim sentence or table cell (max 30 words)
- "location": "Abstract" | "Results paragraph N" | "Table N" | "Figure N legend"

Example:
"hr_value": 0.68,
"hr_source_citation": {
  "text": "The hazard ratio for progression-free survival was 0.68 (95% CI 0.53–0.87)",
  "location": "Results paragraph 2"
}

If two citations are possible, cite both and flag as AMBIGUOUS_SOURCE.
```

### Node 3: Adjudicator

**Model:** Gemini 2.5 Pro

**Required framing (replace current passive prompt):**
> "Compare the two extraction reports. For each discrepancy, first identify why EACH extractor might be wrong before determining the correct value. For fields where both extractors agree, check: (a) do they cite the same source? (b) is there an alternative value in the paper that was not extracted? If both extractors agree AND multiple candidate values exist in the paper, flag as SUSPICIOUS_AGREEMENT with a note on the alternative value. Do not treat agreement as correctness — treat it as a hypothesis to verify."

**Add to adjudicator output schema:**
```json
"extraction_flags": {
  "suspicious_agreement": false,
  "suspicious_agreement_note": null,
  "ambiguous_source": false,
  "source_conflict": false,
  "source_conflict_note": null
}
```

### Node 4: Expert Context (async)

Runs asynchronously after adjudication. See commentary.js for implementation.
Three parallel search paths: Europe PMC citations, EPMC full-text, PubMed Entrez + web synthesis.
Timeout: 45s (`NODE4_TIMEOUT_MS`).

---

## V1 Single-Node Baseline

Single mega-prompt. No parallel extraction. No adjudicator. No source citations. No adversarial framing.
Used as naive baseline for Phase 0 comparison.

**Files:** `lib/pipeline-v1.js` + `api/analyze-v1.js` — to be built.

The V1 prompt should be a condensed single-pass version of the current extractor prompt. Its job is to provide a comparison baseline that reflects what a simple, off-the-shelf extraction approach would produce. Do not give it any of the Phase 0 hardening features.

---

## Phase 0 Validation Study Design

### Purpose

Unblinded pilot run by PI (Saqib). 10 papers. Goal: identify extraction errors and pipeline failure modes, modify prompts accordingly, before finalising V1/V2 architecture for Phase 1 power calculation.

**This is NOT a statistical phase.** No Kappa, no formal analysis. Pure qualitative error identification and prompt improvement.

### Papers

Run ALL 10 through BOTH V1 and V2. Mark all as `is_pilot = true`.

1. ORBITA
2. HIP ATTACK
3. SPORT (disc herniation)
4. UK FASHIoN
5. TKR RCT (Skou 2015)
6. STICH
7. EXCEL
8. PROFHER
9. SCOT-HEART
10. SPORT (spinal stenosis)

**Note:** Current `schema-study.sql` has different papers (CRASH-2, SPRINT, CheckMate 214, etc.) chosen for pipeline stress-testing. Confirm with Saqib whether to switch to the above surgical RCT list or retain the stress-test set.

### Supabase Schema — 5 Tables

```sql
-- 1. Papers
CREATE TABLE study_papers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pmid        TEXT UNIQUE,
  title       TEXT NOT NULL,
  authors     TEXT,
  journal     TEXT,
  year        TEXT,
  specialty   TEXT,
  phase       SMALLINT NOT NULL DEFAULT 0 CHECK (phase IN (0, 1, 2, 3)),
  is_pilot    BOOLEAN NOT NULL DEFAULT FALSE,
  status      TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete', 'error')),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Extractions (V1 + V2 outputs per paper)
CREATE TABLE study_extractions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id      UUID NOT NULL REFERENCES study_papers(id) ON DELETE CASCADE,
  version       TEXT NOT NULL CHECK (version IN ('v1', 'v2')),
  output_json   JSONB,
  source_type   TEXT,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(paper_id, version)
);

-- 3. Grades (per-field structured)
CREATE TABLE study_grades (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id           UUID NOT NULL REFERENCES study_extractions(id) ON DELETE CASCADE,
  session_id              UUID REFERENCES study_sessions(id),
  field_name              TEXT NOT NULL,
  match_status            TEXT CHECK (match_status IN ('exact_match','partial_match','fail','hallucinated')),
  error_taxonomy          TEXT CHECK (error_taxonomy IN ('omission','misclassification','formatting_syntax','semantic')),
  correction_text         TEXT,
  harm_severity           SMALLINT CHECK (harm_severity BETWEEN 1 AND 5),
  frequency_count         INTEGER DEFAULT 1,
  pipeline_section        TEXT CHECK (pipeline_section IN ('extractor','adjudicator','post_processing')),
  suspicious_agreement    BOOLEAN DEFAULT FALSE,
  suspicious_agreement_note TEXT,
  graded_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Rater assignments (Phase 2 blinding)
CREATE TABLE study_rater_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rater_id    TEXT NOT NULL,
  paper_id    UUID NOT NULL REFERENCES study_papers(id) ON DELETE CASCADE,
  version     TEXT CHECK (version IN ('v1', 'v2')),
  blinded     BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(rater_id, paper_id, version)
);

-- 5. Sessions
CREATE TABLE study_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id TEXT NOT NULL,
  paper_id    UUID REFERENCES study_papers(id),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  notes       TEXT
);
```

---

## Phase 0 Review UI Spec (`/pilot`)

### Route
`/pilot` — PI only. No blinding required for Phase 0.

### Layout
Split view:
- **Left panel:** paper metadata + V1 output fields
- **Right panel:** V2 output fields
- PDF opens in separate browser tab

### Assessment Criteria Per Field

**A. Match Status** (radio, required):
- Exact Match | Partial Match | Fail | Hallucinated

**B. Error Taxonomy** (dropdown, required on non-Exact Match):
- Omission | Misclassification | Formatting/Syntax | Semantic

**C. Correction** (text, required on non-Exact Match)

**D. Harm Score — two-axis pair** (required on non-Exact Match):
- **Severity** (1–5): 1=Cosmetic, 2=Minor clinical, 3=Moderate, 4=Serious, 5=Dangerous
- **Frequency** (auto-counter): tracks how many papers this field/error combo has occurred in
- Priority score = severity × frequency (shown in aggregate view)

**E. Pipeline Section Tag** (3-option, required on non-Exact Match):
- Extractor | Adjudicator | Post-processing

**F. Suspicious Agreement Flag** (checkbox + note, optional):
- Check when both V1 and V2 extracted the same wrong value. Highest-priority error type.

### Consistency Gate (blocking)

Before any primary endpoint field can be marked Exact Match, reviewer must complete a consistency check:
- HR numeric value (as extracted)
- 95% CI (as extracted)
- Arm labels: which arm is intervention, which is control

Reviewer confirms: "The direction of effect implied by the HR, the CI, and the arm labels are jointly coherent."
- Coherent → checkbox ticked → individual fields unlock for grading
- Not coherent → reviewer selects which field is wrong → that field pre-marked Fail

**This gate MUST block field-level marking. It cannot be optional.**

### Session Notes
Free text per paper. Secondary to structured error log. For qualitative observations that don't fit the taxonomy.

---

## `/pilot/summary` Aggregate View

- Error rate by field (% non-Exact Match across all papers)
- Error rate by pipeline section tag
- Severity × frequency heatmap by field
- Suspicious agreement flags: list of fields with correlated bias detected
- Prompt modification queue: fields ranked by priority score (severity × frequency)

This view is the output that drives prompt changes before Phase 1.

---

## Error Handling Architecture (Required for Phase 1 Scale)

### Exponential backoff with jitter

```javascript
async function callWithRetry(fn, maxRetries = 4) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries - 1) throw err;
      const isRetryable = err.status === 429 || err.status === 503 || err.name === 'TimeoutError';
      if (!isRetryable) throw err;
      const delay = Math.min(1000 * 2 ** attempt + Math.random() * 500, 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
```

Classify before retry:
- 429 rate limit → retry with backoff
- 503 unavailable → retry with backoff
- 408/timeout → retry with backoff
- 400 bad request → fail immediately (prompt is broken)
- 500 server error → retry once only

### Concurrency-limited queue

```javascript
async function runWithConcurrency(tasks, limit = 5) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = task().then(r => {
      executing.splice(executing.indexOf(p), 1);
      return r;
    });
    results.push(p);
    executing.push(p);
    if (executing.length >= limit) await Promise.race(executing);
  }
  return Promise.all(results);
}
```

### Per-stage timeout budgets
- Abstract screening: 10s per call
- Single-pass extraction: 30s per call
- 3-node adjudication: 45s per call
- Synthesis/pooling: 60s per call

---

## Future Phase 1 Architecture Notes (Do Not Build Yet)

### Meta-analysis pipeline
~180 LLM calls per run. ~$1.50–$5. ~6–8 mins parallelised.
- Single-pass extraction for corpus scale; confidence-based escalation to 3-node for flagged trials
- Concurrency-limited queue (max 5 parallel)
- Checkpoint persistence to Supabase after each trial
- Heterogeneity gate: LLM assesses clinical validity of pooling before producing forest plot

### Clinical question answering
~40 LLM calls per run. ~$0.40–$0.60.
Guideline check is a hard gate: if high-quality guideline exists (NICE/SIGN/Cochrane), surface it first.
Shares extraction stages 2–6 with meta-analysis pipeline.
