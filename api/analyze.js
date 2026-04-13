// api/analyze.js
// HTTP handler for single-trial analysis.
// Source fetching lives here; the 3-node Gemini pipeline lives in lib/pipeline.js.

import { GoogleGenAI } from '@google/genai';
import pdfParse               from 'pdf-parse/lib/pdf-parse.js';
import { Ratelimit }          from '@upstash/ratelimit';
import { Redis }              from '@upstash/redis';
import { runPipeline }        from '../lib/pipeline.js';

// ==========================================
// VERCEL SERVERLESS CONFIG
// ==========================================
export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } }
};

// ==========================================
// SECURITY LAYER 3: Upstash Rate Limiter
// 100 API calls per IP per 24-hour sliding window (~20 full pipeline runs at 5 calls each)
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
const MIN_CHARS = { FULLTEXT: 2000, ABSTRACT: 200, JINA: 1000 };
const ai        = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ==========================================
// SOURCE TIER 1: PMC full text XML
// ==========================================
async function fetchFullTextPMC(pmcid, pmid) {
  if (!pmcid) return null;
  try {
    const url  = `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml  = await res.text();
    const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_CHARS.FULLTEXT) return null;
    console.log(`[Tier 1] PMC full text XML: ${text.length} chars`);
    return { text, sourceType: 'full-text-pmc', pmcid, pmid: pmid || null };
  } catch (err) {
    console.log(`[Tier 1] PMC XML failed: ${err.message}`);
    return null;
  }
}

// ==========================================
// SOURCE TIER 2: Jina scrape of PMC reader
// ==========================================
async function fetchFullTextJina(pmcid) {
  if (!pmcid) return null;
  try {
    const res  = await fetch(`https://r.jina.ai/https://europepmc.org/article/PMC/${pmcid}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text || text.includes('Access Denied') || text.length < MIN_CHARS.JINA) return null;
    console.log(`[Tier 2] Jina/PMC scrape: ${text.length} chars`);
    return { text, sourceType: 'full-text-jina', pmcid };
  } catch (err) {
    console.log(`[Tier 2] Jina scrape failed: ${err.message}`);
    return null;
  }
}

// ==========================================
// SOURCE TIER 3: Jina DOI scrape
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
// SOURCE TIER 4: Europe PMC abstract
// ==========================================
async function fetchAbstract(query, isPmid) {
  try {
    const searchQuery = isPmid ? `ext_id:${query}` : query;
    const url  = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(searchQuery)}&resultType=core&format=json`;
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
    const authorList2 = article.authorString
      ? article.authorString.split(',').map(a => a.trim()).filter(Boolean)
      : [];
    const authorsStr2 = authorList2.length === 0  ? null
      : authorList2.length <= 3 ? authorList2.join(', ')
      : authorList2.slice(0, 3).join(', ') + ' et al.';
    return {
      text:       `TITLE: ${article.title}\n\n[ABSTRACT ONLY]\n${abstract}`,
      sourceType: 'abstract-only',
      pmid:       article.pmid  || null,
      pmcid:      article.pmcid || null,
      doi:        article.doi   || null,
      authors:    authorsStr2,
    };
  } catch (err) {
    console.log(`[Tier 4] Abstract fetch failed: ${err.message}`);
    return null;
  }
}

// ==========================================
// SOURCE TIER ORCHESTRATOR
// ==========================================
async function fetchTrialSource(query, isPmid) {
  let meta = null;
  try {
    const searchQuery = isPmid ? `ext_id:${query}` : query;
    const url  = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(searchQuery)}&resultType=core&format=json`;
    const res  = await fetch(url);
    if (res.ok) {
      const data    = await res.json();
      const article = data.resultList?.result?.[0];
      if (article) {
        // Format authors — first 3 then et al.
        const authorList  = article.authorString
          ? article.authorString.split(',').map(a => a.trim()).filter(Boolean)
          : [];
        const authorsStr  = authorList.length === 0  ? null
          : authorList.length <= 3 ? authorList.join(', ')
          : authorList.slice(0, 3).join(', ') + ' et al.';
        meta = {
          pmid:    article.pmid   || null,
          pmcid:   article.pmcid  || null,
          doi:     article.doi    || null,
          authors: authorsStr,
        };
      }
    }
  } catch (err) {
    console.log(`[Meta lookup] Failed: ${err.message}`);
  }

  if (!meta) return null;

  const tier1 = await fetchFullTextPMC(meta.pmcid, meta.pmid);
  if (tier1) return { ...tier1, ...meta };

  const tier2 = await fetchFullTextJina(meta.pmcid);
  if (tier2) return { ...tier2, ...meta };

  const tier3 = await fetchFromDoi(meta.doi);
  if (tier3) return { ...tier3, ...meta };

  const tier4 = await fetchAbstract(query, isPmid);
  if (tier4) return { ...tier4, ...meta };

  return null;
}

// ==========================================
// SOURCE VERIFICATION
// ==========================================
async function verifySource(sourceText, originalQuery) {
  const sample     = sourceText.slice(0, 3000).toLowerCase();
  const keywords   = originalQuery.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
  const matchRatio = keywords.length > 0
    ? keywords.filter(w => sample.includes(w)).length / keywords.length
    : 1;

  if (matchRatio >= 0.35) {
    console.log(`[Verify] OK: ${Math.round(matchRatio * 100)}% keyword match`);
    return { verified: true };
  }

  try {
    const result = await ai.models.generateContent({
      model:    'gemini-1.5-flash-latest',
      contents: [{ role: 'user', parts: [{ text:
        `Does this document describe a clinical trial relevant to: "${originalQuery}"?\nAnswer ONLY "YES" or "NO".\nExcerpt: ${sourceText.slice(0, 1500)}`
      }] }],
      config: { temperature: 0.0, maxOutputTokens: 10 },
    });
    const answer = result.text.trim().toUpperCase();
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
// ==========================================
function buildSkeletonResponse(query, dataSource) {
  return {
    reportMeta: {
      trial_identification: query,
      study_design:         'Unknown',
      source_type:          'abstract-only',
      pubmed_id: null, pmc_id: null, doi: null,
      pubmed_link: null, pmc_link: null,
      generated_at:       new Date().toISOString(),
      extraction_warning: 'All source tiers failed — only partial or no data available.',
    },
    clinician_view: {
      context:                  { already_known: 'Source unavailable.', what_this_adds: 'Source unavailable.' },
      pico:                     { population: 'Source unavailable', intervention: 'Source unavailable', control: 'Source unavailable', primary_outcome: 'Source unavailable', secondary_outcomes: [] },
      baseline_characteristics: 'Source unavailable.',
      critical_appraisal:       { grade_certainty: 'Very Low', risk_of_bias: 'Unclear', risk_of_bias_rationale: 'Full text unavailable.', limitations: 'Full text unavailable.' },
      interactive_data:         { endpoints: [] },
    },
    patient_view: {
      lay_summary:                     'We were unable to retrieve the full text of this trial.',
      shared_decision_making_takeaway: 'Please access the original paper directly for clinical decision making.',
    },
    metadata:    { trial_identification: query, study_design: 'Unknown' },
    _provenance: { source: dataSource || 'Unknown', timestamp: new Date().toISOString() },
  };
}

// ==========================================
// MAIN HANDLER
// ==========================================
export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // Security Layer 1: token
  const authToken = req.headers['x-api-token'];
  if (!authToken || authToken !== process.env.INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorised.' });
  }

  // Security Layer 2: rate limit
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? '127.0.0.1';
  const { success, remaining } = await ratelimit.limit(ip);
  if (!success) {
    return res.status(429).json({
      error:   'Daily academic compute limit reached.',
      message: 'This tool is limited to approximately 20 full analyses per day. Please try again tomorrow.'
    });
  }
  res.setHeader('X-RateLimit-Remaining', remaining);

  try {
    const { inputPayload, isPdf } = req.body;
    if (!inputPayload) return res.status(400).json({ error: 'No input provided.' });

    // ── Input routing ─────────────────────────────────────────────────────
    let textToAnalyze = '';
    let sourceMeta    = {};

    if (isPdf) {
      const pdfBuffer = Buffer.from(inputPayload, 'base64');
      const data      = await pdfParse(pdfBuffer);
      textToAnalyze   = data.text;
      sourceMeta      = { sourceType: 'full-text-pdf' };

    } else {
      const trimmed = inputPayload.trim();

      if (trimmed.startsWith('http')) {
        const urlRes  = await fetch(`https://r.jina.ai/${trimmed}`);
        if (!urlRes.ok) throw new Error('URL extraction failed.');
        textToAnalyze = await urlRes.text();
        sourceMeta    = { sourceType: 'url' };

      } else if (trimmed.length > 150) {
        textToAnalyze = trimmed;
        sourceMeta    = { sourceType: 'pasted-text' };

      } else {
        const isPmid = /^\d{7,8}$/.test(trimmed);
        const result = await fetchTrialSource(trimmed, isPmid);

        if (!result) {
          return res.status(200).json(buildSkeletonResponse(trimmed, 'All source tiers failed'));
        }

        textToAnalyze = result.text;
        sourceMeta    = {
          sourceType: result.sourceType,
          pmid:       result.pmid  || null,
          pmcid:      result.pmcid || null,
          doi:        result.doi   || null,
        };

        const verification = await verifySource(textToAnalyze, trimmed);
        if (!verification.verified) {
          sourceMeta.extractionWarning = verification.warning;
        }
      }
    }

    if (!textToAnalyze) {
      return res.status(200).json(buildSkeletonResponse(inputPayload, 'No text retrieved'));
    }

    // ── Build source context for pipeline ────────────────────────────────
    const sourceContext = [
      `[SOURCE: ${sourceMeta.sourceType}]`,
      sourceMeta.pmid  ? `[PMID: ${sourceMeta.pmid}]`   : '',
      sourceMeta.pmcid ? `[PMCID: ${sourceMeta.pmcid}]` : '',
      sourceMeta.doi   ? `[DOI: ${sourceMeta.doi}]`     : '',
      sourceMeta.extractionWarning
        ? `[WARNING: ${sourceMeta.extractionWarning}]`
        : '',
      '',
      textToAnalyze,
    ].filter(Boolean).join('\n');

    // ── Delegate to shared pipeline ──────────────────────────────────────
    const parsed = await runPipeline(sourceContext, sourceMeta);

    return res.status(200).json(parsed);

  } catch (error) {
    console.error('Pipeline error:', error);
    if (error instanceof SyntaxError) {
      return res.status(502).json({
        error:   'AI returned malformed JSON. Please retry.',
        details: error.message,
      });
    }
    const msg = error.message || '';
    if (msg.startsWith('GEMINI_UNAVAILABLE:') ||
        msg.toLowerCase().includes('503') ||
        msg.toLowerCase().includes('service unavailable') ||
        msg.toLowerCase().includes('high demand')) {
      return res.status(503).json({
        error:   'Gemini AI service unavailable.',
        details: 'The Gemini AI service is experiencing high demand and is temporarily unavailable. This is a Google-side issue. Please wait 1–2 minutes and try again.',
      });
    }
    return res.status(500).json({ error: 'Processing failed.', details: error.message });
  }
}