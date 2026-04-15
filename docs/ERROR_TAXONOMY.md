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

### Class 2 — Correlated Recall Failure (Both Extractors)

**Definition:** Neither Extractor A nor B surfaced the correct value. Both produced candidates, but the correct value was absent from all of them. The adjudicator confirmed a wrong candidate.

**This is the highest-severity class.** It is structurally undetectable from the pipeline output alone — the extraction looks clean, the adjudication looks clean, the candidates look plausible. Requires PI review against source document.

**Detectable by:** PI comparing pipeline output to source document. `suspicious_agreement: true` is a hint but does not guarantee detection.

**Pipeline origin:** Both extractors (correlated).

**Mechanism subtypes:**

| Subtype | Description | Example |
|---|---|---|
| 2a — Shared table misread | Both models misread the same table identically | Both extract HR from wrong row of a multi-endpoint table |
| 2b — Abstract anchoring | Both default to abstract value; neither looks up full-text table | Both report unadjusted HR from abstract; adjusted HR from Results not surfaced |
| 2c — Model convergence | Both models make same inference from ambiguous text | Ambiguous "treatment effect" phrasing interpreted identically by Gemini and GPT-4o-mini |

**Fix target:** Extractor prompt diversity (make A and B search different source locations explicitly) or paper-level escalation to a stronger model.

**Phase 0 flag:** `suspicious_agreement: true` in `extraction_flags`. Should be manually verified for every paper flagged.

---

### Class 3 — Ranking Failure (Adjudicator)

**Definition:** The correct value was present in `primary_endpoint_candidates` but was not selected. The adjudicator ranked a less appropriate candidate above it.

**Detectable by:** Checking whether the correct value is in the array but has `selected: false`.

**Pipeline origin:** Adjudicator.

**Mechanism subtypes:**

| Subtype | Description | Example |
|---|---|---|
| 3a — Priority violation | Adjudicator ignored the ranking hierarchy (adjusted > unadjusted, ITT > PP, etc.) | Unadjusted HR selected despite adjusted HR being present and correctly labelled |
| 3b — Label trust | Adjudicator trusted extractor label over analytical appropriateness | Candidate labelled "secondary analysis" deprioritised even though it matched pre-specified primary endpoint in Methods |
| 3c — Anti-bias failure | Adjudicator selected more extreme value or abstract-prominent value | HR of 0.61 selected over HR of 0.74 because it was further from null, not because it was analytically superior |
| 3d — Source trust | Adjudicator weighted synthetic or uncertain citation as confirmation | Both extractors produced similar-looking citations for wrong value; adjudicator treated this as source grounding |

**Fix target:** Adjudicator prompt — ranking rules, anti-bias rule, or source verification instructions.

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
| 3 — Ranking failure | Adjudicator ranking rules + anti-bias rule | Low–Medium |
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

*Update this table whenever a category is added, split, merged, or redefined. Note the paper that prompted the revision.*
