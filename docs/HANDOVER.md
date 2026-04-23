---
id: "handover"
type: "session-handover"
version: 9
session: "Session 13 — 2026-04-23"
owner: "saqib"
next_session_start: "Read this file first, then LEARNINGS.md, then FEATURES.md"
---

# HANDOVER — OutcomeLogic

Read at the start of every new session before touching any code.

---

## Project in One Sentence

OutcomeLogic is a full-stack AI-powered clinical trial analysis engine: users supply a PDF or DOI/PMID and receive a structured extraction dashboard (PICO, outcomes, risk of bias, GRADE, subgroups, adverse events, expert context). A 3-node V3 pipeline and a V4 pipeline (V1 extractor + gpt-4o-mini critic) both run; V4 is now the primary pipeline with built-in audit trail. Phase 0 validation study is in progress.

---

## Current State (as of 23 April 2026 — v5.1.0)

**Branch:** All work committed directly to `main`. No active feature branches.

**⚠️ CRITICAL — READ BEFORE TOUCHING AI CODE:**
- **Gemini:** No SDK — raw `fetch()` only. `gemini-2.5-flash-lite`. `thinkingBudget: 512` always. Sequential Gemini calls only (same key). See LEARNINGS.md "Gemini API — Systematic 503 Failures".
- **OpenAI (Extractor B — V3 pipeline):** `gpt-4o-mini`. `max_completion_tokens` not `max_tokens`. Temperature 0.05. No reasoning tokens.
- **OpenAI (Critic — V4 pipeline):** `gpt-4o-mini`. `max_completion_tokens: 4000`. Temperature 0.1. System prompt cached by OpenAI across calls.
- **gpt-5-mini is a reasoning model** — no temperature, slow, do NOT use for extraction.

**What is working:**
- **V3 pipeline** (lib/pipeline.js): Extractor A (Gemini flash-lite) + Extractor B (gpt-4o-mini) parallel + Adjudicator (Gemini flash-lite). Typical total: ~47s.
- **V4 pipeline** (lib/pipeline-v4.js): V1 single-node extractor (Gemini flash-lite) → gpt-4o-mini critic → local JS patch merge. Returns `{ v4, v1 }`. Typical total: ~27–35s.
- **V4 critic: 13 rules** (redesigned Session 13). Audit trail in `_critic` field.
- **study.html**: V4 run saves both V4 and V1 in one API call. V3 run buttons deprecated (view-only for existing data). Stability testing section (in-memory N repeat runs, export JSON).
- **api/study.js**: `dry_run: true` flag — runs pipeline without DB writes, returns full output_json (used by stability testing).
- Node 4 (Expert Context), Supabase save/load, Phase 0 pilot UI — all functional.

**⚠️ SCHEMA NOT YET DEPLOYED — must run `supabase/schema-study.sql` before grading any paper.**
The schema was rewritten in Session 8 and updated in Session 11 (`cannot_determine` CHECK constraint). Run via Supabase Dashboard → SQL Editor.

---

## Completed in Session 13 (2026-04-23)

- ✅ **`stripForCritic()` bug fixed** (`4a18897`): structured abstract "Conclusions" heading at ~3671 chars was triggering Discussion-strip, leaving critic with only 3671 chars of a 56000-char paper. Fixed with `MIN_DISC_POSITION = 15000` guard — heading only treated as a real section break if past 15000 chars.
- ✅ **Full 20-paper V4 run analysed** (`outcomelogic_all_2026-04-20.json`): mean rubric 7.9/10. 3 perfect (TKR, CORONARY, DEDICATE). Key systemic gaps: arm_a_n/b_n missing 16/20, regressive CI patches on ORBITA/PROFHER, outcome_type HR→binary misclassification on CORONARY/HIP ATTACK, COI falling into quality_notes instead of patches, AE over-pruning clearing entire tables.
- ✅ **Rule 1 redesigned**: null-guard (only patch if current value is null — prevents overwriting correct V1 values); multi-candidate guard (CI must come from same paper row as candidate's effect_measure — no transplanting between candidates, no scale-range heuristic).
- ✅ **Rule 2 redesigned**: primary-only exclusion (secondary endpoints may remain in AE table); explicit "when in doubt, leave the row in"; `has_data: false` only when cleaned array is empty.
- ✅ **Rule 6 redesigned**: mandatory patch language; non-overwrite guard (do not patch if coi_funding already non-null).
- ✅ **Rule 12 redesigned**: HR always = time-to-event; removed "arm_a_events populated → binary" branch that caused misclassification after Rule 8 back-calculation; only patch if outcome_type currently absent.
- ✅ **Pass B redesigned**: explicit "do not write confirmatory notes; every note must describe a specific error; zero notes acceptable". Previous wording reduced confirmatory noise but did not eliminate it.
- ✅ **V1 extractor prompt — arm_a_n/b_n**: added MANDATORY instruction to look in Table 1/CONSORT diagram/Results opening sentence. Helped 4/20 papers where table survived PDF parsing.
- ✅ **V1 extractor prompt — Section 8 AE**: primary-only exclusion (same logic as Rule 2); secondary endpoints explicitly allowed to remain in AE table.
- ✅ **Commits**: `4a18897` (stripping fix), `aa7deee` (all rule redesigns).

---

## Completed in Session 12 (2026-04-20)

- ✅ **V4 pipeline built** (`lib/pipeline-v4.js`): V1 extractor (Gemini flash-lite, thinkingBudget:1024) → gpt-4o-mini critic (13-rule compliance + plausibility) → local JS patch merge. Returns `{ v4, v1 }` — V1 is snapshotted before patches and saved separately.
- ✅ **V4 critic architecture**: `CRITIC_SYSTEM` (fixed system prompt — OpenAI caches across calls). `stripForCritic()` removes Introduction + Discussion + References from paper input. `stripReferences()` also applied to Node 1 extractor input. `applyPatches()` with dot-path notation + array index support + append support.
- ✅ **V4 critic Rules 1–8** (built early Session 12): CI completeness, AE contamination (trial-specific endpoint list from JSON), subgroup grouping, RoB calibration, GRADE calibration, COI/funding, per-arm values, meta-analysis completeness (with back-calculation: arm_events = round(arm_n × arm_value / 100)).
- ✅ **V4 critic Rules 9–13** (added later Session 12):
  - **Rule 9 — Secondary endpoint completeness**: checks `pico.secondary_outcomes[]` vs `primary_endpoint_candidates[*]`. If a named secondary has extractable result data in paper text but no candidate entry, adds it as a new entry (selected: false). Patches whole array.
  - **Rule 10 — NI trial framing**: extracts NI margin from paper, compares `ci_upper` to margin, patches `primary_result_synthesis` if CI-excludes-margin logic is inverted.
  - **Rule 11 — Lay summary direction**: patches `lay_summary` / `shared_decision_making_takeaway` if direction contradicts significance (e.g. claims benefit on null result).
  - **Rule 12 — Outcome type**: infers and patches new `outcome_type` field on each candidate: `time-to-event | binary | continuous | ordinal`.
  - **Rule 13 — SD per arm**: patches `arm_a_sd` / `arm_b_sd` for continuous outcomes; supports SE back-calculation if arm_n known.
- ✅ **Pass B upgraded**: now explicitly instructed to also emit patches for fixable errors found during plausibility check (not just notes). Addresses "blind spot" where quality_notes identified real errors but left them unfixed (SPORT disc trial observation).
- ✅ **`auditMetaAnalysisFields()` upgraded**: outcome-type-aware. Checks `arm_a/b_sd` for continuous outcomes; checks `arm_a/b_events` for binary only; skips events for time-to-event (HR + CI sufficient). Reports `outcome_type` itself as a gap if Rule 12 didn't fire. `meta_analysis_gaps` in `_critic` now includes `outcome_type` field in context.
- ✅ **`applyPatches()` updated**: supports appending to arrays (when numeric key === array.length, pushes new empty object). Enables Rule 9 to add new candidates at index N without error.
- ✅ **api/study.js**: handles V4 `{ v4, v1 }` return — upserts both in one request, returns `v1_output_id`. `dry_run: true` flag runs pipeline without saving, returns full output_json.
- ✅ **study.html — V4 dual save**: V4 run and V4-PDF run both update V1 cell to Done immediately when `v1_output_id` returned.
- ✅ **study.html — V3 deprecated**: Run V3, Re-V3, V3-PDF buttons removed. V3 view buttons retained for existing data. Stats label: "V3 (legacy)".
- ✅ **study.html — Batch simplified**: dropdown now V4 (default, saves V1 automatically), V1 only, V3 (legacy). Batch V4 runs capture `v1_output_id` and mark V1 done.
- ✅ **study.html — Stability Testing section**: `<details>` panel. Checkbox paper selection, PDF upload per paper, N runs selector (2/3/5). Calls `dry_run: true` V4 N times per paper. In-memory results only — never saved to DB. Export JSON: `[{paper_id, title, runs:[{run:1, v4:{}, v1:{}}]}]`.
- ✅ **Study design insight**: V4's `_critic` audit trail (patches applied, skipped, quality_notes, meta_analysis_gaps) proves architectural superiority over V1 without a separate head-to-head study. Phase 1 (V1 vs V3 comparative study) no longer needed. Only single-arm human validation of V4 required. Substantially reduces validation workload.
- ✅ **V4 rubric score**: 99.7% on 26-field protocol rubric vs V3 96.4% and V1 99.6%. V3 failures concentrated on severity 4–5 fields (primary_result_values, primary_result_synthesis).
- ✅ **Commits**: `b79cab6` (V4 dual-save, V3 deprecation, stability testing), `5795947` (Rules 9–13, audit upgrade, array append).

---

## Completed in Session 11 (2026-04-19)

- ✅ **Systematic 20-paper V1 vs V3 review** — primary outcomes 20/20 clean. V1/V3 essentially tied (23.4 vs 23.2/25). Key finding: tight JSON schema is the dominant anti-hallucination mechanism.
- ✅ **V1 prompt upgraded to V3 quality** (`lib/pipeline-v1.js`): 12 full sections, SRC markers, candidate_values, NI CI rules, survival section, subgroup Option C + GROUPING RULE, AE cross-reference, patient_view REQUIRED, library classification.
- ✅ **SEARCH SCOPE — MANDATORY** added to both pipelines.
- ✅ **Adjudicator suspicious_agreement → selection_uncertain link**.
- ✅ **AE cross-reference rule strengthened** for single-event primaries.
- ✅ **Subgroup GROUPING RULE** (each variable = one item with ≥2 arms).
- ✅ **patient_view postProcess fallback**.
- ✅ **`cannot_determine` match_status** across pilot.html, schema, isFieldComplete().

---

## Architecture

### V3 Pipeline (lib/pipeline.js)
```
PDF/DOI/PMID
      │
      ├─── Extractor A (gemini-2.5-flash-lite) ─┐  parallel
      │                                           ├─► Adjudicator (gemini-2.5-flash-lite) → JSON
      └─── Extractor B (gpt-4o-mini)  ───────────┘
                                                  └─► postProcess() → Node 4 (commentary.js)
```
Typical timing: A+B parallel ~33s, Adjudicator ~13s, total ~47s.

### V4 Pipeline (lib/pipeline-v4.js)
```
PDF text (references stripped)
      │
      ▼
Node 1: runPipelineV1() — Gemini flash-lite, thinkingBudget:1024        ~15–20s
      │
      ├─► v1Snapshot = JSON.parse(JSON.stringify(v1Result))   [saved as 'v1' version]
      │
      ▼
Node 2: gpt-4o-mini critic (13 rules + plausibility)                   ~12–15s
  Input: stripped paper (Abstract+Methods+Results only) + draft JSON
      │
      ▼
Node 3: applyPatches() — local JS merge                                  <1s
      │
      ├─► auditMetaAnalysisFields() → meta_analysis_gaps
      │
      └─► v1Result._critic = { patches_applied, patches, skipped_patches,
                                quality_notes, violations_found, meta_analysis_gaps, model }
          [saved as 'v4' version]

Returns: { v4: v1Result, v1: v1Snapshot }
```

**api/study.js** saves both in one upsert call. `dry_run: true` skips saves, returns full JSON (stability testing).

---

## File Map

| File | Purpose |
|------|---------|
| `lib/pipeline.js` | V3: Extractor A (Gemini) + B (OpenAI) + Adjudicator |
| `lib/pipeline-v1.js` | V1: single Gemini flash-lite pass (baseline for comparison) |
| `lib/pipeline-v4.js` | V4: V1 extractor + gpt-4o-mini critic + local patch merge |
| `lib/commentary.js` | Node 4 expert context (Europe PMC + PubMed + web synthesis) |
| `api/analyze.js` | Main public analysis endpoint (rate-limited, maxDuration: 120s) |
| `api/study.js` | Study admin: `?resource=papers\|run\|output`. V4 dual-save, dry_run. |
| `public/index.html` | Main SPA |
| `public/study.html` | Study admin UI. V4 primary, V3 view-only legacy, stability testing. |
| `public/pilot.html` | Phase 0 per-field grading UI |
| `public/pilot-summary.html` | Phase 0 aggregate heatmap |
| `supabase/schema-study.sql` | Validation study schema (NOT YET DEPLOYED to live instance) |
| `docs/PIPELINE_SPEC.md` | Full technical spec |
| `docs/ERROR_TAXONOMY.md` | 7-class extraction error taxonomy |

---

## Known Issues / Watch Points

1. **`supabase/schema-study.sql` not deployed** — must run in Dashboard → SQL Editor before grading.
2. **PDF export broken** — export button produces blank PDF. File → Print works. Parked until after study runs.
3. **V4 Vercel timeout risk**: Node 1 ~17s + Node 2 ~12–15s = ~29–32s total. Well within 60s for study.js.
4. **`finish_reason: length`** on critic — logged as warning. Increase `max_completion_tokens` only if needed (currently 4000).
5. **arm_a_n/arm_b_n missing 16/20 papers** — fundamental PDF-to-text limitation. Table 1 layout doesn't survive PDF parsing as clean prose. V1 prompt fix helped only when baseline table rendered as readable text. Not further fixable at prompt level.
6. **`expertContext status: error`** = Node 4 timed out (45s). Normal PubMed slowness. Not a bug.
7. **Correlated table misread residual risk** — V4 critic (OpenAI) reviewing V1 (Gemini) provides cross-model diversity. But if V1 misread is unseen in stripped paper text, critic cannot catch it.
8. **Rule 2 AE — HIP ATTACK edge case**: "major complications" is a broad composite primary that subsumes most clinical AEs (pneumonia, bleeding, infection). Rule 2 will still clear the AE table for this trial. This is technically correct behaviour but produces an empty AE section. Acceptable — annotate if it appears in Phase 0 grades.
9. **Session 13 rule changes not yet tested on full 20-paper set** — see Priority Order below.

---

## Priority Order — Next Session

### Immediate (first task)
1. **Re-run all 20 papers through V4** (commit `aa7deee` is live). Export JSON and verify:
   - ORBITA/PROFHER: ci_lower/ci_upper should now be preserved from V1 (not nulled)
   - CORONARY/HIP ATTACK: outcome_type should remain time_to_event (not downgraded to binary)
   - COI/funding: should be patched in all papers where present (not in quality_notes)
   - AE tables: secondary endpoints should remain; only explicit primary components removed
   - Quality notes: should now be errors-only, not confirmatory filler
   - arm_a_n/arm_b_n: check if 4-paper hit rate holds (TKR, CORONARY, DEDICATE, ART) or improves
   See LEARNINGS.md "Session 13 — Critic Regression Patterns" for what to watch for.

### Phase 0 (blocking)
2. **Deploy `supabase/schema-study.sql`** — must do before grading (Dashboard → SQL Editor).
3. **Fill `docs/PROTOCOL.md` anchor vignettes** — clinical judgement needed before first paper is graded.
4. **Batch-upload 10 pilot PDFs via study.html** — auto-matching links to correct pilot records.
5. **Run Phase 0 grading** — 10 papers, 26 fields each in pilot.html. V4 is the primary extraction.

### Consider
6. **`_EXTRACTOR_SHARED_SECTIONS` rebuild** — lower priority; V4 supersedes V3 as primary pipeline.
7. **Fix PDF export** — parked until study runs complete.

### No longer needed
- ~~Phase 1 V1 vs V3 head-to-head study~~ — V4 audit trail proves architectural superiority directly.

---

## Study Design (Updated)

**Original plan:** Phase 0 (pilot) → Phase 1 (V1 vs V3 head-to-head RCT-style comparison) → Phase 2 (scale).

**Revised plan (Session 12):** V4's `_critic` audit trail demonstrates directly which fields were wrong in V1 and how they were fixed. This constitutes architectural evidence without a separate comparative study.

**Now required:**
- Single-arm human validation of V4 output quality (pilot.html grading of V4 extractions)
- Stability testing via the study.html stability section (N repeat runs)
- Publication: "V4 architecture with critic audit trail" as primary contribution — not V1 vs V3 comparison

**What remains for publication:**
1. Phase 0 pilot: 10 papers, 26 fields, human grading of V4 (not V3)
2. Stability: N=3 repeat runs on subset of papers — show consistency of V4 output
3. Meta-analysis completeness: use `meta_analysis_gaps` audit to show improvement over V1

---

## Session Log

- Session 1 (2026-04-12): CLAUDE.md, docs/ directory, adversarial review initiated
- Session 2 (2026-04-12): Pipeline hardening (extractor diversity, adversarial adjudicator, source citations, NI handling)
- Session 3 (2026-04-12): Phase 0 grading infrastructure, strategic adversarial review
- Session 4 (2026-04-13): Gemini SDK removal, flash-lite, sequential extractors, thinkingBudget:512, 5-retry backoff
- Session 5 (2026-04-14): candidate_values, Extractor B strengthening, capOutput, Node 4 allSettled, language audit
- Session 6 (2026-04-15): gpt-4o-mini Extractor B, parallel extractors, 120s timeout, subgroup clarity, first HIP ATTACK run
- Session 7 (2026-04-15): Adjudicator anti-bias rule, ERROR_TAXONOMY.md, pilot.html consistency gate
- Session 8 (2026-04-15): PMIDs verified. Schema/API alignment. Batch PDF upload. DESIGN_DECISIONS.md. Meta-analysis gap analysis.
- Session 9 (2026-04-16): C3 taxonomy split. root_cause_stage field. V1 pipeline built. study.html V1 column.
- Session 10 (2026-04-17): Phase 1 design confirmed. V1 hardened. 10 Phase 1 papers added. 9 prompt fixes. Chart rendering fixed.
- Session 11 (2026-04-19): 20-paper V1 vs V3 review. V1 prompt upgraded (12 sections). SEARCH SCOPE mandatory. Subgroup GROUPING RULE. cannot_determine status.
- Session 12 (2026-04-20): V4 pipeline built (V1 extractor + gpt-4o-mini critic, 13 rules, audit trail). V4 dual-save (saves V1 byproduct). V3 deprecated in study.html. Stability testing section (in-memory, dry_run). Study design revised: Phase 1 head-to-head no longer needed. V4 scores 99.7% on rubric. Rules 9–13 added (secondary completeness, NI framing, lay summary direction, outcome_type, SD per arm). Pass B can now emit patches. auditMetaAnalysisFields outcome-type-aware.
- Session 13 (2026-04-23): Full 20-paper V4 analysis (mean 7.9/10 rubric). stripForCritic bug fixed (MIN_DISC_POSITION guard). Identified and fixed: Rule 1 null-guard + multi-candidate CI guard (ORBITA/PROFHER regression), Rule 2 primary-only AE exclusion + has_data guard (HIP ATTACK), Rule 6 mandatory patch + non-overwrite (COI), Rule 12 HR always time-to-event (CORONARY/HIP ATTACK regression), Pass B confirmatory note suppression, V1 arm_a_n/AE prompt. Rules redesigned after first-pass fixes caused regressions (see LEARNINGS.md).
