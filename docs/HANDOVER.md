---
id: "handover"
type: "session-handover"
version: 4
session: "Session 6 — 2026-04-15"
owner: "saqib"
next_session_start: "Read this file first, then LEARNINGS.md, then FEATURES.md"
---

# HANDOVER — OutcomeLogic

Read at the start of every new session before touching any code.

---

## Project in One Sentence

OutcomeLogic is a full-stack AI-powered clinical trial analysis engine: users supply a PDF or DOI/PMID and receive a structured extraction dashboard (PICO, outcomes, risk of bias, GRADE, subgroups, adverse events, expert context). A 3-node pipeline (Gemini + OpenAI) extracts and adjudicates; Phase 0 validation study is in progress.

---

## Current State (as of 15 April 2026 — v4.5.0)

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
- `study.html` + `api/study.js` — study admin working
- First successful Phase 0 run: HIP ATTACK — all primary outcomes, subgroups, secondary outcomes correct

**Completed in Session 6 (2026-04-15):**
- ✅ **gpt-4o-mini as Extractor B** — cross-model diversity. Gemini (A) + OpenAI (B) + Claude (code). Correlated table misreads now produce detectable discrepancies. `callOpenAI()` in pipeline.js.
- ✅ **Parallel extractor execution** — A and B now run with `Promise.all` when `OPENAI_API_KEY` set (different providers, no concurrency conflict). Falls back to sequential Gemini if key absent. Saves ~20s.
- ✅ **Vercel `maxDuration` raised to 120s** for `api/analyze.js` — was 60s, caused timeouts with sequential extractors.
- ✅ **ChatGPT critique F1** — candidate completeness check: extractors must verify adjusted primary, abstract value, and competing table value are all present before finalising `candidate_values`.
- ✅ **ChatGPT critique F3** — adjudicator ranking tiebreaker: explicit priority order (adjusted > unadjusted, ITT > PP, final > interim, pre-specified > post-hoc). Do not rely on label text alone.
- ✅ **ChatGPT critique F6** — truncation notice extended: when truncated, adjudicator notes candidate list may be incomplete.
- ✅ **ChatGPT critique F5** — synthetic citations logged in LEARNINGS as known, tolerated limitation.
- ✅ **Subgroup extraction clarity** — `pre_specified`, `post_hoc`, `cis_all_cross_one`, `direction_vs_hypothesis`, `interaction_note`, `ci_crosses_one` per arm, `absolute_events` per arm. Exposed by HIP ATTACK: troponin subgroup was post-hoc and CI-crossing was not visible.
- ✅ **Subgroup UI update** — pre-specified (green) / post-hoc (orange) badges; amber warning when all CIs cross 1; direction note; per-arm CI-crosses-one + absolute events; plain-language interaction note.
- ✅ **PIPELINE_SPEC.md updated** — reflects current architecture.
- ✅ **CLAUDE.md git workflow** — no worktrees; direct feature branches, merge to main at session end.

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
| `api/analyze-v1.js` | V1 single-node endpoint — **NOT YET BUILT** |
| `lib/pipeline-v1.js` | V1 single-node pipeline — **NOT YET BUILT** |
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

## Priority Order — Next Session

### Phase 0 is V3-only
Phase 0 runs the current pipeline (V3) against 10 papers. Goal: identify and eliminate systematic extraction errors before scaling. There is no comparison arm in Phase 0 — V1 is deferred to Phase 1.

### Immediate (unblocking Phase 0)
1. **Fill `docs/PROTOCOL.md` anchor vignettes** — Saqib's clinical judgement needed before first paper is graded.
2. **Run Phase 0** — 10 papers through V3, grade 26 fields each in pilot.html.

### Required before Phase 1 clinical deployment
5. **NI structured output fields** — `ni_margin`, `ni_margin_excluded_by_ci`, `ni_result_label`. PROFHER is NI design — paper 8 of Phase 0 will expose this.
6. **Verify HALT-IT post-deploy** — check Vercel logs for `[Node 4] PubMed Entrez resolved "HALT-IT"`.

### Phase 1 (after Phase 0 findings)
- **Build `lib/pipeline-v1.js` + `api/analyze-v1.js`** — V1 single-node baseline for Phase 1 comparison arm. Required for powered validation study (N≥25 papers, ≥2 raters, Kappa ≥0.6).

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
