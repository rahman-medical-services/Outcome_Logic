// api/search.js
// v8: LLM-native architecture
//   Call 1 — Gemini constructs optimal PubMed query from user input
//   PubMed  — esearch + esummary fetches 25 results
//   Call 2 — Gemini re-ranks results by clinical relevance
// Rate limit: 50 searches per IP per 24h (each search = 2 Gemini calls)

import { Ratelimit } from '@upstash/ratelimit';
import { Redis }     from '@upstash/redis';

const NCBI_TOOL  = 'rahmanmedical-trial-visualiser';
const NCBI_EMAIL = 'saqib@rahmanmedical.co.uk';
const NCBI_BASE  = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const GEMINI_MODEL = 'gemini-2.5-flash-lite';  // lightweight model for query construction + re-ranking
const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';

const ratelimit = new Ratelimit({
  redis:     Redis.fromEnv(),
  limiter:   Ratelimit.slidingWindow(50, '24 h'),
  analytics: true,
  prefix:    'search',
});

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const authToken = req.headers['x-api-token'];
  if (!authToken || authToken !== process.env.INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorised.' });
  }

  // Rate limit by IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? '127.0.0.1';
  const { success } = await ratelimit.limit(ip);
  if (!success) {
    return res.status(429).json({ error: 'Search rate limit reached. Please try again later.' });
  }

  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing search query.' });

    // -----------------------------------------------------------------------
    // GEMINI CALL 1: Construct optimal PubMed query
    // -----------------------------------------------------------------------
    const { pubmedQuery, queryIntent } = await buildPubmedQueryWithGemini(query);

    // -----------------------------------------------------------------------
    // PUBMED: esearch — get PMIDs
    // -----------------------------------------------------------------------
    const esearchUrl = `${NCBI_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(pubmedQuery)}&retmax=25&retmode=json&usehistory=y&tool=${encodeURIComponent(NCBI_TOOL)}&email=${encodeURIComponent(NCBI_EMAIL)}`;
    const esearchRes = await fetch(esearchUrl);
    if (!esearchRes.ok) throw new Error(`PubMed esearch failed: ${esearchRes.status}`);
    const esearchData = await esearchRes.json();

    const pmids = esearchData?.esearchresult?.idlist || [];
    if (pmids.length === 0) {
      return res.status(200).json({
        results:    [],
        query_used: pubmedQuery,
        intent:     queryIntent,
      });
    }

    // -----------------------------------------------------------------------
    // PUBMED: esummary — fetch metadata for all PMIDs
    // -----------------------------------------------------------------------
    const esummaryUrl = `${NCBI_BASE}/esummary.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=json&tool=${encodeURIComponent(NCBI_TOOL)}&email=${encodeURIComponent(NCBI_EMAIL)}`;
    const esummaryRes = await fetch(esummaryUrl);
    if (!esummaryRes.ok) throw new Error(`PubMed esummary failed: ${esummaryRes.status}`);
    const esummaryData = await esummaryRes.json();

    const docs = esummaryData?.result;
    if (!docs) {
      return res.status(200).json({ results: [], query_used: pubmedQuery });
    }

    // Build result array — skip the 'uids' key and any error records
    const results = pmids
      .filter(id => docs[id] && !docs[id].error)
      .map(id => ({ ...docs[id], _pmid: id }));

    if (results.length === 0) {
      return res.status(200).json({ results: [], query_used: pubmedQuery });
    }

    // -----------------------------------------------------------------------
    // GEMINI CALL 2: Re-rank results by clinical relevance
    // -----------------------------------------------------------------------
    const rankedPmids = await rerankWithGemini(query, queryIntent, results);

    // Build final ordered list using Gemini's ranking
    // Fall back to original PubMed order for any PMIDs Gemini didn't return
    const rankedResults = [];
    const seen = new Set();

    for (const pmid of rankedPmids) {
      const doc = results.find(r => r._pmid === pmid || r.uid === pmid);
      if (doc && !seen.has(pmid)) {
        rankedResults.push(doc);
        seen.add(pmid);
      }
    }
    // Append any results Gemini omitted (safety net)
    for (const doc of results) {
      const id = doc._pmid || doc.uid;
      if (!seen.has(id)) rankedResults.push(doc);
    }

    // -----------------------------------------------------------------------
    // Format top 10 for UI
    // -----------------------------------------------------------------------
    const formattedResults = rankedResults.slice(0, 10).map(doc => {
      const pmid           = doc._pmid || doc.uid;
      const hasFreeFullText = !!doc.pmcid;
      return {
        id:                 pmid,
        title:              cleanTitle(doc.title),
        authors:            formatAuthors(doc),
        journal:            resolveJournal(doc),
        year:               extractYear(doc),
        doi:                extractDoi(doc),
        pmcid:              doc.pmcid || null,
        pubmed_url:         `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        pmc_url:            doc.pmcid
                              ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${doc.pmcid}/`
                              : null,
        pub_type:           normalisePubType(doc),
        has_free_full_text: hasFreeFullText,
      };
    });

    return res.status(200).json({
      results:    formattedResults,
      query_used: pubmedQuery,
      intent:     queryIntent,
    });

  } catch (error) {
    console.error('Search API Error:', error);
    return res.status(500).json({ error: 'Search failed.', details: error.message });
  }
}


// =============================================================================
// GEMINI CALL 1: PUBMED QUERY CONSTRUCTION
//
// Gemini returns:
//   pubmedQuery — a valid PubMed search string using field tags [ti][tiab][mh][pt]
//   queryIntent — one of: named_trial | pico | design_intent
//                 (used to guide the re-ranking prompt)
// =============================================================================
async function buildPubmedQueryWithGemini(userQuery) {

  const prompt = `You are an expert clinical librarian who constructs PubMed search queries.

Given the user's search input, return a single optimal PubMed query string and classify the search intent.

Rules for the PubMed query:
- Use PubMed field tags: [ti] for title, [tiab] for title/abstract, [mh] for MeSH headings, [pt] for publication type
- If the query contains a named clinical trial (e.g. CODA, CROSS, APPAC, FLOT, MAGIC), anchor the search on that trial name in the title: TRIALNAME[ti]
- If the query is about a clinical condition and intervention (PICO), use MeSH terms and title tags with appropriate publication type filters
- If the query specifies a study design (crossover, RCT, cohort, systematic review), apply the correct [pt] filter
- Keep the query precise enough to find relevant papers but not so narrow it misses the primary trial paper
- Do not include explanations, only return valid JSON

Return ONLY this JSON structure, no markdown, no backticks:
{
  "pubmedQuery": "the complete PubMed query string",
  "queryIntent": "named_trial | pico | design_intent",
  "trialName": "the trial acronym if detected, otherwise null"
}

User input: "${userQuery}"`;

  const data = await callGemini(prompt, 512);

  // Parse JSON response
  const text    = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const cleaned = text.replace(/```json|```/gi, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Gemini response wasn't clean JSON — fall back to simple query
    console.warn('Gemini query construction failed to parse, using fallback');
    return {
      pubmedQuery: `${userQuery}[tiab] AND ("randomized controlled trial"[pt] OR "clinical trial"[pt])`,
      queryIntent: 'pico',
    };
  }

  if (!parsed.pubmedQuery) {
    return {
      pubmedQuery: `${userQuery}[tiab] AND ("randomized controlled trial"[pt] OR "clinical trial"[pt])`,
      queryIntent: 'pico',
    };
  }

  return {
    pubmedQuery: parsed.pubmedQuery,
    queryIntent: parsed.queryIntent || 'pico',
    trialName:   parsed.trialName   || null,
  };
}


// =============================================================================
// GEMINI CALL 2: RESULTS RE-RANKING
//
// Sends all 25 result summaries to Gemini and asks it to return the PMIDs
// in order of clinical relevance for the original query.
//
// Gemini understands:
//   - Primary trial papers vs secondary analyses vs protocols
//   - Study design hierarchy (RCT > cohort > cross-sectional)
//   - Named trial paper types without needing regex
// =============================================================================
async function rerankWithGemini(originalQuery, queryIntent, results) {

  // Build a compact summary of each result for Gemini to reason over
  // Keep it token-efficient: PMID, title, journal, year, pub types only
  const resultSummaries = results.map(doc => ({
    pmid:      doc._pmid || doc.uid,
    title:     cleanTitle(doc.title),
    journal:   resolveJournal(doc),
    year:      extractYear(doc),
    pub_types: toArray(doc.pubtype).join(', '),
  }));

  const intentGuidance = {
    named_trial:   'The user is searching for a specific named clinical trial. Rank the PRIMARY outcomes paper first, then the protocol paper, then secondary analyses and subgroup analyses, then other citing papers. Demote cross-sectional studies, editorials, and papers that merely mention the trial name in passing.',
    pico:          'The user is searching for evidence on a clinical question. Rank by study design quality: systematic reviews and meta-analyses first, then RCTs, then cohort studies. Within each design tier, rank by recency.',
    design_intent: 'The user has specified a study design. Prioritise papers matching that design. Within that tier, rank by clinical relevance to the condition/intervention and recency.',
  };

  const guidance = intentGuidance[queryIntent] || intentGuidance.pico;

  const prompt = `You are an expert clinical research librarian ranking PubMed search results.

Original search query: "${originalQuery}"
Search intent: ${queryIntent}

Ranking guidance: ${guidance}

Here are the search results to rank:
${JSON.stringify(resultSummaries, null, 2)}

Return ONLY a JSON array of PMIDs in your preferred order, most relevant first.
No markdown, no explanation, no backticks. Example: ["12345678", "87654321", "11223344"]`;

  const data = await callGemini(prompt, 512);

  const text    = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const cleaned = text.replace(/```json|```/gi, '').trim();

  try {
    const ranked = JSON.parse(cleaned);
    if (Array.isArray(ranked)) return ranked.map(String);
  } catch {
    console.warn('Gemini re-ranking failed to parse, using PubMed original order');
  }

  // Fallback: return original PubMed order
  return results.map(r => String(r._pmid || r.uid));
}


// =============================================================================
// SHARED GEMINI CALLER
// =============================================================================
async function callGemini(prompt, maxTokens = 512) {
  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const geminiRes = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents:         [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: maxTokens },
    }),
  });

  if (!geminiRes.ok) throw new Error(`Gemini API error: ${geminiRes.status}`);
  return geminiRes.json();
}


// =============================================================================
// HELPERS — all array fields go through toArray() to defend against PubMed
// esummary collapsing single-element arrays into bare objects
// =============================================================================

function toArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function cleanTitle(title) {
  return (title || 'Untitled').replace(/\.$/, '').trim();
}

function resolveJournal(doc) {
  return doc.fulljournalname || doc.source || 'Unknown Journal';
}

function formatAuthors(doc) {
  const authors = toArray(doc.authors);
  if (authors.length === 0) return 'Unknown Authors';
  const named   = authors.filter(a => a && a.authtype === 'Author').map(a => a.name);
  const display = named.length > 0 ? named : authors.map(a => a.name).filter(Boolean);
  if (display.length === 0)  return 'Unknown Authors';
  if (display.length <= 3)   return display.join(', ');
  return display.slice(0, 3).join(', ') + ' et al.';
}

function extractYear(doc) {
  const raw   = doc.pubdate || doc.epubdate || '';
  const match = raw.match(/\b(\d{4})\b/);
  return match ? match[1] : null;
}

function extractDoi(doc) {
  const locations = toArray(doc.elocationid);
  const doiEntry  = locations.find(e => e && typeof e === 'object' && e.eidtype === 'doi');
  return doiEntry ? doiEntry.value : null;
}

function getPubTypes(doc) {
  return toArray(doc.pubtype).map(t => String(t).toLowerCase());
}

function normalisePubType(doc) {
  const types = getPubTypes(doc);
  if (types.some(t => t.includes('randomized controlled trial'))) return 'RCT';
  if (types.some(t => t.includes('controlled clinical trial')))   return 'CCT';
  if (types.some(t => t.includes('clinical trial')))              return 'Clinical Trial';
  if (types.some(t => t.includes('meta-analysis')))               return 'Meta-analysis';
  if (types.some(t => t.includes('systematic review')))           return 'Systematic Review';
  if (types.some(t => t.includes('cohort')))                      return 'Cohort Study';
  if (types.some(t => t.includes('observational')))               return 'Observational';
  return 'Publication';
}