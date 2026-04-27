---
id: "error-taxonomy"
type: "methodology"
version: 1
created: 2026-04-15
owner: "saqib"
status: "draft — subject to revision after Phase 0 grading begins"
---

# OutcomeLogic — Extraction Error Taxonomy

**Purpose:** Systematic classification of extraction errors for use in Phase 0 grading, Phase 1 analysis, and prompt iteration. Each error must be assigned exactly one primary class. Secondary classes are permitted where genuinely ambiguous.

**Status:** This taxonomy is provisional. It must be validated against real Phase 0 errors during the first 3 papers and revised if categories prove under- or over-specified. Record changes in the revision log at the end of this document.

---

## Taxonomy Overview

Errors are classified along two axes:

1. **Origin axis** — where in the pipeline did the error arise?
2. **Mechanism axis** — what kind of failure caused it?

These axes determine the fix: origin identifies which node to modify; mechanism identifies what kind of prompt change is needed.

```
ORIGIN          MECHANISM
─────────────────────────────────────────────────────
Extractor       Recall failure
Extractor       Correlated recall failure
Extractor       Misclassification
Adjudicator     Ranking failure
Adjudicator     Anti-bias failure
Post-processing Formatting / Enum error
Any node        Interpretation failure
Any node        Hallucination
```

---

## Primary Error Classes

### Class 1 — Recall Failure (Extractor)

**Definition:** The correct value was not present in `primary_endpoint_candidates` (or the equivalent extractor output for non-primary fields). The adjudicator never had the opportunity to select it.

**Detectable by:** Checking whether the correct value appears in the candidates array at grading time.

**Pipeline origin:** Extractor A or B (one or both).

**Mechanism subtypes:**

| Subtype | Description | Example |
|---|---|---|
| 1a — Omission | Value exists in the paper but was not extracted | Adjusted HR in Table 3 not surfaced; only abstract unadjusted HR extracted |
| 1b — Wrong field | Value extracted but placed under wrong field | NI margin placed in `primary_outcome_def` rather than structured NI field |
| 1c — Truncation loss | Value was in the paper but in the section lost to 40k char cap | AEs or secondary outcomes cut off on long papers |

**Fix target:** Extractor prompt — candidate coverage check, field-specific instructions, or (for 1c) input prioritisation.

**Phase 0 metric:** Candidate recall failure rate — for each paper, was the correct value present in the candidates array?

---

### Class 2 — Correlated Recall Failure (V3 pipeline only)

**⚠️ V4 note:** Class 2 is not applicable in the V4 pipeline. V4 uses a single extractor (V1) — there is no second extractor to be correlated with. A V1 recall failure is Class 1. A critic-introduced error is Class 8 (see below). Class 2 is preserved for historical reference and for any future use of the V3 pipeline.

**Definition (V3):** Neither Extractor A nor B surfaced the correct value. Both produced candidates, but the correct value was absent from all of them. The adjudicator confirmed a wrong candidate.

**This was the highest-severity class in V3.** Structurally undetectable from pipeline output alone — the extraction looks clean, the adjudication looks clean, the candidates look plausible. Requires PI review against source document.

**Detectable by:** PI comparing pipeline output to source document. `suspicious_agreement: true` is a hint but does not guarantee detection.

**Pipeline origin:** Both extractors (correlated) — V3 only.

**Mechanism subtypes:**

| Subtype | Description | Example |
|---|---|---|
| 2a — Shared table misread | Both models misread the same table identically | Both extract HR from wrong row of a multi-endpoint table |
| 2b — Abstract anchoring | Both default to abstract value; neither looks up full-text table | Both report unadjusted HR from abstract; adjusted HR from Results not surfaced |
| 2c — Model convergence | Both models make same inference from ambiguous text | Ambiguous "treatment effect" phrasing interpreted identically by Gemini and GPT-4o-mini |

**Fix target (V3):** Extractor prompt diversity; paper-level escalation to a stronger model.

**V4 equivalent risk:** A single-extractor recall failure (Class 1) combined with a critic that fails to catch it (because the missed value is not visible in the stripped paper text). This is less dangerous than V3 Class 2 because the critic receives a different model's perspective and different section stripping; but it remains a residual failure mode.

---

### Class 3a — Ranking: Hierarchy Violation (Adjudicator)

**Definition:** The correct value was present in `primary_endpoint_candidates` but was not selected because the adjudicator violated the pre-specified ranking hierarchy (adjusted > unadjusted, ITT > PP, pre-specified > post-hoc, etc.).

**Detectable by:** Checking whether the correct value is in the array but has `selected: false`, and whether the selected candidate ranks lower by explicit hierarchy rules.

**Pipeline origin:** Adjudicator.

**Mechanism subtypes:**

| Subtype | Description | Example |
|---|---|---|
| 3a-i — Analysis type hierarchy | Unadjusted selected over adjusted | Unadjusted HR selected despite adjusted Cox HR being present and correctly labelled |
| 3a-ii — Population hierarchy | PP or mITT selected over ITT | Per-protocol result selected when ITT result was available |
| 3a-iii — Anti-bias failure | More extreme or abstract-prominent value selected | HR 0.61 selected over HR 0.74 because it was further from null, not analytically superior |
| 3a-iv — Source trust | Synthetic/uncertain citation weighted as confirmation | Both extractors cite wrong table; adjudicator treats agreement as grounding |

**Fix target:** Adjudicator ranking rules — add explicit hierarchy enforcement and anti-bias check.

---

### Class 3b — Ranking: Ambiguity Resolution Failure (Adjudicator)

**Definition:** The correct value was present in `primary_endpoint_candidates` but was not selected because the candidates were genuinely ambiguous — multiple candidates were plausibly defensible — and the adjudicator chose the wrong one. Distinguished from 3a in that no clear hierarchy rule was violated; the failure was a judgement call under uncertainty.

**Detectable by:** Multiple candidates exist with similar labels and similar plausibility; the correct one is present but the selection rationale is not clearly wrong by rule.

**Pipeline origin:** Adjudicator.

**Mechanism subtypes:**

| Subtype | Description | Example |
|---|---|---|
| 3b-i — Label trust failure | Adjudicator trusted extractor label without cross-checking Methods | Candidate labelled "secondary analysis" deprioritised though it matched pre-specified primary endpoint |
| 3b-ii — Timepoint ambiguity | Multiple timepoints present; wrong one selected | 3-year composite selected when 5-year was the pre-specified primary |
| 3b-iii — Subgroup/overall confusion | Subgroup result promoted over overall trial result | STICH geographic subgroup result selected as primary endpoint |

**Fix target:** Adjudicator prompt — require Methods section cross-check for pre-specified primary endpoint before ranking candidates.

---

### Class 4 — Misclassification (Extractor)

**Definition:** The extracted value is numerically correct but the label, population tag, analysis type, or endpoint definition is wrong.

**Detectable by:** The value matches the source but the surrounding metadata does not.

**Pipeline origin:** Extractor A or B.

**Mechanism subtypes:**

| Subtype | Description | Example |
|---|---|---|
| 4a — Analysis type wrong | Correct number, wrong label | HR 0.68 extracted correctly but labelled "unadjusted" when it is the adjusted Cox model result |
| 4b — Population wrong | Correct number, wrong population tag | ITT result tagged as per-protocol |
| 4c — Endpoint wrong | Correct statistic, wrong endpoint | HR extracted from secondary endpoint table, labelled as primary |
| 4d — Timepoint wrong | Correct statistic, wrong timepoint | 1-year mortality extracted; paper's primary endpoint was 30-day |

**Fix target:** Extractor prompt — label verification instructions, Methods cross-check requirement.

---

### Class 5 — Interpretation Failure (Any node)

**Definition:** The extracted values and labels are correct, but the clinical or methodological interpretation is wrong.

**This class applies to non-numeric fields** — GRADE certainty, risk of bias, NI result label, lay summary, shared decision-making takeaway.

**Pipeline origin:** Extractor or adjudicator (whichever generates the interpretation field).

**Mechanism subtypes:**

| Subtype | Description | Example |
|---|---|---|
| 5a — GRADE miscalibration | Certainty rating does not match the evidence characteristics | "High" certainty assigned to open-label RCT with subjective primary outcome |
| 5b — RoB miscalibration | Risk of bias rating does not reflect domain-level assessment | "Low" assigned despite no allocation concealment |
| 5c — NI conflation | Non-inferiority result described as superiority, or vice versa | "Treatment A is better than B" in lay summary for NI trial that was NI-successful but not superior |
| 5d — Effect language | Language implies causation, recommendation, or certainty not supported by the evidence | "Surgery is recommended" in patient view |
| 5e — Direction error | Effect direction reversed | "Favours intervention" when HR > 1 with CI entirely above 1 |

**Fix target:** Language audit in extractor and adjudicator prompts. GRADE/RoB rubric in system instruction. NI framing rules.

**Severity note:** 5c and 5e are severity-5 errors. A clinician reading a reversed direction or a conflated NI result may make the wrong treatment decision.

---

### Class 6 — Hallucination (Any node)

**Definition:** The extracted field contains content that does not exist in the source document and cannot be inferred from it.

**Distinct from misclassification** (Class 4): hallucination is fabrication, not mislabelling of real content.

**Pipeline origin:** Extractor or adjudicator.

**Mechanism subtypes:**

| Subtype | Description | Example |
|---|---|---|
| 6a — Fabricated statistic | Numeric value has no source location | HR 0.72, 95% CI 0.55–0.94 with no matching entry in full text |
| 6b — Fabricated citation | `source_citation` field contains text not present in the paper | "Table 3, row 4: HR 0.68..." when Table 3 has no such entry |
| 6c — Fabricated endpoint | Outcome described that was not in the paper's protocol | "Composite cardiovascular endpoint" described when the trial used all-cause mortality only |
| 6d — Confabulated context | Node 4 expert context draws on a paper that does not exist | Citation with plausible-looking PMID and title but no real article |

**Fix target:** Source verification instructions, citation grounding requirements, verifySource() threshold.

**Note on 6b:** Partially synthetic citations (see LEARNINGS.md) are tolerated when used for ranking context only. Flag as 6b only when citations are used in a user-facing field or when the fabrication caused a ranking error.

---

### Class 7 — Formatting / Enum Error (Post-processing)

**Definition:** The value is substantively correct but fails structural validation — wrong enum, wrong data type, missing required field, broken schema.

**Pipeline origin:** Post-processing (`postProcess()` in `pipeline.js`).

**Detectable by:** Automated checks; `postProcess()` should catch most of these before output reaches the UI.

**Examples:** `grade_certainty: "Moderate-High"` instead of `"Moderate"`. `risk_of_bias: null` when a value was extracted. Numeric field returned as string.

**Fix target:** `postProcess()` enum enforcement, or extractor/adjudicator prompt enum instructions.

**Severity note:** Severity 1–2 only, unless the formatting error causes downstream display failure (e.g. NI flag not set, blocking NI-specific UI rendering).

---

### Class 8 — Critic Regression (V4 critic — new in PROTOCOL.md v2.0)

**Definition:** The V1 extraction was correct. The gpt-4o-mini critic generated a patch that changed a correct value to an incorrect one. The error originates in the critic pass, not the V1 extractor.

**Why this is a separate class:** Classes 1–7 capture errors that originated in the extractor or adjudicator. In V4, a new failure mode exists: the critic can introduce errors into correct extractions. This is distinct from the critic failing to fix an existing V1 error (which would still be classified by the type of V1 error). Class 8 is specifically the case where V4 output is worse than V1 output on a field.

**Detectable by:** Cross-referencing Phase 1a ground truth with `_critic.patches`. If a field appears in `_critic.patches` (was patched by the critic) and the patched V4 value does not match ground truth, but the V1 snapshot value does match ground truth — Class 8.

**Pipeline origin:** gpt-4o-mini critic (Node 2) in V4.

**Mechanism subtypes:**

| Subtype | Description | Example |
|---|---|---|
| 8a — Null overwrite | Critic patches correct non-null value to null or wrong value | SYNTAX: `ci_upper=1.81` overwritten with RD CI value. Fixed by JS CI null-guard. |
| 8b — Type reclassification | Critic changes correct `outcome_type` based on faulty reasoning | ISCHEMIA: correct `time_to_event` changed to `binary` ("composite is binary"). Fixed by `enforceOutcomeTypeForRatioMeasures()`. |
| 8c — Scale error | Critic patches using values from a different measurement scale | SYNTAX: CI in percentage points patched onto an HR candidate. |
| 8d — Prompt override | LLM reasoning overrides an explicit categorical rule in the critic prompt | Rule 12 prompt said "HR always = time_to_event" — critic applied class reasoning anyway. |

**Fix target:** For each Class 8 subtype, the fix is one of: (a) add a JS-level null-guard or enforcement function in `applyPatches()` or post-processing, or (b) revise the critic rule to prevent the failure. JS guards are preferred because they cannot be overridden by LLM reasoning.

**Priority signal:** Class 8 errors are the most actionable for further V4 iteration. High Class 8 frequency on a specific field → review that critic rule and add a deterministic enforcement.

**Date added:** 2026-04-27 (PROTOCOL.md v2.0).

---

---

## Root Cause Stage

`root_cause_stage` is an optional field recorded alongside `pipeline_section` in the grading schema. It captures the deepest fixable origin of the error — the thing that, if changed, would prevent the error from occurring again.

**Why this is separate from `pipeline_section`:** `pipeline_section` records where the error *manifested* (e.g. adjudicator chose the wrong value). `root_cause_stage` records *why* — which could be: the extractor never surfaced the right candidate (extractor), the adjudicator ranking logic was wrong (adjudicator), the schema didn't have a slot for the right data type (schema_design), the prompt didn't instruct correctly (prompt_guidance), or the source document was structured in an ambiguous way that no prompt change would fix (document_structure).

**Interaction effects:** Adjudicator errors often have their root cause in extractor omission (Class 3 errors can be reclassified as Class 1 if the correct candidate was never in the array). `root_cause_stage` captures this without requiring reclassification of the primary taxonomy.

| Stage | Definition | Fix |
|---|---|---|
| `extractor` | Root cause is in Extractor (V1 in V4, or A/B in V3) — candidate recall or labelling | Extractor prompt |
| `critic` | Root cause is in the V4 critic — a patch introduced or worsened an error | Critic rule revision or JS guard |
| `adjudicator` | Root cause is in adjudicator ranking or synthesis logic (V3 only) | Adjudicator prompt |
| `schema_design` | The output schema has no field or type for the correct value | Schema change |
| `prompt_guidance` | A prompt rule is absent, ambiguous, or contradictory | Prompt revision |
| `document_structure` | The source document structure caused the failure regardless of prompt | No pipeline fix; document-level annotation needed |

---

## Phase 0 Analysis Sheet

For each paper, for each field, ask these questions in order. Stop at the first yes.

```
1. Is the extracted value correct?
   → YES: mark Exact Match. Stop.

2. Is the correct value present in primary_endpoint_candidates?
   → NO: Class 1 (Recall Failure) or Class 2 (Correlated Recall Failure)
         Check: did one extractor surface it but not the other? → Class 1
         Neither surfaced it? → Class 2

3. Is the correct value in candidates but not selected?
   → YES: Class 3 (Ranking Failure)
          Check: which ranking subtype? (3a priority, 3b label, 3c anti-bias, 3d source trust)

4. Is the value correct but the label / metadata wrong?
   → YES: Class 4 (Misclassification)

5. Is the value correct but the clinical interpretation wrong?
   → YES: Class 5 (Interpretation Failure)

6. Does the field contain content not in the source document?
   → YES: Class 6 (Hallucination)

7. Is the value correct but structurally malformed?
   → YES: Class 7 (Formatting / Enum Error)
```

---

## Phase 0 Metrics to Track

Derived from GPT critique (2026-04-15). These are the operationally meaningful signals Phase 0 will generate.

| Metric | Definition | Why it matters |
|---|---|---|
| Candidate recall rate | % of papers where correct value was in candidates array | Primary failure mode signal — adjudicator cannot fix what isn't there |
| Ranking error rate | % of papers where correct candidate existed but wasn't selected | Adjudicator weakness signal |
| Single-candidate rate | % of primary endpoint extractions with only 1 candidate | Highest-risk outputs — no adjudication is possible |
| Cross-model disagreement rate | % of fields where A and B differed | Target: 40–70%. Too low = correlation persists. Too high = noise |
| Correlated recall failure rate | % of papers where neither extractor surfaced correct value | Worst-case failure mode — requires Phase 0 PI review to detect |
| Citation plausibility rate | % of citations that correspond to a real verbatim location | Tracks synthetic citation prevalence |

---

## Error Class → Fix Target Mapping

| Class | Primary fix target | Effort |
|---|---|---|
| 1 — Recall failure | Extractor prompt (candidate coverage check, field instructions) | Medium |
| 2 — Correlated recall | Extractor prompt diversity; escalation logic | High |
| 3a — Ranking: hierarchy | Adjudicator ranking rules + anti-bias rule | Low |
| 3b — Ranking: ambiguity | Adjudicator Methods cross-check requirement | Medium |
| 4 — Misclassification | Extractor label verification instructions | Low |
| 5 — Interpretation | Language audit; GRADE/RoB rubric; NI framing | Medium |
| 6 — Hallucination | Source grounding requirements; verifySource() | Medium |
| 7 — Formatting | postProcess() enum enforcement | Low |

---

## Phase Scope

| Phase | Primary use of taxonomy |
|---|---|
| Phase 0 | Classify errors from V3 10-paper pilot. Build frequency × severity heatmap. Identify prompt modification queue. |
| Phase 1 | Classify errors from V1 and V3 across N≥25 papers. Statistical comparison. Error class distribution by version. |
| Phase 2 (future) | Extend taxonomy to corpus-level errors (pooling errors, outcome harmonisation failures, PRISMA violations). |

---

## Revision Log

| Date | Change | Reason |
|---|---|---|
| 2026-04-15 | v1 created | Initial taxonomy based on pipeline architecture review and GPT critique |
| 2026-04-16 | C3 split into C3a (hierarchy violation) and C3b (ambiguity resolution failure) | GPT critique identified that C3 conflated two structurally different failures with different fix targets |
| 2026-04-16 | Added root_cause_stage concept | GPT critique identified interaction effects between pipeline_section and true root cause |

*Update this table whenever a category is added, split, merged, or redefined. Note the paper that prompted the revision.*
