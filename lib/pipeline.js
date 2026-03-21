// lib/pipeline.js
// Shared 3-node OutcomeLogic analysis pipeline.
// Imported by api/analyze.js and api/library-batch.js — single source of truth.
//
// Exports one function:
//   runPipeline(sourceContext, sourceMeta) → parsed analysis JSON
//
// sourceContext — the full text string passed to the extractors, including
//                 [SOURCE:], [PMID:], [WARNING:] header lines
// sourceMeta    — { pmid, pmcid, doi, sourceType, extractionWarning }

import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const GEMINI_MODEL        = 'gemini-2.5-flash';
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
// PROMPTS
// ─────────────────────────────────────────────
const EXTRACTOR_PROMPT = `You are an elite Surgical Data Extraction Agent analyzing a FULL-TEXT clinical trial.
Extract detailed PICO data, baseline demographics, secondary outcomes, and adverse events.
Identify the primary endpoint and extract its statistical significance (p-values, HRs, CIs).

CRITICAL INSTRUCTION FOR KAPLAN-MEIER / SURVIVAL DATA:
You must reconstruct the survival/failure curve.
1. Scan the text for explicit time-point survival rates.
2. Hunt for "Number at risk" tables usually located below the Kaplan-Meier figures.
3. Use the baseline N, events, and number-at-risk at various time intervals to extract exact cumulative incidence or survival percentages.
4. Output these reconstructed step-coordinates clearly so the Adjudicator can format them into a stepped-line chart.

Assess methodological limitations and Risk of Bias using the Cochrane RoB tool domains.
Classify Risk of Bias as exactly one of: Low | Moderate | High | Unclear
Classify GRADE certainty as exactly one of: High | Moderate | Low | Very Low

Keep your output focused and concise. Do not reproduce full sections of the source text.`;

const ADJUDICATOR_PROMPT_BASE = `You are the Chief of Surgery and an EBM expert.
Compare the two provided extraction reports. Resolve discrepancies and create a single, unified synthesis.

You MUST output STRICTLY in this JSON schema — no preamble, no markdown fences:
{
  "reportMeta": {
    "trial_identification": "String",
    "study_design": "String",
    "authors": "String — e.g. van Hagen PDEM, Hulshof MCCM, van Lanschot JJB et al. Extract from the paper. Null if not found.",
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
      "primary_outcome": "String",
      "secondary_outcomes": ["String — max 3 items"]
    },
    "baseline_characteristics": "String — max 2 sentences",
    "critical_appraisal": {
      "grade_certainty": "High | Moderate | Low | Very Low",
      "risk_of_bias": "Low | Moderate | High | Unclear",
      "risk_of_bias_rationale": "String — max 2 sentences",
      "limitations": "String — max 2 sentences"
    },
    "interactive_data": {
      "endpoints": [
        {
          "id": "String",
          "label": "String",
          "recommended_chart_type": "bar | stepped-line",
          "clinical_synthesis": "String",
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
    "lay_summary": "String",
    "shared_decision_making_takeaway": "String"
  },
  "library_meta": {
    "domain": "Surgery | Orthopaedics | Medicine | Critical Care | Anaesthesia",
    "specialty": "String — must be valid for the domain",
    "subspecialty": "String or null — must be valid for the specialty",
    "tags": ["String — 3 to 6 lowercase keywords"],
    "landmark_year": 0,
    "display_title": "String — TRIAL NAME — First Author et al. (Year)"
  }
}

CRITICAL INSTRUCTIONS FOR CONCISENESS:
- Be ruthless with word count. Use extremely concise, bullet-like phrasing.
- Maximum 1 sentence for 'already_known' and 'what_this_adds'.
- Maximum 2 sentences for 'baseline_characteristics', 'risk_of_bias_rationale', and 'limitations'.
- Limit 'secondary_outcomes' to only the 2 or 3 most clinically significant findings.

CRITICAL INSTRUCTIONS FOR ENUMS — these fields MUST be exactly one of the allowed values:
- grade_certainty: "High" | "Moderate" | "Low" | "Very Low"
- risk_of_bias: "Low" | "Moderate" | "High" | "Unclear"

CRITICAL INSTRUCTIONS FOR KAPLAN-MEIER:
1. Use 'stepped-line' for survival/time-to-event data.
2. Provide 4-5 data points (e.g., '0d', '30d', '60d', '90d') to form a proper stepped curve.
3. Ensure y-values are numeric (e.g., 0.95 for 95%).

CRITICAL INSTRUCTIONS FOR reportMeta:
- Populate pubmed_id, pmc_id, doi, pubmed_link, pmc_link from the source context if available.
- Set generated_at to the current ISO timestamp.
- source_type must be exactly one of the allowed string values.
- authors: extract the author string from the paper (e.g. "van Hagen PDEM, Hulshof MCCM et al."). If more than 3 authors, list first 3 then "et al.". Set null if not determinable.

CRITICAL INSTRUCTIONS FOR library_meta:
- domain must be exactly one of: Surgery | Orthopaedics | Medicine | Critical Care | Anaesthesia
- specialty must be a valid specialty within that domain (see taxonomy below)
- subspecialty must be a valid subspecialty within that specialty, or null if unclear
- landmark_year is the year the primary paper was published (integer), or null if unknown
- display_title format: "TRIAL NAME — First Author et al. (Year)" e.g. "CROSS Trial — van Hagen et al. (2012)"
  If no trial acronym, use: "Intervention vs Control — First Author et al. (Year)"
- tags: 3-6 lowercase keywords describing the trial e.g. ["neoadjuvant", "chemoradiotherapy", "rct", "survival"]
- If domain or specialty cannot be determined with confidence, default to the most likely based on the clinical content`;

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
    pubmed_link: pmid  ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`             : null,
    pmc_link:    pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`  : null,
  };
}

function postProcess(parsed, sourceMeta) {
  const links = buildLinks(sourceMeta.pmid, sourceMeta.pmcid);

  // ── reportMeta ───────────────────────────────────────────────────────────
  parsed.reportMeta = {
    ...parsed.reportMeta,
    authors:      parsed.reportMeta?.authors       || sourceMeta.authors    || null,
    source_type:  parsed.reportMeta?.source_type   || sourceMeta.sourceType || null,
    pubmed_id:    parsed.reportMeta?.pubmed_id      || sourceMeta.pmid       || null,
    pmc_id:       parsed.reportMeta?.pmc_id         || sourceMeta.pmcid      || null,
    doi:          parsed.reportMeta?.doi             || sourceMeta.doi        || null,
    pubmed_link:  parsed.reportMeta?.pubmed_link     || links.pubmed_link     || null,
    pmc_link:     parsed.reportMeta?.pmc_link        || links.pmc_link        || null,
    generated_at: parsed.reportMeta?.generated_at   || new Date().toISOString(),
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

  // ── library_meta ─────────────────────────────────────────────────────────
  const lm       = parsed.library_meta || {};
  const domain   = TAXONOMY_DOMAINS.includes(lm.domain) ? lm.domain : TAXONOMY_DOMAINS[0];
  const specs    = TAXONOMY_SPECIALTIES[domain] || [];
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
//
// @param sourceContext  string — full text with header lines for Gemini
// @param sourceMeta     object — { pmid, pmcid, doi, sourceType, extractionWarning }
// @param adjMeta        object — extra key/value lines injected into the adjudicator
//                                input (e.g. source_type, pubmed_link)
//
// @returns parsed analysis JSON with reportMeta, clinician_view, patient_view,
//          library_meta, metadata (legacy), _provenance
// ─────────────────────────────────────────────
export async function runPipeline(sourceContext, sourceMeta = {}, adjMeta = {}) {

  // Build adjudicator prompt with taxonomy injected
  const adjudicatorPrompt = ADJUDICATOR_PROMPT_BASE + `\n\nVALID TAXONOMY (use these exact values for library_meta):\n${getTaxonomyPromptText()}`;

  // ── Node 1 & 2: parallel dual extraction ─────────────────────────────────
  const eA = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: EXTRACTOR_PROMPT });
  const eB = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: EXTRACTOR_PROMPT });

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
    model:             GEMINI_MODEL,
    systemInstruction: adjudicatorPrompt,
    generationConfig:  { responseMimeType: 'application/json', temperature: 0.0 },
  });

  // Build adjudicator input — inject source metadata as named fields
  const links     = buildLinks(sourceMeta.pmid, sourceMeta.pmcid);
  const metaLines = [
    `source_type:  ${sourceMeta.sourceType    || 'unknown'}`,
    `pubmed_id:    ${sourceMeta.pmid           || 'unknown'}`,
    `pmc_id:       ${sourceMeta.pmcid          || 'unknown'}`,
    `doi:          ${sourceMeta.doi            || 'unknown'}`,
    `pubmed_link:  ${links.pubmed_link         || ''}`,
    `pmc_link:     ${links.pmc_link            || ''}`,
    `generated_at: ${new Date().toISOString()}`,
    sourceMeta.extractionWarning
      ? `WARNING:      ${sourceMeta.extractionWarning}`
      : null,
    // Any extra metadata passed by the caller
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

  // ── Post-process and return ───────────────────────────────────────────────
  return postProcess(parsed, sourceMeta);
}