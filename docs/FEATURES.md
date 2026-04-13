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

### ⬜ `lib/pipeline-v1.js` — single-node V1 baseline
**Status:** Not started.
**Spec:** Single mega-prompt, no parallel extractors, no adjudicator. Condensed extractor prompt only. NO source citations, NO adversarial framing. Serves as Phase 1 comparison baseline.
**Effort:** Medium (1–2 hrs).

### ⬜ `api/analyze-v1.js` — V1 endpoint
**Status:** Not started.
**Spec:** Thin wrapper calling `pipeline-v1.js`. Same rate limiting as `analyze.js`.
**Effort:** Easy (30 min, mostly copying analyze.js structure).

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

### 🔧 Merge `claude/competent-borg` → main
**Status:** Branch working, not yet merged. Contains all session 4 changes (SDK removal, flash-lite, sequential extractors).

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

### ⬜ `capOutput()` truncation flag **[Medium]**
**Status:** Not started.
**Problem:** When extractor output exceeds 40,000 chars, `capOutput()` truncates silently. If A is truncated and B is not, the adjudicator receives a lopsided comparison. STICH and SPORT with extensive supplementary tables are most at risk.
**Fix:** Add `output_truncated: true` to adjudicator input JSON when `capOutput()` fires. Adjudicator prompt should acknowledge: if one report is flagged as truncated, treat its missing fields as unknown rather than absent.
**Effort:** 20 mins.

### ⬜ Raise `MIN_ITEMS_FOR_SYNTHESIS` to 3 **[Low]**
**Status:** Not started.
**Location:** `lib/commentary.js`.
**Fix:** One line. Two items is insufficient for meaningful synthesis.

### ⬜ Patient/clinician view recommendation language audit **[Medium — liability]**
**Status:** Not started.
**Problem:** Any "X treatment is better than Y" language in the AI output creates liability if a clinician acts on it. Intended use claim is "research tool", not "clinical decision support."
**Fix:** Grep for "recommend", "is better", "confirms", "establishes" in ADJUDICATOR_PROMPT_BASE, EXTRACTOR_CORE, patient_view prompt. Replace with "this trial showed", "the data suggest", "results indicate".

---

## Phase 1 — Scale and Publication

---

### ⬜ Model diversity for Phase 1 extractors **[High for Phase 1]**
**Status:** Documented, not started.
**Problem:** Extractor A and B both use `gemini-2.5-flash-lite`. Prompt diversity (A=adjusted/ITT, B=first-reported) is insufficient to catch model-level correlated errors (HR direction convention, hallucinated CIs from footnotes). For Phase 0 this is acceptable. For Phase 1 at scale it is not.
**Fix:** Extractor A = Gemini flash-lite (current). Extractor B = Claude Sonnet or GPT-4o. Requires new API client in pipeline.js.
**Effort:** Medium (2–3 hrs). **Do not build before Phase 0 results.**

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

- **Priority for next session:** Deploy schema → build V1 baseline → fill PROTOCOL.md anchor vignettes → run Phase 0 papers → review heatmap
- **Do not begin Phase 2 meta-analysis until Phase 0 go/no-go** (≥85% exact match on primary numeric fields)
- **The Phase 0/Phase 1 validation paper is the commercial moat** — it is not optional quality assurance
- Session 1 (2026-04-12): CLAUDE.md, docs/ directory, adversarial review initiated
- Session 2 (2026-04-12): Pipeline hardening (extractor diversity, adversarial adjudicator, source citations, NI handling, 10 fixes)
- Session 3 (2026-04-12): Phase 0 grading infrastructure, strategic adversarial review (HAWK/FALCON/EAGLE/OWL), meta-analysis strategy
- Session 4 (2026-04-13): Gemini SDK removal, flash-lite primary model, sequential extractors, thinkingBudget:512, 5-retry backoff, api/study.js consolidation — first successful pipeline run confirmed
