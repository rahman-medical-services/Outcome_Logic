// api/search.js
// Upgraded: Gemini query enrichment → boolean Europe PMC query → post-fetch re-ranking

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

  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing search query.' });

    // -----------------------------------------------------------------------
    // STAGE 1: Gemini query enrichment
    // Extract structured PICO components from free text, with fallback
    // -----------------------------------------------------------------------
    let enriched = null;
    try {
      enriched = await enrichQueryWithGemini(query);
    } catch (geminiError) {
      console.warn('Gemini enrichment failed, using fallback query:', geminiError.message);
    }

    // -----------------------------------------------------------------------
    // STAGE 2: Build Europe PMC boolean query
    // -----------------------------------------------------------------------
    const epmc_query = buildEpmcQuery(query, enriched);

    // -----------------------------------------------------------------------
    // STAGE 3: Fetch from Europe PMC (top 25 for re-ranking pool)
    // -----------------------------------------------------------------------
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(epmc_query)}&resultType=core&format=json&pageSize=25`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to contact Europe PMC.');
    const data = await response.json();

    if (!data.resultList?.result?.length) {
      return res.status(200).json({ results: [], query_used: epmc_query });
    }

    // -----------------------------------------------------------------------
    // STAGE 4: Re-rank results by clinical relevance
    // -----------------------------------------------------------------------
    const queryTerms = extractTerms(query);
    const ranked = rankResults(data.resultList.result, queryTerms);

    // Return top 10 after re-ranking
    const formattedResults = ranked.slice(0, 10).map(trial => {
      const hasFreeFullText = trial.pmcid || trial.isOpenAccess === 'Y';
      return {
        id:                 trial.pmid || trial.id,
        title:              trial.title,
        authors:            trial.authorString
                              ? trial.authorString.split(',').slice(0, 3).join(', ') + ' et al.'
                              : 'Unknown Authors',
        journal:            trial.journalTitle || 'Unknown Journal',
        year:               trial.pubYear,
        abstract:           trial.abstractText || null,
        doi:                trial.doi || null,
        pmcid:              trial.pmcid || null,
        pub_type:           normalisePubType(trial),
        has_free_full_text: !!hasFreeFullText,
        _score:             trial._score   // useful for debug; strip if not needed in UI
      };
    });

    return res.status(200).json({ results: formattedResults, query_used: epmc_query });

  } catch (error) {
    console.error('Search API Error:', error);
    return res.status(500).json({ error: 'Search failed.', details: error.message });
  }
}


// =============================================================================
// GEMINI ENRICHMENT
// Extracts PICO components from free text. Returns null on any failure so the
// fallback path always fires cleanly.
// =============================================================================
async function enrichQueryWithGemini(userQuery) {
  const prompt = `You are a clinical research assistant. Extract structured PICO components from the following search query.

Return ONLY valid JSON — no markdown, no explanation, no backticks.

Schema:
{
  "condition": "primary disease or condition (string or null)",
  "intervention": "treatment, drug, or procedure being studied (string or null)",
  "comparator": "control or comparison arm if mentioned (string or null)",
  "outcome": "primary outcome if mentioned (string or null)",
  "study_design": "rct | cohort | systematic_review | meta_analysis | other | null"
}

Query: "${userQuery}"`;

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 256 }
      })
    }
  );

  if (!geminiRes.ok) throw new Error(`Gemini API error: ${geminiRes.status}`);
  const geminiData = await geminiRes.json();

  const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Empty Gemini response');

  // Strip any accidental markdown fences before parsing
  const cleaned = raw.replace(/```json|```/gi, '').trim();
  const parsed = JSON.parse(cleaned);

  // Return null if Gemini found nothing useful
  const hasContent = parsed.condition || parsed.intervention || parsed.outcome;
  return hasContent ? parsed : null;
}


// =============================================================================
// BOOLEAN QUERY BUILDER
// Constructs the Europe PMC query string from enriched PICO + fallback
// =============================================================================
function buildEpmcQuery(rawQuery, enriched) {

  // --- Fallback: raw query + trial type filter ---
  if (!enriched) {
    return `(${rawQuery}) AND (PUB_TYPE:"randomized controlled trial" OR PUB_TYPE:"clinical trial" OR PUB_TYPE:"controlled clinical trial")`;
  }

  const parts = [];

  // Condition clause
  if (enriched.condition) {
    parts.push(`(TITLE:"${enriched.condition}" OR ABSTRACT:"${enriched.condition}" OR MeSH:"${enriched.condition}")`);
  }

  // Intervention clause
  if (enriched.intervention) {
    parts.push(`(TITLE:"${enriched.intervention}" OR ABSTRACT:"${enriched.intervention}" OR MeSH:"${enriched.intervention}")`);
  }

  // Outcome clause (softer — ABSTRACT only to avoid over-restriction)
  if (enriched.outcome) {
    parts.push(`(ABSTRACT:"${enriched.outcome}")`);
  }

  // If Gemini extracted nothing useful, fall back to raw terms
  if (parts.length === 0) {
    parts.push(`(${rawQuery})`);
  }

  // Study design filter
  // If user explicitly wants a review, honour that; otherwise bias toward trials
  const designFilter = buildDesignFilter(enriched.study_design);

  return `${parts.join(' AND ')} AND ${designFilter}`;
}

function buildDesignFilter(study_design) {
  switch (study_design) {
    case 'systematic_review':
    case 'meta_analysis':
      return `(PUB_TYPE:"systematic review" OR PUB_TYPE:"meta-analysis")`;
    case 'cohort':
      return `(PUB_TYPE:"clinical trial" OR PUB_TYPE:"cohort study" OR PUB_TYPE:"observational study")`;
    case 'rct':
      return `(PUB_TYPE:"randomized controlled trial" OR PUB_TYPE:"controlled clinical trial")`;
    default:
      // Broad trial filter — catches RCTs, CCTs, and clinical trials
      return `(PUB_TYPE:"randomized controlled trial" OR PUB_TYPE:"clinical trial" OR PUB_TYPE:"controlled clinical trial")`;
  }
}


// =============================================================================
// POST-FETCH RE-RANKING
// Scores each result on a 100-point rubric then sorts descending
// =============================================================================
function rankResults(results, queryTerms) {
  return results
    .map(trial => {
      let score = 0;

      // 1. Study design (max 40 pts) — RCTs and systematic reviews rank highest
      const pubTypes = getPubTypes(trial);
      if (pubTypes.some(t => t.includes('randomized controlled trial'))) score += 40;
      else if (pubTypes.some(t => t.includes('controlled clinical trial'))) score += 35;
      else if (pubTypes.some(t => t.includes('clinical trial')))            score += 30;
      else if (pubTypes.some(t => t.includes('systematic review')))         score += 35;
      else if (pubTypes.some(t => t.includes('meta-analysis')))             score += 35;
      else if (pubTypes.some(t => t.includes('cohort')))                    score += 15;
      else if (pubTypes.some(t => t.includes('observational')))             score += 10;

      // 2. Open access / full text availability (max 15 pts)
      if (trial.pmcid || trial.isOpenAccess === 'Y') score += 15;

      // 3. Recency (max 20 pts) — linear decay over 10 years
      const currentYear = new Date().getFullYear();
      const age = currentYear - (parseInt(trial.pubYear) || 2000);
      score += Math.max(0, 20 - age * 2);

      // 4. Query term overlap in title (max 25 pts)
      if (trial.title && queryTerms.length > 0) {
        const titleLower = trial.title.toLowerCase();
        const matchCount = queryTerms.filter(t => titleLower.includes(t)).length;
        score += Math.min(25, Math.round((matchCount / queryTerms.length) * 25));
      }

      return { ...trial, _score: score };
    })
    .sort((a, b) => b._score - a._score);
}


// =============================================================================
// HELPERS
// =============================================================================

// Extract meaningful terms from the raw query (strip stopwords)
function extractTerms(query) {
  const stopwords = new Set([
    'a','an','the','and','or','of','in','for','with','on','at','to','is',
    'are','was','were','be','been','by','from','as','that','this','it',
    'trial','study','effect','effects','outcome','outcomes','patients','patient'
  ]);
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !stopwords.has(t));
}

// Safely extract pub type strings from a result object
function getPubTypes(trial) {
  if (!trial.pubTypeList?.pubType) return [];
  const pt = trial.pubTypeList.pubType;
  return Array.isArray(pt) ? pt.map(t => t.toLowerCase()) : [pt.toLowerCase()];
}

// Return a clean human-readable study design label for the UI
function normalisePubType(trial) {
  const types = getPubTypes(trial);
  if (types.some(t => t.includes('randomized controlled trial'))) return 'RCT';
  if (types.some(t => t.includes('controlled clinical trial')))   return 'CCT';
  if (types.some(t => t.includes('clinical trial')))              return 'Clinical Trial';
  if (types.some(t => t.includes('meta-analysis')))               return 'Meta-analysis';
  if (types.some(t => t.includes('systematic review')))           return 'Systematic Review';
  if (types.some(t => t.includes('cohort')))                      return 'Cohort Study';
  if (types.some(t => t.includes('observational')))               return 'Observational';
  return 'Publication';
}