---
id: "project-summary"
type: "summary"
created: 2026-04-24
owner: "saqib"
---

# OutcomeLogic — Project Summary

**As of 24 April 2026 (v5.2.0 · commit f0180e1)**

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

### Deterministic post-processing (V4 Node 3 — added Sessions 14/15)
| Function | What it does |
|---|---|
| `restoreDroppedCandidateFields()` | Re-merges V1 snapshot into patched candidates — guards against Rule 9 array replacement dropping fields |
| `coerceNumericFields()` | String integer → Number on all numeric candidate fields |
| `backCalculateEvents()` | Priority 1: copy `events_arm_a` (direct); Priority 2: back-calc from arm_n×rate% |
| `backCalculateSD()` | Cochrane §6.5.2 SE back-calc; 1.75× plausibility guard overrides contaminated extracted SD |
| `normaliseOutcomeTypes()` | `time-to-event` → `time_to_event` (canonical underscore form) |
| `flagAmbiguousSelection()` | ≥2 candidates with different effect measures → `selection_uncertain=true` |
| `auditMetaAnalysisFields()` | Reports which meta-analysis fields are missing and why |

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

## Validation Study — Phase 0 (In Progress)

**Goal:** Human grading of V4 extractions against source papers. 10 papers, 26 fields each.

**Papers:** 9 landmark surgical RCTs + 1 post-training-cutoff paper (OPTIMAS 2024). Chosen to stress-test specific pipeline failure modes.

**Infrastructure built:**
- `supabase/schema-study.sql` — 5-table schema (papers, extractions, sessions, grades, rater_assignments). **⚠️ Not yet deployed to live Supabase instance — must run before grading.**
- `public/pilot.html` — per-field grading (exact/partial/fail/hallucinated, taxonomy, severity, correction text)
- `public/pilot-summary.html` — aggregate heatmap, priority queue, CSV export

**Go/no-go gate:** ≥85% exact match on primary numeric fields → proceed to Phase 1 powered study.

**What Phase 0 will prove:** Whether the critic adds value on quality fields (ROB, GRADE, COI, lay summary direction) — the JS post-processing layer handles coverage; the critic's value is in quality.

---

## What We Are Trying to Prove (Publication Path)

**Thesis:** A V1 extractor + critic + deterministic post-processing architecture achieves significantly higher extraction accuracy and consistency than a single-pass extractor alone, and provides an auditable evidence trail (via `_critic`) that makes errors detectable and correctable.

**Evidence required:**
1. **Phase 0 pilot** (10 papers, human-graded): exact/partial/fail/hallucinated per field. Priority scores identify worst failure modes → prompt modification queue.
2. **Stability study** (5 papers × 5 runs): modal agreement rate shows how consistent V4 is across re-runs.
3. **Critic audit analysis**: `_critic.patches_applied` shows what V4 fixed in V1 output. Graded against source paper to show critic accuracy on quality fields.
4. **Phase 1 powered validation** (25+ papers, 2 independent raters, kappa ≥0.6): publishable in JAMIA / npj Digital Medicine.

**Target journals:** JAMIA, JBI, npj Digital Medicine.

---

## Known Structural Limits

| Issue | Status |
|---|---|
| `arm_n` missing 16/20 papers | Fundamental PDF-to-text limit. Table 1 rarely parses as clean prose. Not fixable at prompt level. |
| SPORT arm_n null | Correct — dual-cohort design, no unambiguous single N. |
| EXCEL selection_uncertain | Correct — paper genuinely reports HR as primary and OR in subgroup. Human review required. |
| SD back-calc blocked when arm_n null | Correct — Cochrane §6.5.2 needs both CI and N. |
| Critic utility not yet proven on quality fields | Phase 0 grading will address this. |

---

## Next Session

1. Re-run all 20 papers with latest code (`f0180e1`) — verify SCOT-HEART fix, ORBITA SD, EXCEL flag, BITA/SYNTAX events
2. Run stability test (5 papers × 5 runs)
3. Deploy `supabase/schema-study.sql` to Supabase
4. Begin Phase 0 grading in `pilot.html`

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
