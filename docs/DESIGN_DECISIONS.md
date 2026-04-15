---
id: "design-decisions"
type: "methodology-record"
version: 1
created: 2026-04-15
owner: "saqib"
status: "living document — update when decisions change or new risks identified"
---

# OutcomeLogic — Design Decisions and Risk Mitigation Record

**Purpose:** This document records all substantive architectural decisions made during development of the OutcomeLogic extraction pipeline, the rationale for each decision, alternatives considered, and the risk mitigation measures in place. It is intended to:

1. Provide the evidentiary basis for the Methods section of the Phase 1 validation study report (DECIDE-AI / CONSORT-AI compliance).
2. Serve as an audit trail for decisions that will be scrutinised during peer review.
3. Enable future developers to understand why the system is designed the way it is — not just what it does.

**Maintenance:** Update this document when a decision is revised, a new risk is identified, or a mitigation is added. Record the session and date of each change in the revision log at the end.

---

## Part 1 — Pipeline Architecture Decisions

### 1.1 Three-node pipeline (Extractor A + Extractor B + Adjudicator)

**Decision:** Use a three-node pipeline with two independent extractors and a separate adjudicator, rather than a single extraction pass.

**Rationale:** A single extraction pass produces a single candidate value with no mechanism for detecting or correcting errors. Two independent extractors with divergent extraction priorities produce a candidate set that the adjudicator can rank. This converts the adjudication problem from open-ended search (find the correct value in a large document) to ranking over a provided set (select the best candidate from a small, curated list). The ranking problem is substantially easier and more reliable than the search problem.

**Alternative considered:** Single mega-prompt with adversarial self-review. Rejected because self-review by the same model on the same pass is unlikely to surface errors — the model has no structural incentive to contradict itself within a single generation.

**Evidence base:** This design pattern (ensemble extraction with adjudication) is consistent with the multi-agent consensus literature in LLM evaluation (e.g., Chen et al. 2023). The specific three-node structure was refined through iterative adversarial review sessions (Gemini, GPT-4o) conducted April 2026.

**Date:** Session 2, 2026-04-12.

---

### 1.2 Model diversity: Gemini flash-lite (Extractor A) + GPT-4o-mini (Extractor B)

**Decision:** Use different model families for the two extractors — Google Gemini (flash-lite) for Extractor A and OpenAI GPT-4o-mini for Extractor B — rather than two instances of the same model.

**Rationale:** Two instances of the same model receiving the same input will tend to make the same errors. When both extractors agree on an incorrect value, the adjudicator has no signal to detect the error — it sees consensus and confirms it. Cross-model diversity substantially reduces correlated extraction errors. When Gemini and GPT-4o-mini disagree, the disagreement is visible and the adjudicator must adjudicate. When they agree, consensus is more likely to reflect genuine convergence on the correct value rather than shared bias.

**Residual risk:** Correlated recall failure remains possible when both models are anchored to the same prominent text (e.g., the abstract). This is the dominant remaining failure mode entering Phase 0. See Section 2.1.

**Alternative considered:** Two Gemini instances with different sampling temperatures. Rejected — temperature variation does not create meaningful diversity on extraction tasks; both instances will still anchor to the same prominent text.

**Technical constraint:** Gemini API allows only one concurrent call per API key. Parallel execution of two Gemini instances therefore triggers 503 errors. Cross-provider parallel execution (Gemini + OpenAI simultaneously) is safe because the two calls use different API keys and have no shared concurrency limit. Confirmed via systematic curl testing (Session 4, 2026-04-13).

**Date:** Session 6, 2026-04-15.

---

### 1.3 Divergent extractor priorities (Prompt A vs Prompt B)

**Decision:** Extractor A is instructed to prioritise analytically superior values (adjusted > unadjusted, ITT > per-protocol, methods-specified primary > results-section first-reported). Extractor B is instructed to prioritise face-value reporting (first-reported, as-labelled, no analytical adjustment).

**Rationale:** Gives the adjudicator genuine informational diversity. If both extractors had the same priority rules, they would produce near-identical candidate sets and the adjudicator would have nothing to adjudicate. The divergent priority structure ensures that when a paper reports an unadjusted HR in the abstract and an adjusted HR in Table 3, Extractor A surfaces the adjusted value and Extractor B surfaces the abstract value. The adjudicator then applies the ranking hierarchy to select between them.

**Alternative considered:** Both extractors with identical prompts, relying on stochastic variation for diversity. Rejected — deterministic priority divergence is more reliable than stochastic variation.

**Date:** Session 2, 2026-04-12.

---

### 1.4 Adversarial adjudicator framing

**Decision:** The adjudicator is explicitly instructed to find errors, not confirm agreement. It is told: "Do not treat agreement as correctness — treat it as a hypothesis to verify."

**Rationale:** A passive adjudicator that simply resolves disagreements will confirm consensus without scrutiny. When both extractors agree on an incorrect value, a passive adjudicator produces no signal. The adversarial framing instructs the adjudicator to actively check agreement cases for suspicious agreement indicators — same source cited, multiple candidates present, abstract vs. full-text conflict.

**Limitation:** The adjudicator has no access to the original source document. It can only identify suspicious agreement from evidence present in the two extractor reports. If both extractors omit a value entirely (correlated recall failure), the adjudicator has no evidence of omission and cannot flag it. This is a structural limitation, not a prompt limitation. See Section 2.1.

**Date:** Session 2, 2026-04-12.

---

### 1.5 Mandatory candidate values array (primary_endpoint_candidates)

**Decision:** Both extractors are required to output a `candidate_values` list (up to 3 candidates) for the primary endpoint effect size, covering all plausible alternative values. The adjudicator compiles these into `primary_endpoint_candidates` and ranks them.

**Rationale:** Before this design, extractors output a single value. The adjudicator then had to both select the correct value AND verify it — but with only one candidate, verification was vacuous. The candidate array separates the recall problem (do the extractors surface the right candidates?) from the ranking problem (does the adjudicator select the right one?). This decomposition is analytically important: a ranking failure (correct value in candidates but not selected) is a different type of error from a recall failure (correct value never surfaced), requires different fixes, and has a different risk profile.

**Requirement:** Each candidate must include its value, label (adjusted/unadjusted, ITT/PP, etc.), population, and the verbatim source citation from each extractor. This enables the adjudicator to make source-grounded ranking decisions rather than label-trust decisions.

**Coverage check added:** Extractors are instructed to verify before finalising candidates that they have considered: (1) adjusted primary analysis estimate, (2) abstract-reported value, (3) main results table value. If any category is absent and the paper reports it, the extractor must add it. This directly addresses the dominant failure mode (recall failure).

**Date:** Session 5, 2026-04-14.

---

### 1.6 Adjudicator ranking hierarchy and anti-bias rule

**Decision:** The adjudicator applies an explicit priority order when ranking candidates: (1) adjusted > unadjusted, (2) ITT > per-protocol > mITT, (3) final timepoint > interim, (4) pre-specified primary > post-hoc. Additionally, an explicit anti-bias rule prohibits ranking a candidate higher because it is more extreme (further from null) or because it appeared earlier in the abstract.

**Rationale for hierarchy:** Without an explicit hierarchy, the adjudicator defaults to label text ("this was labelled as the primary result") or prominence ("this appeared first in the results section"). Both are unreliable. Many papers prominently report unadjusted results in the abstract and adjusted results in the tables. The hierarchy ensures the adjudicator applies analytical standards rather than presentation order.

**Rationale for anti-bias rule:** After implementing the hierarchy, adversarial review (GPT-4o, April 2026) identified a residual bias: adjudicators tend to prefer more extreme effect sizes (HR further from 1) and values that appear earlier in the abstract, independent of analytical quality. Both are presentation artefacts. A value is not a better primary result because it shows a larger effect. The anti-bias rule explicitly prohibits this.

**Date:** Anti-bias rule added Session 7, 2026-04-15.

---

### 1.7 Source citations requirement

**Decision:** Both extractors are required to provide a source citation (`source_citation`) for every extracted value — a verbatim or near-verbatim text snippet and a location identifier (Abstract | Results para N | Table N | Figure N).

**Rationale:** Source citations serve two functions. First, they allow the adjudicator to assess source grounding when ranking candidates — a value supported by a table citation is stronger evidence than a value supported only by an abstract sentence. Second, they provide an audit trail for the PI during Phase 0 grading, allowing verification of each extracted value against the source location.

**Known limitation:** When no clean verbatim snippet exists (e.g., in complex tables with merged cells), extractors produce synthetic citations — plausible-looking text that is not verbatim from the source. These citations are used for ranking context only and are not displayed to users. The risk is that synthetic citations for a wrong value may appear credible and mislead the adjudicator. This is a structural limitation of LLM-based extraction from complex tables. Flagged in LEARNINGS.md (Session 5, 2026-04-14) and treated as a tolerated limitation for Phase 0.

**Practical implication for grading:** During Phase 0 PI review, citation plausibility should be manually checked — does the cited location actually contain the extracted value? High synthetic citation rate is a signal of table extraction difficulty, not necessarily pipeline failure.

**Date:** Session 2, 2026-04-12.

---

### 1.8 Truncation flag to adjudicator

**Decision:** When an extractor's output exceeds 40,000 characters, the text is truncated and a `[TRUNCATION NOTICE]` is appended, instructing the adjudicator that the candidate list may be incomplete due to truncation.

**Rationale:** On long papers (e.g., HIP ATTACK, which produced 49,818 chars before truncation), the candidate list and adverse events sections appear late in the extractor output. Without a truncation flag, the adjudicator sees incomplete data and has no way to distinguish "this field was not reported in the paper" from "this field was reported but cut off." The truncation flag propagates the uncertainty signal rather than silently dropping information.

**Limitation:** Truncation disproportionately affects late-appearing content (adverse events, subgroups, secondary outcomes). The 40,000 character cap was chosen to stay within model context limits with safety margin. A future improvement would be to prioritise primary endpoint content in the extractor output ordering. See open risks (Section 4).

**Date:** Session 5, 2026-04-14.

---

### 1.9 Node 4 Promise.allSettled for partial result recovery

**Decision:** The expert context module (Node 4) runs three API calls concurrently using `Promise.allSettled` rather than `Promise.all`. Each result is processed independently. Partial output from completed calls is retained even when one call fails or times out.

**Rationale:** Node 4 aggregates data from three external APIs (Europe PMC citation graph, Europe PMC full-text search, PubMed Entrez + web synthesis). These APIs have different latency profiles. Under `Promise.all`, a single API failure or timeout causes all three results to be discarded. Under `Promise.allSettled`, two successful API calls produce usable output even when the third fails. This is especially important because PubMed Entrez is the slowest and most prone to timeout, but Europe PMC results are typically fast and high quality.

**Date:** Session 5, 2026-04-14.

---

### 1.10 Raw fetch() for all Gemini API calls — no SDK

**Decision:** All Gemini API calls use raw `fetch()` to the v1beta REST endpoint. Neither `@google/generative-ai` nor `@google/genai` SDK is used anywhere in the codebase.

**Rationale:** Systematic testing (Session 4, 2026-04-13) confirmed that both Gemini SDKs cause consistent 503 errors on the first call when a large system instruction is present (~4000 tokens). The same payload sent as raw `fetch()` succeeds. The SDKs appear to modify the request construction in a way the API rejects with a misleading "high demand" 503 error. This is not a capacity issue — it is a request format issue specific to the SDKs. Raw `fetch()` with the API key in the URL is the deliberate, tested architecture.

**Specific gotchas documented in LEARNINGS.md:**
- `thinkingBudget: 0` causes 503 on `gemini-2.5-flash` (not a capacity error — it is an unsupported parameter).
- `thinkingBudget: 512` is required for all models. This satisfies flash-lite, flash, and pro.
- `gemini-2.5-flash` has persistent ~50% 503 rate on this account due to TPM throttling. `gemini-2.5-flash-lite` is the stable model for extraction.
- Sequential Gemini calls only (same API key). Parallel Gemini calls from the same key → one 503s, reliably.

**Date:** Session 4, 2026-04-13.

---

### 1.11 PDF-only source input for validation study runs

**Decision:** The study runner (`api/study.js`, `resource=run`) requires an uploaded PDF for all Phase 0 and Phase 1 extractions. PMID/DOI-based text retrieval is not available for study runs.

**Rationale:** The public endpoint (`api/analyze.js`) supports multiple input modes (PDF, DOI, PMID), each of which produces a different `source_type` (full-text-pdf, full-text-pmc, full-text-jina, abstract-only). These source types differ in text quality, completeness, and formatting. If study papers were submitted via different source types, performance differences between papers could reflect input quality differences rather than pipeline capability. Requiring uploaded PDFs for all study runs eliminates this confounder and ensures all extractions are on full-text content of consistent quality.

**Practical implication:** The PI must obtain the full-text PDF for each study paper (institutional access, open access, or author copy). Papers for which a full-text PDF cannot be obtained are excluded, not substituted.

**Date:** Session 7, 2026-04-15.

---

## Part 2 — Risk Identification and Mitigation

### 2.1 Correlated recall failure (highest residual risk)

**Risk:** Both extractors converge on the same incorrect value and neither surfaces the correct value as a candidate. The adjudicator, operating only on the provided candidates, confirms the wrong value. The output looks clean — no flags, no disagreement, plausible-looking citation. This is structurally undetectable from the pipeline output alone.

**Severity:** 5 (dangerous). If both extractors misread a primary endpoint table identically, the output is confidently wrong with no internal signal.

**Mechanism:** Most likely when (a) a value is prominently reported in the abstract and both models anchor to it without searching the Results section, or (b) both models misread the same table row (e.g., wrong row in a multi-endpoint table).

**Mitigations in place:**
- Cross-model diversity (Gemini + GPT-4o-mini) reduces but does not eliminate correlated errors. The two model families have different training data and different attention patterns. Errors that arise from identical misreading of ambiguous table structure may persist.
- Candidate coverage check: extractors must confirm they have considered adjusted, abstract, and table values before finalising candidates. This forces both models to search multiple locations.
- `suspicious_agreement` flag: adjudicator sets this flag when both extractors cite the same source location for the same value. This is a weak signal — it is not always a problem (both citing Table 2 for the correct primary result is fine), but it surfaces cases for PI review.
- Phase 0 PI review is the **primary control** for this failure mode. The PI has access to the source document and will identify cases where the pipeline extracted a plausible but incorrect value.

**Residual risk:** Cannot be eliminated by prompt engineering. The structural fix is to provide the model with a grounded database of pre-extracted values (e.g., from ClinicalTrials.gov or a curated trial registry) against which extractions are verified. Not implemented. Out of scope for Phase 0/1.

**Phase 0 metric:** Candidate recall failure rate — for each paper, was the correct value present in `primary_endpoint_candidates`? If not, this is a recall failure. If neither extractor surfaced it, it is a correlated recall failure (highest priority for prompt redesign).

---

### 2.2 Adjudicator ranking failure

**Risk:** The correct value is present in `primary_endpoint_candidates` but the adjudicator selects a less appropriate candidate.

**Severity:** 4 (serious). The correct value was available but not chosen. The output is wrong but the information to correct it exists within the pipeline output (visible in the candidates array).

**Mitigations in place:**
- Explicit ranking hierarchy (Section 1.6): adjusted > unadjusted, ITT > per-protocol, final > interim, pre-specified > post-hoc.
- Anti-bias rule (Section 1.6): explicit prohibition on preferring extreme effects or abstract prominence.
- Label verification instruction: adjudicator told not to trust extractor labels alone — must verify against methods section description within the extractor report.

**Residual risk:** When extractor labels are systematically wrong (e.g., both label the unadjusted estimate as "primary analysis"), the adjudicator may trust the label despite the hierarchy instruction. Phase 0 PI review will identify this.

---

### 2.3 NI trial conflation

**Risk:** A non-inferiority (NI) trial result is presented using superiority framing. "Non-inferior" becomes "no significant difference" or "equivalent." This is a severity-5 error — the clinical conclusion changes from "treatment A is at least as good as B within an acceptable margin" to "treatment A and B are indistinguishable," which may lead to incorrect clinical decisions.

**Severity:** 5 (dangerous).

**Mitigations in place:**
- `ni_trial: true` flag in `extraction_flags` — set whenever the study uses a non-inferiority design. This triggers the conditional `ni_handling` grading field in the pilot UI.
- NI framing instructions in extractor prompts: extractors told to include NI margin and CI-excludes-NI check in `primary_outcome` field.
- Source citation requirement for NI margin: `source_citations.ni_margin` is a mandatory schema field for NI trials.
- Language audit: lay summary and SDM fields explicitly prohibited from using "equivalent" or "no significant difference" for NI results.

**Outstanding gap:** `ni_margin`, `ni_margin_excluded_by_ci`, and `ni_result_label` are not yet structured output fields. They are currently embedded in the `primary_outcome` string. PROFHER (paper 8 of Phase 0) is a non-inferiority trial — this paper will expose whether current NI handling is sufficient. Structured NI fields are scheduled before Phase 1. See FEATURES.md.

---

### 2.4 Language liability — clinical recommendation framing

**Risk:** Lay summary or shared decision-making fields use language that implies clinical recommendation, certainty, or superiority where the evidence does not support it. Phrases like "Surgery is recommended" or "This treatment is better" in a patient-facing summary could harm patients if acted upon without clinical review.

**Severity:** 5 for misleading direction; 3 for overclaiming certainty.

**Mitigations in place:**
- Language audit (Session 5, 2026-04-14): `lay_summary` prompt explicitly prohibits "is better," "recommends," "confirms," "establishes," "proves." Permitted: "suggests," "indicates," "the trial found."
- `shared_decision_making_takeaway` schema description rewritten to require hedged, option-presenting language.
- Intended use statement: OutcomeLogic is a clinical research tool for use by qualified clinicians, not a patient-facing tool without supervision. This does not eliminate the risk but establishes the intended use context.

---

### 2.5 Synthetic source citations

**Risk:** Source citations produced by extractors are not verbatim from the source document. They are plausible-sounding summaries that do not correspond to any specific text location. If used as confirmation of a wrong value, they may mislead the adjudicator.

**Severity:** 2–3 when citations are internal (ranking context only). Would be severity 5 if synthetic citations were displayed to users as evidence.

**Mitigations in place:**
- Source citations are used internally for adjudicator ranking only. They are not displayed verbatim in the user interface.
- Phase 0 grading includes a `source_citations` quality field — the PI will manually verify whether citations correspond to real text locations.
- `verifySource()` function in the pipeline checks that the extractor's cited text contains keywords matching the paper — a weak but non-zero verification step.

**Known limitation:** Table citations are the most likely to be synthetic. When a value appears in a complex multi-column table, extractors cannot reliably produce a verbatim snippet. This is a structural limitation of text-based LLM extraction and is not fixable by prompt engineering.

---

### 2.6 Post-processing enum failures

**Risk:** The pipeline produces an invalid enum value (e.g., `grade_certainty: "Moderate-High"`) that the UI cannot render correctly, or a missing required field that causes downstream display failure.

**Severity:** 1–2 for cosmetic failures; 3 if NI flag is dropped and the ni_handling field is never triggered.

**Mitigations in place:**
- `postProcess()` in `lib/pipeline.js` enforces enum values for `grade_certainty` and `risk_of_bias`. Invalid values are normalised to the closest valid enum or a safe default.
- Critical deployment check: `node -e "import('./lib/pipeline.js')"` is run before every push to catch syntax errors.
- Phase 0 grading includes `extraction_flags` and `library_meta` quality fields that surface post-processing failures.

---

### 2.7 Subgroup credibility — post-hoc analysis framing

**Risk:** A post-hoc or exploratory subgroup analysis is presented with the same visual weight as a pre-specified subgroup, leading a clinician to over-interpret a hypothesis-generating result as confirmatory evidence.

**Severity:** 3–4 depending on whether the subgroup result contradicts the primary result.

**Mitigations in place:**
- `pre_specified` and `post_hoc` boolean flags per subgroup item in the pipeline output schema.
- UI: pre-specified subgroups shown with green badge, post-hoc with amber badge.
- `cis_all_cross_one` flag: when all individual subgroup confidence intervals cross 1.0, an amber warning is displayed.
- `interaction_note` free-text field: adjudicator required to explain in plain language what the interaction p-value means and what it does NOT prove.
- `direction_vs_hypothesis` field: flags when observed subgroup direction contradicts the pre-specified hypothesis.

**Origin:** Exposed during HIP ATTACK Phase 0 run (Session 6, 2026-04-15). The troponin subgroup was post-hoc with all CIs crossing 1, but the interaction p-value was significant (p=0.02). Without the flags and note, a clinician might interpret this as strong subgroup evidence.

---

### 2.8 Confirmation bias in Phase 0 PI review

**Risk:** The PI (Saqib) has read all 10 Phase 0 papers and has strong prior knowledge of the results. During grading, he may unconsciously rate the pipeline output as correct when it matches his prior knowledge, even when the output does not precisely match the source document.

**Severity:** 3 — systematic over-reporting of extraction accuracy in Phase 0, which distorts the prompt modification queue for Phase 1.

**Acknowledged and accepted for Phase 0:** This is an inherent limitation of an unblinded, single-rater pilot study. DECIDE-AI does not require blinding for early-phase evaluations. Phase 0 produces no publishable accuracy estimates. Its function is error identification, not accuracy measurement.

**Mitigation for Phase 1:** Blinded reference standard (established before reviewing pipeline output), ≥2 independent raters, formal kappa analysis. The PI must not establish the Phase 1 reference standard.

---

## Part 3 — Study Design Decisions

### 3.1 Phase 0 is V3-only (no comparison arm)

**Decision:** Phase 0 runs the current pipeline (V3, 3-node Gemini + GPT adjudication) against 10 papers without a V1 comparison arm.

**Rationale:** Phase 0's function is error identification and prompt calibration, not comparative accuracy measurement. Running a V1 baseline in Phase 0 would double the grading workload (20 extractions per paper instead of 10) without producing publishable comparisons (Phase 0 has no statistical power). Building V1 before Phase 0 completion would also mean building the comparison baseline before knowing what errors Phase 0 exposes — errors that might change what V1 should look like as a meaningful control.

**V1 baseline deferred to Phase 1:** Phase 1 will compare V1 (single-pass, no adversarial framing, no candidate values) against V3 across N≥25 papers with ≥2 independent raters. This is the design that will generate publishable accuracy estimates.

**Date:** Decision recorded Session 7, 2026-04-15.

---

### 3.2 GRADE certainty and Risk of Bias as evaluative fields (secondary analysis)

**Decision:** GRADE certainty and Risk of Bias rating are excluded from the primary exact-match analysis and reported as a secondary agreement analysis.

**Rationale:** These fields are not extractable facts — they are clinical and methodological judgements generated by the pipeline. The pipeline applies the GRADE approach and Cochrane RoB 2.0 framework to the paper content and produces a summary rating. The correct output cannot be determined by checking the source document; it requires an independent expert applying the same frameworks.

Reporting exact-match rate for these fields would require treating "pipeline agrees with PI's GRADE assessment" as equivalent to "pipeline extracted a correct numeric value from the paper." These are structurally different tasks with different epistemological bases. Including them in the primary analysis would inflate or deflate the primary accuracy estimate depending on how well the pipeline happens to match the PI's clinical judgement — which is not the same as whether the pipeline is functionally correct.

**Inter-rater variability:** Expert pairs disagree on GRADE certainty by 1 level ~30–40% of the time. This means the reference standard itself has uncertainty. For Phase 1, 2-rater consensus with weighted kappa is the appropriate analysis.

**Date:** Decision recorded Session 7, 2026-04-15.

---

### 3.3 Error taxonomy: 7-class system

**Decision:** A 7-class error taxonomy is used, decomposed by pipeline origin (extractor vs. adjudicator vs. post-processing) and error mechanism (recall, ranking, misclassification, interpretation, hallucination, formatting). This replaces an earlier 4-class system (omission, misclassification, formatting_syntax, semantic).

**Rationale:** The 4-class system did not distinguish between errors that arise in different pipeline nodes. An "omission" could be a recall failure by one extractor, a correlated recall failure by both extractors, or a truncation loss — three different root causes requiring different fixes. The 7-class system maps directly onto the pipeline architecture: Class 1–2 (recall) → extractor fix; Class 3 (ranking) → adjudicator fix; Classes 4–7 → prompt instruction or post-processing fix.

The taxonomy was designed to generate an actionable prompt modification queue: high frequency of Class 2 (correlated recall) in any field indicates that the candidate coverage check is insufficient for that field and requires targeted prompt redesign before Phase 1.

**Date:** Session 7, 2026-04-15.

---

### 3.4 Reporting frameworks: DECIDE-AI (Phase 0) + CONSORT-AI (Phase 1)

**Decision:** Phase 0 is reported under DECIDE-AI (Vasey et al., *Nature Medicine* 2022). Phase 1 is reported under CONSORT-AI (Liu et al., *BMJ* 2020).

**Rationale:** DECIDE-AI is designed for early-phase, feasibility-focused AI evaluations — it is the correct framework for an unblinded, single-rater pilot study. CONSORT-AI is designed for randomised or comparative studies of AI interventions — it is the correct framework for the Phase 1 accuracy study (V1 vs. V3, blinded, multi-rater).

Using CONSORT-AI for Phase 0 would be methodologically inappropriate — Phase 0 does not have the blinding, rater count, or statistical power that CONSORT-AI assumes.

**Date:** Session 7, 2026-04-15.

---

## Part 4 — Open Risks (Unmitigated or Partially Mitigated)

These risks have been identified but not fully addressed. They are recorded here for transparency and for future sessions.

| Risk | Severity | Current status | Planned mitigation |
|---|---|---|---|
| NI structured output fields absent | 5 | `ni_margin` etc. are free-text in `primary_outcome`, not structured fields | Add before Phase 1; PROFHER (paper 8) will expose this |
| Truncation of late-appearing content | 3 | Truncation flag sent to adjudicator but content is still lost | Input prioritisation (primary endpoint first) — not yet implemented |
| Synthetic table citations mislead adjudicator | 2–3 | Tolerated; citations used for ranking only | No structural fix without OCR-level grounding |
| Correlated recall failure structurally undetectable | 5 | Reduced by model diversity; not eliminated | Phase 0 PI review is primary control; no automated fix |
| Training data contamination (papers known to models) | 2 | OPTIMAS (2024) added to reduce this; most papers are pre-cutoff | Cannot be fully eliminated with foundation models |
| Model deprecation (flash-lite, gpt-4o-mini) | 1 | Both active as of April 2026 | Monitor model availability; update LEARNINGS.md on deprecation |

---

## Revision Log

| Date | Session | Change | Reason |
|---|---|---|---|
| 2026-04-15 | Session 7 | v1 created | Initial documentation of all decisions made in Sessions 1–7 |

*Update this table whenever a decision in this document is revised or a new decision is added.*
