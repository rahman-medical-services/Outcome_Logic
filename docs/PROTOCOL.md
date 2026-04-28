# OutcomeLogic Validation Study — Protocol

**Document version:** 2.0  
**Date:** 2026-04-27  
**Supersedes:** Version 1.0 (2026-04-12) — Phase 0/Phase 1 ablation design, now obsolete.  
**Status:** DRAFT — not yet locked. Lock before Phase 1a data collection begins.  
**PI:** Saqib Rahman  

---

## 0. Preliminary Test Run (Beta-Blockers in HFrEF)

Before formal Phase 1a data collection begins, the full workflow (Phase 1a manual extraction → V4 pipeline → Phase 2a/2b review → Phase 3 arbitration) will be rehearsed on a small set of papers **outside** the formal study domain. This serves three purposes:

1. **End-to-end workflow validation** — confirm that Phase 1a UI, Phase 2a/2b UI, Phase 3 UI, database writes, and meta-analysis output all function as designed
2. **Timing calibration** — establish realistic per-paper estimates for Phase 1a and Phase 2a before committing raters to the full 30-paper set
3. **Rater calibration** — identify systematic disagreements on borderline match_status calls before formal data collection, so that calibration happens before the study, not during

**Test set: Beta-blockers for heart failure with reduced ejection fraction (HFrEF)**

| Trial | Citation | Primary outcome | Effect | N |
|---|---|---|---|---|
| CIBIS-II | CIBIS-II Investigators, *Lancet* 1999;353:9–13 | All-cause mortality | HR 0.66 (95% CI 0.54–0.81) | 2647 |
| MERIT-HF | MERIT-HF Study Group, *Lancet* 1999;353:2001–7 | All-cause mortality | HR 0.66 (95% CI 0.53–0.81) | 3991 |
| COPERNICUS | Packer M et al., *NEJM* 2001;344:1651–8 | All-cause mortality | HR 0.65 (95% CI 0.52–0.81) | 2289 |
| SENIORS | Flather MD et al., *Eur Heart J* 2005;26:215–25 | Mortality + CV hospitalisation | HR 0.86 (95% CI 0.74–0.99) | 2128 |
| BEST | Beta-Blocker Evaluation of Survival Trial, *NEJM* 2001;344:1659–67 | All-cause mortality | HR 0.90 (95% CI 0.78–1.02) | 2708 |

**Benchmark Cochrane review:** Shibata MC et al. *Beta-blockers for heart failure*. Cochrane Database of Systematic Reviews (most recent update). Pooled mortality HR ~0.73 provides the external reference for pilot meta-analysis validation.

**Key design features of this set:**
- All compare beta-blocker vs placebo in patients with reduced EF — same comparator class across all 5
- Four report all-cause mortality as HR; SENIORS reports a composite (will test the pipeline's endpoint selection and outcome_type logic); BEST is a null result (tests that the pipeline does not fabricate significance)
- Large trials with precise estimates — extraction errors are unambiguous, not lost in noise
- All published in Lancet/NEJM/Eur Heart J — PDF availability is straightforward

**What test run results will and will not contribute:**
- Results from this set **inform protocol refinement only**. They are not reported as part of the formal validation study.
- Timing estimates from Phase 1a on these papers **do** feed into the rater burden estimate for the formal 30-paper study.
- Any systematic match_status disagreements trigger calibration discussion before formal data collection begins.

**PMIDs:** To be verified against live PubMed before PDFs are obtained. Add here when confirmed.

---

## 1. Study Overview and Rationale

### 1.1 What changed from v1.0

The v1.0 protocol was designed around a head-to-head comparison of V1 vs V3 pipelines, with Phase 0 as a small pilot to calibrate grading before a powered comparative study. Three things have changed:

1. **V3 is deprecated.** V4 (V1 extractor + gpt-4o-mini critic + deterministic post-processing) is now the production pipeline. The V1 vs V3 comparison is no longer meaningful.

2. **The ablation study is unnecessary.** V4's `_critic` audit trail (patches applied, verifications, skipped patches, patch provenance) provides direct evidence of where and how V1 extraction errors were caught and corrected. This is more informative than a net-effect comparison — it demonstrates the mechanism, not just the aggregate outcome.

3. **The scope is clarified.** The primary use case is meta-analysis automation. The validation should be scoped to that claim: accuracy and time saving on fields required for meta-analysis input. Full-field validation is included to generate an overall error rate and a validated paper library, but is not the primary claim.

### 1.2 Study design in one sentence

A prospective accuracy and efficiency validation study of the V4 pipeline for automated extraction of meta-analysis–relevant data from general surgery RCTs, using temporally blinded ground truth for the primary endpoints and blinded arbitration for all fields.

### 1.3 Paper set

**N = 30 papers**, all general surgery RCTs.

**Composition:**
- 25 landmark general surgery RCTs — diverse across subspecialty, trial size, outcome type (binary, time-to-event, continuous), and risk of bias profile
- 5 papers on a single pre-specified focused question for which a published Cochrane review exists (see Section 1.4)

**Selection criteria:**
- Full-text PDF obtainable (open access, institutional, or author copy)
- Published RCT (individual or cluster), any sample size
- Primary endpoint is a clinical outcome (not biomarker or surrogate only)
- General surgery topic (includes hepatobiliary, colorectal, upper GI, vascular, trauma, emergency surgery, bariatric)

**Exclusion:** The 10 Phase 0 papers from the previous protocol (ORBITA, HIP ATTACK, SPORT disc, SPORT stenosis, UK FASHIoN, PROFHER, SCOT-HEART, OPTIMAS, SYNTAX, TKR) are **excluded** from the formal 30-paper set. These papers were used iteratively during pipeline development — the pipeline has been tuned against them in repeated cycles, creating selection bias. Including them would inflate accuracy estimates on the fields that triggered prompt changes. The 30 formal papers must be unseen by the PI as pipeline test cases.

**Paper list:** To be finalised by PI before Phase 1a begins. Must be recorded and locked in this document before any Phase 1a extraction is performed.

### 1.4 Meta-analysis validation subset (5 papers)

The 5 focused papers will be used for a pilot meta-analysis (Section 9). The focused question must:
- Have ≥ 5 qualifying RCTs available as full-text PDFs
- Have a published Cochrane systematic review and meta-analysis on the same question, with pooled estimates, for external benchmarking
- Be a general surgery question within the library domain

**Candidate questions:** To be selected by PI after the preliminary test run (Section 0) is complete. Candidates include laparoscopic vs open colectomy for cancer, mesh vs no mesh for primary inguinal hernia repair, early vs delayed cholecystectomy for acute cholecystitis, laparoscopic vs open appendicectomy. Final selection must be recorded here before Phase 1a begins.

**Note:** The preliminary test run (Section 0 — beta-blockers in HFrEF) is a separate, non-surgical test set used for workflow validation only. It is not the formal 5-paper focused subset.

---

## 2. Phase Structure

The study has three phases. Different raters are used for Phase 1 and Phase 2 to avoid anchoring.

```
Phase 1a  ──────────────────────────────────────────────────────────
  Manual extraction of MA fields from source PDF — timed
  2 independent raters, BLINDED to pipeline output
  Produces: ground truth for MA fields + baseline time per paper
  
Phase 2a  ──────────────────────────────────────────────────────────
  Check and correct pipeline MA field output — timed
  2 DIFFERENT independent raters (not Phase 1 raters)
  Produces: corrected MA output + pipeline verification time per paper

Phase 2b  ──────────────────────────────────────────────────────────
  Check and correct pipeline full field output — timed
  Same 2 raters as Phase 2a
  Produces: corrected full output + overall error rate

Phase 3   ──────────────────────────────────────────────────────────
  Blinded arbitrator resolves all Phase 2a/2b discrepancies
  Rates quality and usability of each pipeline output
  Produces: validated paper library (primary secondary endpoint)
```

### 2.1 Temporal blinding

The design sequence is:
1. Phase 1a raters extract MA fields manually from source PDFs **before the pipeline is run on those papers**. Phase 1a raters are not given access to pipeline output at any stage.
2. Phase 1a data are locked.
3. The V4 pipeline is run on all 30 papers. Phase 2 raters then check and correct pipeline output — they have not been involved in Phase 1a.

The sequence is the blinding. Phase 1a raters cannot be influenced by pipeline output because they extract before seeing it, and they never see the pipeline output at all. Phase 2 raters cannot be influenced by Phase 1a ground truth because they are different people.

### 2.2 Crossover design for time comparison

To eliminate rater speed as a confound on the time comparison (Phase 1a manual extraction vs Phase 2a pipeline verification), a crossover assignment is used:

- **Papers 1–15:** Rater Pair A performs Phase 1a manual extraction; Rater Pair B performs Phase 2a pipeline verification
- **Papers 16–30:** Rater Pair A performs Phase 2a pipeline verification; Rater Pair B performs Phase 1a manual extraction

Each rater pair appears in both Phase 1a and Phase 2a conditions, on different paper sets. The within-rater time comparison (Phase 1a time for papers they extracted vs Phase 2a time for papers they reviewed) is the primary test of time saving — it is free of between-rater speed confounds. A Wilcoxon signed-rank test on paired within-rater per-paper times is the primary statistical test for the time endpoint.

### 2.3 Rater requirements

**Phase 1a raters (N = 2):** Surgical trainees or consultants with experience in systematic review methodology. Must be able to interpret RCT methods sections, apply Cochrane RoB 2.0, and make GRADE certainty judgements. Not required to be blinded to each other — inter-rater agreement is measured but raters work independently. **PI (Rahman) does not perform Phase 1a extraction.** The PI designed the pipeline; performing ground truth extraction would compromise independence even with temporal blinding. An external independent rater pair is required for all 30 papers.

**Phase 2a/2b raters (N = 2):** Must NOT be the same people as Phase 1a raters. Should have equivalent clinical background. Raters are shown V4 pipeline output (field values visible) but the `_critic` audit trail (which fields were corrected by the critic and why) is **not shown**. This ensures Phase 2 verification is independent of knowledge of critic corrections.

**Arbitrator (N = 1):** Must be blinded to which rater produced which output during arbitration. Should be a consultant surgeon or clinical academic with systematic review experience. The arbitrator resolves discrepancies between Phase 2a and 2b rater pairs and assigns overall quality and usability ratings. The arbitrator also resolves Phase 1a evaluative field disagreements (see Section 3.3). PI does not arbitrate.

**Inter-rater disagreement on evaluative fields (Phase 1a):** When the two Phase 1a raters disagree on `rob_overall` or `grade_certainty`, the arbitrator reviews the paper and produces a consensus assessment. This consensus becomes the Phase 1a reference standard for those fields on that paper. The arbitrator is blinded to Phase 2 output when performing this arbitration.

### 2.4 Time measurements

**Phase 1a per-paper time:** From first opening the source PDF to final field recorded. Recorded by rater per paper.

**Phase 2a per-paper time (`phase2a_seconds`):** From first interaction with the pipeline output to Phase 2a submission (MA fields only). Recorded separately from Phase 2b. A rater cannot begin Phase 2b until Phase 2a is submitted and locked — the sessions are sequentially gated, not combined.

**Phase 2b per-paper time (`phase2b_seconds`):** From first interaction with the Phase 2b interface (non-MA fields) to Phase 2b submission. Timer starts fresh after Phase 2a is locked. Stored separately. Reports additional burden of full-field review — not used in the primary time comparison.

**Pipeline run time:** V4 pipeline run time per paper is recorded automatically as `_runtime_seconds` in the V4 output JSON. Measured variable, not a fixed estimate.

**Primary time comparison:** `phase1a_seconds` vs `phase2a_seconds` — MA fields only, within-rater paired Wilcoxon signed-rank test. This is the clean apples-to-apples comparison: manual extraction of 19 MA fields vs pipeline-assisted verification of those same 19 fields.

**Secondary time metric:** `phase2a_seconds + phase2b_seconds` = total Phase 2 burden per paper. `_runtime_seconds + phase2a_seconds` = total time to MA-ready output (pipeline run + human verification).

**Crossover assignment:** See Section 2.2. All time analyses use paired within-rater comparisons.

---

## 3. Field Specification

Fields are divided into two classes:

- **MA fields (Phase 1a ground truth):** The pre-specified field set required for meta-analysis input. Ground truth is established pre-pipeline by Phase 1a raters. These are the primary accuracy endpoints.
- **Full fields (Phase 2b only):** All other pipeline output fields. Ground truth is established by Phase 3 arbitration (not pre-pipeline extraction). These produce overall error rate and feed the validated library.

### 3.1 MA Fields (primary accuracy analysis)

| field_id | Label | V4 output path | Notes |
|---|---|---|---|
| pico_population | Population | `clinician_view.pico.population` | Who was enrolled; eligibility criteria summary |
| pico_intervention | Intervention | `clinician_view.pico.intervention` | Including key delivery details |
| pico_control | Control / Comparator | `clinician_view.pico.control` | |
| primary_outcome_def | Primary outcome: definition | `clinician_view.pico.primary_outcome` | Event definition + measurement instrument + timepoint |
| primary_effect_estimate | Primary result: effect estimate | `primary_endpoint_candidates[selected].value` | Numeric point estimate |
| primary_ci | Primary result: confidence interval | `primary_endpoint_candidates[selected].ci_lower/.ci_upper` | Both bounds |
| primary_effect_measure | Effect measure | `primary_endpoint_candidates[selected].effect_measure` | HR / OR / RR / RD / MD / SMD |
| primary_p_value | Primary result: p-value | `primary_endpoint_candidates[selected].p_value` | Verbatim string (e.g. "P<0.001") |
| arm_a_n | Sample size: intervention arm | `primary_endpoint_candidates[selected].arm_a_n` | Randomised N preferred |
| arm_b_n | Sample size: control arm | `primary_endpoint_candidates[selected].arm_b_n` | |
| arm_a_events | Events: intervention arm | `primary_endpoint_candidates[selected].arm_a_events` | Binary/time-to-event outcomes only |
| arm_b_events | Events: control arm | `primary_endpoint_candidates[selected].arm_b_events` | Binary/time-to-event outcomes only |
| arm_a_sd | SD: intervention arm | `primary_endpoint_candidates[selected].arm_a_sd` | Continuous outcomes only |
| arm_b_sd | SD: control arm | `primary_endpoint_candidates[selected].arm_b_sd` | Continuous outcomes only |
| follow_up | Follow-up duration | `clinician_view.follow_up_duration` | Primary outcome timepoint |
| allocation_concealment | Allocation concealment | `clinician_view.critical_appraisal.risk_of_bias_rationale` | Domain extraction from RoB rationale |
| blinding | Blinding | `clinician_view.critical_appraisal.risk_of_bias_rationale` | Domain extraction |
| rob_overall | Risk of Bias — overall | `clinician_view.critical_appraisal.risk_of_bias` | Low / Some concerns / High |
| grade_certainty | GRADE certainty | `clinician_view.critical_appraisal.grade_certainty` | Very low / Low / Moderate / High |

**Conditional fields:** `arm_a_events`, `arm_b_events` — graded only for binary and time-to-event outcomes. `arm_a_sd`, `arm_b_sd` — graded only for continuous outcomes. The denominator for each conditional field is the number of papers where the outcome type applies.

**Note on `rob_overall` and `grade_certainty`:** These are evaluative fields (they require clinical judgement, not just text extraction) but they are primary MA inputs for any Cochrane review. They are included in Phase 1a ground truth because Phase 1a raters can establish independent assessments using Cochrane RoB 2.0 and the GRADE approach. However, they are reported separately using weighted kappa (agreement analysis) rather than exact-match rate, for the reasons described in Section 3.3.

### 3.2 Full Fields (Phase 2b / overall error rate analysis)

All other pipeline output fields checked by Phase 2b raters. These include:

- Study design and bibliographic metadata
- Secondary outcomes
- Baseline characteristics
- Subgroup analyses  
- Adverse events table
- Primary result synthesis (plain-English summary)
- Lay summary and shared decision-making takeaway
- Expert context (Node 4 output)
- Extraction flags and source citations

These fields are graded using the same match_status categories (Section 5) but their ground truth is the Phase 3 arbitrated consensus, not pre-pipeline extraction. Error rate across all fields is reported as a secondary endpoint.

### 3.3 Reporting for evaluative fields (rob_overall, grade_certainty)

These fields are structural inputs for meta-analysis and systematic review (GRADE and RoB are mandatory in a Cochrane review) but they involve clinical and methodological judgement with known inter-rater variability (~30–40% 1-level disagreement between expert pairs for GRADE).

**Primary analysis for these fields:** Weighted kappa between pipeline output and arbitrated Phase 1a consensus. Not included in the primary exact-match rate.

**Benchmarking:** Where a published Cochrane review or NICE evidence review exists for the relevant paper, the published RoB and GRADE assessments are used as an additional reference.

---

## 4. Primary and Secondary Endpoints

### Primary endpoints

1. **MA field accuracy:** Exact-match rate across all MA fields (Section 3.1, excluding evaluative fields), comparing pipeline output (post-Phase 2a correction) against Phase 1a ground truth. Reported per-field and overall, with 95% CI.

2. **Time saving:** Median Phase 1a extraction time vs median Phase 2a verification time per paper. Reported as absolute minutes and percentage reduction.

### Secondary endpoints

3. **Overall error rate:** Proportion of all graded fields (MA + full) across all papers where match_status ≠ exact_match, after Phase 3 arbitration.

4. **Validated paper library:** 30 fully arbitrated, structured pipeline outputs for landmark general surgery RCTs. Each paper has a locked extraction with provenance (V4 output + Phase 2 corrections + Phase 3 arbitration decision).

5. **Pilot meta-analysis accuracy:** For the 5-paper focused subset — pooled estimate from arbitrated V4-extracted fields (i.e., post-Phase 3 consensus values, not raw V4 output) vs pooled estimate from the benchmark Cochrane review. Reported as ratio of point estimates and overlap of confidence intervals.

6. **Error taxonomy distribution:** Frequency of each of the 8 error classes (Section 7) across all non-exact-match grades. Used to identify which pipeline stages are responsible for residual errors. Reported as a descriptive breakdown — not tested statistically (cell counts too small for per-class inference at N=30).

7. **Critic utility:** Among fields where V4 output differs from V1 output, the proportion where V4 is correct and V1 is wrong (determined by Phase 1a ground truth). This directly quantifies the critic's net accuracy contribution without requiring an ablation study — the `_critic.patches` audit trail provides the mechanism evidence.

8. **Model agnosticism (pre-specified secondary analysis):** All 30 papers will be run through an alternative LLM configuration (same schema, same deterministic post-processing, different extractor — GPT-4o or Claude Sonnet in place of Gemini flash-lite) and compared against Phase 1a ground truth. No additional raters required. This tests the claim that accuracy is schema-driven, not model-specific. If the alternative model produces similar accuracy (within ±5pp overall), this supports the schema-as-product framing and model-agnosticism as a durable claim.

### Descriptive breakdowns (not hypothesis-tested)

- By outcome type (binary / time-to-event / continuous): MA field accuracy per type
- By trial size (< 500, 500–2000, > 2000 randomised): MA field accuracy
- By error class: frequency of each taxonomy class

These are descriptive. The study is not powered for per-subgroup inference.

### Inter-rater reliability

Cohen's kappa (unweighted for nominal fields, weighted for ordinal) between the two Phase 1a raters on all MA fields. The two Phase 2a raters are also compared. Threshold for adequate reliability: κ ≥ 0.60. Fields below threshold trigger rater calibration before results are analysed.

---

## 5. match_status Operational Definitions

Four match_status categories. These definitions apply uniformly across all fields, phases, and raters. They are fixed and cannot be amended after Phase 1a data collection begins.

### 5.1 exact_match

**Definition:** The extracted value and the reference standard value convey identical clinical meaning with no material omission, addition, or imprecision. Minor formatting differences that carry no clinical information are permitted.

**Decision rule:** Ask: "Does the extracted value convey exactly what the source document says, to the precision reported?" If yes, grade exact_match.

**Worked examples:**
- Extracted: `HR 0.68 (95% CI 0.53–0.87)` / Reference: `HR 0.68 (0.53–0.87)` → **exact_match** — CI label absent but values identical.
- Extracted: `All-cause mortality at 90 days` / Reference: `All-cause mortality at 90 days` → **exact_match** — verbatim agreement.

### 5.2 partial_match

**Definition:** The extracted value conveys the correct core clinical concept but with material imprecision, incompleteness, or modifier omission that does not change clinical interpretation. A clinician reading only the extracted value would reach the same decision but with less information.

**Decision rule:** Apply the clinical interpretation test. Same decision → partial_match. Decision might differ → fail.

**Worked examples:**
- Extracted: `Mortality at 90 days` / Reference: `All-cause mortality at 90 days` → **partial_match** — "all-cause" absent but does not change decision in surgical RCT context.
- Extracted: `HR 0.68` (no CI) / Reference: `HR 0.68 (95% CI 0.53–0.87)` → **partial_match** — point estimate correct; CI required for clinical decision-making is absent.

### 5.3 fail

**Definition:** The extracted value is incorrect, missing, or so incomplete that it changes clinical interpretation. Includes inversions, wrong values, missing timeframes or denominators that are clinically essential.

**Decision rule:** Any of: (a) value absent where source contains value; (b) wrong in direction or magnitude; (c) missing information that would change clinical decision; (d) wrong category for categorical field.

**Worked examples:**
- Extracted: `HR 1.68` / Reference: `HR 0.68` → **fail** — direction inverted.
- Extracted: `Mortality` / Reference: `All-cause mortality at 90 days` → **fail** — timeframe clinically essential.
- Extracted: (empty) / Reference: any value → **fail** — missing extraction.

### 5.4 hallucinated

**Definition:** The extracted value has no correspondence in the source document. Distinguished from a wrong extraction by the absence of any source text that could be misinterpreted to produce the extracted value.

**Decision rule:** Rater must be confident (not merely uncertain) that the value does not appear anywhere in the paper including tables, appendices, and supplementary material. When in doubt, grade fail rather than hallucinated.

**Treatment:** Counts as fail for exact-match rate calculations. Recorded separately for taxonomy analysis — assign error_taxonomy = Class 6 (Hallucination).

**Worked example:**
- Extracted: `p=0.03 for interaction (age subgroup)` / No such value appears anywhere in paper → **hallucinated**.

### 5.5 Ambiguous cases — clinical interpretation test

> "If a clinician read only the extracted value — not the source document — would they reach the same clinical decision as a clinician who read the full reference value?"

- Same decision → grade one level more favourable
- Different decision possible → grade one level less favourable

### 5.6 Denominator rule

The denominator for each field's frequency calculation is the number of papers where the field was graded. Correctly absent fields (field not present in source document; pipeline correctly outputs null or empty) are graded **exact_match** with a note in correction_text confirming the source also has no value. Conditional fields (arm events for non-binary outcomes, etc.) use the conditional denominator defined in Section 3.1.

---

## 6. Harm Severity Rubric

Scale: 1 (cosmetic) → 5 (dangerous clinical). Applied to all non-exact-match grades.

### Severity 1 — Cosmetic

No clinical implication. Error does not affect any clinical or meta-analytic use of the output.

**Decision test:** Would a systematic review researcher care? If no, grade 1.

**Anchor vignettes:**
- Author initial format: `R Al-Lamee` vs `Al-Lamee R`.
- Journal name abbreviated vs full: `N Engl J Med` vs `New England Journal of Medicine`.
- Trial name capitalisation: `ORBITA` vs `Orbita`.
- Whitespace or punctuation differences not affecting readability.

### Severity 2 — Minor clinical

Minor inaccuracy that would not change any clinical decision. Would not affect systematic review inclusion/exclusion.

**Decision test:** Would this affect a meta-analyst's data extraction? If no, grade 2. If yes, grade 3+.

**Anchor vignettes:**
- Year off by one: `2017` vs `2018` for ORBITA (published online 2017, in print 2018).
- Lay summary missing one secondary benefit that is clearly secondary and non-essential.
- Trial identification missing the acronym but containing the full description.
- Specialty described as `Shoulder surgery` instead of `Proximal humerus ORIF` — loses specificity but does not mislead.

### Severity 3 — Moderate clinical

Imprecision that could cause minor recalibration of treatment confidence but would not reverse the clinical decision. May affect systematic review data extraction quality but would not invert a meta-analytic conclusion.

**Decision test:** Would a meta-analyst extract a different value but reach the same pooled conclusion? If yes, grade 3.

**Anchor vignettes:**
- Primary outcome timeframe omitted: `mortality` vs `90-day mortality` — timeframe is inferrable from context but missing.
- Secondary outcome mislabelled (e.g., KOOS score labelled as Oxford Hip Score) — detectable but causes confusion.
- Baseline characteristics table missing one of several reported variables.
- Lay summary missing a qualifier ("benefit only in pre-specified subgroup" omitted) — changes confidence but not direction.
- Source citation pointing to the right table but wrong row.

### Severity 4 — Serious clinical

Error would materially affect clinical guideline development, systematic review conclusions, or meta-analytic synthesis. A clinician using this output would have meaningfully wrong information.

**Decision test:** Would a clinician or guideline committee reach a materially different conclusion — same direction but wrong magnitude or wrong population? If yes, grade 4.

**Anchor vignettes:**
- Primary result CI extracted from a subgroup table instead of the primary ITT analysis.
- Non-inferiority margin value wrong — would affect NI test interpretation.
- Intervention description missing a key component (e.g., ORBITA: "PCI" extracted without noting sham-controlled — loses the defining methodological feature).
- Adverse events section missing a Grade ≥3 event occurring in ≥10% of patients.
- STICH: complex geographic subgroup result extracted as primary result.

### Severity 5 — Dangerous clinical

Error directly inverts a clinical treatment recommendation. Any clinician acting on this output would be advised to take the opposite action to what the evidence supports.

**Decision test:** Does the error flip direction, invert arms, or conflate NI with superiority? If yes, grade 5.

**Anchor vignettes:**
- Intervention and control arms inverted: HR 0.68 favouring intervention extracted as favouring control.
- HR direction inverted: `HR 0.68` (benefit) extracted as `HR 1.47` (harm).
- NI result labelled as superiority — changes clinical conclusion from "not inferior" to "superior".
- Absolute risk reduction extracted as absolute risk increase.
- PROFHER: NI trial correctly extracted as non-inferior but labelled "no significant difference" with superiority framing — misleads about strength of evidence for conservative management.

---

## 7. Error Taxonomy

For every grade where match_status is partial_match, fail, or hallucinated, assign one of seven taxonomy classes. Use the decision tree first; refer to class descriptions when borderline.

Full definitions and subtypes are in `docs/ERROR_TAXONOMY.md`.

### Decision tree

```
1. Was the correct value absent from primary_endpoint_candidates entirely?
   → Did V1 fail to extract it?       →  Class 1 (Recall Failure — V1)
   
2. Was the correct value in candidates but not selected?
   → Priority hierarchy violation?    →  Class 3a (Ranking: Hierarchy)
   → Ambiguity not resolved?          →  Class 3b (Ranking: Ambiguity)

3. Value numerically correct but label / population / timeframe wrong?
   → YES                              →  Class 4 (Misclassification)

4. Values correct but clinical interpretation wrong?
   (GRADE, RoB, NI framing, lay direction)
   → YES                              →  Class 5 (Interpretation Failure)

5. Extracted content not in source document?
   → YES                              →  Class 6 (Hallucination)

6. Value substantively correct but structurally malformed?
   (wrong enum, wrong type, formatting)
   → YES                              →  Class 7 (Formatting / Enum Error)

7. Critic patch introduced the error (was correct in V1)?
   → YES                              →  Class 8 (Critic Regression)
```

**Note on Class 8 (Critic Regression) — new in v2.0:** When Phase 1a ground truth shows V4 output is wrong on a field and the `_critic.patches` audit trail shows the critic changed that field from the (correct) V1 value, this is a critic regression. Distinct from V1-origin errors (Classes 1–7). Critical for evaluating critic net accuracy (Secondary endpoint 7).

### Class descriptions (abbreviated)

**Class 1 — Recall Failure:** Correct value was findable in the paper by an attentive human reader but V1 did not extract it. The critic cannot catch it because it wasn't in the candidate set.

**Class 2 — DEPRECATED in V4.** In V3, Class 2 was "Correlated Recall Failure" (both extractors fail). V4 uses a single extractor; correlated failure is no longer applicable as a separate class. V1 failures are all Class 1; critic failures are Class 8.

**Class 3 — Ranking Failure:** Correct value was in candidates (`selected: false`) but a less appropriate candidate was selected as primary.
- 3a — Priority violation (unadjusted over adjusted; PP over ITT)
- 3b — Ambiguity resolution failure (legitimate candidates, wrong choice)

**Class 4 — Misclassification:** Numeric or categorical value correct; label, population tag, analysis type, or timeframe wrong.

**Class 5 — Interpretation Failure:** Extracted values correct; clinical or methodological interpretation wrong (GRADE, RoB, NI framing, lay summary direction).

**Class 6 — Hallucination:** Value does not appear anywhere in the source document.

**Class 7 — Formatting / Enum Error:** Value substantively correct but structurally malformed (wrong enum value, wrong data type, CI as string instead of numeric pair).

**Class 8 — Critic Regression:** V1 extraction was correct; critic patch introduced an error. Identified by cross-referencing `_critic.patches` with Phase 1a ground truth.

### Taxonomy in analysis

- Class 1 → V1 prompt problem (coverage, section search)
- Classes 3–5 → V1 prompt instruction problem (labelling, ranking, interpretation rules)
- Class 6 → Grounding problem (source verification)
- Class 7 → Post-processing bug (enum enforcement, type coercion)
- Class 8 → Critic rule problem (prompt null-guards, enforcement, scope)

High Class 8 frequency in a specific field → review that critic rule and consider adding a deterministic JS enforcement. Class 8 errors are the most actionable for further pipeline iteration.

---

## 8. Priority Score

For each field, priority_score quantifies the urgency of pipeline improvement work:

```
priority_score = avg_harm_severity × error_rate
```

Where:
- `avg_harm_severity` = mean harm_severity across all non-exact-match grades for this field
- `error_rate` = (fail + partial + hallucinated) / total graded

Fields with priority_score > 2.0 → immediate pipeline modification.  
Fields with priority_score 1.0–2.0 → flagged for review.  
Fields with priority_score < 1.0 → monitored.

---

## 9. Pilot Meta-Analysis (5-paper subset)

### Purpose

To validate the end-to-end workflow: pipeline extraction → meta-analysis input → pooled estimate. Field-level accuracy (Section 4) validates individual extractions; this validates whether the aggregate output is usable for its intended purpose.

### Method

1. V4 extracts MA fields from the 5 focused papers.
2. Phase 2a raters check and correct the extracted fields (as per normal Phase 2a process).
3. **Phase 3 arbitrated V4 output** is used as the meta-analysis input dataset — not raw V4 output, not Phase 2a corrected output without arbitration.
4. A **DerSimonian–Laird random-effects meta-analysis** is run on the arbitrated data using the extracted effect estimates, CIs, and sample sizes. This method is pre-specified to match the Cochrane review benchmark (see Section 4 pilot meta-analysis), so that method differences do not confound the comparison.
5. The pooled estimate is compared against the benchmark Cochrane review pooled estimate on the same question.

### Reported metrics

- Ratio of pooled point estimates (V4-derived vs Cochrane): target < 5% difference
- Overlap of 95% CIs: qualitative (fully overlapping / partially overlapping / non-overlapping)
- Heterogeneity statistic (I²): comparison with Cochrane review value
- Number of papers where V4 extraction errors required correction before the paper could be included (field-level errors that would have produced an incorrect meta-analytic contribution)

### Benchmark source

The published Cochrane review must be specified and locked before Phase 1a begins. The Cochrane pooled estimate is the external reference standard. If the Cochrane review has been updated since the individual papers were published, use the version that covers the same paper set.

---

## 10. Reporting Framework

### Framework: STARD-informed

No single reporting framework precisely covers a prospective accuracy validation of a clinical AI extraction system. This study is reported using **STARD 2015** (Standards for Reporting Diagnostic Accuracy Studies) as a structural reference, because the study design — test output vs reference standard with temporal blinding — maps most directly onto the diagnostic accuracy paradigm. Where STARD items do not apply, **TRIPOD-AI** (Collins et al., *BMJ* 2021) and **DECIDE-AI** (Vasey et al., *Nature Medicine* 2022) inform additional AI-specific reporting items. The adopted framework is described explicitly in the manuscript methods.

Key reporting items addressed:

| Item | Source | Requirement | Status |
|---|---|---|---|
| AI system | TRIPOD-AI | Version, model(s), architecture | V4 pipeline: Gemini 2.5 Flash Lite (extractor) + GPT-4o-mini (critic) + deterministic JS post-processing. Version tag to be recorded at paper selection lock. |
| Intended use | TRIPOD-AI | Clinical context, decision supported | Automated extraction of RCT data for meta-analysis input. Target users: clinical academics, systematic reviewers. |
| Reference standard | STARD | How ground truth was established | Phase 1a: pre-pipeline manual extraction by 2 independent raters (not the PI), blinded to pipeline output. Phase 3 arbitration for evaluative fields and full-field output. |
| Sample size justification | STARD | Basis for N=30 | See Section 10.1 |
| Statistical analysis | STARD | Methods for accuracy and reliability | Exact-match rate with Wilson 95% CI; weighted kappa for evaluative fields; Wilcoxon signed-rank for time comparison (within-rater paired, crossover) |
| Descriptive breakdowns | TRIPOD-AI | Pre-specified analyses | By outcome type, by error class, by trial size — all descriptive, not hypothesis-tested |
| Limitations | DECIDE-AI | Known limitations | Single-specialty (general surgery); single pipeline version; PI excluded from ground truth extraction. |

### 10.1 Sample size justification

**N = 30 papers** is chosen for this first validation study.

**Overall accuracy:** At N = 30 papers and ~17 MA fields graded per paper, the field-level observation count is ~510. A Wilson 95% CI around an observed overall exact-match rate of 85% is approximately ±3 percentage points — sufficient to distinguish accurate (>80%) from unacceptably inaccurate (<70%) extraction with meaningful precision.

**Per-field accuracy:** Each field has N = 30 observations (one per paper, adjusted for conditional fields). A Wilson 95% CI at 85% accuracy on N=30 is approximately ±13 percentage points. Per-field results are therefore **descriptive only** — they identify fields warranting further attention, not statistically powered conclusions about individual field accuracy. This is appropriate: the primary claim is overall pipeline accuracy, not per-field accuracy.

**Practical constraints:** ~15–22 hrs per Phase 1a rater at 30–45 min/paper is feasible without compensation for clinical academic raters. N < 25 would produce CIs too wide to be meaningful; N > 40 would impose an unreasonable burden.

**No comparative arm:** This is a single-arm accuracy validation. There is no control pipeline and no minimum detectable difference. Power calculations are the appropriate framework for comparative designs; they are not applied here.

---

## 11. Pre-Registration and Locking

This document must be finalised and locked before Phase 1a extraction begins. The following must be recorded before locking:

- [ ] Complete list of 30 papers with PMIDs/DOIs
- [ ] Focused question for 5-paper subset and Cochrane review citation
- [ ] V4 pipeline version tag at time of lock
- [ ] Phase 1a rater names and roles
- [ ] Phase 2a/2b rater names and roles
- [ ] Arbitrator name and role
- [ ] Anticipated Phase 1a start date

**Pre-registration:** OSF pre-registration is recommended before Phase 1a data collection begins. The registered document should include Sections 1–5 and the paper list. Sections 6–10 (analysis methods) may be included or appended as supplementary.

**Amendment procedure:** Any change to the pre-specified paper list, field list, or primary endpoint definition after locking constitutes a protocol amendment and must be documented with date and justification. The locked version of this document must be preserved.

---

## 12. Source Input Constraint

**All 30 papers must be submitted as uploaded full-text PDFs.** DOI and PMID-based retrieval is not used for study papers. This eliminates variability from partial text retrieval, PMC availability differences, abstract-only fallback, and text cleaning differences across source types.

**Traceability:** For each paper, record the PDF filename and a SHA-256 hash against the extraction record in the database. PDFs are archived for the duration of the study. Any paper where a full-text PDF cannot be obtained is excluded and replaced with the next paper on the pre-specified reserve list (which must also be specified before locking).

---

*End of protocol v2.0*
