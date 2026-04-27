---
id: "project-summary"
type: "summary"
created: 2026-04-24
owner: "saqib"
---

# OutcomeLogic — Project Summary

**As of 27 April 2026 (v5.4.0 · commit 9feed53)**

---

## What Is This?

OutcomeLogic is a full-stack AI system that takes a clinical trial paper (PDF or DOI/PMID) and returns a structured clinical evidence report in ~30 seconds. The report includes:

- **Primary outcome**: effect size, CI, p-value, effect measure, arm-level values and event counts
- **PICO**: population, intervention, comparator, outcome, study design
- **Risk of bias** and **GRADE certainty**
- **Subgroup analyses** (pre-specified, post-hoc, interaction p-values)
- **Adverse events table** (complications only — endpoint components excluded)
- **Meta-analysis completeness** audit (what fields would need to be present to include this trial in a pooled analysis)
- **Expert context** (related citations, commentary from Europe PMC / PubMed, AI synthesis)
- **Lay summary** and shared decision-making takeaway

The target user is a clinician or researcher who needs to rapidly assess a clinical trial — not to replace reading the paper, but to provide a structured first-pass extraction that can be reviewed and trusted.

---

## The Pipeline (V4 — current production)

```
PDF text
    │
    ▼
Node 1: Gemini flash-lite (V1 extractor)          ~15–20s
    │   thinkingBudget:1024
    │   Raw fetch(), no SDK
    │
    ├──► v1 snapshot saved (pre-critic baseline)
    │
    ▼
Node 2: GPT-4o-mini critic (13 rules)             ~12–15s
    │   Checks compliance, plausibility, completeness
    │   Returns structured patches (dot-path notation)
    │
    ▼
Node 3: Deterministic JS post-processing            <1s
    │   applyPatches()
    │   restoreDroppedCandidateFields()
    │   coerceNumericFields()
    │   backCalculateEvents()
    │   backCalculateSD()
    │   normaliseOutcomeTypes()
    │   flagAmbiguousSelection()
    │   auditMetaAnalysisFields()
    │
    ▼
v4 output (with full _critic audit trail)

Node 4: Expert context (Europe PMC + PubMed)      ~10–30s
         Runs independently, returns partial on timeout
```

Both `v4` and `v1` outputs are saved on every run. This means we always have a before/after comparison showing exactly what the critic changed and why.

---

## What Has Been Built (15 Sessions)

### Infrastructure
- Vercel serverless backend (ESM), Supabase Postgres + auth, Upstash Redis rate limiting
- `api/analyze.js` — public endpoint (rate-limited, 100/24h per IP, PDF/DOI/PMID input)
- `api/study.js` — research admin endpoint (V4 dual-save, dry_run for stability testing)
- `public/index.html` — main SPA (clinical report rendering, charts, interactive data)
- `public/study.html` — research admin UI (batch runs, V1/V4 comparison, stability testing)
- `public/pilot.html` — Phase 0 per-field grading interface (26 fields, auto-save)
- `public/pilot-summary.html` — aggregate heatmap (priority scores, taxonomy, prompt queue)

### Pipeline evolution
- **V1** (Sessions 9–11): Single Gemini flash-lite pass. 12-section structured prompt. Baseline for comparison.
- **V3** (Sessions 1–8): Extractor A (Gemini) + Extractor B (GPT-4o-mini) parallel + Adjudicator (Gemini). Now deprecated in study UI (view-only for existing data).
- **V4** (Sessions 12–15): V1 extractor + GPT-4o-mini critic + deterministic JS layer. Current production pipeline.

### Critic rules (V4 Node 2 — 13 rules + 2-pass)
1. CI completeness and null-guard (no regressive patches)
2. AE table contamination (primary endpoint components excluded)
3. Subgroup variable grouping
4. ROB calibration
5. GRADE certainty calibration (with upgrade guard — only downgrades allowed)
6. COI/funding extraction (mandatory patch, non-overwrite)
7. Per-arm values completeness
8. Meta-analysis field completeness (back-calculation from arm_n × rate%)
9. Secondary endpoint completeness (adds missing secondaries to candidates)
10. NI trial framing (CI-excludes-margin direction check)
11. Lay summary direction (checks against significance)
12. Outcome type classification (HR=time_to_event, etc.)
13. SD per arm for continuous outcomes

Pass B: plausibility check — identifies and patches any fixable errors not caught by Rules 1–13.

### Deterministic post-processing (V4 Node 3 — current, Sessions 14/15/16/17)
| Function | What it does |
|---|---|
| `canonicaliseLegacyKeys()` | Runs BEFORE critic. Migrates `n_arm_a`→`arm_a_n`, `events_arm_a`→`arm_a_events`; strips `'null'` strings; parses compound fractions (`"159/891"`); strips trailing `%` from arm value/SD fields |
| `applyPatches()` | Returns `{applied, verifications, skipped}`. CI null-guard blocks overwriting non-null `ci_lower`/`ci_upper`. GRADE guard blocks upgrades. Tags substantive changes with `_<field>_source: "critic_patched:<rule>"` |
| `mergeUncertainFields()` | Copies `uncertain_candidate_fields` from critic onto candidate `uncertain_fields` arrays |
| `restoreDroppedCandidateFields()` | Re-merges V1 snapshot into patched candidates — guards against Rule 9 array replacement dropping fields |
| `coerceNumericFields()` | String → Number on all numeric candidate fields including arm_*_value, arm_*_sd, ci_lower/upper |
| `guardMDFabrication()` | For MD/SMD: resets arm values to null when one is 0 and the other ≈ between-arm difference |
| `backCalculateEvents()` | Priority 1: direct V1 extraction; Priority 2: back-calc from arm_n×rate% |
| `backCalculateSD()` | Cochrane §6.5.2 SE back-calc; 1.75× plausibility guard |
| `normaliseOutcomeTypes()` | `time-to-event` → `time_to_event` (canonical underscore form) |
| `enforceOutcomeTypeForRatioMeasures()` | HR always → `time_to_event`, deterministic, no LLM override |
| `flagAmbiguousSelection()` | ≥2 candidates with different effect measures → `selection_uncertain=true` |
| `auditMetaAnalysisFields()` | Reports `missing` fields split into `uncertain` (irresolvable conflict) vs `absent` (not reported) |

---

## Current Extraction Performance (20-paper run, 2026-04-24)

| Field | V1 | V4 | Notes |
|---|---|---|---|
| Overall rubric | 94% | 96% | +2pp |
| arm_a_events | 86% | 100% | back-calc + direct extraction |
| arm_a_sd | 33% | 67% | Cochrane CI back-calc |
| primary_result_synthesis | 100% | 100% | New field added this session |
| Papers improved by V4 | — | 4/20 | — |
| Papers worsened by V4 | — | 0/20 | SCOT-HEART regression fixed |

**Stability** (5 papers × 5 runs):
- V1 modal agreement: 84%
- V4 modal agreement: 84%
- EXCEL flagged as genuinely ambiguous (HR vs OR selection, `selection_uncertain=true`)
- ORBITA SD contamination: fixed (1.75× plausibility guard)
- UK FASHIoN GRADE stochasticity: fixed (GRADE upgrade guard)

---

## Validation Study (Redesigned — PROTOCOL.md v2.0)

The old Phase 0 / Phase 1 pilot → ablation study design has been superseded. New design:

**N = 30 general surgery RCTs.** 25 diverse landmark papers + 5 focused on a single gen surg question with a published Cochrane review.

**3-phase design:**
- **Phase 1a:** 2 independent raters extract the 19 MA fields manually from source PDFs, timed. Pre-pipeline. Establishes temporally blinded ground truth for primary accuracy endpoints.
- **Phase 2a/2b:** 2 different independent raters check and correct V4 pipeline output, timed. Phase 2a = MA fields only. Phase 2b = all fields.
- **Phase 3:** Blinded arbitrator resolves all rater-pair discrepancies, rates quality and usability. Produces final validated paper library.

**Primary endpoints:** MA field exact-match rate (V4 vs Phase 1a ground truth) + time saving (Phase 1a time vs Phase 2a time per paper).

**Secondary endpoints:** Overall error rate, validated 30-paper library, pilot meta-analysis (V4-extracted fields → pooled estimate vs Cochrane benchmark).

**Preliminary test run:** 5 HFrEF beta-blocker trials (CIBIS-II, MERIT-HF, COPERNICUS, SENIORS, BEST) will be used to rehearse the full workflow and calibrate timing estimates before formal data collection. Not part of the formal study dataset.

**UI needed (all new):** Phase 1a blind extraction form, Phase 2a/2b timed review interface, Phase 3 arbitration UI, study management dashboard. See FEATURES.md.

---

## What We Are Trying to Prove (Publication Path)

**Thesis:** V4 (single extractor + critic + deterministic post-processing) accurately extracts meta-analysis–relevant data from general surgery RCTs, with measurable time savings over manual extraction, demonstrated through prospective blinded human validation.

**Evidence required:**
1. **Phase 1a ground truth + Phase 2a review** (30 papers, 2 rater pairs): MA field accuracy with 95% CIs. Time saving per paper.
2. **Phase 2b full-field review + Phase 3 arbitration**: Overall error rate, error taxonomy distribution, critic regression rate (Class 8 errors).
3. **Stability study** (already complete — 5×5 runs): modal agreement rate, EXCEL ambiguity, GRADE guard effectiveness.
4. **Critic audit analysis**: `_critic.patches` audit trail cross-referenced with Phase 1a ground truth → critic net accuracy on quality fields without an ablation study.
5. **Pilot meta-analysis** (5-paper gen surg subset): pooled estimate vs Cochrane benchmark.

**Target journals:** JAMIA, JBI, npj Digital Medicine, BMJ Open.

---

## Known Structural Limits

| Issue | Status |
|---|---|
| `arm_n` 85% coverage | 2 structural nulls (SPORT dual-cohort — correct); remainder recovered by canonicalisation (Session 16). |
| SPORT arm_n null | Correct — dual-cohort design, no unambiguous single N. |
| EXCEL selection_uncertain | Correct — paper reports HR as primary AND OR in subgroup. `selection_uncertain=true` set. Human review required. |
| SD back-calc blocked when arm_n null | Correct — Cochrane §6.5.2 needs both CI and N. ~65% coverage on continuous outcomes. |
| EXCEL RD CI scale | V1-level instability: oscillates between proportion and percentage-point scale across runs. CI guard protects against critic overwrite. Phase 0 grading annotation. |
| Critic utility | Demonstrated mechanistically via `_critic.patches` audit trail. Formal quantification requires Phase 1a ground truth cross-reference (critic net accuracy on quality fields). |

---

## Next Steps

1. Build validation study UI: Phase 1a blind extraction form, Phase 2a/2b timed review, Phase 3 arbitration, study management dashboard
2. Preliminary test run: 5 beta-blocker HFrEF papers (CIBIS-II, MERIT-HF, COPERNICUS, SENIORS, BEST)
3. Curate 30-paper formal study set (25 diverse gen surg + 5 focused gen surg with Cochrane review)
4. Lock PROTOCOL.md, OSF pre-registration, recruit raters

---

## Tech Stack

| Component | Technology |
|---|---|
| Frontend | Vanilla JS SPA, Tailwind CSS CDN, Chart.js |
| Backend | Vercel serverless (ESM) |
| Primary AI | Google Gemini 2.5 Flash Lite — raw `fetch()`, no SDK, `thinkingBudget:512` |
| Critic AI | OpenAI GPT-4o-mini — `max_completion_tokens:4000`, temperature 0.1 |
| Database | Supabase (Postgres + auth) |
| Rate limiting | Upstash Redis |
| PDF parsing | pdf-parse |
| Deployment | Vercel (Pro plan, `maxDuration:120s`) |
