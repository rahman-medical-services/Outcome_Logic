---
id: "features"
type: "backlog"
version: 1
created: 2026-04-12
owner: "saqib"
---

# FEATURES — OutcomeLogic Backlog

Features by phase. ✅ = shipped, 🔧 = in progress / partially built, ⬜ = backlog. Pick up from here at the start of any session.

---

## Phase 0 — Pre-Run (BLOCKING)

These must be complete before any Phase 0 paper runs.

### ✅ Extractor diversity — Extractor A and B split prompts
**Status:** Complete (Session 2, 2026-04-12).
**Location:** `lib/pipeline.js` — `EXTRACTOR_PROMPT_A` (adjusted/ITT priority) + `EXTRACTOR_PROMPT_B` (first-reported priority).

### ✅ Source citation requirement in extractor output
**Status:** Complete (Session 2, 2026-04-12).
**Location:** `lib/pipeline.js` — Section 10 of `EXTRACTOR_CORE`. Mandatory `source_citation` + `source_citations` schema in adjudicator output.

### ✅ Adversarial adjudicator framing
**Status:** Complete (Session 2, 2026-04-12).
**Location:** `lib/pipeline.js` — `ADJUDICATOR_PROMPT_BASE` rewritten. `extraction_flags` added to output schema.


---

## Phase 0 — Study Infrastructure

### ✅ Supabase schema rebuild — 5 tables per spec
**Status:** Complete (Session 2, 2026-04-12). Deploy to Supabase before running UI.
**Location:** `supabase/schema-study.sql` — `study_papers`, `study_extractions` (not study_outputs), `study_sessions`, `study_grades` (per-field structured), `study_rater_assignments`. 10 Phase 0 papers seeded.

### ✅ `docs/PROTOCOL.md` — pre-registration protocol
**Status:** Complete (Session 3, 2026-04-12).
**Contains:** 26-field list with severity_max, match_status operational definitions with worked examples, harm severity rubric with anchor vignettes (template — Saqib to add clinical anchors), priority_score formula, Phase 1 publication requirements.
**Action needed:** Saqib to fill in clinical anchor vignettes before first paper is graded (2–3 hrs).

### ✅ `api/study-grade.js` — grade read/write endpoint
**Status:** Complete (Session 3, 2026-04-12).
**GET** `/api/study-grade?output_id=<uuid>` — returns all grades for an output.
**POST** `/api/study-grade` — upserts single field grade, conflict on (output_id, field_name).
**Schema dependency:** `UNIQUE(output_id, field_name)` constraint added to `study_grades` in SQL.

### ✅ `api/study-summary.js` — aggregated heatmap data
**Status:** Complete (Session 3, 2026-04-12).
**Returns:** per-field priority scores, exact/partial/fail/hallucinated counts, avg severity, version breakdown, taxonomy breakdown, prompt modification queue (fields with priority_score > 1.0).

### ✅ `public/pilot.html` — per-field grading interface
**Status:** Complete (Session 3, 2026-04-12).
**Features:** Paper list with grade progress pills (0/26 → 26/26), split-panel grading view (paper links + extraction flags left, 26 field cards right), auto-save per field, progress bar, pre-populate from existing grades.

### ✅ `public/pilot-summary.html` — severity × frequency heatmap
**Status:** Complete (Session 3, 2026-04-12).
**Features:** Stats bar, priority heatmap (red/amber/green by priority_score), version comparison delta, error taxonomy table, pipeline section table, prompt modification queue, CSV download.

---

## Phase 0 — Deployment

### ✅ Merge `claude/competent-borg` + `claude/sweet-mccarthy` → main
**Status:** Complete (Session 6, 2026-04-15). All pipeline changes merged and pushed.

### ⬜ Deploy `schema-study.sql` to Supabase
**Status:** SQL rebuilt and ready. Must be run before pilot.html can save grades.
**Action:** Supabase Dashboard → SQL Editor → New query → paste contents of `supabase/schema-study.sql` → Run.
**Note:** DROP TABLE statements at top will clear any existing study data.

### ⬜ Verify HALT-IT post-deploy
**Status:** Pending. Check Vercel logs: `[Node 4] PubMed Entrez resolved "HALT-IT"`.

### ⬜ `riskTable1/riskTable2` rendering
**Status:** Elements in pipeline output but `renderRiskTable` may not be wired.
**Check:** Verify after merge.

---

## Phase 0 — Required Pipeline Fixes Before Clinical Deployment

### ⬜ NI trial structured output fields **[High — PROFHER will expose this]**
**Status:** Not started.
**Problem:** NI margin, CI-excludes-NI check, and NI result label are buried in the `primary_outcome` string. No structured output fields. PROFHER (paper 7 of Phase 0) is a NI design — conflating NI success with superiority is a severity-5 error.
**Fix:** Add `ni_margin`, `ni_margin_excluded_by_ci` (boolean), `ni_result_label` as structured fields to the adjudicator output schema in `lib/pipeline.js` and `postProcess()`.
**Effort:** 30–45 mins.

### ✅ `capOutput()` truncation flag **[Medium]**
**Status:** Complete (Session 5, 2026-04-14).
**Location:** `lib/pipeline.js` — `capOutput()` returns `{ text, truncated }`. `TRUNCATION NOTICE` injected into adjudicator input. Adjudicator treats absent fields from truncated reports as UNKNOWN.

### ✅ Raise `MIN_ITEMS_FOR_SYNTHESIS` to 3 **[Low]**
**Status:** Complete (Session 5, 2026-04-14).
**Location:** `lib/commentary.js` line 24.

### ✅ Patient/clinician view recommendation language audit **[Medium — liability]**
**Status:** Complete (Session 5, 2026-04-14).
**Location:** `lib/pipeline.js` — `lay_summary` critical instructions now explicitly prohibit "is better", "recommends", "confirms", "establishes". `shared_decision_making_takeaway` schema description rewritten.

---

### ✅ `candidate_values` array — extractor and adjudicator **[High — pre-Phase 0]**
**Status:** Complete (Session 5, 2026-04-14).
**Location:** `lib/pipeline.js` — `_EXTRACTOR_SHARED_SECTIONS` section 4, `ADJUDICATOR_PROMPT_BASE` candidate ranking block, adjudicator output schema `primary_endpoint_candidates` array.
**What it does:** Extractors list all plausible primary endpoint values (max 3, labelled: adjusted/unadjusted, ITT/PP, interim/final, subgroup). Adjudicator compiles into `primary_endpoint_candidates`, ranks, and marks `selected: true`. Converts adjudication from search problem to ranking problem. Addresses GPT failure cases 1 (adjusted/unadjusted trap), 4 (abstract framing), 6 (timepoint confusion), 7 (metric substitution).

### ✅ Extractor B co-primary and abstract/full-text strengthening **[High — pre-Phase 0]**
**Status:** Complete (Session 5, 2026-04-14).
**Location:** `lib/pipeline.js` — `EXTRACTOR_PROMPT_B` priority rules.
**What it does:** Explicit co-primary rule (list all, don't select one). Explicit abstract vs full-text rule: when they differ, record both and flag; do NOT default to abstract value.

### ✅ Node 4 `Promise.allSettled()` — partial result recovery **[Medium]**
**Status:** Complete (Session 5, 2026-04-14).
**Location:** `lib/commentary.js` — all four `Promise.all` calls converted: external API fan-out (EPMC/PubMed/name search), abstract batch fetch, `_runSynthesis`.
**What it does:** One hanging API no longer drops results from the others. EPMC data survives PubMed timeout, and vice versa.

### ✅ Schema version constraint relaxed **[Low — pre-Phase 0]**
**Status:** Complete (Session 5, 2026-04-14).
**Location:** `supabase/schema-study.sql` — `study_extractions` and `study_rater_assignments`.
**What it does:** Removed `CHECK (version IN ('v1', 'v2'))`. Free-form TEXT for Phase 0 prompt iteration. Add formal CHECK before Phase 1 freeze.

### ✅ Pilot UI consistency gate **[Completed Session 7, 2026-04-15]**
**Status:** Complete.
**What was built:** Blocking gate rendered at top of grading view before field cards are unlocked. Displays extracted effect measure, point estimate, 95% CI, arm labels, population, and adjusted status from `clinician_view.interactive_data.endpoints[0]`. Two paths: (a) Coherent → all fields unlock; (b) Not coherent → reviewer identifies which element is wrong → `primary_result_values` pre-marked Fail + correction pre-populated → all fields unlock. Gate is dynamic from `effect_measure` output — works for HR, OR, RR, MD, SMD, RD.

---

## Phase 1 — Scale and Publication

### ⬜ `lib/pipeline-v1.js` — single-node V1 baseline
**Status:** Not started. Required before Phase 1 powered validation study — not needed for Phase 0.
**Spec:** Single mega-prompt, no parallel extractors, no adjudicator. Condensed extractor prompt only. NO source citations, NO adversarial framing. Serves as comparison arm for Phase 1 statistical validation.
**Effort:** Medium (1–2 hrs).

### ⬜ `api/analyze-v1.js` — V1 endpoint
**Status:** Not started.
**Spec:** Thin wrapper calling `pipeline-v1.js`. Same rate limiting as `analyze.js`.
**Effort:** Easy (30 min, mostly copying analyze.js structure).

---

### ✅ Model diversity — gpt-4o-mini as Extractor B **[Completed Session 6, 2026-04-15]**
**Status:** Complete.
**What was built:** Extractor B now uses `gpt-4o-mini` (OpenAI) via `callOpenAI()` in `lib/pipeline.js`. Raw `fetch()` to `v1/chat/completions`. `max_completion_tokens: 8000`, temperature 0.05. 5-retry backoff. Falls back to Gemini flash-lite if `OPENAI_API_KEY` absent.
**Cross-model diversity achieved:** Gemini (A) + OpenAI (B). Correlated table misreads now produce detectable discrepancies rather than silent consensus.
**Timing:** gpt-4o-mini responds in ~3–10s (vs ~26s for Gemini flash-lite on same input).

### ⬜ Phase 1 powered validation study **[Publication path]**
**Status:** Planned. Depends on Phase 0 findings.
**Requirements for JAMIA/JBI/npj Digital Medicine publication:**
1. Pre-specified protocol (in `docs/PROTOCOL.md` — Saqib to finalise clinical anchors)
2. N≥25 papers per version (power to detect 15pp improvement at 80%, α=0.05)
3. ≥2 independent raters for primary fields, kappa ≥ 0.6
4. Prospective blinding: reference standard established before AI output is reviewed
5. Source_type stratification in analysis (full-text vs abstract-only)
6. CONSORT-AI or equivalent reporting framework compliance
7. Comparison against published benchmark where available

---

## Phase 2 — Meta-Analysis Module (Future — Do Not Build Yet)

**Strategic position (from Session 3 adversarial review):** AI-assisted evidence synthesis for clinician review — NOT automated meta-analysis. Three human curation gates are non-negotiable: study selection, extraction sign-off, GRADE confirmation. Fully automated meta-analysis is not PRISMA-compliant and is not scientifically defensible.

**Commercial frame:** Institutional subscription (medical schools, hospital departments) for research/education. Not SaMD. Intended use = "clinical research tool for evidence synthesis for review by qualified clinicians."

**Go/no-go gate:** Phase 0 heatmap must show ≥85% exact match on primary numeric fields before committing Phase 1 engineering investment.

**3-month MVP build order:**

### ⬜ Python statistical microservice **[Month 1]**
DerSimonian-Laird / REML random effects, I², tau², Q, Egger's test (N≥10), forest plot coordinates.
Input: `[{ effect_size, variance, trial_id }]`. Deploy as Vercel serverless Python function.
JavaScript has no mature meta-analysis library — Python is required.

### ⬜ ClinicalTrials.gov API integration **[Month 1]**
Add to `api/search.js` alongside PubMed. Free API. Required for defensible grey literature search.

### ⬜ PICO disambiguation layer **[Month 2]**
NL clinical question → structured PICO JSON → search query. Extend `buildPubmedQueryWithGemini()`.

### ⬜ Abstract screening step **[Month 2]**
flash-lite batch classify each candidate as relevant/irrelevant/uncertain. Human gate for uncertain cases.

### ⬜ Outcome harmonisation check **[Month 2]**
Structured outcome field extraction (concept + modifier + timeframe + instrument). Pairwise similarity across trials. Flag mismatched definitions for human review before pooling. This is the most underappreciated failure mode — CRASH-2/3/WOMAN/HALT-IT all measure mortality differently.

### ⬜ Meta-analysis synthesis view **[Month 3]**
Forest plot rendering (client-side), I² display, hedged narrative (Gemini Pro), GRADE component review (human gate). Language constraint: no "confirms"/"establishes"/"recommends" — only "this analysis suggests"/"the pooled estimate indicates."

### ⬜ Automated meta-analysis pipeline (full)
~180 LLM calls per run. ~$1.50–$5 per run. ~6–8 mins parallelised.

**Key architecture decisions (agreed, not yet implemented):**
- Single-pass extraction for corpus scale, confidence-based escalation to 3-node for flagged trials
- Concurrency-limited Promise queue (max 5 parallel) — not Promise.all
- Exponential backoff with jitter on all LLM calls (see PIPELINE_SPEC.md)
- Checkpoint persistence to Supabase after each trial extraction
- I² computed by Python stats microservice; LLM assesses clinical validity of pooling

### ⬜ Clinical question answering
~40 LLM calls per run. ~$0.40–$0.60 per run. Shares stages 2–6 with meta-analysis pipeline.

### ⬜ Error handling — exponential backoff with jitter
See PIPELINE_SPEC.md for `callWithRetry()` and `runWithConcurrency()`. Must be added before corpus-level runs.

---

## Phase 2 — Tier System (Future)

### ⬜ Registrar / Consultant tier definitions (`public/config/tiers.js`)
**Status:** File exists but empty (`paidTier: false`).
**Spec:** Registrar and Consultant tier definitions. Feature flags per tier.

### ⬜ Phase 1 rater UI (`/registrar-review`, `/consultant-review`)
**Status:** Not started. Phase 0 completes first; Phase 1 architecture follows from its findings.

---

## Backlog — Quality & Observability

### ⬜ Downstream sanity checks (pre-pooling, meta-analysis layer)
Before pooling:
- Impossible consistency (identical rounding across trials)
- Effect size distribution anomalies (all HRs same direction and similar magnitude)
- "Too clean" datasets (no trial has any missing fields)
These are Phase 1 concerns, not Phase 0.

### ⬜ Exclusion logging at extraction time
Currently there is no structured log of what was excluded from extraction and why. Build into the pipeline as a `extraction_exclusions` field.

### ⬜ Per-stage timeout budgets
Currently only Node 4 has a timeout (`NODE4_TIMEOUT_MS = 45000`). Per-call timeouts needed for meta-analysis scale:
- Abstract screening: 10s
- Single-pass extraction: 30s
- 3-node adjudication: 45s
- Synthesis/pooling: 60s

---

## Notes

- **Priority for next session:** Deploy schema → generalise pilot UI consistency gate → fill PROTOCOL.md anchor vignettes → run Phase 0 papers (V3 only) → review heatmap
- **Do not begin Phase 2 meta-analysis until Phase 0 go/no-go** (≥85% exact match on primary numeric fields)
- **The Phase 0/Phase 1 validation paper is the commercial moat** — it is not optional quality assurance
- Session 1 (2026-04-12): CLAUDE.md, docs/ directory, adversarial review initiated
- Session 2 (2026-04-12): Pipeline hardening (extractor diversity, adversarial adjudicator, source citations, NI handling, 10 fixes)
- Session 3 (2026-04-12): Phase 0 grading infrastructure, strategic adversarial review (HAWK/FALCON/EAGLE/OWL), meta-analysis strategy
- Session 4 (2026-04-13): Gemini SDK removal, flash-lite primary model, sequential extractors, thinkingBudget:512, 5-retry backoff, api/study.js consolidation — first successful pipeline run confirmed
- Session 5 (2026-04-14): Adversarial critique review (Gemini + GPT, stress-tested against codebase by agents). candidate_values array, Extractor B strengthening, capOutput truncation flag, Node 4 allSettled, MIN_ITEMS_FOR_SYNTHESIS=3, schema version constraint relaxed, language audit. All SDK removal re-applied to branch.
- Session 6 (2026-04-15): gpt-4o-mini Extractor B (cross-model diversity), parallel A+B extractors (different providers), Vercel maxDuration 60→120s, ChatGPT critique F1 (candidate completeness check), F3 (adjudicator ranking tiebreaker), F5 (synthetic citations logged), F6 (truncation notice for incomplete candidate list), subgroup clarity (pre/post-hoc badges, CI-crosses-one per arm, cis_all_cross_one flag, direction_vs_hypothesis, interaction_note), subgroup UI update. First HIP ATTACK Phase 0 run confirmed at ~47s.
