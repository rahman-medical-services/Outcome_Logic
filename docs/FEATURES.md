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

### ✅ `lib/pipeline-v1.js` — single-node V1 baseline **[Completed Session 9–10]**
**Status:** Complete and hardened. Single Gemini flash-lite call, `thinkingBudget:512`, identical output schema to V3. `callGemini` deliberately duplicated (not imported) to isolate V1 from V3 prompt changes during Phase 1. `postProcess()` shared via export from pipeline.js. Integrated into `api/study.js` (`version:'v1'` routing). study.html V1 column complete. Session 10: self-check removed, uncertainty flags removed — V1 is now a clean single-pass baseline with no internal adjudication.

### ✅ Phase 1 papers seeded in schema **[Completed Session 10, 2026-04-17]**
**Status:** Complete. 10 cardiac surgery papers inserted into `supabase/schema-study.sql` (phase=1). PMIDs verified against live PubMed: SYNTAX (19228612), CREST (20505173), PARTNER 1 (21639811), FREEDOM (23121323), CORONARY (22449296), PARTNER 2 (27040324), ART (30699314), PARTNER 3 (30883058), ISCHEMIA (32227755), DEDICATE (38588025). Domain chosen: cardiac surgery (general surgery reserved for Phase 2 commercial product).

### 🔧 `_EXTRACTOR_SHARED_SECTIONS` rebuild on V1 foundations **[Session 11 — TOP PRIORITY]**
**Status:** Planned, not yet implemented. Full implementation plan in HANDOVER.md.
**Why:** Phase 1 DEDICATE run revealed V3 extractor prompts systematically inferior to V1. V3 produces endpoint-contaminated AE tables, zero subgroups, blank charts, inverted NI framing. Root cause: `_EXTRACTOR_SHARED_SECTIONS` written independently of V1, weaker language, missing explicit rules.
**What changes:** `_EXTRACTOR_SHARED_SECTIONS` in `lib/pipeline.js` rewritten using V1's sections 1–9 as skeleton. V3-specific additions (source citations, candidate_values, survival section, subgroup detail) grafted in. AE endpoint-exclusion rule. Subgroup Option C limit. Chart explicit arm-to-y-value mapping. See HANDOVER.md for section-by-section spec.
**What stays the same:** `EXTRACTOR_PROMPT_A` prefix, `EXTRACTOR_PROMPT_B` prefix, `ADJUDICATOR_PROMPT_BASE`, all API/call mechanics.
**Verification:** After implementation, run DEDICATE through V3. Pass criteria: (1) AE table has ~5 true complications only, (2) subgroups show 4 (age, sex, STS-PROM, renal function) from null-interaction set, (3) chart renders bar+forest, (4) NI framing correct, (5) page count ~3–4.

### ⬜ `api/analyze-v1.js` — V1 public endpoint
**Status:** Not started. Not needed for Phase 0 or Phase 1 study runs (those go via api/study.js). Build only if V1 needs separate rate-limited public access.
**Effort:** Easy (30 min).

---

### ✅ Model diversity — gpt-4o-mini as Extractor B **[Completed Session 6, 2026-04-15]**
**Status:** Complete.
**What was built:** Extractor B now uses `gpt-4o-mini` (OpenAI) via `callOpenAI()` in `lib/pipeline.js`. Raw `fetch()` to `v1/chat/completions`. `max_completion_tokens: 8000`, temperature 0.05. 5-retry backoff. Falls back to Gemini flash-lite if `OPENAI_API_KEY` absent.
**Cross-model diversity achieved:** Gemini (A) + OpenAI (B). Correlated table misreads now produce detectable discrepancies rather than silent consensus.
**Timing:** gpt-4o-mini responds in ~3–10s (vs ~26s for Gemini flash-lite on same input).

### ⬜ Utility layer — blind clinical usability assessment **[Phase 2 — introduce alongside powered V1 vs V3]**
**Status:** Not started. Designed following GPT critique (2026-04-16).
**Rationale:** Exact-match rate measures "is the extraction correct?" — the utility layer measures "can a clinician trust and use this without re-reading the paper?" These are orthogonal axes. High accuracy + low usability is a real failure mode. The utility layer is required to identify which error classes actually break trust (vs which are invisible to clinicians).
**Design:**
- Document-level (not field-level). 4 questions, coarse scale. Blind to extraction internals.
- Reviewer sees the rendered report only (index.html output), not raw JSON or pilot.html grading.
- Grader A (taxonomy grading) and Grader B (utility assessment) must be different people — same person anchors on known errors.
- Internal hidden field (not shown to reviewer): "Was the primary outcome direction correct?" (yes/no). Enables calibrated trust analysis — identifies dangerous false-trust cases (report wrong but trusted) vs UX/framing failures (report correct but not trusted).
**4 utility questions:**
1. "Would you use this without opening the paper?" (Yes / Yes with minor verification / No)
2. "Do you trust the primary outcome result?" (High / Moderate / Low)
3. "What is the main issue, if any?" (free text — high value, treat as qualitative data)
4. "How much time does this save you?" (None / Some / Significant)
**Implementation dependencies:**
- Clean utility review URL (read-only index.html report with questions appended) — no grading interface, no raw JSON visible
- `study_utility_assessments` table in Supabase (paper_id, reviewer_id, q1–q4, direction_correct, assessed_at)
- Post-hoc linkage analysis: utility score cross-tabulated with error taxonomy + severity by paper
**Target:** 10–20 papers, 1–2 reviewers, Phase 2 alongside powered validation. Not powered for statistics — calibrating intuition and identifying catastrophic failure modes.
**Strategic output:** "% of reports usable with minimal correction" — product KPI, sales story, pricing anchor.
**Effort:** Medium (utility review UI ~2hrs, schema ~30min, linkage analysis script ~1hr).

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

---

### Meta-Analysis Extraction Gap Items (identified Session 8 — add to pipeline before Phase 2)

These are data fields not currently extracted that are required for defensible pooling. **Do not add until after Phase 0** — they are low-risk (JSONB storage, no migration needed) but should be assessed against Phase 0 findings first.

#### ⬜ SD per arm for continuous outcomes **[High — Phase 2 blocker]**
**Status:** Not started.
**Gap:** DerSimonian-Laird and REML random-effects pooling require mean ± SD per arm for continuous outcomes. Currently only the between-arm effect size (MD, SMD) is extracted. Without SD, continuous outcome pooling is impossible.
**Fix:** Add `arm_a_mean`, `arm_a_sd`, `arm_b_mean`, `arm_b_sd` to primary outcome schema in `lib/pipeline.js`. Only populated when `effect_measure` is MD or SMD.
**Effort:** Low (prompt addition + schema field). No DB migration needed.

#### ⬜ Structured outcome timepoint **[High — Phase 2 blocker]**
**Status:** Not started.
**Gap:** Outcome timepoint is currently embedded in free text. For pooling, timepoint must be structured (e.g. `{ value: 12, unit: "months" }`) to detect heterogeneous follow-up lengths before pooling.
**Fix:** Add `primary_outcome_timepoint: { value, unit }` to adjudicator output schema. Extractor already surfaces timepoint in narrative — parse it into structured form.
**Effort:** Low.

#### ⬜ Explicit outcome type flag **[High — Phase 2 blocker]**
**Status:** Not started.
**Gap:** No machine-readable flag distinguishing continuous / binary / time-to-event / ordinal. The Python stats microservice needs this to select the correct pooling method and variance formula.
**Fix:** Add `outcome_type: 'continuous' | 'binary' | 'time-to-event' | 'ordinal'` to adjudicator output schema.
**Effort:** Trivial (one enum field + prompt instruction).

#### ⬜ Structured secondary endpoints array **[Medium]**
**Status:** Not started.
**Gap:** `secondary_outcomes_list` is currently a freetext string. For systematic review, secondary outcomes must be a structured array `[{ name, effect_size, ci, p_value, direction }]` to allow cross-trial comparison.
**Fix:** Change `secondary_outcomes_list` in the adjudicator output schema to an array of structured objects. Update pilot.html grading view to handle array display.
**Effort:** Medium (prompt change + schema change + UI update). Breaking change — complete Phase 0 first.

#### ⬜ N randomised vs N analysed distinction **[Medium]**
**Status:** Not started.
**Gap:** Currently conflates randomised N with analysed N (ITT vs modified ITT vs per-protocol). Attrition bias assessment and pooled N calculation require both.
**Fix:** Add `n_randomised_arm_a`, `n_randomised_arm_b` alongside existing `n_arm_a`, `n_arm_b` (which become analysed N). Add `analysis_population` classification: `ITT | modified_ITT | per_protocol | unknown`.
**Note:** `arm_a_n` and `arm_b_n` already exist for primary outcome. This is a global trial-level field.
**Effort:** Low.

#### ⬜ Exclusion criteria structured field **[Low — applicability assessment]**
**Status:** Not started.
**Gap:** PICO population field captures inclusion criteria only. Key exclusion criteria (e.g. prior revascularisation, LVEF threshold) are not extracted but are clinically important for applicability assessment — determining whether a trial's result generalises to a specific patient.
**Fix:** Add `exclusion_criteria` as a subfield under `clinician_view.pico` in the adjudicator output schema. Free-text string or short array. Not required for pooling but improves per-trial applicability display.
**Effort:** Low (prompt addition only, no DB migration).
**Note:** Absence of exclusion criteria from the Population field is NOT an extraction error — graders should not penalise for this in Phase 0.

#### ⬜ Follow-up duration **[Medium]**
**Status:** Not started.
**Gap:** No structured follow-up duration field. Required for heterogeneity detection (pooling 1-month and 12-month mortality is a clinical error). Related to outcome timepoint but distinct — follow-up duration is the total observation window, not the outcome assessment time.
**Fix:** Add `followup_duration: { value, unit, type: 'median' | 'mean' | 'planned' }` to adjudicator output schema.
**Effort:** Low.

---

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

### ⬜ Grading completion gate — Phase 1 pilot.html **[Phase 1 — data integrity]**
**Status:** Not started.
**Spec:** Block navigation away from a paper (or submission of grades) if any field card is incomplete. Incomplete = match_status not set, OR match_status is not exact_match and taxonomy/severity/pipeline_section are unset. Highlight incomplete cards visually (red border or scroll-to). Phase 0 relies on PI discipline; Phase 1 with multiple raters requires enforcement.
**Effort:** Low — add validation pass before any navigation/submit action in pilot.html.

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

- **Priority for next session:** Run `supabase/schema-study.sql` in Supabase dashboard → batch-upload all 10 pilot PDFs via study.html → run Phase 0 papers (V3) → grade in pilot.html → review heatmap
- **Do not begin Phase 2 meta-analysis until Phase 0 go/no-go** (≥85% exact match on primary numeric fields)
- **The Phase 0/Phase 1 validation paper is the commercial moat** — it is not optional quality assurance
- Session 1 (2026-04-12): CLAUDE.md, docs/ directory, adversarial review initiated
- Session 2 (2026-04-12): Pipeline hardening (extractor diversity, adversarial adjudicator, source citations, NI handling, 10 fixes)
- Session 3 (2026-04-12): Phase 0 grading infrastructure, strategic adversarial review (HAWK/FALCON/EAGLE/OWL), meta-analysis strategy
- Session 4 (2026-04-13): Gemini SDK removal, flash-lite primary model, sequential extractors, thinkingBudget:512, 5-retry backoff, api/study.js consolidation — first successful pipeline run confirmed
- Session 5 (2026-04-14): Adversarial critique review (Gemini + GPT, stress-tested against codebase by agents). candidate_values array, Extractor B strengthening, capOutput truncation flag, Node 4 allSettled, MIN_ITEMS_FOR_SYNTHESIS=3, schema version constraint relaxed, language audit. All SDK removal re-applied to branch.
- Session 6 (2026-04-15): gpt-4o-mini Extractor B (cross-model diversity), parallel A+B extractors (different providers), Vercel maxDuration 60→120s, ChatGPT critique F1 (candidate completeness check), F3 (adjudicator ranking tiebreaker), F5 (synthetic citations logged), F6 (truncation notice for incomplete candidate list), subgroup clarity (pre/post-hoc badges, CI-crosses-one per arm, cis_all_cross_one flag, direction_vs_hypothesis, interaction_note), subgroup UI update. First HIP ATTACK Phase 0 run confirmed at ~47s.
- Session 7 (2026-04-15): Adjudicator anti-bias rule, Phase 0 V3-only clarification, ERROR_TAXONOMY.md (7-class), pilot.html consistency gate (blocking, dynamic), taxonomy dropdowns updated to 7-class.
- Session 8 (2026-04-15): All 10 pilot PMIDs verified against live PubMed (was: AI-generated and wrong). Schema/API alignment: study_outputs→study_extractions, output_id→extraction_id, 7-class taxonomy CHECK, reference_standard_value column, UNIQUE constraint fixed. Batch PDF upload with pilot-paper matching in study.html. Endpoint bugs fixed in pilot.html. study.js v2 fallback for v3_output. DESIGN_DECISIONS.md created. Meta-analysis data gaps identified and added to Phase 2 backlog.
