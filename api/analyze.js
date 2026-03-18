// api/analyze.js
// Rebuilt: 4-tier source cascade + enum critical appraisal + reportMeta + skeleton fallback

import { GoogleGenerativeAI } from '@google/generative-ai';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ==========================================
// VERCEL SERVERLESS CONFIG
// ==========================================
export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } }
};

// ==========================================
// SECURITY LAYER 3: Upstash Rate Limiter
// 100 requests per IP per 24-hour sliding window
// ==========================================
const ratelimit = new Ratelimit({
  redis:     Redis.fromEnv(),
  limiter:   Ratelimit.slidingWindow(100, '24 h'),
  analytics: true,
  prefix:    'trial-visualiser',
});

// ==========================================
// CONSTANTS
// ==========================================
// Soft runaway guard only — Gemini 2.5 Flash has a 1M token context window
// and in practice extractor outputs rarely exceed 15,000 chars even for long papers
const EXTRACTOR_OUTPUT_CAP = 40000;
const MIN_CHARS = { FULLTEXT: 2000, ABSTRACT: 200, JINA: 1000 };

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ==========================================
// PROMPTS
// ==========================================
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

const ADJUDICATOR_PROMPT = `You are the Chief of Surgery and an EBM expert.
Compare the two provided extraction reports. Resolve discrepancies and create a single, unified synthesis.

You MUST output STRICTLY in this JSON schema — no preamble, no markdown fences:
{
  "reportMeta": {
    "trial_identification": "String",
    "study_design": "String",
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
- source_type must be exactly one of the allowed string values.`;

// ==========================================
// SOURCE TIER 1: PubMed / Europe PMC full text XML
// Cleanest source — no scraping, structured XML stripped to plain text
// ==========================================
async function fetchFullTextPMC(pmcid, pmid) {
  if (!pmcid) return null;
  try {
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml  = await res.text();
    // Strip XML tags — faster and cleaner than a full XML parser in serverless
    const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_CHARS.FULLTEXT) return null;
    console.log(`[Tier 1] PMC full text XML: ${text.length} chars`);
    return {
      text,
      sourceType: 'full-text-pmc',
      pmcid,
      pmid: pmid || null,
    };
  } catch (err) {
    console.log(`[Tier 1] PMC XML failed: ${err.message}`);
    return null;
  }
}

// ==========================================
// SOURCE TIER 2: Jina scrape of Europe PMC reader
// Used when PMC XML is unavailable (some OA papers are HTML-only)
// ==========================================
async function fetchFullTextJina(pmcid) {
  if (!pmcid) return null;
  try {
    const targetUrl = `https://europepmc.org/article/PMC/${pmcid}`;
    const res       = await fetch(`https://r.jina.ai/${targetUrl}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (
      !text ||
      text.includes('Access Denied') ||
      text.length < MIN_CHARS.JINA
    ) return null;
    console.log(`[Tier 2] Jina/PMC scrape: ${text.length} chars`);
    return { text, sourceType: 'full-text-jina', pmcid };
  } catch (err) {
    console.log(`[Tier 2] Jina scrape failed: ${err.message}`);
    return null;
  }
}

// ==========================================
// SOURCE TIER 3: Jina DOI scrape
// For paywalled papers where DOI is known — gets landing page / preview
// ==========================================
async function fetchFromDoi(doi) {
  if (!doi) return null;
  try {
    const res  = await fetch(`https://r.jina.ai/https://doi.org/${doi}`, {
      headers: { Accept: 'text/plain' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length < MIN_CHARS.JINA) return null;
    console.log(`[Tier 3] Jina/DOI: ${text.length} chars`);
    return { text, sourceType: 'full-text-jina', doi };
  } catch (err) {
    console.log(`[Tier 3] Jina/DOI failed: ${err.message}`);
    return null;
  }
}

// ==========================================
// SOURCE TIER 4: Europe PMC abstract fallback
// Always available for indexed papers — better than nothing
// ==========================================
async function fetchAbstract(query, isPmid) {
  try {
    const searchQuery = isPmid ? `ext_id:${query}` : query;
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(searchQuery)}&resultType=core&format=json`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const article = data.resultList?.result?.[0];
    if (!article) return null;

    const abstract = article.abstractText
      ? article.abstractText.replace(/<[^>]*>?/gm, '')
      : null;

    if (!abstract || abstract.length < MIN_CHARS.ABSTRACT) return null;

    console.log(`[Tier 4] Abstract: ${abstract.length} chars`);
    return {
      text:       `TITLE: ${article.title}\n\n[ABSTRACT ONLY]\n${abstract}`,
      sourceType: 'abstract-only',
      pmid:       article.pmid  || null,
      pmcid:      article.pmcid || null,
      doi:        article.doi   || null,
      title:      article.title || null,
    };
  } catch (err) {
    console.log(`[Tier 4] Abstract fetch failed: ${err.message}`);
    return null;
  }
}

// ==========================================
// SOURCE TIER ORCHESTRATOR
// Runs the cascade for PMID / keyword queries.
// Returns { text, sourceType, pmid, pmcid, doi } or null.
// ==========================================
async function fetchTrialSource(query, isPmid) {
  // First, look up the article metadata to get pmcid/doi
  let meta = null;
  try {
    const searchQuery = isPmid ? `ext_id:${query}` : query;
    const url  = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(searchQuery)}&resultType=core&format=json`;
    const res  = await fetch(url);
    if (res.ok) {
      const data    = await res.json();
      const article = data.resultList?.result?.[0];
      if (article) {
        meta = {
          pmid:  article.pmid  || null,
          pmcid: article.pmcid || null,
          doi:   article.doi   || null,
          title: article.title || null,
        };
      }
    }
  } catch (err) {
    console.log(`[Meta lookup] Failed: ${err.message}`);
  }

  if (!meta) return null;

  // Tier 1: PMC full text XML
  const tier1 = await fetchFullTextPMC(meta.pmcid, meta.pmid);
  if (tier1) return { ...tier1, ...meta };

  // Tier 2: Jina scrape of PMC reader
  const tier2 = await fetchFullTextJina(meta.pmcid);
  if (tier2) return { ...tier2, ...meta };

  // Tier 3: Jina DOI scrape
  const tier3 = await fetchFromDoi(meta.doi);
  if (tier3) return { ...tier3, ...meta };

  // Tier 4: Abstract fallback
  const tier4 = await fetchAbstract(query, isPmid);
  if (tier4) return { ...tier4, ...meta };

  return null;
}

// ==========================================
// SOURCE VERIFICATION (lightweight)
// Checks the fetched text plausibly matches the search query
// before burning Gemini calls on irrelevant content.
// ==========================================
async function verifySource(sourceText, originalQuery) {
  const sample   = sourceText.slice(0, 3000).toLowerCase();
  const keywords = originalQuery
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);

  const matchCount = keywords.filter(w => sample.includes(w)).length;
  const matchRatio = keywords.length > 0 ? matchCount / keywords.length : 1;

  if (matchRatio >= 0.35) {
    console.log(`[Verify] OK: ${Math.round(matchRatio * 100)}% keyword match`);
    return { verified: true };
  }

  // AI fallback for borderline cases
  try {
    const verifier = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result   = await verifier.generateContent({
      contents: [{ role: 'user', parts: [{ text:
        `Does this document describe a clinical trial relevant to: "${originalQuery}"?
Answer ONLY "YES" or "NO".
Excerpt: ${sourceText.slice(0, 1500)}`
      }] }],
      generationConfig: { temperature: 0.0, maxOutputTokens: 10 }
    });
    const answer   = result.response.text().trim().toUpperCase();
    const verified = answer.startsWith('YES');
    console.log(`[Verify] AI: ${answer}`);
    return { verified, warning: verified ? null : 'Source may not match query — results may be unreliable.' };
  } catch (err) {
    console.log(`[Verify] AI check failed — proceeding: ${err.message}`);
    return { verified: true };
  }
}

// ==========================================
// SKELETON RESPONSE
// Returned when all source tiers fail — UI gets a structured
// response with provenance rather than a raw error.
// ==========================================
function buildSkeletonResponse(query, dataSource) {
  return {
    reportMeta: {
      trial_identification: query,
      study_design:         'Unknown',
      source_type:          'abstract-only',
      pubmed_id:            null,
      pmc_id:               null,
      doi:                  null,
      pubmed_link:          null,
      pmc_link:             null,
      generated_at:         new Date().toISOString(),
      extraction_warning:   'All source tiers failed — only partial or no data available.',
    },
    clinician_view: {
      context: {
        already_known:  'Source unavailable.',
        what_this_adds: 'Source unavailable.',
      },
      pico: {
        population:         'Source unavailable',
        intervention:       'Source unavailable',
        control:            'Source unavailable',
        primary_outcome:    'Source unavailable',
        secondary_outcomes: [],
      },
      baseline_characteristics: 'Source unavailable.',
      critical_appraisal: {
        grade_certainty:        'Very Low',
        risk_of_bias:           'Unclear',
        risk_of_bias_rationale: 'Full text unavailable — unable to assess.',
        limitations:            'Full text unavailable.',
      },
      interactive_data: { endpoints: [] },
    },
    patient_view: {
      lay_summary:                      'We were unable to retrieve the full text of this trial.',
      shared_decision_making_takeaway:  'Please access the original paper directly for clinical decision making.',
    },
    _provenance: {
      source:    dataSource || 'Unknown',
      timestamp: new Date().toISOString(),
    },
  };
}

// ==========================================
// HELPER: soft cap extractor output
// Pure runaway guard — Gemini 2.5 Flash has a 1M token context window
// so this only fires if an extractor response is pathologically long.
// Sentence-boundary aware to avoid cutting mid-thought.
// ==========================================
function capExtractorOutput(text, maxChars = EXTRACTOR_OUTPUT_CAP) {
  if (text.length <= maxChars) return text;
  console.warn(`[Cap] Extractor unusually long (${text.length} chars) — truncating at ${maxChars}`);
  const trimmed      = text.slice(0, maxChars);
  const lastSentence = trimmed.lastIndexOf('.');
  return lastSentence > 0 ? trimmed.slice(0, lastSentence + 1) : trimmed;
}

// ==========================================
// HELPER: build links from IDs
// ==========================================
function buildLinks(pmid, pmcid) {
  return {
    pubmed_link: pmid  ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`                  : null,
    pmc_link:    pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`        : null,
  };
}

// ==========================================
// MAIN HANDLER
// ==========================================
export default async function handler(req, res) {

  // --- SECURITY LAYER 1: CORS ---
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // --- SECURITY LAYER 2: Secret Token ---
  const authToken = req.headers['x-api-token'];
  if (!authToken || authToken !== process.env.INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorised.' });
  }

  // --- SECURITY LAYER 3: Rate Limiting ---
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? '127.0.0.1';
  const { success, remaining } = await ratelimit.limit(ip);
  if (!success) {
    return res.status(429).json({
      error:   'Daily academic compute limit reached.',
      message: 'This tool is limited to 100 analyses per IP address per day. Please try again tomorrow.'
    });
  }
  res.setHeader('X-RateLimit-Remaining', remaining);

  try {
    const { inputPayload, isPdf } = req.body;
    if (!inputPayload) return res.status(400).json({ error: 'No input provided.' });

    // -----------------------------------------------------------------------
    // INPUT ROUTING: determine source and retrieve text
    // -----------------------------------------------------------------------
    let textToAnalyze = '';
    let dataSource    = '';
    let sourceMeta    = {};   // { pmid, pmcid, doi }

    if (isPdf) {
      // Direct PDF upload — skip all tiers
      dataSource    = 'Full-Text PDF';
      textToAnalyze = await (async () => {
        const pdfBuffer = Buffer.from(inputPayload, 'base64');
        const data      = await pdfParse(pdfBuffer);
        return data.text;
      })();
      sourceMeta = {};

    } else {
      const trimmed = inputPayload.trim();

      if (trimmed.startsWith('http')) {
        // URL input — Jina fetch directly
        dataSource = `URL: ${trimmed}`;
        const res2 = await fetch(`https://r.jina.ai/${trimmed}`);
        if (!res2.ok) throw new Error('URL extraction failed.');
        textToAnalyze = await res2.text();
        sourceMeta    = {};

      } else if (trimmed.length > 150) {
        // Pasted full text — use directly
        dataSource    = 'Pasted Text';
        textToAnalyze = trimmed;
        sourceMeta    = {};

      } else {
        // PMID or keyword query — run the 4-tier source cascade
        const isPmid = /^\d{7,8}$/.test(trimmed);
        const result = await fetchTrialSource(trimmed, isPmid);

        if (!result) {
          // All tiers failed — return skeleton rather than error
          return res.status(200).json(buildSkeletonResponse(trimmed, 'All source tiers failed'));
        }

        textToAnalyze = result.text;
        dataSource    = result.sourceType;
        sourceMeta    = {
          pmid:  result.pmid  || null,
          pmcid: result.pmcid || null,
          doi:   result.doi   || null,
        };

        // Source verification
        const verification = await verifySource(textToAnalyze, trimmed);
        if (!verification.verified) {
          console.warn(`[Verify] Source mismatch warning: ${verification.warning}`);
          sourceMeta.extractionWarning = verification.warning;
        }
      }
    }

    if (!textToAnalyze) {
      return res.status(200).json(buildSkeletonResponse(inputPayload, 'No text retrieved'));
    }

    // -----------------------------------------------------------------------
    // BUILD SOURCE CONTEXT for extractors
    // -----------------------------------------------------------------------
    const links       = buildLinks(sourceMeta.pmid, sourceMeta.pmcid);
    const sourceContext = [
      `[SOURCE: ${dataSource}]`,
      sourceMeta.pmid  ? `[PMID: ${sourceMeta.pmid}]`   : '',
      sourceMeta.pmcid ? `[PMCID: ${sourceMeta.pmcid}]` : '',
      sourceMeta.doi   ? `[DOI: ${sourceMeta.doi}]`     : '',
      sourceMeta.extractionWarning ? `[WARNING: ${sourceMeta.extractionWarning}]` : '',
      '',
      textToAnalyze,
    ].filter(Boolean).join('\n');

    // -----------------------------------------------------------------------
    // NODE 1 & 2: Parallel dual extraction (temperature variance)
    // -----------------------------------------------------------------------
    const extractorA = genAI.getGenerativeModel({
      model:             'gemini-2.5-flash',
      systemInstruction: EXTRACTOR_PROMPT,
    });
    const extractorB = genAI.getGenerativeModel({
      model:             'gemini-2.5-flash',
      systemInstruction: EXTRACTOR_PROMPT,
    });

    const [resultA, resultB] = await Promise.all([
      extractorA.generateContent({
        contents:         [{ role: 'user', parts: [{ text: sourceContext }] }],
        generationConfig: { temperature: 0.1 },
      }),
      extractorB.generateContent({
        contents:         [{ role: 'user', parts: [{ text: sourceContext }] }],
        generationConfig: { temperature: 0.2 },
      }),
    ]);

    const reportA = capExtractorOutput(resultA.response.text());
    const reportB = capExtractorOutput(resultB.response.text());

    // -----------------------------------------------------------------------
    // NODE 3: Adjudication
    // -----------------------------------------------------------------------
    const adjudicator = genAI.getGenerativeModel({
      model:             'gemini-2.5-flash',
      systemInstruction: ADJUDICATOR_PROMPT,
      generationConfig:  { responseMimeType: 'application/json', temperature: 0.0 },
    });

    const adjInput = [
      `Compare these two extraction reports and generate the final unified JSON.`,
      ``,
      `Source metadata to populate in reportMeta:`,
      `  source_type:  ${dataSource}`,
      `  pubmed_id:    ${sourceMeta.pmid  || 'unknown'}`,
      `  pmc_id:       ${sourceMeta.pmcid || 'unknown'}`,
      `  doi:          ${sourceMeta.doi   || 'unknown'}`,
      `  pubmed_link:  ${links.pubmed_link || ''}`,
      `  pmc_link:     ${links.pmc_link   || ''}`,
      `  generated_at: ${new Date().toISOString()}`,
      sourceMeta.extractionWarning
        ? `  WARNING: ${sourceMeta.extractionWarning}`
        : '',
      ``,
      `REPORT A:`,
      reportA,
      ``,
      `REPORT B:`,
      reportB,
    ].filter(line => line !== undefined).join('\n');

    const finalResult = await adjudicator.generateContent(adjInput);
    const parsed      = JSON.parse(finalResult.response.text());

    // -----------------------------------------------------------------------
    // POST-PROCESS: ensure reportMeta is complete and enums are valid
    // -----------------------------------------------------------------------

    // Guarantee reportMeta fields — adjudicator may have missed some
    parsed.reportMeta = {
      ...parsed.reportMeta,
      source_type:  parsed.reportMeta?.source_type  || dataSource,
      pubmed_id:    parsed.reportMeta?.pubmed_id     || sourceMeta.pmid   || null,
      pmc_id:       parsed.reportMeta?.pmc_id        || sourceMeta.pmcid  || null,
      doi:          parsed.reportMeta?.doi            || sourceMeta.doi    || null,
      pubmed_link:  parsed.reportMeta?.pubmed_link    || links.pubmed_link || null,
      pmc_link:     parsed.reportMeta?.pmc_link       || links.pmc_link    || null,
      generated_at: parsed.reportMeta?.generated_at  || new Date().toISOString(),
    };

    if (sourceMeta.extractionWarning) {
      parsed.reportMeta.extraction_warning = sourceMeta.extractionWarning;
    }

    // Enforce enum constraints — coerce to nearest valid value if needed
    const ca = parsed.clinician_view?.critical_appraisal;
    if (ca) {
      const validGrade = ['High', 'Moderate', 'Low', 'Very Low'];
      const validRoB   = ['Low', 'Moderate', 'High', 'Unclear'];

      if (!validGrade.includes(ca.grade_certainty)) {
        ca.grade_certainty = 'Unclear' in ca.grade_certainty
          ? 'Unclear'
          : 'Very Low';    // safe default
      }
      if (!validRoB.includes(ca.risk_of_bias)) {
        ca.risk_of_bias = 'Unclear';  // safe default
      }
    }

    // Legacy _provenance field — kept for backwards compatibility with existing UI
    parsed._provenance = {
      source:    dataSource,
      timestamp: new Date().toISOString(),
    };

    return res.status(200).json(parsed);

  } catch (error) {
    console.error('Pipeline error:', error);
    if (error instanceof SyntaxError) {
      return res.status(502).json({
        error:   'AI returned malformed JSON. Please retry.',
        details: error.message,
      });
    }
    return res.status(500).json({
      error:   'Processing failed.',
      details: error.message,
    });
  }
}