---
id: "handover"
type: "session-handover"
version: 6
session: "Session 10 — 2026-04-17"
owner: "saqib"
next_session_start: "Read this file first, then LEARNINGS.md, then FEATURES.md"
---

# HANDOVER — OutcomeLogic

Read at the start of every new session before touching any code.

---

## Project in One Sentence

OutcomeLogic is a full-stack AI-powered clinical trial analysis engine: users supply a PDF or DOI/PMID and receive a structured extraction dashboard (PICO, outcomes, risk of bias, GRADE, subgroups, adverse events, expert context). A 3-node pipeline (Gemini + OpenAI) extracts and adjudicates; Phase 0 validation study is in progress.

---

## Current State (as of 17 April 2026 — v4.8.0)

**Branch:** All work committed directly to `main`. No active feature branches. See CLAUDE.md git workflow.

**⚠️ CRITICAL — READ BEFORE TOUCHING AI CODE:**
- **Gemini:** No SDK — raw `fetch()` only. `gemini-2.5-flash-lite`. `thinkingBudget: 512` always. Sequential Gemini calls only (same key). See LEARNINGS.md "Gemini API — Systematic 503 Failures".
- **OpenAI:** `gpt-4o-mini`. Raw `fetch()` only. `max_completion_tokens` not `max_tokens`. Temperature 0.05 supported. No reasoning tokens. ~3–40s depending on paper length.
- **gpt-5-mini is a reasoning model** — no temperature control, internal reasoning tokens, very slow on large inputs. Do NOT use for extraction.

**What is working:**
- 3-node pipeline: Extractor A (Gemini flash-lite) + Extractor B (gpt-4o-mini) run in **parallel**, then Adjudicator (Gemini flash-lite)
- Typical timing: A+B parallel ~33s, Adjudicator ~13s, total ~47s on full paper
- Node 4 (Expert Context): Europe PMC + PubMed Entrez + web synthesis — functional
- Supabase save/load (library) — working
- PDF export — working
- Phase 0 pilot UI: `pilot.html` + `pilot-summary.html` — built and functional
- `study.html` + `api/study.js` — study admin working, batch PDF upload with pilot-paper matching
- First successful Phase 0 run: HIP ATTACK — all primary outcomes, subgroups, secondary outcomes correct

**⚠️ SCHEMA NOT YET DEPLOYED — must run `supabase/schema-study.sql` before grading any paper**
The schema was rewritten in Session 8 to fix critical bugs. The Supabase instance still has the old broken schema. Run via Dashboard → SQL Editor before touching pilot.html.

**Completed in Session 10 (2026-04-17):**
- ✅ **V1 pipeline hardened for Phase 1 isolation** — removed self-check / internal adjudication block and removed all uncertainty flag population (selection_uncertain, ambiguous_source, ni_trial, zero_event_arm, multi_arm_trial) from `pipeline-v1.js`. These flags remain in the output schema (always false/null) so the schema is identical to V3 for grading purposes. Header comment updated to document what V1 lacks vs V3.
- ✅ **Phase 1 papers added to schema** — 10 cardiac surgery papers inserted into `supabase/schema-study.sql` (phase=1). All PMIDs verified against live PubMed E-utilities API. Papers: SYNTAX (19228612), CREST (20505173), PARTNER 1 (21639811), FREEDOM (23121323), CORONARY (22449296), PARTNER 2 (27040324), ART (30699314), PARTNER 3 (30883058), ISCHEMIA (32227755), DEDICATE (38588025). Domain: cardiac surgery. EXCEL excluded (already run). General surgery reserved for Phase 2 commercial product.
- ✅ **Adjudicator prompt: 6 fixes applied** (all in `ADJUDICATOR_PROMPT_BASE`, `lib/pipeline.js`):
  1. NI trial framing rule: primary_outcome MUST lead with per-arm rates + absolute difference + CI-excludes-margin + NI test result. HR/OR is supporting context only.
  2. NI superiority constraint: do NOT claim superiority unless pre-specified superiority test was performed and passed.
  3. NI margin CI logic: explicit direction — "CI upper < NI margin = CI excludes margin = NI demonstrated. CI upper > NI margin = NI failure." Prevents inversion error seen in DEDICATE re-run.
  4. Subgroup compilation: compile ALL subgroups from BOTH extractor reports. Missing subgroups = completeness failure.
  5. AE classification rule: AE table must contain ONLY procedure/drug complications. Exclude primary/secondary endpoints (death, stroke, MI, AF) even if they appear in a paper's safety table.
  6. Language constraints: prohibit "superior", "better than", "confirms", "establishes", "recommends", "preferred option" in ALL narrative fields.
- ✅ **Extractor prompts: 3 fixes applied** (all in `_EXTRACTOR_SHARED_SECTIONS`, `lib/pipeline.js`):
  1. AE classification rule moved into extractors — adjudicator-only fix insufficient because both extractors were generating the error; adjudicator can only filter what extractors surface.
  2. Subgroup completeness reinforced: "missing subgroups = completeness failure", explicit instruction to scan forest plot figures (subgroups may be in figures only, not numbered tables).
  3. NI margin CI logic added: same direction rule as adjudicator — ensures extractors correctly classify NI success/failure before adjudicator compiles.
- ✅ **Chart rendering fixed** (`public/index.html`, `renderEndpoint`): bar chart now shown first when per-arm event rate data exists, forest plot shown below when HR/OR/RR effect measure present. Previous behaviour: HR endpoints routed to forest-plot-only, hiding bar chart entirely. V1 produced bar+forest because it always populates arm values; V3 was showing neither.
- ✅ **Adjudicator chart data instruction** (`ADJUDICATOR_PROMPT_BASE` schema comment): `arms[].data_points[].y` must be per-arm observed event rate as raw percentage (5.4 not 0.054), sourced from arm_a_value/arm_b_value. Without this V3 was outputting y=0, producing blank charts.
- ⬜ **PLANNED but NOT IMPLEMENTED — `_EXTRACTOR_SHARED_SECTIONS` full rebuild on V1 foundations** — see section below. This is the top priority for Session 11.

**Completed in Session 9 (2026-04-16):**
- ✅ **Error taxonomy C3 split** — `ranking_failure` (C3) split into `ranking_hierarchy` (C3a: extraction picks wrong position in known hierarchy, e.g. co-primary vs secondary) and `ranking_ambiguity` (C3b: true tie between reported values, right level but wrong pick). `docs/ERROR_TAXONOMY.md` updated. `pilot.html`, `api/study-grade.js`, `supabase/schema-study.sql`, `api/study-summary.js` all updated. BLOCKER fixed: study-summary.js was silently dropping all C3 grades — both the `error_taxonomy_dist` initialiser and the `categories` array had `ranking_failure` and neither had the split names.
- ✅ **`root_cause_stage` field** — new optional attribution field on `study_grades`. Separate from `pipeline_section` (which node failed) — this tracks *why* (extractor | adjudicator | schema_design | prompt_guidance | document_structure). `pilot.html` grading card, `api/study-grade.js`, `supabase/schema-study.sql`, `api/study-summary.js` (SELECT, flatGrades, `computeRootCauseBreakdown()`), `docs/ERROR_TAXONOMY.md` all updated.
- ✅ **`zero_event_arm` + `multi_arm_trial` flags** — two new boolean flags in `extraction_flags` schema in `lib/pipeline.js`. ARM VALUE RULE reinforced: arm_a/arm_b = per-arm observed values, NOT between-group effect size. ARM VALUE RULE violation warning added to `postProcess()` for synthetic endpoints. `postProcess()` exported for import by pipeline-v1.js.
- ✅ **Utility layer backlog** — GPT critique reviewed and accepted. Separate document-level clinical usability assessment (4 questions, blind reviewer, Phase 2). Added to `docs/FEATURES.md`.
- ✅ **V1 single-node pipeline** (`lib/pipeline-v1.js`) — built following adversarial code review. Single Gemini flash-lite call, `thinkingBudget: 512`, identical output schema to V3. `callGemini` deliberately duplicated (not imported) to isolate V1 from any future V3 prompt changes during Phase 1. `postProcess()` shared. `api/study.js` imports `runPipelineV1` and routes `version: 'v1'` to it.
- ✅ **study.html V1 column** — V1 Run / Re-V1 / V1-PDF buttons, purple badge, `runV1()` function, `runFromPdf()` generalised to accept `version` param, `viewOutput()` accepts version with [V1]/[V3] modal prefix, stats bar shows V1 complete + "ready to compare" counts.

**Completed in Session 8 (2026-04-15):**
- ✅ **All 10 pilot paper PMIDs verified against live PubMed** — previous PMIDs were AI-generated and wrong (e.g. 29126895 was an ECMO paper, not ORBITA). All 10 now corrected in `supabase/schema-study.sql` via E-utilities API verification. Notable: PROFHER is JAMA not Lancet; SCOT-HEART is 2018 not 2019.
- ✅ **Schema/API alignment** — `study_outputs` → `study_extractions`, `output_id` → `extraction_id` throughout `api/study-grade.js`. `reference_standard_value TEXT` column added to `study_grades`. `error_taxonomy` CHECK constraint updated from 4-class to 7-class. `rater_id` removed from UNIQUE constraint (was blocking all Phase 0 upserts since API never sends rater_id).
- ✅ **Batch PDF upload with pilot-paper matching** — `study.html` now accepts multiple PDFs, normalises filenames, fuzzy-matches against `trial_name` (ORBITA, EXCEL etc), and auto-selects the pilot record in a per-file dropdown. User can override or allow new-record creation.
- ✅ **pilot.html endpoint fixes** — was calling `/api/study-papers` (old endpoint, file deleted) → fixed to `/api/study?resource=papers`. Was calling `/api/study-output?id=` → fixed to `/api/study?resource=output&id=`.
- ✅ **study.js v2 fallback** — `v3_output` now falls back to any `v2` extraction so papers run before the v2→v3 rename remain visible.
- ✅ **DESIGN_DECISIONS.md created** — comprehensive record of pipeline and study design decisions for Phase 1 publication.
- ✅ **Meta-analysis data gap assessment** — 6 missing fields identified (SD per arm, structured timepoint, outcome type flag, structured secondary endpoints, N randomised vs analysed, follow-up duration). All are low-risk JSONB additions. Added to Phase 2 backlog in FEATURES.md. Recommendation: add after Phase 0 findings, not before.

**Completed in Session 6 (2026-04-15):**
- ✅ **gpt-4o-mini as Extractor B** — cross-model diversity. Gemini (A) + OpenAI (B) + Claude (code). Correlated table misreads now produce detectable discrepancies. `callOpenAI()` in pipeline.js.
- ✅ **Parallel extractor execution** — A and B now run with `Promise.all` when `OPENAI_API_KEY` set (different providers, no concurrency conflict). Falls back to sequential Gemini if key absent. Saves ~20s.
- ✅ **Vercel `maxDuration` raised to 120s** for `api/analyze.js` — was 60s, caused timeouts with sequential extractors.
- ✅ **Subgroup extraction clarity** — `pre_specified`, `post_hoc`, `cis_all_cross_one`, `direction_vs_hypothesis`, `interaction_note`, `ci_crosses_one` per arm, `absolute_events` per arm.
- ✅ **Subgroup UI update** — pre-specified (green) / post-hoc (orange) badges; amber warning when all CIs cross 1; per-arm CI-crosses-one + absolute events; plain-language interaction note.

---

## Architecture — 3+1 Node Pipeline

```
PDF / DOI / PMID
      │
      ▼
api/analyze.js  OR  api/study.js
      │
      ├─── Extractor A (gemini-2.5-flash-lite) ─┐  ← run in parallel
      │                                           ├─► Adjudicator (gemini-2.5-flash-lite) ──► unified JSON
      └─── Extractor B (gpt-4o-mini, OpenAI) ───┘
                                                  │
                                                  ├─► postProcess() — enum enforcement, taxonomy, clinician_view / patient_view
                                                  │
                                                  └─► Node 4 / commentary.js (async, never throws)
                                                        ├── Europe PMC citation graph
                                                        ├── EPMC full-text phrase search
                                                        └── PubMed Entrez + web synthesis (Gemini googleSearch)
```

**Key constants (lib/pipeline.js):**
- `GEMINI_MODEL = 'gemini-2.5-flash-lite'` (Extractor A, Adjudicator)
- `OPENAI_MODEL_B = 'gpt-4o-mini'` (Extractor B)
- `EXTRACTOR_OUTPUT_CAP = 40000`
- Gemini calls: `thinkingBudget: 512`, 5 retries with backoff, raw fetch() — NO SDK
- OpenAI calls: `max_completion_tokens: 8000`, temperature: 0.05, 5 retries, raw fetch() — NO SDK
- Parallel when `OPENAI_API_KEY` present; sequential Gemini fallback otherwise

**Vercel env vars required (server-side):**
- `GEMINI_API_KEY` — Extractor A, Adjudicator, Node 4
- `OPENAI_API_KEY` — Extractor B (gpt-4o-mini). If absent, falls back to Gemini for both.

---

## Node 4 Architecture (lib/commentary.js)

Three search paths via `Promise.allSettled` (partial results survive any single API hang):
1. Europe PMC citation graph (`MED/{pmid}/citations`)
2. Europe PMC full-text search
3. PubMed Entrez + web synthesis (Gemini googleSearch)

**Key constants:**
- `MIN_ITEMS_FOR_SYNTHESIS = 3`
- `NODE4_TIMEOUT_MS = 45000`

---

## File Map

| File | Purpose |
|------|---------|
| `lib/pipeline.js` | 3-node pipeline — Extractor A (Gemini) + B (OpenAI) + Adjudicator |
| `lib/commentary.js` | Node 4 expert context |
| `api/analyze.js` | Main analysis endpoint (rate-limited, maxDuration: 120s) |
| `api/analyze-v1.js` | V1 single-node endpoint — not yet built (not needed for Phase 0) |
| `lib/pipeline-v1.js` | V1 single-node pipeline — **built and integrated into study.js** |
| `api/library-save.js` | Saves analysis to Supabase |
| `api/library-get.js` | Retrieves trials (paginated) |
| `api/library-batch.js` | Bulk processing |
| `api/study.js` | Study admin: `?resource=papers\|run\|output` |
| `public/index.html` | Main SPA |
| `public/pilot.html` | Phase 0 per-field grading UI |
| `public/pilot-summary.html` | Phase 0 aggregate heatmap |
| `supabase/schema-study.sql` | Validation study schema (ready to deploy) |
| `scripts/generate-env.js` | Injects env vars at build time |
| `docs/PIPELINE_SPEC.md` | Full technical spec — read on demand |
| `docs/ERROR_TAXONOMY.md` | 7-class extraction error taxonomy + Phase 0 analysis sheet + phase scope |

---

## Known Issues / Watch Points

1. **`expertContextSection` stays hidden if `expert_context` absent** — correct. Console: `window._lastAnalysis?.clinician_view?.expert_context?.status`
2. **`[postProcess] expertContext status: error`** = Node 4 timed out (45s). Usually PubMed slow. Acceptable.
3. **`_runWebSearchSynthesis` uses `tools: [{ googleSearch: {} }]`** — confirm works in raw fetch v1beta. Check Vercel logs for `[Node 4] Web-search synthesis failed` if web synthesis returns null.
4. **Extractor A truncation on long papers** — HIP ATTACK produced 49,818 chars, capped at 40,000. AEs were missing. Truncation notice correctly sent to adjudicator. Primary fields survived intact.
5. **`candidate_values` is prompt-level** — extractors output free text; adjudicator parses into `primary_endpoint_candidates`. If extractor omits the block (single-value paper), adjudicator produces single-item array. Correct behaviour.
6. **Correlated table misread residual risk** — now reduced by cross-model diversity (Gemini A + OpenAI B). If both still converge on same wrong value, it remains undetectable. Residual risk for Phase 0.
7. **Source citations may be partially synthetic** — see LEARNINGS.md. Used for ranking context only, not displayed verbatim. Tolerated.
8. **gpt-4o-mini model string in logs** — actual model returned is `gpt-4o-mini-2024-07-18`. Normal.

---

## ⚠️ TOP PRIORITY — Session 11: Rebuild `_EXTRACTOR_SHARED_SECTIONS` on V1 Foundations

### Background
Phase 1 running (DEDICATE V1 vs V3) revealed that V3's extractor prompts are systematically inferior to V1. V1 produces correct AE tables, 13 subgroups, correct charts, and correct NI framing. V3 produces endpoint-contaminated AE tables, zero subgroups, blank charts, and inverted NI margin logic. Root cause: `_EXTRACTOR_SHARED_SECTIONS` was written independently of V1 and diverged in language clarity, explicit rules, and chart instructions.

The architectural decision: V3's design (cross-model extractors + adversarial adjudicator) remains correct. The fix is to rebuild the extractor prompt body using V1's sections as the base, then layer V3-specific additions on top. The A/B priority rule prefixes and the adjudicator are unchanged.

### What to implement

Rebuild `_EXTRACTOR_SHARED_SECTIONS` in `lib/pipeline.js` section by section as follows. Do NOT change `EXTRACTOR_PROMPT_A`, `EXTRACTOR_PROMPT_B` (priority rule prefixes), or `ADJUDICATOR_PROMPT_BASE`.

**Section 1 — TRIAL IDENTIFICATION**: V1 as-is. Clean.

**Section 2 — PICO**: V1 as-is. "Secondary outcomes: list up to 4 pre-specified secondary endpoints." (V3 says "list all" — too much.)

**Section 3 — BASELINE CHARACTERISTICS**: V1 as-is. Structured follow-up duration `{ value, unit, type }`.

**Section 4 — PRIMARY ENDPOINT**: V1 base language + three V3 additions grafted in:
- V1 base: HIERARCHY RULES reference, ARM VALUE RULE (per-arm observed values not between-group effect size), NI design instruction (margin from methods + CI-excludes-margin + NI test label)
- Add: NI margin CI direction: "CI upper < NI margin = CI excludes margin = NI demonstrated. CI upper > NI margin = NI failure. Do NOT invert this."
- Add: `candidate_values` block (Session 5 — max 3, covering: adjusted vs unadjusted, ITT vs per-protocol, abstract vs full-text table values). Format: `value=X | effect_measure= | outcome_type= | p= | timepoint= | label= | population= | arm_a= | arm_b= | [SRC:]`
- Add: CANDIDATE COMPLETENESS CHECK (Session 5 — 4-point checklist: adjusted value included? abstract value included? alternative table value included? arm_a/arm_b correctly separated from value?)

**Section 5 — SECONDARY ENDPOINTS**: V1 as-is. Up to 4 pre-specified, name + effect measure + CI + p-value.

**Section 6 — SURVIVAL / TIME-TO-EVENT DATA**: Keep V3's section verbatim. V1 has no equivalent. Needed for multi-timepoint survival papers. Key rule: extract only explicitly stated time points, never interpolate.

**Section 7 — SUBGROUP ANALYSES — Option C (new)**:
- Lead with V1's imperative: "Pre-specified subgroups: extract ALL regardless of significance. Post-hoc: only if interaction p<0.05."
- Then add Option C limit:
  - If ANY interaction p < 0.10 (significant or borderline): extract ALL pre-specified subgroups that meet this threshold
  - If ALL interactions are null (p ≥ 0.10): extract maximum 4, in this clinical priority order: (1) Age, (2) Sex, (3) Disease severity measure (STS-PROM, LVEF, NYHA, tumour stage — domain-specific), (4) One key domain comorbidity (renal function, prior therapy, fracture type)
  - Hard cap: maximum 8 subgroups in output total
  - Post-hoc: only if p < 0.05 (unchanged)
- Add: "Completeness rule — scan ALL figures including forest plots. Subgroups may be in forest plot figures only and not in numbered tables. Extract from both."
- Add V3's detail for each extracted subgroup: interaction p-value, borderline flag (0.04–0.06), pre_specified/post_hoc flag, ci_crosses_one per arm, absolute_events per arm, direction_vs_hypothesis, cis_all_cross_one, interaction_note (plain language)
- If no subgroups reported: state explicitly "No subgroup analyses reported."

**Section 8 — ADVERSE EVENTS**: V1 base (brief, direct) + one explicit rule:
- V1 base: "Grade ≥3 AEs occurring in ≥5% of either arm. Event name, percentage both arms. Discontinuation rates, treatment-related mortality rates."
- Add: "CLASSIFICATION RULE — AE table must contain ONLY procedure-related or drug-related complications. Do NOT include primary endpoints, secondary endpoints, or pre-specified trial outcome events — even if they appear in a safety section or safety table in the paper. Events such as death, stroke, MI, atrial fibrillation, LBBB, new pacemaker, or any outcome defined as a trial endpoint belong in the outcomes section, not here. If the paper's safety table mixes complications with endpoints, extract only the true complications (e.g. wound infection, bleeding requiring transfusion, AKI, sepsis) and exclude the endpoint events."

**Section 9 — CRITICAL APPRAISAL**: V1 base + V3's Cochrane domain detail:
- Risk of bias: assess each Cochrane domain (randomisation, allocation concealment, blinding, outcome adjudication, attrition). Single label: Low | Moderate | High | Unclear.
- GRADE certainty: High | Moderate | Low | Very Low.
- Key limitations (max 2 sentences). COI/industry funding disclosures.

**Section 10 — CHARTS**: Replace V3's vague schema with V1's explicit rules + arm mapping:
- "Always set `recommended_chart_type: 'bar'`."
- "Populate `arms[].data_points[].y` with the per-arm OBSERVED EVENT RATE as a raw percentage number — 5.4 for 5.4%, NOT 0.054. Use arm_a_value for the intervention arm, arm_b_value for the control arm. This is the source for the bar chart. Missing or zero y-values produce a blank chart."
- "Also populate `point_estimate`, `ci_lower`, `ci_upper`, `effect_measure` from the primary result. These drive the forest plot below the bar chart. Both must be populated whenever the data exists — one drives the bar chart, the other the forest plot."
- "For multi-timepoint survival: one data point per arm per explicitly reported time point. Do not interpolate."
- "Maximum 2 endpoints in the array."

**Section 11 — SOURCE CITATIONS** (new, from V3 Session 2 — V1 has no equivalent):
- For every extracted numeric value, append: `[SRC: "verbatim quote ≤20 words" | Location]`
- Location must be: Abstract | Results para N | Table N | Figure N legend | Methods
- If two locations give same value: `[SRC: AMBIGUOUS | location-1 vs location-2]`
- This is mandatory — unsourced values cannot be adjudicated.

**Section 12 — LIBRARY CLASSIFICATION**: V1 as-is. Taxonomy note: Orthopaedics = any musculoskeletal/joint/bone/fracture/spine trial regardless of whether treatment is surgical or non-surgical. Surgery = general/visceral/vascular/breast/endocrine/colorectal only.

### After implementing
Run DEDICATE through V3 and compare to V1. Check:
1. AE table: should have ~5 true complications only (no AF, stroke, pacemaker)
2. Subgroups: null interactions → should show 4 (age, sex, STS-PROM, renal function)
3. Chart: bar chart (5.4% vs 10%) + forest plot both rendered
4. Primary outcome: correct NI framing, no inversion
5. Page count should be ~3-4 pages (vs V1's 5 pages with 13 subgroups)

---

## Priority Order — Next Session

### Immediate — Session 11 first task
1. **Implement `_EXTRACTOR_SHARED_SECTIONS` rebuild** — full plan above. Edit `lib/pipeline.js` only. Do not touch `EXTRACTOR_PROMPT_A`, `EXTRACTOR_PROMPT_B`, or `ADJUDICATOR_PROMPT_BASE`. After implementing, run DEDICATE through V3 and compare to V1 output using the 5-point checklist above.

### Phase 0 (unblocking — still pending from earlier sessions)
2. **Deploy `supabase/schema-study.sql`** — Dashboard → SQL Editor → paste file → Run. DROP TABLE statements at top clear existing data (acceptable).
3. **Batch-upload 10 pilot PDFs via study.html** — auto-matching links to correct pilot records.
4. **Fill `docs/PROTOCOL.md` anchor vignettes** — Saqib's clinical judgement needed before first paper is graded.
5. **Run Phase 0** — 10 papers through V3, grade 26 fields each in pilot.html.

### Required before Phase 1 clinical deployment
6. **NI structured output fields** — `ni_margin`, `ni_margin_excluded_by_ci`, `ni_result_label`. PROFHER is NI design — paper 8 of Phase 0 will expose this.

### Phase 1 (after Phase 0 findings)
- **`lib/pipeline-v1.js`** — ✅ built. Integrated into `api/study.js` for study runs. `api/analyze-v1.js` (public endpoint) not yet needed — build for Phase 1 if separate rate-limiting required.
- **Run Phase 1**: N≥25 papers, ≥2 raters, Kappa ≥0.6. Both V3 and V1 must be run on the same papers via `study.html`. Grading is per-extraction (pilot.html). Statistical comparison of V3 vs V1 exact-match rate.

### Study Runner — PDF-Only (Phase 0 and Phase 1)

`api/study.js` (`resource=run`) requires `pdf_base64` for all study runs. PMID/DOI-based text fetching has been removed from the study runner. This is deliberate — it eliminates source-type variability from the validation study. All study extractions will have `source_type = 'full-text-pdf'`. The PI must obtain and upload the full-text PDF for each paper.

The public `api/analyze.js` is unaffected — it continues to accept PDF, DOI, and PMID inputs.

### Design Warning — Correlated Extraction Bias
Both extractors now use different model families (Gemini + OpenAI). Correlated errors are substantially reduced but not eliminated — if both models make the same inference from ambiguous text, it remains undetectable. This is the residual highest-risk failure mode entering Phase 0. Phase 0 PI review is the primary control.

---

## Session Log

- Session 1 (2026-04-12): CLAUDE.md, docs/ directory, adversarial review initiated
- Session 2 (2026-04-12): Pipeline hardening (extractor diversity, adversarial adjudicator, source citations, NI handling)
- Session 3 (2026-04-12): Phase 0 grading infrastructure, strategic adversarial review (HAWK/FALCON/EAGLE/OWL)
- Session 4 (2026-04-13): Gemini SDK removal, flash-lite, sequential extractors, thinkingBudget:512, 5-retry backoff
- Session 5 (2026-04-14): candidate_values, Extractor B strengthening, capOutput truncation flag, Node 4 allSettled, language audit, ChatGPT/Gemini critique review
- Session 6 (2026-04-15): gpt-4o-mini Extractor B, parallel extractors, 120s timeout, ChatGPT critique F1/F3/F5/F6 fixes, subgroup clarity (pre/post-hoc, CI-crosses-one, interaction note), first HIP ATTACK run confirmed
- Session 7 (2026-04-15): Adjudicator anti-bias rule (no preference for extreme effects or abstract prominence), Phase 0 clarified as V3-only (V1 deferred to Phase 1), ERROR_TAXONOMY.md (7-class system), pilot.html consistency gate (blocking, dynamic from effect_measure, pre-marks Fail on incoherence), taxonomy dropdown updated to 7-class, pilot-summary.html CSV + api/study-summary.js updated to 7-class taxonomy
- Session 8 (2026-04-15): All 10 pilot PMIDs verified (was AI-generated/wrong). Schema/API alignment (study_outputs→extractions, output_id→extraction_id, 7-class taxonomy CHECK, reference_standard_value, UNIQUE fix). Batch PDF upload with fuzzy pilot-paper matching (study.html). pilot.html endpoint bugs fixed. study.js v2 fallback for v3_output. DESIGN_DECISIONS.md. Meta-analysis gap analysis → 6 items added to Phase 2 backlog.
- Session 9 (2026-04-16): C3 taxonomy split (ranking_hierarchy / ranking_ambiguity) + BLOCKER fix in study-summary.js. root_cause_stage field across schema/API/grading UI/summary. zero_event_arm + multi_arm_trial flags. postProcess() exported; ARM VALUE RULE warning. Utility layer added to Phase 2 backlog. V1 single-node pipeline (lib/pipeline-v1.js) — callGemini duplicated for Phase 1 isolation. study.html V1 column complete. api/study.js routes version:v1.
- Session 10 (2026-04-17): Phase 1 design confirmed (10 cardiac papers, V1 vs V3 head-to-head). V1 hardened (self-check removed, uncertainty flags removed). 10 Phase 1 papers added to schema (PMIDs verified). 9 prompt fixes across adjudicator and extractor: NI framing, NI CI direction, AE endpoint exclusion, subgroup completeness + forest plot scan, chart arm data, language constraints. Chart rendering fixed (bar+forest both shown for HR). Key finding: V3 extractor prompts systematically inferior to V1. Full rebuild of _EXTRACTOR_SHARED_SECTIONS planned (Section 11 top priority — not yet implemented).
