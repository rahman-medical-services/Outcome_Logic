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

## Validation Study — UI (BLOCKING — must precede data collection)

The validation study design is finalised (PROTOCOL.md v2.0). Four UI components are required. The existing `pilot.html` covers Phase 2 style (pipeline output shown to rater) but not Phase 1a (blind manual extraction) or Phase 3 (arbitration). The Supabase schema also needs updating to support multi-rater, timed, multi-phase grading.

### ✅ Phase 1a UI — Blind manual extraction form
**Status:** Shipped Session 20 (2026-04-29). `public/phase1a.html`. Split-pane (PDF left, form right) with draggable divider and pop-out. Live timer (server-side started_at on first field write). Debounced 350ms autosave per field. Cannot determine / Uncertain flags. ⓘ reference link on rob_overall (Cochrane RoB 2.0) and grade_certainty (GRADE handbook). Completeness gate before submit. Read-only after lock. Blinding enforced at API layer (other_rater action sealed until both sessions locked).
**Original spec retained for reference:**
**What it is:** A per-rater, per-paper form for the 19 MA fields (Section 3.1 of PROTOCOL.md). No pipeline output is shown. Rater works from source PDF only.
**Required features:**
- Rater login / identity (rater_id passed to DB)
- Paper list: title, DOI/PMID link, PDF download link
- Per-field inputs: text, number, or categorical depending on field type
- Per-paper timer: starts on first field input, records total time to submission
- Save draft (auto-save per field) + explicit submit when complete
- Cannot view another rater's submissions for the same paper until both have submitted (blinding)
- No pipeline output, no V4 JSON, no existing grades visible
**Effort:** ~3–4 hrs. New page (`public/phase1a.html` or equivalent).
**Schema change needed:** `study_grades` table needs `rater_id`, `phase` ('1a'/'2a'/'2b'/'3'), `time_seconds` columns. Or new table `study_phase1a_extractions`.

### ✅ Phase 2a/2b UI — Pipeline output review form (separately timed)
**Status:** Shipped Session 20 (2026-04-29). `public/phase2.html`. Single-page handles both 2a and 2b sequentially; submitting 2a unlocks 2b for the same paper. Same split-pane shell as phase1a. Per field: pipeline value displayed (JSON pretty-print for arrays/objects), match_status pill row (5 pills), severity buttons 1-5, taxonomy/pipeline_section/root_cause_stage selects, correction textarea, optional notes. Detail block hidden for exact_match/cannot_determine. `_critic` audit trail and all `_<field>_source` provenance stripped server-side via stripInternalFields() before V4 output reaches the rater. Crossover-inverse visibility (Pair B does Phase 2 on a_phase1a papers). Phase 2b creation and submission gated server-side on Phase 2a being locked.
**Original spec retained for reference:**
**What it is:** Shows V4 pipeline output alongside source paper link. Rater checks each field, marks match_status, adds correction if needed. **Phase 2a and Phase 2b are separately timed and separately submitted — they are not one combined session.**
**Critical timing requirement:**
- **Phase 2a** (MA fields only): rater sees only the 19 MA fields. Timer runs from first interaction to Phase 2a submit. Time stored as `phase2a_seconds`. This is the primary time comparison endpoint (vs `phase1a_seconds`).
- **Phase 2b** (remaining fields): unlocks only after Phase 2a is submitted and locked for that rater. Rater now sees all non-MA fields. Separate timer starts fresh. Time stored as `phase2b_seconds`. Reports additional burden of full-field review.
- A rater cannot access Phase 2b until Phase 2a is submitted. There is no combined mode.
**Other required features:**
- Rater login / rater_id
- V4 field values shown; `_critic` audit trail NOT shown (key blinding requirement)
- Two separate rater records stored independently per paper
- Cannot view the other rater's grades until both have submitted (blinding within Phase 2)
- Auto-save per field within each phase session
**Effort:** ~2–3 hrs of additions to existing `pilot.html`.

### ✅ Validation admin UI — paper management + PDF upload
**Status:** Shipped Session 20 (2026-04-29). `public/validation-admin.html`. Login (admin role required). List, add, edit, delete papers; toggle is_active/is_preliminary; set crossover_assignment; upload PDFs to Supabase Storage (≤9 MB raw via base64) or paste an external URL. Delete cascades all phase data + clears the paper's PDF folder from Storage.
**Gaps to close next session:**
- `v4_extraction_id` field is not surfaced in the edit form. Currently requires SQL UPDATE to attach a V4 pipeline run to a validation paper before Phase 2 grading is testable. Adding a free-text field plus a "pick from study_extractions" dropdown is the planned fix.
- "Run V4 on this paper" button — would let admin trigger a V4 pipeline run against the uploaded PDF directly, instead of running V4 via study.html and copying the extraction id. Quality-of-life; not blocking.
- No rater management UI yet. Add/edit raters via SQL. Suitable while the rater set is closed and small.

### ⬜ Phase 3 arbitration UI
**Status:** Not started.
**What it is:** Shown to the arbitrator after both Phase 2 raters have submitted. For each field, shows: V4 output value, Rater A correction (if any), Rater B correction (if any), whether they agree. Arbitrator makes a final decision where raters disagree.
**Required features:**
- Discrepancy highlighting: fields where Rater A ≠ Rater B shown in amber; fields where both corrected the same way shown in green; agreement on exact_match shown greyed
- Per-field: arbitrator decision (adopt Rater A / adopt Rater B / new value / exact_match confirmed)
- Overall quality rating (1–5) and usability rating (1–5) per paper
- Free-text arbitrator notes
- Submit locks the paper as final validated output
**Effort:** ~3 hrs. New page (`public/phase3.html`).

### ⬜ Study management dashboard
**Status:** Not started.
**What it is:** Overview of all 30 papers across all phases. Which papers are at which stage, rater completion status, discrepancy count per paper, overall progress.
**Required features:**
- Paper table: phase 1a (rater A done? rater B done?), phase 2a (rater A done? rater B done?), phase 2b (same), phase 3 (arbitrated?)
- Click-through to open any paper in the relevant UI for the current phase
- **Crossover assignment display:** Papers 1–15 show Pair A→Phase 1a / Pair B→Phase 2a; papers 16–30 show swap. Rater identity enforced in Phase 1a and Phase 2a UIs (rater only sees their assigned papers).
- **Export button:** Downloads all Phase 3 arbitrated outputs as structured JSON. Must include per paper per rater: all 19 MA field arbitrated values, match_status per field, Phase 1a ground truth values (both raters), Phase 2a rater corrections (both raters), Phase 2b rater corrections (both raters), Phase 3 arbitrator decision, `phase1a_seconds` (per rater), `phase2a_seconds` (per rater — separately timed, MA fields only), `phase2b_seconds` (per rater — separately timed, non-MA fields only), pipeline `_runtime_seconds`. Primary time comparison uses `phase1a_seconds` vs `phase2a_seconds` only; `phase2b_seconds` is reported separately as additional burden for full-field review. This export is the meta-analysis input dataset and the validated library asset.
**Effort:** ~2–3 hrs. Extension of existing `study.html`.

### ✅ Supabase schema update for multi-phase, multi-rater study
**Status:** Shipped Session 20 (2026-04-29). `supabase/schema-validation.sql` — 8 tables + view + trigger function. Coexists with schema-study.sql (separate tables; only link is application-level `validation_papers.v4_extraction_id`). Flexibility-first design: TEXT for all categoricals, no CHECK constraints, ON DELETE CASCADE on FKs, soft-delete via `is_active`. **Lock down before formal study** — switch FKs to RESTRICT, add CHECK on enums. Companion files: `supabase/setup-storage-bucket.sql` (creates `validation-pdfs` public bucket, 20 MB cap, PDF only) and `supabase/seed-pi-rater.sql` (idempotent PI tester seed). NOT YET DEPLOYED to live Supabase — PI must run all three via SQL Editor.
**Original spec retained for reference:**
**New tables needed:**
- `validation_papers` — the 30 formal papers (separate from `study_papers` which has Phase 0 data). Fields: id, title, pmid, doi, pdf_sha256, crossover_assignment ('a_phase1a' | 'a_phase2a'), phase1a_locked (bool), phase2a_locked (bool), phase3_locked (bool).
- `phase1a_extractions` — manual extraction records. Fields: id, paper_id, rater_id, field_name, extracted_value, cannot_determine (bool), time_seconds (per-paper, recorded on submit), submitted_at. UNIQUE (paper_id, rater_id, field_name).
- `phase2_grades` — pipeline correction records. Fields: id, paper_id, extraction_id (FK to study_extractions), rater_id, phase ('2a'|'2b'), field_name, match_status, correction_value, harm_severity, error_taxonomy, submitted_at. UNIQUE (paper_id, rater_id, phase, field_name). Note: time is stored at the session level (per paper per phase), not per field.
- `phase2_sessions` — one row per rater per paper per phase. Fields: id, paper_id, rater_id, phase ('2a'|'2b'), phase2a_seconds (null for 2b rows), phase2b_seconds (null for 2a rows), submitted_at. Phase 2b session cannot be created until Phase 2a session exists and is submitted. Stores the primary time data for the time endpoint.
- `phase3_arbitrations` — final arbitrated decisions. Fields: id, paper_id, field_name, arbitrated_value, arbitrator_decision ('adopt_a'|'adopt_b'|'new_value'|'exact_match'), arbitrator_notes, quality_rating (1-5), usability_rating (1-5), arbitrated_at.
**Effort:** ~1–2 hrs (schema design + SQL + Supabase deploy).
**Do this first** — all UIs depend on it.

### ⬜ Acceptance gate — preliminary test run (5 beta-blocker papers)
**Status:** Not started. Blocked on all 4 UIs being complete.
**What it is:** PI runs the full workflow end-to-end on CIBIS-II, MERIT-HF, COPERNICUS, SENIORS, BEST before recruiting formal study raters.
**Steps:** Phase 1a extraction (PI, manual, timed) → V4 pipeline run → Phase 2a review (PI or colleague, timed) → Phase 3 arbitration → Export arbitrated JSON → run pilot meta-analysis vs Shibata Cochrane review.
**Gate:** If any UI component fails, breaks, or produces unusable export during this test, fix before proceeding. This is the acceptance test for all 4 UIs.

---

## Phase 1 — Scale and Publication

### ✅ `lib/pipeline-v1.js` — single-node V1 baseline **[Completed Session 9–10]**
**Status:** Complete and hardened. Single Gemini flash-lite call, `thinkingBudget:512`, identical output schema to V3. `callGemini` deliberately duplicated (not imported) to isolate V1 from V3 prompt changes during Phase 1. `postProcess()` shared via export from pipeline.js. Integrated into `api/study.js` (`version:'v1'` routing). study.html V1 column complete. Session 10: self-check removed, uncertainty flags removed — V1 is now a clean single-pass baseline with no internal adjudication.

### ✅ Phase 1 papers seeded in schema **[Completed Session 10, 2026-04-17]**
**Status:** Complete. 10 cardiac surgery papers inserted into `supabase/schema-study.sql` (phase=1). PMIDs verified against live PubMed: SYNTAX (19228612), CREST (20505173), PARTNER 1 (21639811), FREEDOM (23121323), CORONARY (22449296), PARTNER 2 (27040324), ART (30699314), PARTNER 3 (30883058), ISCHEMIA (32227755), DEDICATE (38588025). Domain chosen: cardiac surgery (general surgery reserved for Phase 2 commercial product).

### 🔧 `_EXTRACTOR_SHARED_SECTIONS` rebuild on V1 foundations **[Session 12 — pending re-run analysis]**
**Status:** Planned, not yet implemented. Full implementation plan in HANDOVER.md.
**Gate:** First run updated V1 on all 20 papers and analyse the re-run JSON. If upgraded V1 still outperforms current V3 on the 5-point checklist (DEDICATE AE, subgroups, chart, NI framing, page count), proceed with rebuild. If V1 upgraded matches V3 on those points, the gap is closed and V3 rebuild becomes lower priority.
**Why:** V1 and V3 scored essentially identically on 20-paper review (23.4 vs 23.2/25). Residual V3 failures (AE contamination, subgroup grouping, blank charts) are prompt engineering failures, not architectural. V1 prompt is now at V3 quality — if re-run confirms this, V3 rebuild may become optional.
**What changes if still needed:** `_EXTRACTOR_SHARED_SECTIONS` in `lib/pipeline.js` rewritten using V1's upgraded sections. V3-specific additions (source citations, candidate_values, survival section, subgroup detail) grafted in. See HANDOVER.md for section-by-section spec.
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

#### 🔧 SD per arm for continuous outcomes **[High — Phase 2 blocker]**
**Status:** Partial. `arm_a_sd` / `arm_b_sd` back-calculated via Cochrane §6.5.2 in `backCalculateSD()` (Session 14/15). Requires CI + N in candidate. V4 coverage: 67% (up from 33% V1). Full extraction from text still needed for papers where CI back-calc is blocked.
**Gap remaining:** Direct extraction from text (mean ± SD tables) not yet reliable — depends on table surviving PDF parse. Prompt addition planned.
**Effort:** Low (prompt addition + schema field). No DB migration needed.

#### ⬜ Structured outcome timepoint **[High — Phase 2 blocker]**
**Status:** Not started.
**Gap:** Outcome timepoint is currently embedded in free text. For pooling, timepoint must be structured (e.g. `{ value: 12, unit: "months" }`) to detect heterogeneous follow-up lengths before pooling.
**Fix:** Add `primary_outcome_timepoint: { value, unit }` to adjudicator output schema. Extractor already surfaces timepoint in narrative — parse it into structured form.
**Effort:** Low.

#### ✅ Explicit outcome type flag **[High — Phase 2 blocker]**
**Status:** Complete (Session 12 Rule 12 critic, Session 14/15 normalisation). `outcome_type: time_to_event | binary | continuous | ordinal` extracted by critic Rule 12. `normaliseOutcomeTypes()` enforces canonical underscore form post-patch.
**Location:** `lib/pipeline-v4.js` — critic Rule 12 + `normaliseOutcomeTypes()`.

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

- **Priority for next session (Session 21):** (1) PI smoke-tests the validation stack end-to-end on one preliminary paper — schema deploy → admin upload PDF → SQL-set v4_extraction_id → Phase 1a grade + submit → Phase 2a grade + submit → Phase 2b grade + submit. Report wiring issues. (2) Add `v4_extraction_id` setter to validation-admin form (~15 min, removes the SQL step). (3) Build Phase 3 arbitration UI + study management dashboard with JSON export. (4) Lock-down before formal study: CHECK constraints on enums, FKs to RESTRICT, strip phase1a role from PI, verify preliminary-paper PMIDs. See HANDOVER.md "Priority Order".
- **Priority for previous session (Session 17):** Re-run all 20 papers with V4 on the post-Session-16 build. Verify (a) `arm_a_n` / `arm_b_n` populated on canonical key (no more legacy `n_arm_a` keys anywhere); (b) no fabricated MD/SMD per-arm values; (c) `_critic.patches_applied` reflects substantive patches only with `verifications_count` separate; (d) provenance tags present on critic-corrected fields. Re-run 5×5 stability — type oscillation should be gone. Then deploy schema and begin Phase 0 grading.
- **Session 16 (2026-04-27 — meta-analysis hardening):** External Opus critique addressed. 5 fixes shipped on `claude/meta-analysis-hardening`: canonicaliseLegacyKeys (resolved the false "PDF-to-text limitation" diagnosis — 40 candidates were stranded in legacy keys, now migrated to canonical and legacy keys deleted); coerceNumericFields scope extended to include arm_*_value, arm_*_sd, value, point_estimate, ci_lower, ci_upper (kills type oscillation across runs); guardMDFabrication + Rule 7 prompt update (blocks Rule 7 from manufacturing per-arm change scores from between-arm MD); applyPatches now returns `{applied, verifications, skipped}` distinguishing substantive vs no-op patches; critic-corrected candidate fields tagged with `_<field>_source = "critic_patched:<rule>"`. Fix 5 (silent run failures, ~20%) deferred — Vercel timeout, not resolvable on current Vercel plan.
- **Session 14/15 (2026-04-24):** 3 commits on main. 7 V4 post-processing functions (coerceNumericFields, backCalculateEvents priority, backCalculateSD Cochrane §6.5.2, restoreDroppedCandidateFields, normaliseOutcomeTypes, GRADE guard, flagAmbiguousSelection). V1 prompt: canonical effect_measure labels, p_value verbatim format, primary_result_synthesis field. Full 20-paper run: V1=94%, V4=96%, arm_events 100%, SD 67%. Stability analysis complete. Commits: ca658f7, c4c1aee, f0180e1.
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
- Session 11 (2026-04-19): 20-paper V1 vs V3 review — primary outcomes 20/20 clean, V1/V3 essentially tied (23.4 vs 23.2/25). V1 prompt upgraded to match V3 quality (12 full sections). SEARCH SCOPE mandatory added to both pipelines. Adjudicator: suspicious_agreement + single-source → selection_uncertain. AE rule strengthened for single-event primaries. Subgroup GROUPING RULE. patient_view postProcess fallback. cannot_determine match_status added to pilot.html + schema. isFieldComplete() corrected for fail/hallucinated correction enforcement.
