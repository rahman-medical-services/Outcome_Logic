---
id: "handover"
type: "session-handover"
version: 2
session: "Session — 2026-04-13"
owner: "saqib"
next_session_start: "Read this file first, then LEARNINGS.md, then FEATURES.md"
---

# HANDOVER — OutcomeLogic

Read this at the start of every new session before touching any code. It describes the current state of the project, the architecture, known gotchas, and what to do next.

---

## Project in One Sentence

OutcomeLogic is a full-stack AI-powered clinical trial analysis engine: users supply a PDF or DOI/PMID and receive a structured extraction dashboard (PICO, outcomes, risk of bias, GRADE, subgroups, adverse events, expert context). A 3-node Gemini pipeline extracts and adjudicates; a Phase 0 validation study is in progress to identify and fix systematic extraction errors.

---

## Current State (as of 13 April 2026 — v4.3.0)

**Branch:** `claude/competent-borg` — working branch. Needs merge to main.

**⚠️ CRITICAL — READ BEFORE TOUCHING GEMINI CODE:**
The Gemini API has severe undocumented constraints. Read `LEARNINGS.md` section "Gemini API — Systematic 503 Failures (2026-04-13)" before any AI-related changes. Summary:
- **No SDK** — both `@google/generative-ai` and `@google/genai` cause 503s. Raw `fetch()` only.
- **Model: `gemini-2.5-flash-lite`** — not flash. Flash has persistent 503s.
- **`thinkingBudget: 512`** — always set this. 0 causes 503 on flash. Missing causes TPM exhaustion.
- **Sequential calls only** — parallel calls trigger concurrency 503s.
- **5 retries with backoff** — built into `callGemini()` in pipeline.js and commentary.js.

**What is working:**
- 3-node AI pipeline (Extractor A → B sequential, Adjudicator) — **confirmed working on flash-lite**
- Node 4 (Expert Context): Europe PMC + PubMed Entrez + web synthesis — functional
- Supabase save/load (library) — working
- PDF export (4-page clinical report) — working
- `study.html` + `api/study.js` (consolidated) — study admin working

**Completed in Session 2 (2026-04-12) — Pipeline hardening:**
- ✅ Extractor diversity — EXTRACTOR_PROMPT_A (adjusted/ITT) + EXTRACTOR_PROMPT_B (first-reported)
- ✅ Source citation requirement — mandatory `[SRC: verbatim | location]` in both extractor prompts
- ✅ Adversarial adjudicator — `extraction_flags` schema, suspicious_agreement detection
- ✅ `verifySource()` keyword filter tightened (length > 5, threshold 0.50)
- ✅ `_scoreCitation()` pubType scoring added (follow-up RCTs no longer excluded)
- ✅ `supabase/schema-study.sql` rebuilt — 5 tables, per-field grading, 10 Phase 0 papers seeded
- ✅ NI trial handling in extractor prompts
- ✅ Meta-analysis fields: effect_measure, ci_lower, ci_upper, arm_a_n, arm_b_n, time_point_weeks, analysis_population, adjusted

**Completed in Session 4 (2026-04-13) — Gemini stability:**
- ✅ Removed all SDK dependencies (`@google/generative-ai`, `@google/genai`)
- ✅ All Gemini calls use raw `fetch()` to v1beta REST endpoint
- ✅ Switched primary model to `gemini-2.5-flash-lite`
- ✅ `thinkingBudget: 512` on all calls
- ✅ Sequential extractors (not parallel)
- ✅ 5 retries with exponential backoff + jitter in `callGemini()`
- ✅ `api/study-papers.js` + `api/study-run.js` + `api/study-output.js` consolidated into `api/study.js`
- ✅ `vercel.json` updated to remove deleted files, add `api/study.js`
- ✅ First successful pipeline run confirmed on flash-lite

**What is NOT yet built (in priority order):**
1. **Merge `claude/competent-borg` → `main`**
2. **`lib/pipeline-v1.js` + `api/analyze-v1.js`** — single-node V1 baseline for ablation comparison
3. **Phase 0 grading UI** (`/pilot` review interface) — may already exist in old branch, verify
4. **Verify HALT-IT post-deploy** — check Vercel logs for Node 4 HALT-IT resolution

**Phase 0 can begin after:** branch merged + V1 baseline built.

---

## Architecture — 3+1 Node Pipeline

```
PDF / DOI / PMID
      │
      ▼
api/analyze.js  OR  api/study.js
      │
      ├─── Extractor A (gemini-2.5-flash-lite, sequential) ─┐
      │                                                       ├─► Adjudicator (gemini-2.5-flash-lite) ──► unified JSON
      └─── Extractor B (gemini-2.5-flash-lite, sequential) ─┘
                                                              │
                                                              ├─► postProcess() — enum enforcement, taxonomy, clinician_view / patient_view
                                                              │
                                                              └─► Node 4 / commentary.js (async, never throws)
                                                                    ├── Europe PMC citation graph
                                                                    ├── EPMC full-text phrase search
                                                                    └── PubMed Entrez + web synthesis (Gemini googleSearch)
```

**Key constants (lib/pipeline.js):**
- `GEMINI_MODEL = 'gemini-2.5-flash-lite'` (all nodes)
- `GEMINI_MODEL_PRO = 'gemini-2.5-flash'` (escalation path only, rarely triggered)
- `EXTRACTOR_OUTPUT_CAP = 40000`
- All calls: `thinkingBudget: 512`, 5 retries with backoff, raw fetch() — NO SDK

---

## Node 4 Architecture (lib/commentary.js)

### Three parallel search paths:
1. Europe PMC citation graph (`MED/{pmid}/citations`) — formal citations
2. Europe PMC full-text search — `"TRIAL NAME trial"` phrase in body text
3. PubMed Entrez — `"TRIAL NAME"[Title/Abstract]`

### PMID resolution cascade (PDF uploads):
1. Pre-scan raw PDF text for DOI/PMID (head + tail of text)
2. `_extractIdentityFromReport(reportA)` — regex on extractor output
3. If DOI → `_resolvePmidFromDoi` (Lancet parentheses fix applied)
4. If trial_name + year → `_resolvePmidViaPubMed` (Entrez fallback)
5. No identifier → `pmid_unresolved` (silent, no section shown)

### Key constants (commentary.js):
- `MEANINGFUL_THRESHOLD = 3`
- `MEANINGFUL_THRESHOLD_NAMED = 1`
- `MIN_ITEMS_FOR_SYNTHESIS = 2`
- `MAX_ITEMS_TO_FETCH = 15`
- `NODE4_TIMEOUT_MS = 45000`

---

## File Map

| File | Purpose |
|------|---------|
| `lib/pipeline.js` | 3-node pipeline — dual extractors + adjudicator |
| `lib/commentary.js` | Node 4 expert context |
| `api/analyze.js` | Main analysis endpoint (rate-limited) |
| `api/analyze-v1.js` | V1 single-node endpoint — **NOT YET BUILT** |
| `lib/pipeline-v1.js` | V1 single-node pipeline — **NOT YET BUILT** |
| `api/library-save.js` | Saves analysis to Supabase |
| `api/library-get.js` | Retrieves trials (paginated) |
| `api/library-batch.js` | Bulk processing |
| `api/study.js` | Consolidated study admin: `?resource=papers\|run\|output` |
| `public/index.html` | Main SPA (~1300 lines) |
| `public/study.html` | Study admin UI (exists, needs Phase 0 review UI) |
| `public/app.js` | Router, global state, tab switching |
| `supabase/schema-study.sql` | Validation study schema (NEEDS REBUILD — see Section 4) |
| `scripts/generate-env.js` | Injects env vars at build time |

---

## Pipeline Changes Required Before Phase 0 Runs

### 3.1 Extractor Diversity — CRITICAL

Both extractors currently receive the same `EXTRACTOR_PROMPT` (lines 476–477, `pipeline.js`). Fix: split into two distinct prompts.

**Extractor A prompt** — add at top:
```
EXTRACTION PRIORITY: Prefer adjusted estimates over unadjusted.
If multiple effect sizes are reported, select the primary analysis result
as pre-specified in the methods section. If ITT and per-protocol results
both appear, extract ITT. Always cite exact sentence/table location.
```

**Extractor B prompt** — add at top:
```
EXTRACTION PRIORITY: Prefer the primary reported outcome exactly as
labelled in the results section, regardless of statistical adjustment.
If multiple effect sizes appear, extract the first one reported in the
abstract results. Do not infer primacy from methods — extract what is
presented first. Always cite exact sentence/table location.
```

**Rationale:** These will genuinely disagree on ambiguous papers (adjusted vs unadjusted HR, ITT vs per-protocol). Agreement on ambiguous papers becomes a risk signal, not quality signal.

### 3.2 Source Citation Requirement — CRITICAL

Add to both extractor prompts:
```
For every extracted value, you MUST include a source_citation field:
- Verbatim text (max 30 words)
- Location: "Abstract", "Results paragraph N", "Table N", "Figure N legend"
If two citations are possible, cite both and flag as AMBIGUOUS_SOURCE.
```

### 3.3 Adversarial Adjudicator — IMPORTANT

Replace current passive adjudicator framing ("Compare two reports, resolve discrepancies") with:
> "For each discrepancy, identify why EACH extractor might be wrong before determining the correct value. For fields where both extractors agree, check: (a) do they cite the same source? (b) is there an alternative value in the paper not extracted? If both agree AND multiple candidate values exist, flag as SUSPICIOUS_AGREEMENT. Do not treat agreement as correctness."

Add to adjudicator output schema:
```json
"extraction_flags": {
  "suspicious_agreement": false,
  "suspicious_agreement_note": null,
  "ambiguous_source": false,
  "source_conflict": false,
  "source_conflict_note": null
}
```

---

## Supabase Schema — Needs Rebuild

Current `supabase/schema-study.sql` has wrong structure (5-point Likert grading, `study_outputs` not `study_extractions`, wrong pilot papers). Required tables:

1. **`study_papers`** — trial registry (`pmid`, `title`, `authors`, `journal`, `year`, `specialty`, `phase`, `is_pilot`, `status`)
2. **`study_extractions`** — V1 and V2 outputs per paper (`paper_id`, `version`, `output_json`, `source_type`)
3. **`study_grades`** — per-field structured grades:
   - `field_name`, `match_status` (exact_match / partial_match / fail / hallucinated)
   - `error_taxonomy` (omission / misclassification / formatting_syntax / semantic)
   - `correction_text`, `harm_severity` (1–5), `frequency_count` (auto-incremented)
   - `pipeline_section` (extractor / adjudicator / post_processing)
   - `suspicious_agreement` (bool), `suspicious_agreement_note`
4. **`study_rater_assignments`** — Phase 2 blinding assignments
5. **`study_sessions`** — session metadata, timestamps, reviewer_id

**Phase 0 pilot papers (10 — replace current SQL inserts):**
ORBITA, HIP ATTACK, SPORT (disc herniation), UK FASHIoN, TKR RCT (Skou 2015), STICH, EXCEL, PROFHER, SCOT-HEART, SPORT (spinal stenosis). All `is_pilot = true`, `phase = 0`. PMIDs to be verified.

---

## Phase 0 Review UI — `/pilot` Route

Split-panel view (PI only, no blinding):
- Left panel: paper metadata + V1 output fields
- Right panel: V2 output fields
- PDF opens in separate tab

**Per-field assessment criteria:**
A. Match status (radio): Exact Match / Partial Match / Fail / Hallucinated
B. Error taxonomy (dropdown, required on non-Exact): Omission / Misclassification / Formatting_Syntax / Semantic
C. Correction (text input, required on non-Exact)
D. Harm severity (1–5 selector) + auto-frequency counter
E. Pipeline section tag (3-option selector): Extractor / Adjudicator / Post-processing
F. Suspicious agreement flag (checkbox + note)

**Consistency gate (blocking):** Before any primary endpoint field can be marked Exact Match, reviewer must confirm HR value, 95% CI, and arm labels are jointly coherent. If not coherent, reviewer selects which is wrong → that field pre-marked Fail. This gate CANNOT be optional.

**`/pilot/summary`** aggregate view:
- Error rate by field (% non-Exact Match)
- Error rate by pipeline section
- Severity × frequency heatmap
- Suspicious agreement flag list
- Prompt modification queue ranked by severity × frequency

---

## V1 Baseline to Build

- `lib/pipeline-v1.js` — single-node mega-prompt (no parallel extraction, no adjudicator). Condensed version of current extractor prompt. NO source citations. NO adversarial framing. Naive baseline.
- `api/analyze-v1.js` — thin wrapper calling pipeline-v1.js

---

## Environment / Deployment

- No .env files in repo — all secrets in Vercel environment variables
- `API_BASE_URL` must always be `/api` (relative) — never hardcode production URL
- `generate-env.js` injects: SUPABASE_URL, SUPABASE_ANON_KEY, API_BASE_URL, INTERNAL_API_TOKEN

**Deployment checklist before pushing to main:**
1. `grep "API_BASE_URL" public/index.html` → must show `/api`
2. `grep -c "<style>" public/index.html` → must show `1`
3. `node -e "import('./lib/pipeline.js')"` — syntax check
4. `node -e "import('./lib/commentary.js')"` — syntax check
5. Resolve GitHub conflicts — keep local working versions
6. Push and verify Vercel deployment log shows no import errors
7. Verify HALT-IT post-deploy: check `[Node 4] PubMed Entrez resolved "HALT-IT"` log

---

## Known Issues / Watch Points

1. **`expertContextSection` stays hidden if `expert_context` absent** — correct silent behaviour. Console check: `window._lastAnalysis?.clinician_view?.expert_context?.status`
2. **`[postProcess] expertContext status: error`** = Node 4 timed out (45s). Usually PubMed esummary slow on large PMID list. Acceptable for now.
3. **Web synthesis "not yet available"** even when items found = googleSearch returned sparse results. Item cards still render correctly.
4. **FNCLCC:** institution blocklist prevents name search noise. Citation path correct.
5. **`riskTable1/riskTable2`** HTML elements present in output but not main branch — verify renderRiskTable wiring after merge.
6. **Both extractors use identical prompts** — this is the active critical risk. Do not run Phase 0 before fixing.

---

## Design Warning — Correlated Extraction Bias

This is the highest-probability failure mode for the meta-analysis product.

**The problem:** Both extractors share the same model family, same input, similar prompts. On ambiguous papers, they make the same wrong inference. The adjudicator confirms consensus. Output looks clean but is systematically wrong.

**Why this matters for meta-analysis:** Random errors cancel in pooling. Systematic correlated errors do not — they shift the pooled estimate in a consistent direction while appearing methodologically clean.

**Mental model:** Agreement = correctness → **Agreement without diversity = risk.**

---

## Priority Order — Next Session

### Immediate (unblocking Phase 0)
1. ✅ Pipeline hardening — complete
2. ✅ Schema rebuild — complete
3. ✅ Phase 0 grading UI — complete (`public/pilot.html`, `public/pilot-summary.html`)
4. ✅ Merge dev → main — complete
5. **Deploy `schema-study.sql` to Supabase** — run SQL in Dashboard → SQL Editor → New query. BLOCKING.
6. **Build `lib/pipeline-v1.js` + `api/analyze-v1.js`** — V1 baseline (medium effort, 2–3 hrs)
7. **Add harm severity anchor vignettes to `docs/PROTOCOL.md`** — Saqib's clinical judgement needed (2–3 hrs). Template is written; needs the clinical examples filled in.
8. **Verify HALT-IT** post-deploy
9. **Run Phase 0** — 10 papers through V1 + V2, grade 26 fields each in pilot.html

### Required before Phase 1 clinical deployment
10. **NI structured output fields** — add `ni_margin`, `ni_margin_excluded_by_ci`, `ni_result_label` to adjudicator JSON schema in `lib/pipeline.js`. Medium effort. High clinical safety priority. PROFHER will expose this gap.
11. **`capOutput()` truncation flag** — add `output_truncated: true` to adjudicator input when capOutput fires. Prevents lopsided adjudication on complex papers.
12. **Raise `MIN_ITEMS_FOR_SYNTHESIS` to 3** — one-line change in `lib/commentary.js`.
13. **Patient/clinician view recommendation language audit** — search for "is better", "confirms", "establishes" in ADJUDICATOR_PROMPT_BASE and EXTRACTOR_CORE. Replace with "this trial showed", "the data suggest". Reduces liability profile.
14. **Model diversity for Phase 1** — Extractor A=Gemini Flash, Extractor B=Claude Sonnet or GPT-4o. Current prompt diversity (A vs B priority headers) is a Phase 0 solution. Model diversity is the Phase 1 solution for correlated deep-inference errors.

### Meta-analysis module — build order (do not start before Phase 0 results)
15. **Python statistical microservice** — DerSimonian-Laird/REML, I², tau², forest plot coordinates. Deploy as Vercel serverless Python function.
16. **ClinicalTrials.gov API** — add to search.js alongside PubMed. Free API, required for defensible literature search.
17. **PICO disambiguation layer** — extend buildPubmedQueryWithGemini to structured PICO JSON.
18. **Abstract screening step** — flash-lite batch classify relevant/irrelevant/uncertain + human gate.
19. **Outcome harmonisation check** — pairwise outcome similarity, flag heterogeneous definitions.
20. **Meta-analysis synthesis view** — forest plot rendering, I² display, hedged narrative, GRADE component review.

---

## Strategic Review Findings (Session 3, 2026-04-12)

Four-persona adversarial review (HAWK=methodologist, FALCON=clinical, EAGLE=commercial, OWL=technical). All findings grounded in source code.

### Pipeline architecture — accepted limitations
- **Extractor diversity is prompt-only, not model-level.** Shared model = correlated deep-inference errors persist. Accepted for Phase 0; model diversity required for Phase 1. Documented.
- **Adjudicator is blind to omissions absent from both reports.** By design — cannot detect what neither extractor mentioned. PI review is the primary control.
- **`suspicious_agreement` has high specificity, low sensitivity.** Fires only when both reports mention an alternative candidate. Supplementary to PI review, not a replacement.
- **Source citation is an audit trail, not hallucination detection.** Must not be described as such in publications.

### Pipeline architecture — required fixes
- **NI handling lacks structured output fields.** `ni_margin`, `ni_margin_excluded_by_ci`, `ni_result_label` must be added to adjudicator schema. PROFHER (NI design) is paper 7 of Phase 0 — this will be exposed immediately.
- **`capOutput()` truncation not propagated to adjudicator.** Lopsided adjudication risk for complex papers (STICH, SPORT with extensive supplementary tables).

### Validation plan — Phase 0 is a calibration exercise, not a publishable accuracy study
- N=10 PI-only unblinded = correct for Phase 0. Zero statistical power for inferential claims.
- Phase 0 is publishable only as Methods section material within a Phase 1 paper.
- Phase 1 requirements for publication: ≥2 raters, kappa≥0.6 for primary fields, power calculation (~25–30 papers per version), prospective blinding, CONSORT-AI compliance.
- Harm severity rubric with anchor vignettes must be written before first paper is graded (template in `docs/PROTOCOL.md` — needs clinical anchors added by Saqib).
- Ground truth: PI must establish reference standard before reviewing AI output for Phase 1. Phase 0 is unblinded — this is disclosed as a pilot limitation.

### Meta-analysis module — strategic position
- **Frame:** "AI-assisted evidence synthesis for clinician review" — NOT "automated meta-analysis."
- **Fully automated meta-analysis is not scientifically defensible** (PRISMA requires dual screening, dual extraction, registered protocol).
- **Three human curation gates are non-negotiable:** study selection, data extraction sign-off, GRADE confirmation.
- **The Phase 0/Phase 1 validation paper is the commercial moat.** Not the architecture.
- **Three highest-risk assumptions:**
  1. Extraction accuracy too low to support meta-analysis (Phase 0 data answers this — 85%+ exact match on primary numeric values is the go/no-go threshold)
  2. Wrong use case (clinicians may want paper-finding help, not extraction — user-test before investing in Phase 1)
  3. Regulatory reclassification (MHRA/FDA may classify as SaMD — manage with precise IUC language, no recommendation/prescriptive wording anywhere in UI)
- **Intended use claim:** "clinical research tool for evidence synthesis and trial data extraction for review by qualified clinicians" — not "clinical decision support."
- **Business model:** Institutional subscription (medical schools, hospital departments) for research/education use. Freemium for individual clinicians. Pharma as separate product line with different compliance.
- **3-month MVP:** (1) Phase 0 complete → (2) Python stats microservice + ClinicalTrials.gov → (3) PICO disambiguation + abstract screening → (4) end-to-end test on one surgical question. Go/no-go: can it produce a defensible evidence synthesis in <30 minutes of human time?
