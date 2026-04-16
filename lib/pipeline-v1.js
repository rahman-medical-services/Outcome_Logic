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
//   ✓ Same output schema shape (same grading fields)
//   ✓ Self-check before JSON output (partial compensation for absent adjudicator)
//   ✗ Cross-model diversity (Gemini + GPT-4o-mini)
//   ✗ Adversarial adjudicator
//   ✗ Multi-candidate pool compilation (≤3 ranked candidates)
//   ✗ Suspicious agreement detection
//   ✗ Source conflict detection across two independent extractors

import { buildSourceContext, postProcess } from './pipeline.js';

const GEMINI_MODEL  = 'gemini-2.5-flash-lite';
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
      thinkingConfig: { thinkingBudget: 512 },
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
- Example: if primary outcome is 30-day mortality, arm_a_value = event rate % in intervention arm (e.g. 15.4), arm_b_value = event rate % in control arm (e.g. 19.2). The HR or RD belongs in "value".
- If per-arm observed values are not reported: set arm_a_value/arm_b_value to null — do NOT substitute the effect size.

UNCERTAINTY FLAGS:
- selection_uncertain: true → you cannot confidently identify which result is the pre-specified primary
- ambiguous_source: true → the primary result appears with different values in 2+ locations
- ni_trial: true → Methods describe a non-inferiority design
- zero_event_arm: true → either arm of the primary outcome has zero events
- multi_arm_trial: true → more than two randomised arms

SELF-CHECK — before outputting JSON, verify each point:
1. Is my selected primary result from the pre-specified primary analysis (not secondary or post-hoc)?
2. If abstract and Results section differ, did I use the Results section value?
3. Are arm_a_value and arm_b_value per-arm observed rates, not the between-arm effect size?
4. If this is an NI trial, did I extract the NI margin and CI-excludes-margin test?
If any check fails, correct the extraction before outputting.`;

// ─────────────────────────────────────────────
// V1 EXTRACTION PROMPT (user content prefix before source text)
// ─────────────────────────────────────────────
const V1_PROMPT_PREFIX = `Extract the following from the clinical trial text below.

1. TRIAL IDENTIFICATION
   - Full trial name and acronym
   - Authors (first 3 then et al.), journal name, year, DOI
   - Study design (RCT | cohort | single-arm | crossover | non-inferiority | factorial)
   - Trial registration number if stated

2. PICO
   - Population: exact eligibility criteria
   - Intervention: full name, dose, schedule, route
   - Control/Comparator: full name, dose, schedule
   - Primary outcome: exact definition as stated in the paper
   - Secondary outcomes: list up to 4 pre-specified secondary endpoints

3. BASELINE CHARACTERISTICS
   - Sample size per arm (randomised N and analysed N if different), median age, sex distribution
   - Key disease characteristics (stage, prior treatment)
   - Follow-up duration as structured value: { value: number, unit: "months|years|days|weeks", type: "median|mean|planned" }

4. PRIMARY ENDPOINT
   - Apply HIERARCHY RULES above before selecting any value
   - Outcome type: binary | continuous | time_to_event
   - Effect measure with 95% CI (HR, OR, RR, RD, MD, SMD — use whichever the paper reports as primary)
   - P-value (exact, not just "significant")
   - Analysis population: ITT | per-protocol | mITT
   - Whether the estimate is adjusted or unadjusted
   - Outcome assessment timepoint: { value: number, unit: "months|years|days|weeks" }
   - Per-arm observed values (ARM VALUE RULE above): event rate % or mean or median for each arm
   - For binary: integer event count and N per arm (e.g. "47/312")
   - For NI design: NI margin from Methods + whether CI excludes the NI margin + NI result label

   Populate primary_endpoint_candidates with exactly ONE entry: the selected primary result with selected: true.
   Set source_a to the verbatim citation [SRC: text | location].

5. SECONDARY ENDPOINTS — up to 4 pre-specified:
   - Name, effect measure with 95% CI, p-value, note if statistically significant

6. SUBGROUP ANALYSES
   - Pre-specified subgroups: extract ALL regardless of significance
   - Post-hoc subgroups: only if interaction p<0.05
   - For each: variable, interaction p-value, pre_specified flag, per-arm HR with CI and absolute counts

7. ADVERSE EVENTS (Grade ≥3, ≥5% either arm):
   - Event name, percentage both arms
   - Discontinuation rates, treatment-related mortality rates

8. CRITICAL APPRAISAL
   - Risk of Bias across Cochrane domains → exactly one of: Low | Moderate | High | Unclear
   - GRADE certainty → exactly one of: High | Moderate | Low | Very Low
   - Key limitations (max 2 sentences)

9. CHARTS — always use recommended_chart_type: "bar"
   - Include endpoint for primary outcome if any numeric data exists
   - y values are percentages as raw numbers (74 means 74%, not 0.74)
   - For multi-timepoint survival: one data point per arm per reported time point
   - Maximum 2 endpoints in the array

10. LIBRARY CLASSIFICATION
Valid taxonomy:
${TAXONOMY_TEXT}
Note: Orthopaedics = any musculoskeletal/joint/bone/fracture/spine trial regardless of whether treatment is surgical or non-surgical. Surgery = general/visceral/vascular/breast/endocrine/colorectal surgery only.

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
      "arm_a_value": "OBSERVED value in intervention arm — event rate %, mean, or median. null if not reported.",
      "arm_a_sd": null,
      "events_arm_a": "Integer or null — events in intervention arm (binary only)",
      "n_arm_a": "Integer or null",
      "n_randomised_arm_a": "Integer or null",
      "arm_b_name": "String — control group label",
      "arm_b_value": "OBSERVED value in control arm. null if not reported.",
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
      "secondary_outcomes": ["String — max 4 items"]
    },
    "baseline_characteristics": "String — 2-3 sentences",
    "critical_appraisal": {
      "grade_certainty": "High | Moderate | Low | Very Low",
      "risk_of_bias": "Low | Moderate | High | Unclear",
      "risk_of_bias_rationale": "String — max 2 sentences",
      "limitations": "String — max 2 sentences"
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
          "variable": "String",
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
              "subgroup_name": "String",
              "hr": "String",
              "ci_95": "String",
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
    "lay_summary": "String — 4-6 sentences plain English. Do not recommend a specific treatment. Do not use 'is better than', 'recommends', 'confirms', or 'establishes'.",
    "shared_decision_making_takeaway": "String — 2-3 sentences on what a patient should understand when considering this evidence with their clinical team."
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
