---
id: "pipeline-spec"
type: "technical-specification"
version: 4
created: 2026-04-12
updated: 2026-04-27
owner: "saqib"
---

# Pipeline Specification — OutcomeLogic

This file is the technical reference for the extraction pipeline. Read on demand (not at session start). For current architecture decisions and rationale, see `docs/DESIGN_DECISIONS.md`. For validation study design, see `docs/PROTOCOL.md`.

---

## Current Production Pipeline: V4

**Architecture:** V1 single extractor (Gemini flash-lite) → gpt-4o-mini critic (13 rules) → deterministic JS post-processing. Total: ~27–35s.

**V3 is deprecated** as the production pipeline (Sessions 12+). V3 (dual extractor + adjudicator) data is viewable in study.html but no new V3 runs are performed.

### Execution order (post-Session 17, current canonical)

```
runPipelineV1()
  → canonicaliseLegacyKeys()             n_arm_a→arm_a_n, 'null'→null, "159/891"→{events,N}, strip '%'
  → runCritic()                          gpt-4o-mini, 13 rules + Pass B, emits uncertain_candidate_fields
  → applyPatches()                       {applied, verifications, skipped}; CI null-guard; GRADE guard;
                                          provenance tags _<field>_source
  → mergeUncertainFields()               copies uncertain_candidate_fields onto candidate.uncertain_fields
  → restoreDroppedCandidateFields()      re-merges V1 snapshot after Rule 9 array replacement
  → coerceNumericFields()                string→Number on all numeric candidate fields
  → guardMDFabrication()                 MD/SMD: reset arm values when one≈0 and other≈|diff|
  → backCalculateEvents()                Priority 1: direct extraction; Priority 2: arm_n × rate%
  → backCalculateSD()                    Cochrane §6.5.2; 1.75× plausibility guard
  → normaliseOutcomeTypes()              time-to-event → time_to_event
  → enforceOutcomeTypeForRatioMeasures() HR always → time_to_event, unconditional
  → flagAmbiguousSelection()             ≥2 candidates with different effect_measure → selection_uncertain
  → auditMetaAnalysisFields()            missing split into uncertain vs absent
```

### Critic rules (Node 2 — gpt-4o-mini)

| Rule | What it checks / fixes |
|---|---|
| 1 | CI completeness — null-guard: only completes missing CI, never overwrites. JS CI null-guard is the enforcement layer. |
| 2 | AE table contamination — removes primary endpoint components from adverse events |
| 3 | Subgroup variable grouping — each variable = one item with ≥2 arms |
| 4 | RoB calibration |
| 5 | GRADE certainty calibration — JS GRADE guard blocks upgrades, allows downgrades only |
| 6 | COI/funding extraction — mandatory patch, non-overwrite |
| 7 | Per-arm values completeness — MD/SMD GUARD: cannot derive arm from between-arm difference |
| 8 | Meta-analysis field completeness (with back-calculation hint) |
| 9 | Secondary endpoint completeness — adds missing secondaries to candidates |
| 10 | NI trial framing — CI-excludes-margin direction check |
| 11 | Lay summary direction — checks against significance |
| 12 | Outcome type classification — note: `enforceOutcomeTypeForRatioMeasures()` is the enforcement; Rule 12 is a hint |
| 13 | SD per arm for continuous outcomes |

Pass B: holistic plausibility review — can emit patches for fixable errors.
Uncertainty tracking: emits `uncertain_candidate_fields` for irresolvable conflicting values.

---

## Legacy Pipeline: V3 (3-Node Dual-Extractor + Adjudicator)

### Node 1 + 2: Extractors A and B

**Extractor A:** `gemini-2.5-flash-lite` via `callGemini()` — adjusted/ITT priority
**Extractor B:** `gpt-4o-mini` (OpenAI) via `callOpenAI()` — first-reported/abstract priority
**Escalation:** `gemini-2.5-flash` for Extractor A when `isEscalation = true` is passed to `runPipeline()`
**Concurrency:** **Parallel** (`Promise.all`) when `OPENAI_API_KEY` is set — different providers, no shared concurrency limit. Sequential fallback (A then B, both Gemini) if key absent.
**Typical timing:** A+B parallel ~10–33s (gpt-4o-mini is faster), Adjudicator ~13s, total ~47s on full paper.

**⚠️ GEMINI API CONSTRAINTS (confirmed 2026-04-13 via systematic curl testing):**
- **No SDK** — `@google/generative-ai` and `@google/genai` both cause 503s on first call with large system instructions. Use raw `fetch()` to v1beta REST only. This is the deliberate architecture across all files.
- **`thinkingBudget: 512`** — always required. `0` = 503 on flash-lite, 400 on Pro. Missing = TPM exhaustion. `512` satisfies all models.
- **flash-lite not flash** — `gemini-2.5-flash` has persistent ~50% 503 rate on this account. flash-lite is stable.
- **Parallel safe only with different providers** — `Promise.all` with 2 simultaneous Gemini calls from same key → one 503s every time. Gemini+OpenAI parallel is safe.
- **5 retries with exponential backoff + jitter** — built into `callGemini()` in `lib/pipeline.js`. 400/401/403/404 are non-retryable and throw immediately.

**⚠️ OPENAI API CONSTRAINTS (confirmed 2026-04-15):**
- **No SDK** — raw `fetch()` to `https://api.openai.com/v1/chat/completions`. `Authorization: Bearer ${process.env.OPENAI_API_KEY}`.
- **`max_completion_tokens` not `max_tokens`** — `max_tokens` returns 400 on gpt-4o-mini and newer models.
- **Temperature 0.05 supported** on `gpt-4o-mini`. Do NOT use `gpt-5-mini` or any o-series reasoning model — they reject temperature and are very slow.
- **5 retries with exponential backoff + jitter** — built into `callOpenAI()`. Non-retryable on 400/401/403.
- **Falls back to Gemini** for Extractor B if `OPENAI_API_KEY` is absent.

**`callGemini()` pattern (canonical — all Gemini calls in the codebase must use this):**
```javascript
const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
const body = {
  system_instruction: { parts: [{ text: systemInstruction }] },
  contents: [{ role: 'user', parts: [{ text: userContent }] }],
  generationConfig: {
    temperature: options.temperature ?? 0.05,
    thinkingConfig: { thinkingBudget: 512 },
    ...(options.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
  },
};
// 5-retry loop: non-retryable on [400,401,403,404]; backoff = min(1000*2^(attempt-1) + jitter, 15000)
```

**`callOpenAI()` pattern (canonical — Extractor B):**
```javascript
const url = 'https://api.openai.com/v1/chat/completions';
const body = {
  model: 'gpt-4o-mini',
  temperature: options.temperature ?? 0.05,
  max_completion_tokens: options.max_completion_tokens ?? 8000,
  messages: [
    { role: 'system', content: systemInstruction },  // omitted if null
    { role: 'user', content: userContent },
  ],
};
// 5-retry loop: non-retryable on [400,401,403]; retryable on 429/500/503
// throws OPENAI_UNAVAILABLE on quota exhaustion
```

**Extractor A — adjusted/ITT priority:**
```
EXTRACTION PRIORITY: Prefer adjusted estimates over unadjusted.
Select the primary analysis result as pre-specified in the methods.
If ITT and per-protocol results both appear, extract ITT.
Always cite exact sentence/table location via source_citation.
```

**Extractor B — first-reported/abstract priority + co-primary and abstract/full-text rules:**
```
EXTRACTION PRIORITY: Prefer the primary reported outcome exactly as
labelled in the results section, regardless of adjustment.
Extract the first effect size reported in the abstract results.
Do not infer primacy from methods — extract what is presented first.

CO-PRIMARY RULE: If the trial specifies co-primary endpoints, list ALL of them.
Do not select one. Flag co_primary = true.

ABSTRACT vs FULL-TEXT RULE: If the abstract value and the full-text table value differ,
record BOTH and set source_conflict = true. Do not default to the abstract.
```

**Source citation requirement (both extractors):**
```
For every extracted value, include source_citation:
- "text": verbatim sentence or table cell (max 30 words)
- "location": "Abstract" | "Results paragraph N" | "Table N" | "Figure N legend"

If two citations conflict, cite both and flag as AMBIGUOUS_SOURCE.
```

**Candidate values — mandatory for primary endpoint effect size (both extractors):**
```
List ALL numeric values that could plausibly be the primary result (maximum 3).
Label each explicitly:
  candidate_values:
    1. value=X.XX | label="adjusted HR, Cox model, Table 2" | population=ITT | [SRC: ...]
    2. value=X.XX | label="unadjusted HR, abstract Results"  | population=ITT | [SRC: ...]

Cover: adjusted vs unadjusted, ITT vs PP, interim vs final, subgroup.
The adjudicator uses this list to rank and select — do not omit candidates.
```

**`capOutput()` truncation flag:**
Extractor raw output is capped at 40,000 characters (`EXTRACTOR_OUTPUT_CAP`). `capOutput()` returns `{ text, truncated }`. If `truncated = true`, the adjudicator input includes:
```
[TRUNCATION NOTICE — Extractor X report was truncated at 40,000 chars.
Treat all absent fields as UNKNOWN, not as omissions.]
```
The adjudicator must never infer that a missing field was not extracted — it may have been cut.

---

### Node 3: Adjudicator

**Model:** `gemini-2.5-flash-lite` (same as extractors — `GEMINI_MODEL_PRO` is defined but not used in current pipeline)
**Temperature:** `0.0` (deterministic)
**Output format:** `application/json` via `responseMimeType`

**Adversarial framing:**
> "Compare the two extraction reports. For each discrepancy, first identify why EACH extractor might be wrong before determining the correct value. For fields where both extractors agree, check: (a) do they cite the same source? (b) is there an alternative value in the paper that was not extracted? If both extractors agree AND multiple candidate values exist in the paper, flag as SUSPICIOUS_AGREEMENT. Do not treat agreement as correctness — treat it as a hypothesis to verify."

**Candidate value ranking block:**
The adjudicator receives all `candidate_values` from both extractors and compiles them into `primary_endpoint_candidates`. The adjudication task is ranking over a provided set, not open-ended search. This is the structural fix for correlated extraction bias.

**Adjudicator output schema additions (beyond standard fields):**
```json
"extraction_flags": {
  "suspicious_agreement": false,
  "suspicious_agreement_note": null,
  "ambiguous_source": false,
  "source_conflict": false,
  "source_conflict_note": null
},
"source_citations": {
  "primary_outcome": { "text": "...", "location": "..." },
  "effect_size":     { "text": "...", "location": "..." }
},
"primary_endpoint_candidates": [
  {
    "value": 0.0,
    "label": "String",
    "population": "ITT | PP | mITT | null",
    "source_a": "String or null",
    "source_b": "String or null",
    "selected": true
  }
]
```

**Known residual limitation:** Correlated table misread — both extractors misread the same table identically — produces a single candidate and is structurally undetectable. This is the residual failure mode for Phase 0. See LEARNINGS.md "Adjudicator cannot detect errors it has no candidates for."

**Subgroup output schema (extended Session 6):**
Each subgroup entry includes:
- `pre_specified` / `post_hoc` (boolean) — credibility flags; post-hoc subgroups are substantially less reliable
- `cis_all_cross_one` (boolean) — true when ALL arm CIs include 1.0 (no individual arm is statistically significant, even if interaction p < 0.05)
- `direction_vs_hypothesis` — whether the observed direction matches the a priori hypothesis
- `interaction_note` — plain-language explanation of what the interaction p-value means (the p-value tests variation in treatment effect across subgroups, NOT individual group significance)
- Per arm: `ci_crosses_one` (boolean), `absolute_events`
- `outcome` — which endpoint this subgroup analysis applies to

The interaction p-value is a common source of clinical misinterpretation. An interaction p < 0.05 means the treatment effect *varies* across subgroups — it does not mean any individual subgroup is significant. See LEARNINGS.md "Subgroup interaction p-value meaning is counterintuitive."

---

### Node 4: Expert Context (async)

Runs asynchronously after adjudication. See `lib/commentary.js` for implementation.

**Three search paths (all via `Promise.allSettled` — partial results survive any single API hang):**
1. Europe PMC citations + full-text links
2. PubMed Entrez summary + related articles
3. Name search (trial acronym) + web synthesis via Gemini with `googleSearch` tool

**Timeout:** 45s (`NODE4_TIMEOUT_MS`). `[postProcess] expertContext status: error` in logs = timeout, not a code bug.
**Synthesis gate:** `MIN_ITEMS_FOR_SYNTHESIS = 3` — synthesis only runs with ≥3 meaningful citation items.

---

## V1 Single-Node Baseline

**Status:** Not yet built. Required before Phase 1 powered validation study — not needed for Phase 0.

Phase 0 runs V3 only. Phase 1 will compare V1 vs V3 across N≥25 papers with ≥2 independent raters.

Single mega-prompt. No parallel extraction. No adjudicator. No source citations. No adversarial framing. No `candidate_values`. Used as naive baseline for Phase 1 comparison.

**Files to build:** `lib/pipeline-v1.js` + `api/analyze-v1.js`

The V1 prompt is a condensed single-pass version of the current extractor core. Its job is to reflect what a simple, off-the-shelf extraction approach would produce. Do not include any Phase 0/Phase 1 hardening features — no adversarial framing, no truncation flags, no candidate values.

---

## Phase 0 Validation Study Design

### Purpose

Unblinded pilot run by PI (Saqib). 10 papers. Goal: identify and eliminate systematic extraction errors in V3 before scaling to Phase 1. No comparison arm — Phase 0 is V3-only. V1 comparison is deferred to Phase 1.

**This is NOT a statistical phase.** No Kappa, no formal analysis. Pure qualitative error identification and prompt improvement.

Go/no-go gate for Phase 1: ≥85% exact match on primary numeric fields.

### Papers

Run all 10 through V3. All seeded in `supabase/schema-study.sql` with `is_pilot = true`, `phase = 0`.

1. ORBITA (PMID 29126895) — sham-controlled RCT, blinding extraction
2. HIP ATTACK — time-to-event, surgical specialty
3. SPORT disc herniation (PMID 17545430) — complex crossover, JAMA
4. UK FASHIoN — non-inferiority design, UK multicentre
5. TKR RCT Skou 2015 (PMID 26488691) — continuous outcome extraction
6. STICH (PMID 21463148) — survival data, multiple time points
7. EXCEL (PMID 27117439) — contentious long-term outcomes, PCI vs CABG
8. PROFHER — null primary endpoint, NI design
9. SCOT-HEART (PMID 31475798) — 5-year follow-up extraction
10. SPORT spinal stenosis (PMID 18997196) — companion to SPORT disc

### Supabase Schema

**Canonical source:** `supabase/schema-study.sql` — do not duplicate SQL here. The schema has been rebuilt (Session 2, updated Session 5). Key points:

- 6 tables: `study_papers`, `study_extractions`, `study_raters`, `study_grades`, `study_rater_assignments`, `study_sessions`
- `study_extractions.version` is **free-form TEXT** (no CHECK constraint) for Phase 0 prompt iteration. Add `CHECK (version IN ('v1', 'v3'))` before Phase 1 freeze.
- `study_grades` uses `extraction_id` (not `output_id` — earlier name was changed in Session 2)
- RLS enabled on all tables — service role key bypasses automatically
- Run `schema-study.sql` in Supabase SQL Editor before first Phase 0 paper is graded. DROP TABLE statements at top wipe existing data.

---

## Phase 0 Review UI Spec (`/pilot`)

**Files:** `public/pilot.html` (per-field grading) + `public/pilot-summary.html` (aggregate heatmap)
**Status:** Both built (Session 3, 2026-04-12).

### Assessment Criteria Per Field (26 fields)

**A. Match Status** (radio, required):
- Exact Match | Partial Match | Fail | Hallucinated

**B. Error Taxonomy** (dropdown, required on non-Exact Match):
- Class 1: Recall Failure | Class 2: Correlated Recall Failure | Class 3: Ranking Failure | Class 4: Misclassification | Class 5: Interpretation Failure | Class 6: Hallucination | Class 7: Formatting/Enum
- Full definitions and decision tree in `docs/ERROR_TAXONOMY.md`

**C. Correction** (text, required on non-Exact Match)

**D. Harm Severity** (1–5, required on non-Exact Match):
- 1 = Cosmetic, 2 = Minor clinical, 3 = Moderate, 4 = Serious, 5 = Dangerous/misleading
- Priority score = severity × frequency (per-field, across papers)

**E. Pipeline Section Tag** (required on non-Exact Match):
- Extractor | Adjudicator | Post-processing

**F. Suspicious Agreement Flag** (checkbox + note, optional):
- Check when both extractors (A and B) extracted the same wrong value. Highest-priority error type — indicates correlated bias that persisted through adjudication.

### Consistency Gate (blocking, before primary endpoint field grading)

Gate is **built and generalised** (Session 7, 2026-04-15). Dynamic from `effect_measure` — works for HR, OR, RR, MD, SMD, RD.

Gate displays from `clinician_view.interactive_data.endpoints[0]`:
- Effect measure type
- Point estimate + 95% CI
- Arm A / Arm B group names
- Analysis population (ITT/PP/mITT) and adjusted flag

Reviewer confirms: "The direction of effect, CI, and arm labels are jointly coherent."
- **Coherent** → all field cards unlock
- **Not coherent** → reviewer identifies which element is wrong (direction / CI / arm labels / value / multiple) → `primary_result_values` pre-marked Fail with pre-populated correction → all other field cards unlock

**This gate blocks field-level marking. It cannot be skipped.**

### `/pilot/summary` Aggregate View

- Error rate by field (% non-Exact Match across all papers)
- Error rate by pipeline section
- Severity × frequency heatmap (red/amber/green by priority score)
- Suspicious agreement flags: fields with correlated bias detected
- Prompt modification queue: fields ranked by priority score
- CSV download
- Version comparison delta (Phase 1: V1 vs V3 — not applicable in Phase 0)

---

## Error Handling Architecture

### Built into `callGemini()` (current — all LLM calls)

5-retry loop with exponential backoff + jitter, built directly into `callGemini()` in `lib/pipeline.js` and mirrored in `lib/commentary.js`. Non-retryable on HTTP 400/401/403/404 (throws immediately). Retryable on 429, 503, network errors.

```
delay = min(1000 * 2^(attempt-1) + random(0-500ms), 15000ms)
```

After all retries exhausted: throws `GEMINI_UNAVAILABLE:` error, caught in `api/analyze.js` handler and returned as HTTP 503 with user-facing message.

### Per-stage timeout budgets (Phase 1 — not yet enforced per-call)

- Abstract screening: 10s per call
- Single-pass extraction: 30s per call
- 3-node adjudication: 45s per call
- Synthesis/pooling: 60s per call

Node 4 has a 45s overall timeout (`NODE4_TIMEOUT_MS`). Per-call budgets are a Phase 1 requirement.

### Concurrency-limited queue (Phase 1 — not yet built)

For corpus-scale meta-analysis. Required before Phase 1 runs.

```javascript
async function runWithConcurrency(tasks, limit = 5) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = task().then(r => { executing.splice(executing.indexOf(p), 1); return r; });
    results.push(p);
    executing.push(p);
    if (executing.length >= limit) await Promise.race(executing);
  }
  return Promise.all(results);
}
```

---

## Future Phase 1 Architecture Notes (Do Not Build Yet)

### Model diversity for extractors

**Implemented (Session 6):** Extractor B uses `gpt-4o-mini` (OpenAI) — cross-model diversity achieved. For Phase 1 at scale, consider upgrading Extractor B to `gpt-4o` if Phase 0 results reveal residual correlated errors.

### Meta-analysis pipeline

~180 LLM calls per run. ~$1.50–$5. ~6–8 mins parallelised.
- Single-pass extraction for corpus scale; confidence-based escalation to 3-node for flagged trials
- Concurrency-limited queue (max 5 parallel, see above)
- Checkpoint persistence to Supabase after each trial
- Heterogeneity gate: LLM assesses clinical validity of pooling before producing forest plot

### Clinical question answering

~40 LLM calls per run. ~$0.40–$0.60.
Guideline check is a hard gate: if high-quality guideline exists (NICE/SIGN/Cochrane), surface it first.
Shares extraction stages 2–6 with meta-analysis pipeline.
