// lib/pipeline-v1.js
// V1 single-node baseline pipeline for Phase 1 accuracy comparison.
//
// Architecture: one Gemini flash-lite call. No parallel extractors. No adjudicator.
// callGemini is duplicated here (not imported) so that V3 changes during the
// study period cannot inadvertently alter V1 behaviour. postProcess() IS shared
// — it applies the same normalisation to both versions for comparable grading.
//
// What V1 has vs V3:
//   ✓ Same hierarchy rules (adjusted > unadjusted, ITT > PP)
//   ✓ ARM VALUE RULE (per-arm observed values, not effect size)
//   ✓ NI trial detection and margin extraction
//   ✓ Source citations (single extractor grounding)
//   ✓ Candidate values for primary endpoint
//   ✓ Tiered subgroup extraction with Option C 4-subgroup rule
//   ✓ AE cross-reference rule
//   ✓ Subgroup grouping rule (≥2 arms per item)
//   ✓ Subgroup hr field: populate with any effect measure, never null
//   ✓ Patient view required fields enforcement
//   ✓ Language constraints
//   ✓ Same output schema shape (same grading fields)
//   ✗ Self-check / internal adjudication (removed — keeps V1 as clean single-pass baseline)
//   ✗ Cross-model diversity (Gemini + GPT-4o-mini)
//   ✗ Adversarial adjudicator
//   ✗ Multi-candidate pool compilation (≤3 ranked candidates from two extractors)
//   ✗ Suspicious agreement detection across two independent extractors

import { buildSourceContext, postProcess } from './pipeline.js';

const GEMINI_MODEL    = 'gemini-2.5-flash-lite';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ─────────────────────────────────────────────
// GEMINI CALL — duplicated from pipeline.js for V1 independence
// ─────────────────────────────────────────────
async function callGemini(systemInstruction, userContent, options = {}) {
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents:           [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig: {
      temperature:    options.temperature ?? 0.05,
      thinkingConfig: { thinkingBudget: 1024 },
      ...(options.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
    },
  };

  const MAX_RETRIES = 2;
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 500, 15000);
      await new Promise(r => setTimeout(r, delay));
      console.log(`[V1 callGemini] Retry ${attempt} after ${Math.round(delay)}ms`);
    }
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err     = new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
        err.status    = res.status;
        if ([400, 401, 403, 404].includes(res.status)) throw err;
        lastError = err;
        continue;
      }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Gemini: empty response body');
      return text;
    } catch (err) {
      if ([400, 401, 403, 404].includes(err.status)) throw err;
      lastError = err;
    }
  }
  const isQuota = lastError?.status === 429 ||
                  (lastError?.message || '').toLowerCase().includes('quota') ||
                  (lastError?.message || '').toLowerCase().includes('resource exhausted');
  if (isQuota) throw new Error('GEMINI_UNAVAILABLE: Gemini API quota limit reached.');
  throw lastError || new Error('V1 Gemini: all retries exhausted');
}

// ─────────────────────────────────────────────
// TAXONOMY REFERENCE (used in prompt)
// ─────────────────────────────────────────────
const TAXONOMY_TEXT = `
Surgery:       Upper GI | Hernia | Colorectal | Breast | Endocrine | Vascular | Hepatobiliary
Orthopaedics:  Hip | Knee | Spine | Shoulder | Trauma
Medicine:      Cardiology | Oncology | Respiratory | Gastroenterology | Endocrinology | Neurology | Infectious Disease
Critical Care: ICU | Emergency Medicine
Anaesthesia:   Regional | General`.trim();

// ─────────────────────────────────────────────
// V1 SYSTEM INSTRUCTION
// ─────────────────────────────────────────────
const V1_SYSTEM = `You are an expert clinical trial extraction engine. Extract structured data from a full-text RCT with precision. Output ONLY valid JSON — no preamble, no markdown fences, no commentary outside the JSON object.

HIERARCHY RULES — apply before extracting any value:
1. Adjusted estimates > unadjusted estimates
2. ITT analysis > per-protocol > mITT
3. Methods-pre-specified primary endpoint > post-hoc > sensitivity analysis
4. Full-text Results section > abstract when values differ
5. Read the Methods section FIRST to identify the primary endpoint definition and any NI design before reading Results.

ARM VALUE RULE — critical:
- arm_a_value and arm_b_value are per-arm OBSERVED values (event rate %, mean, median, or survival % at stated timepoint) — NOT the between-group effect size
- Binary outcome: arm_a_value = event rate % in intervention arm (e.g. 5.4), arm_b_value = event rate % in control arm
- Continuous outcome: arm_a_value = mean or median in intervention arm, arm_b_value = same in control arm
- Change-from-baseline: arm_a_value = mean change in intervention arm, arm_b_value = mean change in control arm
- The between-group effect size (HR, OR, MD, risk difference) belongs in the "value" field — NEVER in arm_a_value or arm_b_value
- If per-arm observed values are not reported: set arm_a_value/arm_b_value to null — do NOT substitute the effect size

LANGUAGE CONSTRAINTS — apply to ALL narrative fields (context, pico, lay_summary, what_this_adds):
Do NOT use: "superior", "better than", "confirms", "establishes", "recommends", "you should",
"preferred option", or any prescriptive phrasing. Use: "noninferior", "the trial showed",
"the results suggest", "the data indicate". Clinical decisions require discussion with a qualified
healthcare professional.`;

// ─────────────────────────────────────────────
// V1 EXTRACTION PROMPT (user content prefix before source text)
// ─────────────────────────────────────────────
const V1_PROMPT_PREFIX = `Extract the following from the clinical trial text below. Only extract what is explicitly stated — write "Not reported" rather than infer.

SEARCH SCOPE — MANDATORY: Before answering each section, scan ALL of: Abstract, Methods, Results text, ALL Tables, ALL Figure captions/legends, and Supplementary material references. Do not stop at the abstract. Values in tables or figure legends take precedence over abstract summaries when they conflict.

SOURCE CITATION REQUIREMENT
For every numeric value you extract (effect sizes, CIs, p-values, event rates, arm counts), immediately append a citation marker:
  [SRC: "verbatim quote ≤20 words" | Location]
Location must be one of: Abstract | Results para N | Table N | Figure N legend | Methods
Example: HR 0.72 (95% CI 0.60–0.86) [SRC: "hazard ratio 0.72, 95% CI 0.60 to 0.86, p<0.001" | Results para 2]
If two locations give the same value: [SRC: AMBIGUOUS | location-1 vs location-2]

1. TRIAL IDENTIFICATION
   - Full trial name and acronym
   - Authors (first 3 then et al.), journal name, year, DOI
   - Study design (RCT, cohort, single-arm, crossover, non-inferiority, factorial etc.)
   - Trial registration number if stated

2. PICO
   - Population: exact eligibility criteria including staging, performance status, prior therapy
   - Intervention: full name, dose, schedule, route
   - Control/Comparator: full name, dose, schedule
   - Primary outcome: exact definition as stated in the paper
   - Secondary outcomes: list up to 4 pre-specified secondary endpoints

3. BASELINE CHARACTERISTICS
   - Sample size per arm (randomised N and analysed N if different), median age, sex distribution
   - Key disease characteristics (stage, prior treatment)
   - Note any significant imbalances between arms
   - Follow-up duration: { value: number, unit: "months|years|days|weeks", type: "median|mean|planned" }

4. PRIMARY ENDPOINT — extract all of the following:
   - Read the Methods section first to identify the pre-specified primary endpoint definition
   - Outcome type: binary | continuous | time_to_event
   - Effect measure with 95% CI (HR, OR, RR, RD, MD, SMD — use whichever the paper reports as primary)
   - P-value (exact, not just "significant")
   - Analysis population: ITT | per-protocol | mITT
   - Whether the estimate is adjusted or unadjusted
   - Outcome assessment timepoint: { value: number, unit: "months|years|days|weeks" }
   - Per-arm observed values (ARM VALUE RULE above): event rate % or mean or median for each arm
   - For binary: integer event count and N per arm (e.g. "47/312")
   - For continuous: mean (or median), SD (or IQR), and N per arm
   - N randomised per arm if reported separately from N analysed

   SAMPLE SIZES — MANDATORY: arm_a_n and arm_b_n must be populated wherever possible.
   Look in this order: (1) baseline characteristics table (Table 1 or equivalent) — column headers
   often state N, e.g. "TAVI (n=496)" or "Surgical AVR (n=454)"; (2) CONSORT flow diagram text,
   e.g. "496 were assigned to TAVI"; (3) Results section opening sentence.
   Do NOT leave arm_a_n / arm_b_n null if N per arm appears anywhere in the paper.
   - Total events across both arms combined (required for time-to-event weighting)

   NON-INFERIORITY TRIALS — if the primary analysis uses a non-inferiority design:
   (a) Extract the pre-specified NI margin from the Methods section
   (b) State whether the 95% CI excludes the NI margin: "CI excludes NI margin: YES" or "NO"
   (c) Label the p-value explicitly as "NI test p=" — do NOT present this as a superiority result
   NI CI DIRECTION — apply exactly:
   - For HRs and RRs (where <1 favours intervention): NI demonstrated when CI upper bound < NI margin
   - For risk differences: NI demonstrated when CI upper bound < NI margin
   Do NOT invert this. "CI excludes the NI margin" means the entire CI is on the beneficial side.
   Do NOT claim superiority unless a formal pre-specified superiority test was performed and passed.

   CANDIDATE VALUES — populate primary_endpoint_candidates with the selected primary result.
   Also note any alternative plausible values (adjusted vs unadjusted, ITT vs PP, abstract vs full-text)
   as additional candidates with selected: false. Format each:
     candidate: value=X.XX | effect_measure=HR/OR/RR/MD | outcome_type=binary/continuous/time_to_event |
       p=p-value | timepoint=[value unit] | label="e.g. adjusted HR, Table 2" | population=ITT/PP |
       arm_a=[GROUP: X.XX, events=N/total] | arm_b=[GROUP: X.XX, events=N/total] | [SRC: ...]

   CANDIDATE COMPLETENESS CHECK — before finalising, verify:
   - Have I included the adjusted primary analysis value?
   - Have I included the abstract value if it differs from full-text?
   - Have I correctly separated arm_a/arm_b (per-arm observed) from value (effect size)?

5. SECONDARY ENDPOINTS — up to 4 pre-specified — for each:
   - Name and definition
   - Result with effect measure, 95% CI, p-value
   - For rate outcomes: extract percentages for each arm
   - Note if statistically significant

6. SURVIVAL / TIME-TO-EVENT DATA:
   - For OS, DFS, PFS and similar endpoints
   - Extract reported survival % at each EXPLICITLY STATED time point only — do NOT interpolate
   - Record the exact time labels as stated (e.g. "6 months", "1 year", "2 years")
   - If only a single time point is reported, record only that point
   - NOTE: A simple rate comparison (e.g. "mortality 3.7% vs 3.8%") is NOT survival data

7. SUBGROUP ANALYSES — TIERED EXTRACTION (Option C):
   If no subgroup analyses are reported, state explicitly "No subgroup analyses reported."
   COMPLETENESS RULE: Scan ALL figures (especially forest plots) — subgroups may appear in figures only.

   TIERED EXTRACTION RULE — apply in order:
   STEP 1: Check all reported interaction p-values across all subgroups.
   STEP 2:
   - If ANY interaction p < 0.10: extract ALL pre-specified subgroups meeting this threshold.
   - If ALL interaction p-values are null or p ≥ 0.10: extract exactly 4 pre-specified subgroups in
     this clinical priority order:
       (1) Age (e.g. age <65 vs ≥65)
       (2) Sex (male vs female)
       (3) Disease severity measure (STS-PROM, LVEF, NYHA class, tumour stage, fracture type, etc.)
       (4) One key comorbidity (renal function, prior therapy, prior revascularisation)
     If fewer than 4 exist in the paper, extract however many are reported.
   STEP 3: POST-HOC subgroups — extract only if interaction p < 0.05.
   HARD CAP: Maximum 8 subgroups total.

   GROUPING RULE — MANDATORY: All arms of the same variable MUST be grouped under ONE item.
   Example: Age <75 and Age ≥75 are two ARMS of ONE item (variable = "Age").
   Do NOT create a separate item for each stratum. An item with only one arm is invalid.

   For each subgroup:
   - Flag as pre-specified or post-hoc
   - Subgroup variable and strata as arm names within the item
   - Interaction p-value (or "not reported")
   - Flag BORDERLINE if interaction p is between 0.04 and 0.06
   - For each arm: effect estimate (HR, OR, MD, or mean difference — use whatever is reported), 95% CI,
     absolute event counts if available
   - IMPORTANT: for the hr field, ALWAYS populate with the reported numeric effect measure — do NOT
     leave null for non-ratio outcomes (e.g. mean difference trials). Use whatever numeric value is given.
   - Whether all CIs cross 1
   - If observed direction contradicts the pre-specified hypothesis, note explicitly

8. ADVERSE EVENTS — Grade ≥3 or ≥2% either arm:
   CLASSIFICATION RULE — MANDATORY: The AE table must contain ONLY unscheduled complications NOT
   pre-specified as trial outcomes. Apply this cross-reference BEFORE finalising this section:
   (a) List every component of the primary composite outcome from Section 4. If the primary is a single
       event (e.g. "death"), that event is also excluded. For composites, ALL individual components are excluded.
   (b) Remove from your AE candidate list ANY event matching (a) — primary components belong in outcomes,
       never in AE.
   NOTE: Secondary endpoints may remain in the AE table if they appear there. They represent both
   efficacy and safety data and are clinically appropriate in both sections.
   Events to EXCLUDE if pre-specified: death, stroke, MI, repeat revascularisation, AF, new LBBB,
   new pacemaker, valve dysfunction (if pre-specified), renal failure (if pre-specified).
   Events typically safe to INCLUDE (if ≥2% and not pre-specified): wound infection, vascular access-site
   complication, bleeding requiring transfusion (if not pre-specified), sepsis, transfusion.
   If this rule leaves no AEs, set has_data: false — this is correct behaviour.
   - List qualifying AE name, percentage in both intervention and control arms
   - Treatment-related mortality rate for both arms
   - Discontinuation due to AE rate for both arms

9. CRITICAL APPRAISAL
   Risk of Bias — read the Methods section carefully. Assess each Cochrane domain explicitly,
   then give an overall label. NEVER output "Unclear".

   Domain assessment:
   - Randomisation: Low if sequence generation method stated (computer-generated, random number
     table, minimisation). Moderate if described only as "randomised" without method.
   - Allocation concealment: Low if central randomisation, pharmacy-controlled, or sealed opaque
     envelopes described. Moderate if not described.
   - Blinding: Low if patients AND providers both blinded (sham-controlled, double-blind, placebo).
     Moderate if open-label or single-blind. High if blinding was broken for a subjective outcome.
   - Outcome adjudication: Low if independent blinded committee stated. Moderate if unclear.
   - Attrition: Low if <10% loss to follow-up or missing data handled by multiple imputation/
     sensitivity analysis. Moderate if 10–20%. High if >20% or differential dropout.

   Overall label:
   - LOW: ≥4 domains are Low AND no domain is High. Open-label alone does NOT prevent Low
     if randomisation, concealment, adjudication, and attrition are all Low.
     Examples: ORBITA (double-blind = Low), ISCHEMIA (NIH-funded, central randomisation,
     independent adjudication, <5% attrition = Low), HIP ATTACK (independent adjudication,
     multicentre, <10% attrition = Low despite unblinded surgical intervention).
   - MODERATE: 1–2 domains Moderate, no domain High. Most open-label surgical RCTs.
   - HIGH: any domain High (e.g. >20% attrition, broken blinding on subjective outcome).
   FALLBACK: if detail is absent for a domain, apply the defaults above rather than Moderate.

   GRADE certainty — assign exactly one of: High | Moderate | Low | Very Low.
   - Very Low: NEVER for an RCT. Reserved for case series and observational studies only.
   - Low: RCT with ≥2 serious limitations (unblinded + high crossover, or small N + high attrition).
   - Moderate: RCT with ≤1 serious limitation. Default for most open-label surgical RCTs.
   - High: Low RoB overall AND large N AND consistent results across ≥2 independent RCTs.

   - Key limitations stated by authors (max 2 sentences)
   - COI / Funding: extract the funding source and sponsor name verbatim if stated.
     Format: "[Sponsor]: [role — e.g. funded trial design and data collection]". null if not reported.

10. CHARTS — always use recommended_chart_type: "bar"
   Populate arms[].data_points[].y with the per-arm OBSERVED value as a raw number:
   - Binary outcome: y = event rate % (e.g. 5.4 for 5.4%, NOT 0.054)
   - Continuous outcome (mean/median comparison): y = mean or median in that arm
     Example — ORBITA exercise time: arm A y = 28.4, arm B y = 11.8
   - Change-from-baseline: y = mean change in that arm (e.g. y = 11.7 for "+11.7 seconds")
   - Time-to-event / survival: y = % event-free (or survival %) at primary timepoint
     Example — STICH 10-year survival: arm A y = 41, arm B y = 33
   y-values come directly from arm_a_value / arm_b_value populated in Section 4.
   After completing Section 4, explicitly state:
     Chart y-values: [Arm A name] = [arm_a_value],  [Arm B name] = [arm_b_value]
   These MUST match arm_a_value and arm_b_value — no substitution.
   IMPORTANT: if arm_a_value or arm_b_value is null, re-check the Results section and tables
   for per-arm means, medians, or event rates before leaving y as null. y=null produces a blank
   chart. Only set null if the per-arm value is genuinely not reported anywhere in the paper.
   For multi-timepoint survival: one data point per arm per explicitly reported timepoint only.
   Maximum 2 endpoints in the array.

11. PATIENT VIEW — REQUIRED (never omit):
   lay_summary: 4-6 sentences in plain English. Include at least one absolute number. Avoid jargon.
   shared_decision_making_takeaway: 2-3 sentences on what a patient should understand when discussing
   this evidence with their clinical team. Do not recommend a specific treatment.

12. LIBRARY CLASSIFICATION
Valid taxonomy:
${TAXONOMY_TEXT}
Note: Orthopaedics = any musculoskeletal/joint/bone/fracture/spine trial regardless of whether
treatment is surgical or non-surgical. Surgery = general/visceral/vascular/breast/endocrine/
colorectal surgery only.

OUTPUT SCHEMA — output exactly this JSON structure:
{
  "reportMeta": {
    "trial_identification": "String",
    "study_design": "String",
    "authors": "String or null",
    "journal": "String or null",
    "year": "String or null",
    "source_type": "full-text-pdf",
    "pubmed_id": null,
    "pmc_id": null,
    "doi": "String or null",
    "pubmed_link": null,
    "pmc_link": null,
    "generated_at": "ISO timestamp",
    "followup_duration": { "value": null, "unit": "months | years | days | weeks", "type": "median | mean | planned" }
  },
  "extraction_flags": {
    "suspicious_agreement": false,
    "suspicious_agreement_note": null,
    "ambiguous_source": false,
    "source_conflict": false,
    "source_conflict_note": null,
    "selection_uncertain": false,
    "ni_trial": false,
    "zero_event_arm": false,
    "multi_arm_trial": false
  },
  "source_citations": {
    "primary_result": { "text": "String or null", "location": "String or null" },
    "effect_size":    { "text": "String or null", "location": "String or null" },
    "ni_margin":      { "text": "String or null", "location": "String or null" }
  },
  "primary_endpoint_candidates": [
    {
      "value": 0.0,
      "label": "String — e.g. 'adjusted HR, Cox model, Table 2'",
      "population": "ITT | PP | mITT | null",
      "arm_a_name": "String — intervention group label",
      "arm_a_value": "OBSERVED value in intervention arm — event rate %, mean, or median. NOT the effect size. null if not reported.",
      "arm_a_sd": null,
      "events_arm_a": "Integer or null",
      "n_arm_a": "Integer or null",
      "n_randomised_arm_a": "Integer or null",
      "arm_b_name": "String — control group label",
      "arm_b_value": "OBSERVED value in control arm. NOT the effect size. null if not reported.",
      "arm_b_sd": null,
      "events_arm_b": "Integer or null",
      "n_arm_b": "Integer or null",
      "n_randomised_arm_b": "Integer or null",
      "total_events": "Integer or null",
      "outcome_type": "binary | continuous | time_to_event",
      "outcome_timepoint": { "value": null, "unit": "months | years | days | weeks" },
      "value_type": "rate_pct | mean_score | median | count | time_to_event",
      "value_unit": "String or null",
      "effect_measure": "HR | OR | RR | RD | MD | SMD | difference | null",
      "p_value": "String or null",
      "ci_lower": 0.0,
      "ci_upper": 0.0,
      "source_a": "String or null — verbatim [SRC: citation]",
      "source_b": null,
      "selected": true
    }
  ],
  "clinician_view": {
    "context": {
      "already_known": "String — max 1 sentence",
      "what_this_adds": "String — max 1 sentence"
    },
    "pico": {
      "population": "String",
      "intervention": "String",
      "control": "String",
      "primary_outcome": "String — include result, effect measure, CI, p-value. For NI trials include NI margin and CI test.",
      "secondary_outcomes": ["String — include result and p-value — max 4 items"]
    },
    "baseline_characteristics": "String — 2-3 sentences",
    "critical_appraisal": {
      "grade_certainty": "High | Moderate | Low | Very Low — NEVER Very Low for an RCT",
      "risk_of_bias": "Low | Moderate | High — NEVER Unclear",
      "risk_of_bias_rationale": "String — enumerate Cochrane domains: randomisation, allocation concealment, blinding, outcome adjudication, attrition",
      "limitations": "String — max 2 sentences",
      "coi_funding": "String or null — verbatim sponsor name and role if stated in paper; null if not reported"
    },
    "adverse_events": {
      "has_data": true,
      "rows": [
        { "event": "String", "intervention_pct": 0, "control_pct": 0, "note": "String or null" }
      ],
      "discontinuation": { "intervention_pct": 0, "control_pct": 0 },
      "treatment_related_mortality": { "intervention_pct": 0, "control_pct": 0, "note": null }
    },
    "subgroups": {
      "has_significant_interactions": false,
      "items": [
        {
          "variable": "String — e.g. Age",
          "outcome": "String",
          "interaction_p": "String",
          "borderline": false,
          "pre_specified": true,
          "post_hoc": false,
          "cis_all_cross_one": false,
          "direction_vs_hypothesis": "String or null",
          "interaction_note": "String",
          "arms": [
            {
              "subgroup_name": "String — e.g. Age <65",
              "hr": "String — ALWAYS populate with whatever numeric effect measure is reported (HR, OR, RR, MD, mean difference). Do NOT leave null for non-ratio outcomes.",
              "ci_95": "String — e.g. 0.48–0.79",
              "ci_crosses_one": true,
              "absolute_events": "String or null"
            }
          ]
        }
      ]
    },
    "interactive_data": {
      "endpoints": [
        {
          "id": "String",
          "label": "String",
          "chart_priority": 1,
          "recommended_chart_type": "bar",
          "clinical_synthesis": "String — 1-2 sentences",
          "axes": { "x_label": "String", "y_label": "String" },
          "arms": [
            { "group_name": "String", "data_points": [ { "x": "String", "y": 0 } ] }
          ],
          "effect_measure": "HR | OR | RR | MD | SMD | RD | null",
          "point_estimate": 0.0,
          "ci_lower": 0.0,
          "ci_upper": 0.0,
          "p_value_str": "String or null",
          "arm_a_n": 0,
          "arm_b_n": 0,
          "arm_a_events": null,
          "arm_b_events": null,
          "time_point_weeks": null,
          "analysis_population": "ITT | mITT | PP | null",
          "adjusted": true,
          "source_citation_a": { "verbatim": "String ≤20 words", "location": "Abstract | Results para N | Table N" },
          "source_citation_b": { "verbatim": null, "location": null }
        }
      ]
    }
  },
  "patient_view": {
    "lay_summary": "String — 4-6 sentences plain English. Include at least one absolute number. Do not use 'is better than', 'recommends', 'confirms', 'establishes'.",
    "shared_decision_making_takeaway": "String — 2-3 sentences on what a patient should understand when considering this evidence with their clinical team. Do not recommend a specific treatment."
  },
  "library_meta": {
    "domain": "Surgery | Orthopaedics | Medicine | Critical Care | Anaesthesia",
    "specialty": "String — must exactly match one valid specialty for the chosen domain",
    "subspecialty": "String or null",
    "tags": ["String — 3 to 6 lowercase keywords"],
    "landmark_year": 0,
    "display_title": "String — TRIAL NAME — First Author et al. (Year)"
  }
}

SOURCE TEXT:
`;

// ─────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────
export async function runPipelineV1(sourceContext, sourceMeta = {}) {
  console.log('[V1 Pipeline] Starting single-node extraction');

  const userContent = V1_PROMPT_PREFIX + sourceContext;

  const rawText = await callGemini(V1_SYSTEM, userContent, {
    responseMimeType: 'application/json',
    temperature:      0.05,
  });

  console.log('[V1 Pipeline] Extraction complete, parsing JSON');

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    // Strip markdown fences if present despite responseMimeType
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(cleaned);
  }

  return postProcess(parsed, sourceMeta);
}

export { buildSourceContext };
