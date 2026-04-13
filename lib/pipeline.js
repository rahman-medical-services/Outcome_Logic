// lib/pipeline.js
// Shared 3-node OutcomeLogic analysis pipeline.
// Imported by api/analyze.js, api/library-batch.js, api/study-run.js — single source of truth.

import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const GEMINI_MODEL         = 'gemini-2.5-flash';
const GEMINI_MODEL_LITE    = 'gemini-2.5-flash-lite';  // fallback when 2.5-flash is overloaded
const GEMINI_MODEL_PRO     = 'gemini-2.5-pro';         // adjudicator always uses Pro
const EXTRACTOR_OUTPUT_CAP = 40000;

const TAXONOMY_DOMAINS = [
  'Surgery', 'Orthopaedics', 'Medicine', 'Critical Care', 'Anaesthesia'
];

const TAXONOMY_SPECIALTIES = {
  Surgery:         ['Upper GI', 'Hernia', 'Colorectal', 'Breast', 'Endocrine', 'Vascular', 'Hepatobiliary'],
  Orthopaedics:    ['Hip', 'Knee', 'Spine', 'Shoulder', 'Trauma'],
  Medicine:        ['Cardiology', 'Oncology', 'Respiratory', 'Gastroenterology', 'Endocrinology', 'Neurology', 'Infectious Disease'],
  'Critical Care': ['ICU', 'Emergency Medicine'],
  Anaesthesia:     ['Regional', 'General'],
};

function getTaxonomyPromptText() {
  return Object.entries(TAXONOMY_SPECIALTIES)
    .map(([domain, specs]) => `  ${domain}: ${specs.join(', ')}`)
    .join('\n');
}

// ─────────────────────────────────────────────
// SOURCE CONTEXT BUILDER — SHARED EXPORT
// Fix C1: was duplicated inline in analyze.js, study-run.js, library-batch.js.
// All endpoints must call this function to ensure the pipeline receives identical
// structured input regardless of which endpoint initiates the run.
// ─────────────────────────────────────────────
export function buildSourceContext(text, meta = {}) {
  return [
    `[SOURCE: ${meta.sourceType || 'unknown'}]`,
    meta.pmid  ? `[PMID: ${meta.pmid}]`   : '',
    meta.pmcid ? `[PMCID: ${meta.pmcid}]` : '',
    meta.doi   ? `[DOI: ${meta.doi}]`     : '',
    meta.extractionWarning ? `[WARNING: ${meta.extractionWarning}]` : '',
    '',
    text,
  ].filter(Boolean).join('\n');
}

// ─────────────────────────────────────────────
// EXTRACTOR PROMPTS
// Two divergent prompts — same extraction targets, different priority rules.
// Extractor A: analytical priority (adjusted estimates, ITT, pre-specified primary).
// Extractor B: face value (first-reported, as-labelled, no analytical preference).
// The adjudicator reconciles discrepancies and flags suspicious agreement.
// ─────────────────────────────────────────────
const _EXTRACTOR_SHARED_SECTIONS = `
Extract the following with precision. Only extract what is explicitly stated — write "Not reported" rather than infer.

SOURCE CITATION REQUIREMENT
For every numeric value you extract (effect sizes, CIs, p-values, event rates, arm counts), immediately append a citation marker:
  [SRC: "verbatim quote ≤20 words" | Location]
Location must be one of: Abstract | Results para N | Table N | Figure N legend | Methods
If two locations give the same value: [SRC: AMBIGUOUS | location-1 vs location-2]
Example: HR 0.72 (95% CI 0.60–0.86) [SRC: "hazard ratio 0.72, 95% CI 0.60 to 0.86, p<0.001" | Results para 2]

1. TRIAL IDENTIFICATION
   - Full trial name and acronym
   - Authors (first 3 then et al.), journal name, year, DOI
   - Study design (RCT, cohort, single-arm, crossover, non-inferiority, factorial etc.)
   - Trial registration number if stated

2. PICO
   - Population: exact eligibility criteria including staging, performance status, prior therapy
   - Intervention: full name, dose, schedule, route
   - Control/Comparator: full name, dose, schedule (or "No comparator" for single-arm)
   - Primary outcome: exact definition as stated in the paper
   - Secondary outcomes: list all pre-specified secondary endpoints

3. BASELINE CHARACTERISTICS
   - Sample size per arm, median age, sex distribution
   - Key disease characteristics (stage, histology, prior treatment)
   - Note any significant imbalances between arms

4. PRIMARY ENDPOINT — extract all of the following:
   - Result (e.g. median OS 48.6 vs 23.2 months, or rate 3.7% vs 3.8%)
   - Effect measure with 95% CI: HR, OR, RR, rate ratio, or risk difference — use whichever the paper reports as primary
   - Absolute difference (e.g. ARR 15%) if reported
   - P-value (exact, not just "significant")
   - Statistical significance threshold used (e.g. p<0.05)
   - For rate/proportion outcomes: extract the EXACT percentages for each arm
   - Number of events and total N per arm where reported
   - NON-INFERIORITY TRIALS: If the primary analysis uses a non-inferiority design, you MUST additionally extract:
     (a) the pre-specified non-inferiority margin as stated in the methods section
     (b) whether the 95% CI excludes the NI margin — state "CI excludes NI margin: YES" or "CI excludes NI margin: NO"
     (c) label the p-value explicitly as "NI test p=" — do NOT present this as a superiority result
     Do NOT conflate NI success with superiority.

5. SECONDARY ENDPOINTS — for each pre-specified secondary endpoint:
   - Name and definition
   - Result with effect measure, 95% CI, p-value
   - For rate outcomes: extract percentages for each arm
   - Note if statistically significant

6. SURVIVAL / TIME-TO-EVENT DATA:
   - For OS, DFS, PFS and similar endpoints
   - Extract reported survival % at each EXPLICITLY STATED time point (e.g. "74% at 2 years", "55% at 3 years")
   - Do NOT interpolate or estimate values between reported time points
   - Record the exact time labels as stated (e.g. "6 months", "1 year", "2 years")
   - If only a single time point is reported (e.g. "2-year OS: 74% vs 71%"), record only that point
   - NOTE: If the primary outcome is a simple rate comparison (e.g. "mortality 3.7% vs 3.8%"), this is NOT survival data

7. SUBGROUP ANALYSES — ONLY pre-specified subgroups with a statistically significant interaction:
   - Only extract if interaction p-value < 0.05
   - State the subgroup variable (e.g. "PD-L1 status", "node-positive vs negative")
   - HR and 95% CI for each subgroup
   - Interaction p-value
   - If the interaction p-value is between 0.04 and 0.06, flag it as "BORDERLINE_INTERACTION"
   - Do NOT extract exploratory or post-hoc subgroups

8. ADVERSE EVENTS — Grade 3 or higher only:
   - List each Grade ≥3 AE occurring in ≥5% of either arm
   - Percentage for BOTH intervention and control arms
   - Treatment-related mortality rate for both arms
   - Discontinuation due to AE rate for both arms

9. CRITICAL APPRAISAL
   - Risk of Bias: assess each Cochrane domain (randomisation, allocation concealment, blinding, outcome adjudication, attrition)
   - Classify as exactly one of: Low | Moderate | High | Unclear
   - GRADE certainty: exactly one of: High | Moderate | Low | Very Low
   - Key limitations stated by authors
   - Any important industry funding or COI disclosures

10. SOURCE CITATIONS — MANDATORY FOR ALL EXTRACTED VALUES
For every extracted numeric value or categorical judgment, record its source location.
Format each citation as:
  source_citation: { "text": "<verbatim sentence or table caption, max 30 words>", "location": "<Abstract | Results paragraph N | Table N | Figure N legend>" }

Example:
  HR 0.68 → source_citation: { "text": "The hazard ratio for PFS was 0.68 (95% CI 0.53–0.87; p=0.002)", "location": "Results paragraph 2" }

If two plausible source locations exist for the same value, cite BOTH and append "(AMBIGUOUS_SOURCE)" to the location string.
This is not optional. Unsourced extractions cannot be adjudicated.

Keep output focused. Do not reproduce full sections of source text.`;

const EXTRACTOR_PROMPT_A = `You are Extractor A — Analytical Priority. You are an elite Surgical Data Extraction Agent analysing a FULL-TEXT clinical trial.

PRIORITY RULES — apply these before extracting any value:
- If both adjusted and unadjusted estimates are reported: extract the ADJUSTED value
- If both ITT and per-protocol analyses are reported: extract ITT
- Select the analysis pre-specified as primary in the Methods or statistical analysis plan
- If the abstract and Results section report different values: prefer the Results section value
- For composite outcomes: extract the composite as the primary endpoint, not individual components
` + _EXTRACTOR_SHARED_SECTIONS;

const EXTRACTOR_PROMPT_B = `You are Extractor B — Face Value. You are an elite Surgical Data Extraction Agent analysing a FULL-TEXT clinical trial.

PRIORITY RULES — apply these before extracting any value:
- Extract the primary outcome EXACTLY as labelled "primary" in the Results section — do NOT infer primacy from Methods
- Extract the FIRST-REPORTED effect size for each endpoint in the order it appears in Results
- If both adjusted and unadjusted estimates are reported: extract WHICHEVER appears first in Results
- If both ITT and per-protocol analyses are reported: extract WHICHEVER appears first in Results
- If the abstract and Results section differ: note BOTH values with their locations; do not choose
- Do NOT select between multiple reported analyses — report the first one you encounter
` + _EXTRACTOR_SHARED_SECTIONS;

// ─────────────────────────────────────────────
// ADJUDICATOR PROMPT — Adversarial framing
// Fix C4: adjudicator now always runs on GEMINI_MODEL_PRO.
// Fix M1 acknowledged: adjudicator cannot detect omissions absent from both reports.
//   Suspicious agreement is flagged only when multiple candidates appear in the
//   extractor text and both chose the same one. Omission detection requires PI review.
// ─────────────────────────────────────────────
const ADJUDICATOR_PROMPT_BASE = `You are the Chief of Surgery and an EBM expert acting as an ADVERSARIAL adjudicator.
Your job is to find extraction errors, not confirm agreement.

Extractor A prioritised adjusted estimates and methods-specified primary analyses.
Extractor B prioritised first-reported values from the results section.
Disagreements between them are expected and informative — resolve each by citing which source location is correct.

For each discrepancy, identify why EACH extractor might be wrong before determining the correct value.
Favour the more specific and numerically precise value, but justify your choice.

For fields where both extractors agree, apply this check:
(a) Do they cite different source locations for the same value? If yes, set source_conflict: true.
(b) Do the extractor reports mention multiple candidate values (e.g. adjusted and unadjusted HR, ITT and per-protocol), and both chose the same one? If yes, set suspicious_agreement: true and note the alternative.

Do NOT treat agreement as correctness — treat it as a hypothesis to verify against the cited sources within the reports.

Important constraint: You do not have access to the original source document. Suspicious agreement can only be detected from evidence within the two extractor reports. Omissions that neither extractor mentioned cannot be detected at this stage — that requires Phase 0 PI review.

Create a single unified synthesis. Output STRICTLY in the JSON schema below — no preamble, no markdown fences:

{
  "reportMeta": {
    "trial_identification": "String — full trial name and acronym",
    "study_design": "String — e.g. Multicentre open-label RCT | Non-inferiority RCT | Single-arm phase 2",
    "authors": "String — First Author, Second Author, Third Author et al. — null if not found",
    "journal": "String — full journal name — null if not found",
    "year": "String — year of publication — null if not found",
    "source_type": "full-text-pmc | full-text-jina | full-text-pdf | abstract-only | pasted-text | url",
    "pubmed_id": "String or null",
    "pmc_id": "String or null",
    "doi": "String or null",
    "pubmed_link": "String or null",
    "pmc_link": "String or null",
    "generated_at": "ISO timestamp string"
  },
  "extraction_flags": {
    "suspicious_agreement": false,
    "suspicious_agreement_note": null,
    "ambiguous_source": false,
    "source_conflict": false,
    "source_conflict_note": null,
    "selection_uncertain": false,
    "ni_trial": false
  },
  "source_citations": {
    "primary_result": { "text": "String or null", "location": "String or null" },
    "effect_size": { "text": "String or null", "location": "String or null" },
    "ni_margin": { "text": "String or null", "location": "String or null" }
  },
  "clinician_view": {
    "context": {
      "already_known": "String — max 1 sentence",
      "what_this_adds": "String — max 1 sentence"
    },
    "pico": {
      "population": "String",
      "intervention": "String",
      "control": "String",
      "primary_outcome": "String — include result, effect measure, CI, p-value. For NI trials, include NI margin and whether CI excludes it.",
      "secondary_outcomes": ["String — include result and p-value — max 4 items"]
    },
    "baseline_characteristics": "String — 2-3 sentences covering N, age, sex, key disease characteristics",
    "critical_appraisal": {
      "grade_certainty": "High | Moderate | Low | Very Low",
      "risk_of_bias": "Low | Moderate | High | Unclear",
      "risk_of_bias_rationale": "String — max 2 sentences covering key RoB domains",
      "limitations": "String — max 2 sentences"
    },
    "adverse_events": {
      "has_data": true,
      "rows": [
        {
          "event": "String — AE name e.g. Neutropenia",
          "intervention_pct": 0,
          "control_pct": 0,
          "note": "String or null — e.g. Grade 3-4 only"
        }
      ],
      "discontinuation": {
        "intervention_pct": 0,
        "control_pct": 0
      },
      "treatment_related_mortality": {
        "intervention_pct": 0,
        "control_pct": 0,
        "note": "String or null"
      }
    },
    "subgroups": {
      "has_significant_interactions": false,
      "items": [
        {
          "variable": "String — e.g. PD-L1 expression ≥1%",
          "interaction_p": "String — e.g. p=0.02",
          "borderline": false,
          "arms": [
            {
              "subgroup_name": "String — e.g. PD-L1 ≥1%",
              "hr": "String — e.g. 0.62",
              "ci_95": "String — e.g. 0.48–0.79"
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
          "clinical_synthesis": "String — 1-2 sentences on clinical meaning",
          "axes": { "x_label": "String", "y_label": "String" },
          "arms": [
            {
              "group_name": "String",
              "data_points": [ { "x": "String", "y": 0 } ]
            }
          ],
          "effect_measure": "HR | OR | RR | MD | SMD | RD | null — exact string from this list or null",
          "point_estimate": 0.0,
          "ci_lower": 0.0,
          "ci_upper": 0.0,
          "p_value_str": "String e.g. '0.023' or '<0.001' — null if not reported",
          "arm_a_n": 0,
          "arm_b_n": 0,
          "arm_a_events": null,
          "arm_b_events": null,
          "time_point_weeks": null,
          "analysis_population": "ITT | mITT | PP | null",
          "adjusted": true,
          "source_citation_a": { "verbatim": "String ≤20 words", "location": "Abstract | Results para N | Table N | Figure N" },
          "source_citation_b": { "verbatim": "String ≤20 words", "location": "Abstract | Results para N | Table N | Figure N" }
        }
      ]
    }
  },
  "patient_view": {
    "lay_summary": "String — 4-6 sentences in plain English. Explain what the trial studied, what was found, what the numbers mean in practical terms (e.g. 'out of 100 patients who received X, approximately Y more were alive at 3 years compared to standard treatment'), and what this means for treatment decisions.",
    "shared_decision_making_takeaway": "String — 2-3 sentences on what a patient should understand when making a treatment decision"
  },
  "library_meta": {
    "domain": "Surgery | Orthopaedics | Medicine | Critical Care | Anaesthesia",
    "specialty": "String — must be valid for the domain",
    "subspecialty": "String or null",
    "tags": ["String — 3 to 6 lowercase keywords"],
    "landmark_year": 0,
    "display_title": "String — TRIAL NAME — First Author et al. (Year)"
  }
}

CRITICAL INSTRUCTIONS FOR ENUMS:
- grade_certainty: MUST be exactly one of: "High" | "Moderate" | "Low" | "Very Low"
- risk_of_bias: MUST be exactly one of: "Low" | "Moderate" | "High" | "Unclear"

CRITICAL INSTRUCTIONS FOR EXTRACTION FLAGS:
- Set ni_trial: true whenever the study uses a non-inferiority design
- Set selection_uncertain: true if either extractor flagged "(SELECTION_UNCERTAIN)"
- Set ambiguous_source: true if either extractor flagged "(AMBIGUOUS_SOURCE)" for the primary result
- Set suspicious_agreement: true if both extractors agreed on a value but the reports mention an alternative candidate that was not selected

CRITICAL INSTRUCTIONS FOR CHARTS:
- ALWAYS include at least one endpoint for the PRIMARY outcome if ANY numeric data is available
- ALWAYS use recommended_chart_type: "bar" for ALL endpoints — including survival and time-to-event data
- Never use "stepped-line" — it is not supported
- chart_priority 1 = primary endpoint (MANDATORY if data exists)
- chart_priority 2 = second chart — ONLY include if there is a meaningful pre-specified secondary endpoint with distinct data
- Maximum 2 endpoints in the array

DATA FORMAT RULES:
- ALL y-values are PERCENTAGES as raw numbers (74 means 74%, NOT 0.74)
- For survival/time-to-event data: extract reported survival % at each EXPLICITLY STATED time point only
- For rate/proportion comparisons: use the reported percentage for each arm
- x values are time-point labels as strings (e.g. "6 months", "1 year", "2 years") OR arm names for single time-point comparisons
- For single time-point outcomes (e.g. "mortality 3.7% vs 3.8%"), provide one data point per arm using arm name as x value
- For multi-time-point survival data, provide one data point per arm per reported time point
- If insufficient data for ANY chart, output an empty endpoints array — but this should be rare for published trials

ENDPOINT EXAMPLES:

Example A — Rate comparison (single time point):
Trial reports: "Death due to bleeding: 3.7% in TXA vs 3.8% in placebo"
Output:
  recommended_chart_type: "bar"
  axes: { x_label: "Treatment", y_label: "Death rate (%)" }
  arms: [
    { group_name: "Tranexamic acid", data_points: [{ x: "TXA", y: 3.7 }] },
    { group_name: "Placebo",         data_points: [{ x: "Placebo", y: 3.8 }] }
  ]

Example B — Survival data with multiple reported time points:
Trial reports: "OS at 1y: 75% vs 65%; at 2y: 55% vs 42%; at 3y: 45% vs 32%; at 5y: 38% vs 24%"
Output:
  recommended_chart_type: "bar"
  axes: { x_label: "Time", y_label: "Overall Survival (%)" }
  arms: [
    { group_name: "Chemotherapy", data_points: [
      { x: "1 year", y: 75 }, { x: "2 years", y: 55 }, { x: "3 years", y: 45 }, { x: "5 years", y: 38 }
    ]},
    { group_name: "Surgery alone", data_points: [
      { x: "1 year", y: 65 }, { x: "2 years", y: 42 }, { x: "3 years", y: 32 }, { x: "5 years", y: 24 }
    ]}
  ]

Example C — Only a single reported survival time point:
Trial reports: "2-year OS: 74% (active surveillance) vs 71% (standard surgery)"
Output:
  recommended_chart_type: "bar"
  axes: { x_label: "Treatment", y_label: "2-Year Overall Survival (%)" }
  arms: [
    { group_name: "Active Surveillance", data_points: [{ x: "Active Surveillance", y: 74 }] },
    { group_name: "Standard Surgery",    data_points: [{ x: "Standard Surgery",    y: 71 }] }
  ]

CRITICAL INSTRUCTIONS FOR ANALYSIS FIELDS (in each endpoint):
- effect_measure: MUST be exactly one of "HR" | "OR" | "RR" | "MD" | "SMD" | "RD" — or null if not applicable
- point_estimate, ci_lower, ci_upper: numeric floats — never strings. e.g. 0.72, 0.60, 0.86
- p_value_str: string preserving exact format from paper e.g. "0.023", "<0.001", "0.14" — null if not reported
- arm_a_n / arm_b_n: total randomised N per arm as integer — extract from baseline table if not in results
- arm_a_events / arm_b_events: integer count of outcome events per arm — null for continuous outcomes
- time_point_weeks: primary follow-up duration in weeks as float (e.g. 52.0 for 1 year, 26.0 for 6 months) — null if not a time-specific outcome
- analysis_population: "ITT" | "mITT" | "PP" — null if not stated
- adjusted: true if the reported effect estimate is from an adjusted model; false if unadjusted; null if unclear
- source_citation_a / source_citation_b: populate from the corresponding extractor report's [SRC:] markers — null if no citation was provided

CRITICAL INSTRUCTIONS FOR ADVERSE EVENTS:
- Only include Grade ≥3 AEs occurring in ≥5% of either arm
- If no AE data available, set has_data to false and rows to empty array
- control_pct should be null for single-arm trials

CRITICAL INSTRUCTIONS FOR SUBGROUPS:
- Only include subgroups with a statistically significant interaction (p<0.05 for interaction)
- Set borderline: true when interaction p is between 0.04 and 0.06
- If no significant interactions, set has_significant_interactions to false and items to empty array
- Do NOT include exploratory or post-hoc subgroups

CRITICAL INSTRUCTIONS FOR LAY SUMMARY:
- Write for a patient with no medical background
- 4-6 sentences minimum
- Include at least one absolute number to convey effect size (e.g. "X more patients out of 100")
- Avoid jargon — if you must use a technical term, explain it immediately

CRITICAL INSTRUCTIONS FOR reportMeta:
- journal: extract the full journal name from the paper (e.g. "The New England Journal of Medicine")
- year: 4-digit publication year as a string
- authors: first 3 authors then "et al." — use the format "Surname INITIALS" e.g. "van Hagen PDEM, Hulshof MCCM, van Lanschot JJB et al."
- Populate pubmed_id, pmc_id, doi, pubmed_link, pmc_link from source context
- source_type must be exactly one of the allowed values

CRITICAL INSTRUCTIONS FOR library_meta:
- domain must be exactly one of the valid domains
- display_title: "TRIAL NAME — First Author et al. (Year)"
- tags: 3-6 lowercase keywords`;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function capOutput(text, max = EXTRACTOR_OUTPUT_CAP) {
  if (text.length <= max) return text;
  console.warn(`[Pipeline] Extractor unusually long (${text.length} chars) — truncating at ${max}`);
  const trimmed = text.slice(0, max);
  const last    = trimmed.lastIndexOf('.');
  return last > 0 ? trimmed.slice(0, last + 1) : trimmed;
}

function buildLinks(pmid, pmcid) {
  return {
    pubmed_link: pmid  ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`            : null,
    pmc_link:    pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/` : null,
  };
}

// ─────────────────────────────────────────────
// POST-PROCESS
// Normalises, validates, and enriches the adjudicator JSON output.
// ─────────────────────────────────────────────
function postProcess(parsed, sourceMeta) {
  const links = buildLinks(sourceMeta.pmid, sourceMeta.pmcid);

  // ── reportMeta ───────────────────────────────────────────────────────────
  parsed.reportMeta = {
    ...parsed.reportMeta,
    authors:      parsed.reportMeta?.authors      || sourceMeta.authors    || null,
    journal:      parsed.reportMeta?.journal      || null,
    year:         parsed.reportMeta?.year         || null,
    source_type:  parsed.reportMeta?.source_type  || sourceMeta.sourceType || null,
    pubmed_id:    parsed.reportMeta?.pubmed_id     || sourceMeta.pmid       || null,
    pmc_id:       parsed.reportMeta?.pmc_id        || sourceMeta.pmcid      || null,
    doi:          parsed.reportMeta?.doi            || sourceMeta.doi        || null,
    pubmed_link:  parsed.reportMeta?.pubmed_link    || links.pubmed_link     || null,
    pmc_link:     parsed.reportMeta?.pmc_link       || links.pmc_link        || null,
    generated_at: parsed.reportMeta?.generated_at  || new Date().toISOString(),
  };

  if (sourceMeta.extractionWarning) {
    parsed.reportMeta.extraction_warning = sourceMeta.extractionWarning;
  }

  // ── Enum enforcement ─────────────────────────────────────────────────────
  const ca = parsed.clinician_view?.critical_appraisal;
  if (ca) {
    const validGrade = ['High', 'Moderate', 'Low', 'Very Low'];
    const validRoB   = ['Low', 'Moderate', 'High', 'Unclear'];
    if (!validGrade.includes(ca.grade_certainty)) ca.grade_certainty = 'Very Low';
    if (!validRoB.includes(ca.risk_of_bias))      ca.risk_of_bias    = 'Unclear';
  }

  // ── Ensure extraction_flags block exists ──────────────────────────────────
  if (!parsed.extraction_flags) {
    parsed.extraction_flags = {
      suspicious_agreement:      false,
      suspicious_agreement_note: null,
      ambiguous_source:          false,
      source_conflict:           false,
      source_conflict_note:      null,
      selection_uncertain:       false,
      ni_trial:                  false,
    };
  }

  // ── Ensure source_citations block exists ──────────────────────────────────
  if (!parsed.source_citations) {
    parsed.source_citations = {
      primary_result: { text: null, location: null },
      effect_size:    { text: null, location: null },
      ni_margin:      { text: null, location: null },
    };
  }

  // ── Ensure adverse_events block exists ───────────────────────────────────
  if (!parsed.clinician_view?.adverse_events) {
    parsed.clinician_view.adverse_events = {
      has_data:                     false,
      rows:                         [],
      discontinuation:              { intervention_pct: null, control_pct: null },
      treatment_related_mortality:  { intervention_pct: null, control_pct: null, note: null },
    };
  }

  // ── Ensure subgroups block exists ─────────────────────────────────────────
  if (!parsed.clinician_view?.subgroups) {
    parsed.clinician_view.subgroups = {
      has_significant_interactions: false,
      items:                        [],
    };
  }

  // ── Enforce max 2 charts, sorted by priority ──────────────────────────────
  const endpoints = parsed.clinician_view?.interactive_data?.endpoints;
  if (Array.isArray(endpoints)) {
    parsed.clinician_view.interactive_data.endpoints = endpoints
      .sort((a, b) => (a.chart_priority || 1) - (b.chart_priority || 1))
      .slice(0, 2);
  }

  // ── Expert context — not loaded by default (on-demand via /api/commentary) ─
  parsed.clinician_view.expert_context = { status: 'not_loaded' };
  console.log('[postProcess] expert_context: not_loaded (on-demand)');

  // ── library_meta ─────────────────────────────────────────────────────────
  const lm        = parsed.library_meta || {};
  const domain    = TAXONOMY_DOMAINS.includes(lm.domain) ? lm.domain : TAXONOMY_DOMAINS[0];
  const specs     = TAXONOMY_SPECIALTIES[domain] || [];
  const specialty = specs.includes(lm.specialty) ? lm.specialty : (specs[0] || null);

  parsed.library_meta = {
    domain,
    specialty,
    subspecialty:  lm.subspecialty  || null,
    tags:          Array.isArray(lm.tags) ? lm.tags.slice(0, 6) : [],
    landmark_year: lm.landmark_year  || null,
    display_title: lm.display_title  ||
                   parsed.reportMeta?.trial_identification ||
                   'Unknown Trial',
  };

  // ── Legacy aliases ────────────────────────────────────────────────────────
  parsed.metadata = {
    trial_identification: parsed.reportMeta?.trial_identification || '',
    study_design:         parsed.reportMeta?.study_design         || '',
  };

  parsed._provenance = {
    source:    sourceMeta.sourceType || 'unknown',
    timestamp: new Date().toISOString(),
  };

  return parsed;
}

// ─────────────────────────────────────────────
// MAIN EXPORT: runPipeline
// ─────────────────────────────────────────────
export async function runPipeline(sourceContext, sourceMeta = {}, adjMeta = {}, isEscalation = false) {

  const extractModel = isEscalation ? GEMINI_MODEL_PRO : GEMINI_MODEL;
  // Adjudicator always uses Pro — it needs a capability advantage over Flash extractors.
  // Fix C4: was incorrectly using the same model as the extractors in non-escalation mode.
  const adjModel = model;  // Flash normally, Pro on escalation — matches extractor behaviour

  console.log(`[Pipeline] Mode: ${isEscalation ? 'ESCALATION' : 'normal'}`);
  console.log(`[Pipeline] Extractors: ${extractModel} | Adjudicator: ${adjModel}`);

  const adjudicatorPrompt = ADJUDICATOR_PROMPT_BASE + `\n\nVALID TAXONOMY:\n${getTaxonomyPromptText()}`;

  const escalationWarning = isEscalation
    ? `\nWARNING: A previous extraction attempt produced a critical error. Read with extreme caution.
       Pay special attention to: absolute vs relative risk, p-values (do not assume significance),
       complex tables where columns may be misaligned, and survival curve reconstruction.\n`
    : '';

  // ── Pre-scan sourceContext for PMID/DOI (PDF uploads only) ───────────────
  if (sourceMeta.sourceType === 'full-text-pdf' && !sourceMeta.pmid && !sourceMeta.doi) {
    const scanHead = sourceContext.slice(0, 4000);
    const scanTail = sourceContext.slice(-2000);
    const scanText = scanHead + '\n' + scanTail;

    // PMID
    const pmidScan = scanText.match(/(?:PMID|PubMed\s*ID)\s*[:\-]?\s*(\d{7,8})/i);
    if (pmidScan?.[1]) {
      sourceMeta.pmid = pmidScan[1];
      console.log(`[Pipeline] Pre-scan found PMID: ${sourceMeta.pmid}`);
    }

    // DOI — allow parentheses for Lancet-style DOIs e.g. S0140-6736(20)31444-6
    if (!sourceMeta.pmid) {
      const doiScan = scanText.match(/(?:DOI|doi)\s*[:\-]?\s*(10\.\d{4,}\/\S+)/i)
                   || scanText.match(/https?:\/\/doi\.org\/(10\.\d{4,}\/\S+)/i)
                   || scanText.match(/\b(10\.\d{4,}\/[^\s,;>"']{4,})/);
      if (doiScan?.[1]) {
        sourceMeta.doi = doiScan[1].replace(/[,\.\]"'>]+$/, '');
        console.log(`[Pipeline] Pre-scan found DOI: ${sourceMeta.doi}`);
      }
    }
  }

  // ── Node 1 & 2: parallel dual extraction ─────────────────────────────────
  // A uses adjusted/ITT/methods-specified priority.
  // B uses first-reported/results-section priority.
  // Different prompts produce genuine disagreement on ambiguous papers.
  // thinkingBudget: 0 disables chain-of-thought (adds 10-30s per call, exceeds Vercel 60s limit).
  function _isOverloaded(msg) {
    return msg.includes('503') || msg.includes('service unavailable') ||
           msg.includes('high demand') || msg.includes('temporarily') ||
           msg.includes('overloaded');
  }
  function _isCapacityError(msg) {
    return _isOverloaded(msg) || msg.includes('429') ||
           msg.includes('rate') || msg.includes('quota') ||
           msg.includes('resource exhausted');
  }

  async function _runExtractors(model) {
    const eA = genAI.getGenerativeModel({ model, systemInstruction: EXTRACTOR_PROMPT_A + escalationWarning });
    const eB = genAI.getGenerativeModel({ model, systemInstruction: EXTRACTOR_PROMPT_B + escalationWarning });
    const [rA, rB] = await Promise.all([
      eA.generateContent({
        contents:         [{ role: 'user', parts: [{ text: sourceContext }] }],
        generationConfig: { temperature: 0.05, thinkingConfig: { thinkingBudget: 0 } },
      }),
      eB.generateContent({
        contents:         [{ role: 'user', parts: [{ text: sourceContext }] }],
        generationConfig: { temperature: 0.05, thinkingConfig: { thinkingBudget: 0 } },
      }),
    ]);
    return [capOutput(rA.response.text()), capOutput(rB.response.text())];
  }

  let reportA, reportB;
  try {
    console.log(`[Pipeline] Extractors A+B using: ${extractModel}`);
    [reportA, reportB] = await _runExtractors(extractModel);
  } catch (err) {
    console.error('[Pipeline] Extractor error:', err.message);
    const msg = err.message?.toLowerCase() || '';
    if (_isOverloaded(msg)) {
      console.warn(`[Pipeline] ${extractModel} overloaded — retrying with ${GEMINI_MODEL_LITE}`);
      try {
        [reportA, reportB] = await _runExtractors(GEMINI_MODEL_LITE);
        console.log(`[Pipeline] Lite fallback succeeded`);
      } catch (fallbackErr) {
        console.error('[Pipeline] Lite fallback also failed:', fallbackErr.message);
        const fbMsg = fallbackErr.message?.toLowerCase() || '';
        if (_isCapacityError(fbMsg)) {
          throw new Error('GEMINI_UNAVAILABLE: Both Gemini models are currently overloaded. Please wait a minute and try again.');
        }
        throw fallbackErr;
      }
    } else if (_isCapacityError(msg)) {
      throw new Error('GEMINI_UNAVAILABLE: The Gemini AI service is temporarily unavailable. Please wait a minute and try again.');
    } else {
      throw err;
    }
  }

  // ── Node 3: adjudication — always on GEMINI_MODEL_PRO ────────────────────
  const links     = buildLinks(sourceMeta.pmid, sourceMeta.pmcid);
  const metaLines = [
    `source_type:  ${sourceMeta.sourceType || 'unknown'}`,
    `pubmed_id:    ${sourceMeta.pmid        || 'unknown'}`,
    `pmc_id:       ${sourceMeta.pmcid       || 'unknown'}`,
    `doi:          ${sourceMeta.doi         || 'unknown'}`,
    `pubmed_link:  ${links.pubmed_link      || ''}`,
    `pmc_link:     ${links.pmc_link         || ''}`,
    `generated_at: ${new Date().toISOString()}`,
    sourceMeta.extractionWarning ? `WARNING: ${sourceMeta.extractionWarning}` : null,
    ...Object.entries(adjMeta).map(([k, v]) => `${k}: ${v}`),
  ].filter(Boolean).join('\n');

  const adjInput = [
    'Compare these two extraction reports and generate the final unified JSON.',
    'Extractor A used adjusted/ITT priority. Extractor B used first-reported/results-section priority.',
    'Disagreements between A and B on numeric values are expected — resolve each with a cited reason.',
    '',
    'Source metadata to populate in reportMeta:',
    metaLines,
    '',
    'REPORT A (adjusted/ITT priority):',
    reportA,
    '',
    'REPORT B (first-reported priority):',
    reportB,
  ].join('\n');

  async function _runAdjudicator(model) {
    const adjNode = genAI.getGenerativeModel({
      model,
      systemInstruction: adjudicatorPrompt,
      generationConfig:  { responseMimeType: 'application/json', temperature: 0.0, thinkingConfig: { thinkingBudget: 0 } },
    });
    const finalResult = await adjNode.generateContent(adjInput);
    return JSON.parse(finalResult.response.text());
  }

  let parsed;
  try {
    console.log(`[Pipeline] Adjudicator using: ${adjModel}`);
    parsed = await _runAdjudicator(adjModel);
  } catch (err) {
    console.error('[Pipeline] Adjudicator error:', err.message);
    const msg = err.message?.toLowerCase() || '';
    if (_isOverloaded(msg)) {
      // Pro overloaded — fall back to Flash (not Lite, which is too weak for adjudication)
      console.warn(`[Pipeline] Adjudicator: ${adjModel} overloaded — retrying with ${GEMINI_MODEL}`);
      try {
        parsed = await _runAdjudicator(GEMINI_MODEL);
        console.log(`[Pipeline] Adjudicator Flash fallback succeeded`);
      } catch (fallbackErr) {
        console.error('[Pipeline] Adjudicator Flash fallback failed:', fallbackErr.message);
        const fbMsg = fallbackErr.message?.toLowerCase() || '';
        if (_isCapacityError(fbMsg) || fallbackErr instanceof SyntaxError) {
          throw new Error('GEMINI_UNAVAILABLE: Both Gemini models are currently overloaded. Please wait a minute and try again.');
        }
        throw fallbackErr;
      }
    } else if (_isCapacityError(msg)) {
      throw new Error('GEMINI_UNAVAILABLE: The Gemini AI service is temporarily unavailable. Please wait a minute and try again.');
    } else {
      throw err;
    }
  }

  return postProcess(parsed, sourceMeta);
}
