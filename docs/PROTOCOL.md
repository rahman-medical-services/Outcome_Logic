# OutcomeLogic Phase 0 Validation Study — Pre-Registration Protocol

**Document version:** 1.0  
**Date:** 2026-04-12  
**Status:** Pre-registered. This document must not be modified after the first grading session begins.  
**PI:** Rahman Medical Services  

---

## 1. Study Overview

### Phase 0 — Pilot (current)

| Parameter | Value |
|---|---|
| Design | PI-only, unblinded, single-rater |
| N | 10 pilot papers (pre-specified, see schema-study.sql) |
| Purpose | Error taxonomy construction; prompt calibration; grading procedure validation |
| NOT a test of | Accuracy, publication-ready performance claims |
| Blinding | None. PI has access to pipeline outputs and source documents simultaneously. |
| Pre-registration | Required before first grade is entered (this document) |
| Output | Ranked field priority list for V2 prompt revision; error taxonomy; Phase 1 power calculation inputs |

Phase 0 produces no publishable accuracy estimates. Its sole function is to identify systematic pipeline failure modes and calibrate the grading rubric before a powered study begins.

### Phase 1 — Blinded Accuracy Study (pre-specified, not yet begun)

| Parameter | Value |
|---|---|
| Design | Prospective, blinded, multi-rater |
| N | ≥ 25 papers per pipeline version (V1 and V2) |
| Raters | ≥ 2 independent raters, blinded to pipeline version |
| Primary endpoint | Exact-match rate across all 26 pre-specified fields |
| Power | Powered to detect 15 percentage point improvement in exact-match rate (V2 vs V1) at 80% power, two-sided α = 0.05 |
| Reference standard | Blinded independent extraction from full-text source document |
| Analysis | Per-field exact-match rate; inter-rater reliability (Cohen's kappa); priority score ranking |

---

## 2. Pre-Specified Field List

All 26 fields below must be graded for every pipeline output (V1 and V2) for every paper in the study. The field list is fixed and cannot be amended after Phase 0 grading begins.

| field_id | Label | Path in output JSON | severity_max |
|---|---|---|---|
| trial_identification | Trial Identification | reportMeta.trial_identification | 2 |
| study_design | Study Design | reportMeta.study_design | 4 |
| authors | Authors | reportMeta.authors | 1 |
| journal_year | Journal / Year | reportMeta.journal + reportMeta.year | 1 |
| population | PICO: Population | clinician_view.pico.population | 4 |
| intervention | PICO: Intervention | clinician_view.pico.intervention | 5 |
| control | PICO: Control | clinician_view.pico.control | 5 |
| primary_outcome_def | Primary Outcome: Definition | clinician_view.pico.primary_outcome | 5 |
| secondary_outcomes | Secondary Outcomes | clinician_view.pico.secondary_outcomes | 3 |
| baseline_characteristics | Baseline Characteristics | clinician_view.baseline_characteristics | 3 |
| primary_result_values | Primary Result: Numeric Values | interactive_data.endpoints[0].arms | 5 |
| primary_result_synthesis | Primary Result: Synthesis | interactive_data.endpoints[0].clinical_synthesis | 4 |
| grade_certainty | GRADE Certainty | clinician_view.critical_appraisal.grade_certainty | 4 |
| risk_of_bias | Risk of Bias Rating | clinician_view.critical_appraisal.risk_of_bias | 4 |
| risk_of_bias_rationale | Risk of Bias Rationale | clinician_view.critical_appraisal.risk_of_bias_rationale | 3 |
| limitations | Limitations | clinician_view.critical_appraisal.limitations | 3 |
| adverse_events | Adverse Events | clinician_view.adverse_events | 4 |
| subgroups | Subgroup Analyses | clinician_view.subgroups | 3 |
| context_already_known | Context: Prior Evidence | clinician_view.context.already_known | 2 |
| context_what_adds | Context: What This Adds | clinician_view.context.what_this_adds | 3 |
| lay_summary | Lay Summary | patient_view.lay_summary | 2 |
| sdm_takeaway | Shared Decision Making | patient_view.shared_decision_making_takeaway | 2 |
| extraction_flags | Extraction Flags Quality | extraction_flags | 3 |
| source_citations | Source Citations Quality | source_citations | 3 |
| ni_handling | NI Trial Handling | extraction_flags.ni_trial (conditional) | 5 |
| library_meta | Library Metadata | library_meta | 2 |

**severity_max** is the maximum plausible harm severity for an error in this field, on the 1–5 scale defined in Section 4.

**Conditional field:** `ni_handling` is only graded when `extraction_flags.ni_trial = true` in the pipeline output. Its denominator is the number of papers where this flag is present.

---

## 3. match_status Operational Definitions

Four match_status categories are used. These definitions are fixed and apply uniformly across all fields and all raters.

### 3.1 exact_match

**Definition:** The extracted value and the reference standard value convey identical clinical meaning with no material omission, addition, or imprecision. Minor formatting differences that carry no clinical information are permitted.

**Decision rule:** Ask: "Does the extracted value convey exactly what the source document says, to the precision reported?" If yes, grade exact_match. Formatting differences (punctuation, abbreviation, capitalisation) that preserve clinical meaning do not disqualify exact_match.

**Worked example — numeric field:**
- Extracted: `HR 0.68 (95% CI 0.53–0.87)`
- Reference: `HR 0.68 (0.53–0.87)`
- Grade: **exact_match** — the CI label is absent but the values are identical and the clinical meaning is preserved.

**Worked example — text field:**
- Extracted: `All-cause mortality at 90 days`
- Reference: `All-cause mortality at 90 days`
- Grade: **exact_match** — verbatim agreement.

### 3.2 partial_match

**Definition:** The extracted value conveys the correct core clinical concept but with material imprecision, incompleteness, or modifier omission that does not change clinical interpretation. The clinician reading the extraction alone would reach the same clinical decision as a clinician reading the full reference value, but would have less information.

**Decision rule:** Apply the clinical interpretation test. Would a clinician reading only the extracted value (not the reference standard) reach the same clinical decision? If yes, grade partial_match. If the clinical decision might differ, grade fail.

**Worked example — text field:**
- Extracted: `Mortality at 90 days` (missing "all-cause" modifier)
- Reference: `All-cause mortality at 90 days`
- Grade: **partial_match** — timeframe is correct; "all-cause" modifier is absent but in a surgical RCT context would not typically change the clinical decision.

**Worked example — numeric field:**
- Extracted: `HR 0.68` (no confidence interval)
- Reference: `HR 0.68 (95% CI 0.53–0.87)`
- Grade: **partial_match** — point estimate is correct but confidence interval, which is required for clinical decision-making, is absent.

### 3.3 fail

**Definition:** The extracted value is incorrect, missing, or so incomplete that it changes clinical interpretation. This includes inversions, wrong values, and missing timeframes or denominators that are clinically essential.

**Decision rule:** Any of the following → grade fail: (a) value is absent/empty where the source document contains a value; (b) value is wrong in direction or magnitude; (c) missing information that would change clinical decision; (d) wrong category selected (for categorical fields).

**Worked example — numeric field (direction inversion):**
- Extracted: `HR 1.68`
- Reference: `HR 0.68`
- Grade: **fail** — direction inverted; opposite treatment recommendation.

**Worked example — text field (timeframe missing):**
- Extracted: `Mortality`
- Reference: `All-cause mortality at 90 days`
- Grade: **fail** — timeframe is clinically essential for this outcome; without it the extracted value is not usable.

**Worked example — empty field:**
- Extracted: (empty)
- Reference: `All-cause mortality at 90 days`
- Grade: **fail** — value exists in source but not extracted.

### 3.4 hallucinated

**Definition:** The extracted value has no correspondence in the source document. The value does not appear in any section of the paper. This is distinguished from a wrong extraction (which would be fail) by the absence of any source text that could be misinterpreted to produce the extracted value.

**Decision rule:** The rater must be confident (not merely uncertain) that the value does not appear in any section of the source document, including supplementary appendices, tables, and footnotes. When in doubt, grade fail rather than hallucinated.

**Treatment in calculations:** hallucinated counts as fail for exact-match rate calculations. It is recorded separately for taxonomy analysis (error_taxonomy is recorded as null for hallucinated rows).

**Worked example:**
- Extracted: `p=0.03 for interaction (age subgroup)`
- Reference: No interaction p-value appears anywhere in the paper
- Grade: **hallucinated** — rater has confirmed by reading the full paper that no such value appears.

### 3.5 Ambiguous cases

When the boundary between exact_match and partial_match, or between partial_match and fail, is unclear, apply the **clinical interpretation test**:

> "If a clinician read only the extracted value — not the source document — would they reach the same clinical decision as a clinician who read the full reference value?"

- Same decision → grade one level more favourable (exact_match if the dispute is exact vs partial; partial_match if the dispute is partial vs fail)
- Different decision possible → grade one level less favourable

### 3.6 Denominator rule

The denominator for each field's frequency calculations is the number of papers where the field was present in the pipeline output and was graded. Empty fields that are correctly empty (e.g., no adverse events in a paper that reports none) are graded as **exact_match** — correct absence. The grader must record a note in correction_text confirming the source document also has no value.

For conditional fields (ni_handling): denominator = number of papers where `extraction_flags.ni_trial = true`.

---

## 4. Harm Severity Rubric with Anchor Vignettes

Scale: 1 = Cosmetic → 5 = Dangerous clinical

### Severity 1 — Cosmetic

No clinical implication. The error does not affect any clinical or meta-analytic use of the output.

**Anchor vignettes:**
- Author initial format error: `R Al-Lamee` extracted as `Al-Lamee R`. No clinical relevance.
- Journal name abbreviated vs full: `N Engl J Med` vs `New England Journal of Medicine`.
- Whitespace or punctuation differences not affecting readability.
- Trial name capitalisation difference: `ORBITA` vs `Orbita`.

### Severity 2 — Minor clinical

The error introduces a minor inaccuracy that would not change any clinical decision in any plausible scenario. Would not affect systematic review inclusion/exclusion.

**Anchor vignettes:**
- Year off by one: `2017` extracted as `2018` for ORBITA (published online 2017, in print 2018).
- Lay summary missing one secondary benefit that is clearly secondary and non-essential.
- SDM takeaway slightly oversimplified but directionally correct and not misleading.
- Specialty described as `Shoulder surgery` instead of `Proximal humerus ORIF` — loses specificity but does not mislead.
- Trial identification missing the acronym but containing the full description.

### Severity 3 — Moderate clinical

The error introduces imprecision that could cause minor recalibration of treatment confidence but would not reverse the clinical decision. May affect systematic review data extraction quality but would not invert a meta-analytic conclusion.

**Anchor vignettes:**
- GRADE certainty off by one level: `Moderate` extracted as `High` — inflates certainty but does not invert the direction of evidence.
- Risk of bias direction wrong by one level: `Low` for a trial with some concerns — would affect NNT/NNH calculations in a systematic review.
- Primary outcome timeframe omitted: `mortality` extracted instead of `90-day mortality` — the timeframe is known from context but missing from the extracted field.
- Secondary outcome mislabelled (e.g., KOOS score labelled as Oxford Hip Score) — could cause confusion in a meta-analysis but is detectable.
- Baseline characteristics table missing one of several reported variables.

### Severity 4 — Serious clinical

The error would materially affect clinical guideline development, systematic review conclusions, or meta-analytic synthesis. A clinician using this output would have meaningfully wrong information.

**Anchor vignettes:**
- GRADE certainty off by two levels: `Low` extracted as `High` — would fundamentally misrepresent the evidence quality.
- Primary result CI extracted from a subgroup table instead of the primary analysis (e.g., SPORT: CI from per-protocol analysis instead of ITT).
- Non-inferiority margin value wrong — would affect NI test interpretation.
- Risk of bias rated `Low` when the paper clearly states unblinded outcome assessment with a patient-reported primary outcome.
- STICH: complex geographic subgroup result extracted as primary result — would misrepresent a landmark trial.

### Severity 5 — Dangerous clinical

The error directly inverts a clinical treatment recommendation. Any clinician acting on this output would be advised to take the opposite action to what the evidence supports.

**Anchor vignettes:**
- Intervention and control arms inverted: HR 0.68 favouring intervention extracted as HR 0.68 favouring control — opposite treatment recommendation.
- HR direction inverted: `HR 0.68` (benefit) extracted as `HR 1.47` (harm), or labelled as favouring the wrong arm.
- NI result labelled as superiority result — the clinical conclusion changes from "not inferior" to "superior."
- Absolute risk reduction extracted as absolute risk increase — reverses the direction of benefit.
- PROFHER: NI trial correctly extracted as non-inferior but labelled as "no significant difference" with superiority framing — would mislead clinicians about the strength of evidence for conservative management (taxonomy = semantic, severity = 5).
- Any error that would, if acted upon, lead a clinician to choose a more harmful treatment over a more beneficial one.

---

## 5. Error Taxonomy Classification Rules

For every grade where match_status is partial_match, fail, or hallucinated, assign one of the following taxonomy categories. For hallucinated, assign error_taxonomy = null (handled separately in summary analysis).

### omission

The correct field is empty or incomplete. The true value exists in the source document but was not extracted, or was extracted only partially.

**Decision rule:** The error is one of absence, not commission. The extracted value is shorter than, or a subset of, the true value.

**Examples:**
- Secondary outcomes list missing two of four pre-specified secondary outcomes.
- Adverse events section present in the paper but field left empty in the output.
- Baseline characteristics table present but only two of six reported variables extracted.
- Source citations populated for primary result but not for secondary outcomes.

### misclassification

A wrong categorical value was selected. The extracted value belongs to the correct field but is in the wrong category.

**Decision rule:** The error involves selection of an incorrect discrete category where a correct category exists.

**Examples:**
- study_design = `cohort study` for a randomised controlled trial.
- risk_of_bias = `Low` when the correct value is `High` (not merely off by one level).
- grade_certainty = `Low` for a large, well-powered RCT with consistent results (should be `High`).
- SCOT-HEART: primary endpoint classified as surrogate endpoint when it is a hard cardiovascular outcome.

### formatting_syntax

The correct value is present but in a wrong format or normalisation. The information content is the same but the representation is wrong.

**Decision rule:** If the correct value is present and the error is purely representational, use formatting_syntax.

**Examples:**
- CI reported as `53–87` instead of `0.53–0.87` (scaling error).
- HR reported as a percentage (`32% reduction`) instead of a ratio (`HR 0.68`).
- P-value reported as `0.031` instead of `p=0.031` in a field that uses a specific format.
- Authors formatted as `Surname Initials` instead of `Initials Surname` per the output schema.
- Date format `April 2017` instead of `2017`.

### semantic

The correct source text was identified but the clinical interpretation is wrong. The extraction found the right passage but applied wrong clinical logic.

**Decision rule:** If the extracted value derives from the correct section of the source document but represents a different clinical concept than the one specified, use semantic.

**Examples:**
- Extracting the as-treated result when the ITT result is specified as the primary analysis (SPORT disc herniation: common error due to the paper prominently reporting both).
- Extracting the unadjusted HR when the adjusted HR is specified as the primary analysis.
- PROFHER: primary endpoint correctly extracted but NI result labelled as `no significant difference` or `equivalence` rather than using the NI test conclusion — this is taxonomy = semantic, severity = 5, because it changes the clinical framing from NI to inconclusive.
- Extracting the p-value for the secondary analysis when the primary analysis p-value is requested.
- STICH: extracting all-cause mortality instead of the composite primary endpoint (death or hospitalisation for cardiovascular causes).

### Hallucination in the taxonomy

Hallucinated values are recorded with error_taxonomy = null and tracked as a fifth category for analysis purposes. In frequency calculations for omission/misclassification/formatting_syntax/semantic, hallucinated rows are excluded from the denominator. They are reported separately in the summary as `hallucinated_count`.

---

## 6. Priority Score Definition

For each field, priority_score quantifies the urgency of prompt modification work:

```
priority_score = avg_harm_severity × (fail_count + partial_count + hallucinated_count) / total_graded_count
```

Where:
- `avg_harm_severity` = mean harm_severity across all non-exact-match grades for this field (exclude null severity values)
- `fail_count` = number of grades with match_status = 'fail'
- `partial_count` = number of grades with match_status = 'partial_match'
- `hallucinated_count` = number of grades with match_status = 'hallucinated'
- `total_graded_count` = number of papers where this field was present in the output and graded (the denominator)

Fields with priority_score > 2.0 require immediate prompt modification before Phase 1 begins. Fields with priority_score 1.0–2.0 are flagged for review. Fields with priority_score < 1.0 are monitored but do not block Phase 1.

---

## 7. Phase 1 Requirements for Publication

The following eight requirements must all be satisfied before Phase 1 data are submitted for publication. These requirements were established in the adversarial review of the Phase 0 protocol.

1. **Minimum rater count:** ≥ 2 independent raters for all 26 fields across all papers. No single-rater data to be included in primary analysis.

2. **Inter-rater reliability threshold:** Cohen's kappa ≥ 0.60 for all five primary fields (primary_result_values, primary_outcome_def, intervention, control, grade_certainty). Fields below this threshold require rater calibration before Phase 1 data are locked.

3. **Formal power calculation:** Pre-registered power calculation showing ≥ 80% power to detect the pre-specified 15 percentage point improvement in exact-match rate (V2 vs V1) at two-sided α = 0.05, with the chosen N and expected standard deviation from Phase 0 data.

4. **Blinded reference standard:** The reference standard must be established by a rater who is blinded to pipeline output at the time of extraction. The PI may establish the reference standard for Phase 0 (unblinded) but must be blinded for Phase 1.

5. **CONSORT-AI compliance:** The study report must include all items from the CONSORT-AI extension checklist (Liu et al., Nat Med 2020), including: description of the AI system version, input data characteristics, performance disaggregated by paper type and source type, and confidence intervals for all accuracy estimates.

6. **Source type stratification:** Accuracy must be reported separately for full-text-pdf, full-text-pmc, and abstract-only source types. No pooled accuracy estimate may be reported without this stratification.

7. **Version blinding:** Raters must be blinded to pipeline version (V1 vs V2) during grading. Version labels must be masked in the grading interface. Unblinding occurs only at the analysis stage.

8. **Pre-registration of Phase 1:** Phase 1 must be pre-registered on a public registry (OSF or ClinicalTrials.gov) before data collection begins. The registration must include: primary and secondary endpoints, power calculation, rater recruitment criteria, analysis plan, and stopping rules.
