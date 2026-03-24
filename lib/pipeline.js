// lib/pipeline.js
// Shared 3-node OutcomeLogic analysis pipeline.
// Imported by api/analyze.js and api/library-batch.js — single source of truth.

import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const GEMINI_MODEL         = 'gemini-2.5-flash';
const GEMINI_MODEL_PRO     = 'gemini-2.5-pro';
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
// EXTRACTOR PROMPT
// Instructs both parallel extractors on what to pull.
// Deliberately verbose — the adjudicator reconciles discrepancies.
// ─────────────────────────────────────────────
const EXTRACTOR_PROMPT = `You are an elite Surgical Data Extraction Agent analyzing a FULL-TEXT clinical trial.

Extract the following with precision. Only extract what is explicitly stated — write "Not reported" rather than infer.

1. TRIAL IDENTIFICATION
   - Full trial name and acronym
   - Authors (first 3 then et al.), journal name, year, DOI
   - Study design (RCT, cohort, single-arm, crossover etc.)
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
   - Result (e.g. median OS 48.6 vs 23.2 months)
   - HR or OR with 95% CI
   - Absolute difference (e.g. ARR 15%)
   - P-value (exact, not just "significant")
   - Statistical significance threshold used (e.g. p<0.05)

5. SECONDARY ENDPOINTS — for each pre-specified secondary endpoint:
   - Name and definition
   - Result with HR/OR, 95% CI, p-value
   - Note if statistically significant

6. KAPLAN-MEIER / SURVIVAL DATA — reconstruct carefully:
   - Scan for explicit time-point survival rates in the text
   - Hunt for "Number at risk" tables below KM figures
   - Use baseline N, events, and number-at-risk at time intervals
   - Extract cumulative incidence or survival % at each time point
   - Output reconstructed step-coordinates for BOTH primary and any significant secondary time-to-event endpoints

7. SUBGROUP ANALYSES — ONLY pre-specified subgroups with a statistically significant interaction:
   - Only extract if interaction p-value < 0.05
   - State the subgroup variable (e.g. "PD-L1 status", "node-positive vs negative")
   - HR and 95% CI for each subgroup
   - Interaction p-value
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

Keep output focused. Do not reproduce full sections of source text.`;

// ─────────────────────────────────────────────
// ADJUDICATOR PROMPT
// ─────────────────────────────────────────────
const ADJUDICATOR_PROMPT_BASE = `You are the Chief of Surgery and an EBM expert.
Compare the two extraction reports. Resolve discrepancies — favour more specific and numerically precise values.
Create a single unified synthesis. Output STRICTLY in this JSON schema — no preamble, no markdown fences:

{
  "reportMeta": {
    "trial_identification": "String — full trial name and acronym",
    "study_design": "String — e.g. Multicentre open-label RCT",
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
  "clinician_view": {
    "context": {
      "already_known": "String — max 1 sentence",
      "what_this_adds": "String — max 1 sentence"
    },
    "pico": {
      "population": "String",
      "intervention": "String",
      "control": "String",
      "primary_outcome": "String — include result, HR/OR, CI, p-value",
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
          "recommended_chart_type": "bar | stepped-line",
          "clinical_synthesis": "String — 1-2 sentences on clinical meaning",
          "axes": { "x_label": "String", "y_label": "String" },
          "arms": [
            {
              "group_name": "String",
              "data_points": [ { "x": "String", "y": 0 } ]
            }
          ]
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

CRITICAL INSTRUCTIONS FOR CHARTS:
- Use 'stepped-line' for all time-to-event / survival / KM data
- Use 'bar' for rates, proportions, and response data
- chart_priority 1 = primary endpoint (always include if data supports a chart)
- chart_priority 2 = second chart — ONLY include if there is a meaningful pre-specified secondary endpoint or significant subgroup with time-to-event data that is clinically distinct from the primary
- Maximum 2 endpoints in the array
- For stepped-line: provide 4-6 data points to form a proper curve; y-values must be numeric proportions (0.95 not 95%)
- For bar: y-values are percentages as integers (e.g. 45 not 0.45)
- If insufficient data for a chart, output an empty endpoints array

CRITICAL INSTRUCTIONS FOR ADVERSE EVENTS:
- Only include Grade ≥3 AEs occurring in ≥5% of either arm
- If no AE data available, set has_data to false and rows to empty array
- control_pct should be null for single-arm trials

CRITICAL INSTRUCTIONS FOR SUBGROUPS:
- Only include subgroups with a statistically significant interaction (p<0.05 for interaction)
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

  const model           = isEscalation ? GEMINI_MODEL_PRO : GEMINI_MODEL;
  const adjudicatorPrompt = ADJUDICATOR_PROMPT_BASE + `\n\nVALID TAXONOMY:\n${getTaxonomyPromptText()}`;

  const escalationWarning = isEscalation
    ? `\nWARNING: A previous extraction attempt produced a critical error. Read with extreme caution.
       Pay special attention to: absolute vs relative risk, p-values (do not assume significance),
       complex tables where columns may be misaligned, and survival curve reconstruction.\n`
    : '';

  // ── Node 1 & 2: parallel dual extraction ─────────────────────────────────
  const eA = genAI.getGenerativeModel({ model, systemInstruction: EXTRACTOR_PROMPT + escalationWarning });
  const eB = genAI.getGenerativeModel({ model, systemInstruction: EXTRACTOR_PROMPT + escalationWarning });

  const [rA, rB] = await Promise.all([
    eA.generateContent({
      contents:         [{ role: 'user', parts: [{ text: sourceContext }] }],
      generationConfig: { temperature: 0.1 },
    }),
    eB.generateContent({
      contents:         [{ role: 'user', parts: [{ text: sourceContext }] }],
      generationConfig: { temperature: 0.2 },
    }),
  ]);

  const reportA = capOutput(rA.response.text());
  const reportB = capOutput(rB.response.text());

  // ── Node 3: adjudication ─────────────────────────────────────────────────
  const adj = genAI.getGenerativeModel({
    model,
    systemInstruction: adjudicatorPrompt,
    generationConfig:  { responseMimeType: 'application/json', temperature: 0.0 },
  });

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
    '',
    'Source metadata to populate in reportMeta:',
    metaLines,
    '',
    'REPORT A:',
    reportA,
    '',
    'REPORT B:',
    reportB,
  ].join('\n');

  const finalResult = await adj.generateContent(adjInput);
  const parsed      = JSON.parse(finalResult.response.text());

  return postProcess(parsed, sourceMeta);
}