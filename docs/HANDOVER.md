---
id: "handover"
type: "session-handover"
version: 12
session: "Session 17 — 2026-04-27"
owner: "saqib"
next_session_start: "Read this file first, then LEARNINGS.md, then FEATURES.md"
---

# HANDOVER — OutcomeLogic

Read at the start of every new session before touching any code.

---

## Project in One Sentence

OutcomeLogic is a full-stack AI-powered clinical trial analysis engine: users supply a PDF or DOI/PMID and receive a structured extraction dashboard (PICO, outcomes, risk of bias, GRADE, subgroups, adverse events, expert context). A 3-node V3 pipeline and a V4 pipeline (V1 extractor + gpt-4o-mini critic) both run; V4 is now the primary pipeline with built-in audit trail. Phase 0 validation study is in progress.

---

## Current State (as of 27 April 2026 — v5.4.0)

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

## Completed in Session 17 (2026-04-27) — Pre-Phase 0 fixes + uncertain_fields

Three deterministic fixes shipped on branch `claude/pre-phase0-fixes`. All verified against 20-paper export (`outcomelogic_all_2026-04-27-2.json`) and 5×5 stability run (`outcomelogic_stability_2026-04-27-2.json`).

**lib/pipeline-v4.js:**
- ✅ **CI null-guard in `applyPatches()`** — programmatic block: any patch to `ci_lower` or `ci_upper` where the current value is already non-null is now skipped with a "CI-guard" reason. Fixes the SYNTAX regression (ci_upper=1.81 overwritten with RD CI value in percentage points). Rule 1 in the prompt still says "only patch if null" but was unreliable; this JS guard is the definitive enforcement layer. Doesn't block legitimate CI completions (null → value). `skipped_patches` records blocked patches with reason for audit trail.
- ✅ **`enforceOutcomeTypeForRatioMeasures()`** (NEW) — runs after `normaliseOutcomeTypes()`. Deterministically sets `outcome_type = time_to_event` for any candidate with `effect_measure === 'HR'`, regardless of what V1 or the critic produced. Records `_outcome_type_source = "enforced:HR_always_time_to_event"`. Fixes ISCHEMIA (critic Rule 12 had changed V1's correct `time_to_event` to `binary` reasoning "composite is binary"). This enforcement cannot be overridden by any prompt instruction.
- ✅ **`mergeUncertainFields()`** (NEW) — runs after `restoreDroppedCandidateFields()`. Reads `uncertain_candidate_fields` from the critic's JSON output (a new array in the critic schema) and merges listed field names onto the corresponding candidate's `uncertain_fields` array. Provides three-state semantics: `null` alone = value simply not reported; `null` + `uncertain_fields` includes the field = conflicting evidence, human review needed; value = confident extraction.
- ✅ **`auditMetaAnalysisFields()` updated** — splits `missing` into `uncertain` (field in `uncertain_fields`) vs `absent` (not reported at all). Downstream consumers can distinguish between "paper doesn't report this" and "paper reports conflicting values".
- ✅ **Critic `CRITIC_SYSTEM` updated** — added UNCERTAINTY TRACKING section before Pass B. Critic now emits `uncertain_candidate_fields: [{ candidate_index, fields }]` for any candidate field where the paper contains genuinely irresolvable conflicting values. Normalisation in `runCritic()` ensures `uncertain_candidate_fields` defaults to `[]` if absent.
- ✅ **`%` strip in `canonicaliseLegacyKeys()`** — strips trailing `%` from `arm_a_value`, `arm_b_value`, `arm_a_sd`, `arm_b_sd` before `coerceNumericFields()` runs. Fixes the pattern where V1 emits `"5.3%"` (confirmed on ISCHEMIA arm data); previously `isNaN("5.3%")=true` blocked coercion and the string persisted.

**lib/pipeline-v1.js:**
- ✅ **`uncertain_fields: []`** added to candidate schema in V1 prompt.
- ✅ **UNCERTAINTY RULE** added to Section 4 — instructs V1 to add the field name to `uncertain_fields` (keeping value null) when two paper sections give incompatible values for the same field and neither can be determined authoritative. Explicitly forbids: using `uncertain_fields` for routine choices (adjusted vs unadjusted → use adjusted; randomised vs analysed N → use randomised). Only for genuinely irresolvable conflicts.

### Execution order (post-Session 17)

```
runPipelineV1()
  → canonicaliseLegacyKeys()           [strips %, 'null', legacy keys, compound fractions]
  → runCritic()                        [LLM — emits uncertain_candidate_fields]
  → applyPatches()                     [returns applied/verifications/skipped; CI-guard blocks overwrite]
  → mergeUncertainFields()             [NEW: copies uncertain_candidate_fields onto candidates]
  → restoreDroppedCandidateFields()
  → coerceNumericFields()
  → guardMDFabrication()
  → backCalculateEvents()
  → backCalculateSD()
  → normaliseOutcomeTypes()
  → enforceOutcomeTypeForRatioMeasures() [NEW: HR always time_to_event, no LLM override]
  → flagAmbiguousSelection()
  → auditMetaAnalysisFields()          [splits missing into uncertain vs absent]
```

### Verification against updated exports (2026-04-27-2)

- **CI null-guard**: SYNTAX ci_upper=1.81 intact across all 5 stability runs. No CI overwrites fired on any of the 20 papers.
- **HR enforcement**: All HR candidates have `outcome_type=time_to_event`. ISCHEMIA confirmed fixed.
- **uncertain_fields**: 0 hits across 20 papers — expected. No papers have genuine irresolvable conflicts. Feature is ready for use; no false positives.
- **% strip**: Not directly testable without re-running ISCHEMIA with the new code, but code path confirmed.
- **EXCEL RD CI scale**: ci_lower/ci_upper oscillates between proportion (~0.007) and percentage point (~4) across stability runs. This is V1-level instability; CI guard correctly protects extracted values from critic overwrite but cannot fix LLM non-determinism at extraction. Phase 0 grading annotation.

### Meta-analysis field completeness (post-Session 17)

| Field | Coverage | Notes |
|---|---|---|
| effect_measure | 100% | |
| value (point estimate) | 100% | stable across runs |
| ci_lower / ci_upper | ~90% | CI guard protects; EXCEL RD scale residual |
| outcome_type | 100% | deterministically enforced |
| arm_a_n / arm_b_n | ~85% | 2 structural nulls (SPORT dual-cohort); 1 residual oscillation |
| arm_a_events / arm_b_events | ~100% | of papers with extractable event data |
| arm_a_sd / arm_b_sd | ~65% | largest gap; blocked when arm_n null or CI null |
| primary_result_synthesis | 100% | |

**SD for continuous outcomes** is the biggest remaining gap (~35% missing). All other primary result fields are effectively complete.

---

## Completed in Session 16 (2026-04-27) — Meta-analysis hardening

External Opus critique of v1 vs v4 outputs (20 papers + 5×5 stability) verified against primary data; valid claims actioned. Five fixes shipped on branch `claude/meta-analysis-hardening`. Fix #5 (silent run failures from JSON-parse / Gemini 503) deferred — it surfaces as a Vercel timeout and is not resolvable on the current Vercel plan; the app already errors visibly when these fire.

**lib/pipeline-v4.js:**
- ✅ **`canonicaliseLegacyKeys()`** (NEW) — runs immediately after V1 extractor, BEFORE critic. Migrates V1 legacy field names (`n_arm_a` → `arm_a_n`, `events_arm_a` → `arm_a_events`, `n_arm_b`, `events_arm_b`) onto canonical names; deletes legacy keys; coerces literal string `'null'` → real null; parses compound fractions like `"159/891"` (SYNTAX) into events numerator + N denominator. Rationale: V1 prompt still emits legacy names on most candidates, downstream code reads canonical names → silent data loss. Confirmed: 40 candidates across 20 papers had `n_arm_a` populated with `arm_a_n` null. Item 5 in the previous "Known Issues" list ("PDF-to-text limitation, not fixable at prompt level") was empirically false — this was a canonicalisation bug, now resolved.
- ✅ **`coerceNumericFields()` extended** — added `arm_a_value`, `arm_b_value`, `arm_a_sd`, `arm_b_sd`, `value`, `point_estimate`, `ci_lower`, `ci_upper` to the coerced field list. Fixes type oscillation across runs (TKR `arm_a_value: 32.5` (number) × 3 vs `'32.5'` (string) × 2 in 5×5 stability test).
- ✅ **`guardMDFabrication()`** (NEW) — for `effect_measure ∈ {MD, SMD}`, detects pattern where one arm is 0 and the other equals |between-arm difference| within 5% tolerance. Resets both per-arm values to null and records `_md_fabrication_blocked` provenance. Stops Rule 7 from manufacturing fake per-arm change scores from the between-arm MD.
- ✅ **Rule 7 prompt augmented** — added MD/SMD GUARD section explicitly forbidding (a) using the between-arm difference as an arm value, (b) setting an arm to 0 unless the paper says "no change", (c) deriving one arm from the other plus the MD.
- ✅ **`applyPatches()` redesigned** — now returns `{ applied, verifications, skipped }` (was `{ applied, skipped }`). A patch is **substantive** (`applied`) only if `JSON.stringify(before) !== JSON.stringify(after)`; otherwise it is a **verification** (no-op). External critique flagged 48% no-op rate (62/129 patches) — these were inflating the "patches applied" count with already-correct re-statements. `_critic` now exposes `patches_applied` (substantive only) and `verifications_count` separately. Existing UI (study.html) reads `patches_applied`/`patches_skipped` — compatible (semantics tightened: applied is now substantive only).
- ✅ **Critic provenance tags** — when `applyPatches()` makes a substantive change at `primary_endpoint_candidates[N].<field>`, it now writes a sibling `_<field>_source = "critic_patched:<rule>"` on the candidate. Downstream consumers (and stability comparisons) can distinguish V1-extracted values from critic-corrected values.

**Removed legacy fallbacks:**
- `backCalculateEvents()`, `backCalculateSD()`, `auditMetaAnalysisFields()` no longer read `c.n_arm_a ?? c.arm_a_n` — legacy keys are deleted by the canonicalisation pass and the canonical key is the single source of truth. The "Priority 1: copy `events_arm_a` → `arm_a_events`" branch in `backCalculateEvents` is also obsolete (canonicalisation does it earlier) — replaced with a simple "tag as extracted if already populated, else back-calculate from N×rate" path.

### Execution order (post-Session 16, updated in Session 17)

See Session 17 block above for current canonical execution order.

### Known limits not fixed in Session 16 (deliberately deferred)

- **Silent run failures (~20% from external critique)**: 3/25 JSON-parse + 2/25 Gemini 503 in stability test. Root cause is Vercel timeout under load. The app already raises an error to the user when this happens; the underlying timeout cannot be resolved on the current Vercel plan. Revisit when Vercel plan upgrade is on the table.
- **Meta-analysis workflow scaffolding**: review/lock/export pipeline for confirmed extractions before they enter a meta-analysis dataset. Out of scope for this session — addressed when Phase 0 grading produces a curated set.

---

## Completed in Session 14/15 (2026-04-24)

Three commits on main: `ca658f7`, `c4c1aee`, `f0180e1`.

### Commit ca658f7 — 7 pipeline fixes (V1 prompt + V4 post-processing)

**lib/pipeline-v1.js:**
- ✅ **Canonical effect_measure labels**: Only `HR | OR | RR | RD | MD | SMD` accepted. Removed "difference" synonym. Added CANONICAL LABELS section.
- ✅ **p_value format rule**: Extract inequality strings verbatim ("P<0.05", "P=0.003") — not null. Applies to all p-value fields.
- ✅ **`primary_result_synthesis`**: New field added to V1 prompt (1–2 sentence plain-English summary with estimate, CI, p-value). 100% coverage in first run.

**lib/pipeline-v4.js:**
- ✅ **`coerceNumericFields()`**: Converts string integers ("602"→602) on all numeric candidate fields before any arithmetic. Fixes silent NaN from V1 string output.
- ✅ **`backCalculateEvents()` priority fix**: Priority 1 = copy `events_arm_a` (direct V1 extraction) → `arm_a_events`. Priority 2 = back-calculate from arm_n×rate% **only when Priority 1 yields nothing**. Fixes BITA (140 vs 134) and SYNTAX (205 vs 253) where back-calc was overriding correct direct extraction.
- ✅ **`backCalculateSD()`**: Cochrane §6.5.2 SE back-calculation (SE=(CI_upper−CI_lower)/(2×1.96), pooled_SD=SE/√(1/nA+1/nB)). Initial threshold 2.0×.
- ✅ **Provenance tags**: `_arm_a_events_source: "extracted" | "back-calculated"`, `_sd_source`, `_sd_conflict`.

### Commit c4c1aee — SCOT-HEART regression fix

- ✅ **`restoreDroppedCandidateFields()`**: Rule 9 (secondary endpoint completeness) replaces entire `primary_endpoint_candidates` array. When it reconstructs the primary candidate it drops fields like `value` that weren't extracted afresh. This function re-merges the pre-patch snapshot into patched candidates matched by index and label. Fixes SCOT-HEART V4 effect_value null regression (V1=0.59, V4=null after Rule 9).
- ✅ **Rule 9 prompt guard**: Added CRITICAL instruction: "DO NOT reconstruct or omit existing entries — preserve ALL fields on the primary candidate exactly as supplied."
- ✅ **Execution order after this fix:**
  ```
  applyPatches() → restoreDroppedCandidateFields() → coerceNumericFields()
  → backCalculateEvents() → backCalculateSD() → normaliseOutcomeTypes()
  → flagAmbiguousSelection() → auditMetaAnalysisFields()
  ```

### Commit f0180e1 — Stability fixes + ambiguous selection flag

- ✅ **`normaliseOutcomeTypes()`**: `time-to-event` → `time_to_event` post-patch. Critic uses hyphen; V1 schema uses underscore. This normalisation runs after `applyPatches()`.
- ✅ **`backCalculateSD()` plausibility threshold lowered to 1.75×**: Initial 2.0 threshold would NOT have caught ORBITA (arm_a_sd=178.7 baseline contamination, ratio=1.98). Verified: 1.75 threshold fires on ORBITA, leaves clean papers untouched.
- ✅ **GRADE guard in `applyPatches()`**: Grade hierarchy: Very Low=0, Low=1, Moderate=2, High=3. Blocks any critic patch where `patchedLevel > currentLevel` (upgrades blocked). Downgrades still allowed. Fixes UK FASHIoN GRADE stochasticity (Moderate→Low across runs).
- ✅ **`flagAmbiguousSelection()`**: Post-patch. Detects ≥2 candidates with different `effect_measure` values. Sets `extraction_flags.selection_uncertain=true` + descriptive note listing all candidates. Also surfaced in `_critic.selection_uncertain`. Gives EXCEL and similar papers a visible flag. Does not fire if `selection_uncertain` is already set from V1 or critic.
- ✅ **`_critic` metadata extended**: `selection_uncertain` + `selection_uncertain_note` added to `_critic` block.

### Session 14/15 run results (outcomelogic_all_2026-04-24-2.json — 20 papers)

| Metric | V1 | V4 | Δ |
|---|---|---|---|
| Overall rubric | 94% | 96% | +2pp |
| arm_a_events | 86% | 100% | +14pp |
| arm_a_sd | 33% | 67% | +34pp |
| primary_synthesis | 100% | 100% | 0 |
| Papers improved by V4 | — | 4/20 | — |
| Papers regressed | — | 1/20 | SCOT-HEART (fixed in c4c1aee) |

### Stability run (outcomelogic_stability_2026-04-24-2.json — 5 papers × 5 runs)

- V1 modal agreement: 84%, V4 modal agreement: 84% — tied
- EXCEL genuinely ambiguous on both V1 and V4 (4/5 runs HR, 1/5 run OR — `selection_uncertain` now flags this)
- ORBITA SD: 1/5 run contamination escape (baseline SD slipped through) — fixed with 1.75× threshold
- UK FASHIoN GRADE: critic stochasticity (Moderate/Low inconsistency) — fixed with GRADE guard

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
      ├─► canonicaliseLegacyKeys()    — n_arm_a→arm_a_n, events_arm_a→arm_a_events,
      │                                 string 'null'→null, "159/891"→{events,n}
      ├─► v1Snapshot = JSON.parse(JSON.stringify(v1Result))   [saved as 'v1' version]
      │
      ▼
Node 2: gpt-4o-mini critic (13 rules + plausibility)                   ~12–15s
  Input: stripped paper (Abstract+Methods+Results only) + draft JSON
      │
      ▼
Node 3: deterministic post-processing                                     <1s
  applyPatches()                      — returns {applied, verifications, skipped};
                                        substantive patches tagged with provenance
                                        (_<field>_source = "critic_patched:<rule>")
  restoreDroppedCandidateFields()     — re-merge pre-patch snapshot (Rule 9 guard)
  coerceNumericFields()               — string numerics → Number (incl. arm_*_value/sd)
  guardMDFabrication()                — for MD/SMD, reset arm values when one is 0
                                        and the other ≈ between-arm difference
  backCalculateEvents()               — back-calc from N×rate% when canonical events null
  backCalculateSD()                   — Cochrane §6.5.2, 1.75× plausibility guard
  normaliseOutcomeTypes()             — time-to-event → time_to_event
  flagAmbiguousSelection()            — ≥2 candidates with different effect_measure
  auditMetaAnalysisFields()           — meta_analysis_gaps report
      │
      └─► v1Result._critic = { patches_applied (substantive), verifications_count,
                                patches_skipped, patches, verifications, skipped_patches,
                                quality_notes, violations_found, meta_analysis_gaps,
                                selection_uncertain, selection_uncertain_note, model }
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
5. **arm_a_n/arm_b_n canonicalisation** — RESOLVED in Session 16. Earlier diagnosis ("PDF-to-text limitation, not fixable") was wrong. Data was being extracted by V1 into legacy field names (`n_arm_a`, `events_arm_a`) and downstream code was reading the canonical names (`arm_a_n`, `arm_a_events`) — silent data loss for ~40 candidates across 20 papers. Fixed by `canonicaliseLegacyKeys()` running before the critic. Lesson logged in LEARNINGS.md.
6. **`expertContext status: error`** = Node 4 timed out (45s). Normal PubMed slowness. Not a bug.
7. **Correlated table misread residual risk** — V4 critic (OpenAI) reviewing V1 (Gemini) provides cross-model diversity. If V1 misread is invisible in the stripped paper text, critic cannot catch it.
8. **Rule 2 AE — HIP ATTACK edge case**: "major complications" composite subsumes most clinical AEs. Rule 2 will clear the AE table. Technically correct but produces empty AE section. Annotate in Phase 0 grades.
9. **SPORT arm_n — structural gap, not fixable**: SPORT is a dual-cohort design (randomised + observational arm) with high crossover and multiple analysis populations (ITT/as-treated/combined). No single unambiguous arm N exists. `arm_n` and `arm_a_events` correctly null for both SPORT papers. Do not attempt to fix.
10. **EXCEL ambiguity — flagged, not fixable**: EXCEL genuinely reports HR as primary AND OR in subgroup analysis. `selection_uncertain=true` is now set. Human review required to confirm which analysis is the intended primary. Stability 4/5 HR, 1/5 OR.
11. **SD back-calc blocked when arm_n missing**: `backCalculateSD()` requires both CI and N. Papers where arm_n is null (e.g. SPORT) will not produce back-calculated SD — this is correct, not a bug.
12. **External LLM analysis of JSON should be verified against primary data**: ChatGPT claimed EXCEL `ci_lower` was patched to 0. Verified: actual value 0.79, correctly extracted. GPT was wrong. Always verify external LLM claims against the JSON and source paper before acting.

---

## Priority Order — Next Session

### Immediate — Validation study UI (blocking everything else)

The validation study design is finalised (PROTOCOL.md v2.0). Before any data collection can begin, four UI components are needed:

1. **Phase 1a UI** — manual extraction form for 19 MA fields, per rater, per paper. No pipeline output visible. Built-in timer. Rater login. Existing `pilot.html` is Phase 2 style (pipeline output shown) — Phase 1a is a blank form. See FEATURES.md.
2. **Phase 2a/2b UI** — pipeline output display with per-field correction interface and timer. `pilot.html` is close to this but needs timing, rater identity, and Phase 2a/2b mode switch.
3. **Phase 3 arbitration UI** — side-by-side rater pair comparison, discrepancy highlighting, arbitrator decision fields, overall quality/usability rating.
4. **Study management view** — which papers are at which phase, rater completion status, export.

### Then — Preliminary test run (5 beta-blocker papers)

Once UI is built, run the full workflow on the 5 HFrEF beta-blocker papers (Section 0 of PROTOCOL.md):
- CIBIS-II, MERIT-HF, COPERNICUS, SENIORS, BEST
- PI does Phase 1a extraction on these papers (before running them through V4)
- Run through V4
- Phase 2a/2b check (PI or colleague)
- Run pilot meta-analysis against Cochrane benchmark (Shibata et al.)
- Calibrate timing estimates and match_status edge cases

### Then — Paper curation for formal study

- Curate 25 diverse general surgery RCTs for the 30-paper formal set
- Select focused 5-paper gen surg question with Cochrane review for the formal meta-analysis subset
- Lock PROTOCOL.md Section 11 checklist, OSF pre-registration
- Recruit Phase 1a and Phase 2a/2b raters

### Parked
- **`_EXTRACTOR_SHARED_SECTIONS` rebuild** — V4 supersedes V3; V3 is legacy.
- **Fix PDF export** — parked until study complete.
- **Deploy `supabase/schema-study.sql`** — schema will need updating before validation study; old Phase 0 schema (10 pilot papers, pilot.html workflow) is superseded by the new 3-phase design.

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
- Session 16 (2026-04-27): Meta-analysis hardening. External Opus critique verified against primary data. 5 fixes shipped: canonicaliseLegacyKeys (resolves the false "arm_a_n PDF-limitation" diagnosis — 40 candidates were stranded in legacy keys), coerceNumericFields scope extended (kills type oscillation across runs), guardMDFabrication + Rule 7 prompt update (blocks fabricated MD/SMD per-arm values from between-arm difference), applyPatches now distinguishes substantive vs verification (no-op) patches, critic-patched candidate fields tagged with `_<field>_source = critic_patched:<rule>`. Silent run failures (~20%) deferred — Vercel timeout, not resolvable on current plan.
- Session 18 (2026-04-27): Protocol rewrite (PROTOCOL.md v2.0) — new 3-phase validation design (Phase 1a pre-pipeline MA extraction, Phase 2a/2b pipeline verification, Phase 3 arbitration → validated library). N=30 general surgery RCTs, pilot meta-analysis on 5-paper gen surg focused subset vs Cochrane. Preliminary test run specified: 5 HFrEF beta-blocker trials (CIBIS-II, MERIT-HF, COPERNICUS, SENIORS, BEST) vs Shibata Cochrane review. Reporting framework: no single framework adopted — STARD-informed with TRIPOD-AI/DECIDE-AI guidance cited. Ablation study eliminated. Class 8 (Critic Regression) added to error taxonomy. FEATURES.md updated with 4 new validation study UI components.
- Session 17 (2026-04-27): Pre-Phase 0 fixes. 3 deterministic fixes + uncertain_fields feature: (1) CI null-guard in applyPatches() — blocks critic overwriting non-null ci_lower/ci_upper (fixes SYNTAX ci_upper regression); (2) enforceOutcomeTypeForRatioMeasures() — HR always time_to_event post-patch, no LLM override (fixes ISCHEMIA critic regression); (3) uncertain_fields three-state signal — null=not reported, null+uncertain_fields=irresolvable conflict, value=confident. Critic now emits uncertain_candidate_fields; V1 prompt includes UNCERTAINTY RULE. (4) % strip in canonicaliseLegacyKeys for arm value/SD fields. Verified against 20-paper export: CI guard correct, HR enforcement correct, 0 false-positive uncertain_fields. EXCEL RD CI scale instability remains at V1 level — Phase 0 grading annotation. Meta-analysis completeness: effect_measure/value/outcome_type 100%; CI ~90%; arm N ~85%; SD ~65% (largest gap). Pipeline ready for Phase 0.
- Session 14/15 (2026-04-24): Full 20-paper V4 re-run. Analysed SPORT arm_n (structural gap, correct null). Identified arm_events coverage artefact (V1 uses events_arm_a, V4 uses arm_a_events — both present = 100% coverage). Verified external LLM claims against primary data (ChatGPT EXCEL ci_lower claim wrong). 7 fixes: coerceNumericFields, backCalculateEvents priority (direct > back-calc), backCalculateSD (Cochrane §6.5.2), provenance tags, primary_result_synthesis in V1, canonical effect_measure labels, p_value format. SCOT-HEART regression fixed (restoreDroppedCandidateFields + Rule 9 prompt guard). Stability analysis: 4 fixes (normaliseOutcomeTypes, SD plausibility guard 1.75×, GRADE guard, flagAmbiguousSelection). Final scores V1=94%, V4=96%. Commits: ca658f7, c4c1aee, f0180e1.
