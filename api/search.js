// api/search.js
// v4: named trial detection + primary paper boosting + secondary analysis demotion

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

  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing search query.' });

    // -----------------------------------------------------------------------
    // STAGE 1: Classify query type
    // Three modes:
    //   'named_trial' — query contains a trial acronym (CODA, CROSS, APPAC…)
    //   'design_intent' — query contains design words (crossover, RCT, cohort…)
    //   'pico' — plain clinical free text
    // -----------------------------------------------------------------------
    const { clinicalQuery, designIntent, trialAcronym, queryMode } = classifyQuery(query);

    // -----------------------------------------------------------------------
    // STAGE 2: Gemini PICO enrichment (skipped for pure named_trial queries
    // where the acronym alone is sufficient to anchor the search)
    // -----------------------------------------------------------------------
    let enriched = null;
    if (queryMode !== 'named_trial') {
      try {
        enriched = await enrichQueryWithGemini(clinicalQuery);
      } catch (e) {
        console.warn('Gemini enrichment failed, using fallback:', e.message);
      }
    }

    const finalDesign = designIntent || enriched?.study_design || null;

    // -----------------------------------------------------------------------
    // STAGE 3: Build Europe PMC query
    // Named trial mode: anchor on TITLE:"ACRONYM" + clinical context terms
    // PICO mode: boolean field-tagged query as before
    // -----------------------------------------------------------------------
    const epmc_query = buildEpmcQuery(clinicalQuery, enriched, finalDesign, trialAcronym, queryMode);

    // -----------------------------------------------------------------------
    // STAGE 4: Fetch from Europe PMC (pool of 25)
    // -----------------------------------------------------------------------
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(epmc_query)}&resultType=core&format=json&pageSize=25`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to contact Europe PMC.');
    const data = await response.json();

    if (!data.resultList?.result?.length) {
      return res.status(200).json({ results: [], query_used: epmc_query });
    }

    // -----------------------------------------------------------------------
    // STAGE 5: Re-rank
    // -----------------------------------------------------------------------
    const queryTerms = extractTerms(clinicalQuery);
    const ranked = rankResults(data.resultList.result, queryTerms, finalDesign, trialAcronym, queryMode);

    const formattedResults = ranked.slice(0, 10).map(trial => {
      const hasFreeFullText = trial.pmcid || trial.isOpenAccess === 'Y';
      return {
        id:                 trial.pmid || trial.id,
        title:              trial.title,
        authors:            formatAuthors(trial),
        journal:            resolveJournal(trial),
        year:               trial.pubYear,
        abstract:           trial.abstractText || null,
        doi:                trial.doi || null,
        pmcid:              trial.pmcid || null,
        pub_type:           normalisePubType(trial),
        has_free_full_text: !!hasFreeFullText,
        _score:             trial._score,
        // TEMP DEBUG — remove once journal field is confirmed working
        _journal_raw: {
          journalTitle:          trial.journalTitle,
          journalInfo_title:     trial.journalInfo?.journal?.title,
          journalInfo_iso:       trial.journalInfo?.journal?.isoabbreviation,
          journalInfo_full:      JSON.stringify(trial.journalInfo)?.slice(0, 200)
        }
      };
    });

    return res.status(200).json({ results: formattedResults, query_used: epmc_query, query_mode: queryMode });

  } catch (error) {
    console.error('Search API Error:', error);
    return res.status(500).json({ error: 'Search failed.', details: error.message });
  }
}


// =============================================================================
// STAGE 1: QUERY CLASSIFIER
//
// Returns:
//   trialAcronym  — the detected acronym string, e.g. "CODA", "CROSS" (or null)
//   designIntent  — detected design word, e.g. "crossover" (or null)
//   clinicalQuery — query with acronym/design words stripped
//   queryMode     — 'named_trial' | 'design_intent' | 'pico'
//
// Detection heuristics (in priority order):
//   1. A word of 2–8 uppercase letters adjacent to "trial" in the query
//   2. A standalone word of 3–8 uppercase letters (likely an acronym)
//   3. A word immediately preceding "trial" regardless of case
// =============================================================================
function classifyQuery(rawQuery) {
  const trimmed = rawQuery.trim();

  // --- Named trial detection ---
  // Pattern A: "ACRONYM trial" or "trial ACRONYM" (case-insensitive for "trial")
  const adjacentPattern = /\b([A-Z]{2,8})\s+trial\b|\btrial\s+([A-Z]{2,8})\b/i;
  const adjacentMatch = trimmed.match(adjacentPattern);

  // Pattern B: standalone all-caps word (2–8 chars) — e.g. bare "CODA" or "CROSS"
  // Exclude common non-acronym caps words
  const EXCLUDED_CAPS = new Set(['RCT', 'OR', 'AND', 'NOT', 'VS', 'CT', 'MRI', 'IV', 'UK', 'US', 'EU']);
  const capsPattern = /\b([A-Z]{2,8})\b/g;
  let capsMatch = null;
  let m;
  while ((m = capsPattern.exec(trimmed)) !== null) {
    if (!EXCLUDED_CAPS.has(m[1])) {
      capsMatch = m[1];
      break;
    }
  }

  // Pattern C: word immediately before "trial" (mixed case) — e.g. "coda trial"
  const beforeTrialPattern = /\b(\w{2,8})\s+trial\b/i;
  const beforeTrialMatch = trimmed.match(beforeTrialPattern);
  // Only use Pattern C if it looks like a proper noun (not a design word)
  const DESIGN_WORDS = new Set(['cross','crossover','randomised','randomized','controlled','pilot','pragmatic','open','blind']);
  const beforeTrialWord = beforeTrialMatch?.[1];
  const isDesignWord = beforeTrialWord && DESIGN_WORDS.has(beforeTrialWord.toLowerCase());

  let trialAcronym = null;
  if (adjacentMatch) {
    trialAcronym = (adjacentMatch[1] || adjacentMatch[2]).toUpperCase();
  } else if (capsMatch) {
    trialAcronym = capsMatch.toUpperCase();
  } else if (beforeTrialMatch && !isDesignWord) {
    trialAcronym = beforeTrialMatch[1].toUpperCase();
  }

  // --- Design intent detection (only if no named trial found) ---
  const designPatterns = [
    { pattern: /\b(crossover|cross[\s-]over|cross[\s-]trial|cross trial)\b/gi, design: 'crossover' },
    { pattern: /\b(rct|randomis[e]?d[\s-]controlled|randomiz[e]?d[\s-]controlled)\b/gi, design: 'rct' },
    { pattern: /\b(randomis[e]?d|randomiz[e]?d)\b/gi, design: 'rct' },
    { pattern: /\b(systematic[\s-]review)\b/gi, design: 'systematic_review' },
    { pattern: /\b(meta[\s-]analysis)\b/gi, design: 'meta_analysis' },
    { pattern: /\b(cohort)\b/gi, design: 'cohort' },
    { pattern: /\b(observational)\b/gi, design: 'observational' },
    { pattern: /\b(trial|trials)\b/gi, design: 'trial' },
  ];

  let designIntent = null;
  let cleanedForDesign = trimmed;
  if (!trialAcronym) {
    for (const { pattern, design } of designPatterns) {
      if (pattern.test(trimmed)) {
        designIntent = design;
        cleanedForDesign = trimmed.replace(pattern, '').replace(/\s{2,}/g, ' ').trim();
        break;
      }
    }
  }

  // Strip the trial acronym and the word "trial" from clinical query
  let clinicalQuery = trimmed;
  if (trialAcronym) {
    // Remove the acronym (case-insensitive) and standalone "trial"
    const acronymRe = new RegExp(`\\b${trialAcronym}\\b`, 'gi');
    const trialWordRe = /\btrial\b/gi;
    clinicalQuery = trimmed
      .replace(acronymRe, '')
      .replace(trialWordRe, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  } else {
    clinicalQuery = cleanedForDesign;
  }

  // Determine mode
  let queryMode = 'pico';
  if (trialAcronym) queryMode = 'named_trial';
  else if (designIntent) queryMode = 'design_intent';

  return { clinicalQuery, designIntent, trialAcronym, queryMode };
}


// =============================================================================
// STAGE 2: GEMINI PICO ENRICHMENT
// =============================================================================
async function enrichQueryWithGemini(userQuery) {
  const prompt = `You are a clinical research assistant. Extract PICO components from the search query below.

Return ONLY valid JSON — no markdown, no backticks, no explanation.

Schema:
{
  "condition": "primary disease or condition (string or null)",
  "intervention": "treatment, drug, or procedure (string or null)",
  "comparator": "control or comparison arm if mentioned (string or null)",
  "outcome": "primary outcome if mentioned (string or null)",
  "study_design": "rct | crossover | cohort | systematic_review | meta_analysis | other | null"
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

  const cleaned = raw.replace(/```json|```/gi, '').trim();
  const parsed = JSON.parse(cleaned);
  const hasContent = parsed.condition || parsed.intervention || parsed.outcome;
  return hasContent ? parsed : null;
}


// =============================================================================
// STAGE 3: BOOLEAN QUERY BUILDER
// =============================================================================
function buildEpmcQuery(clinicalQuery, enriched, finalDesign, trialAcronym, queryMode) {

  // Named trial mode: anchor hard on the trial name in the title
  // Include clinical context terms if present (improves precision)
  if (queryMode === 'named_trial') {
    const parts = [`TITLE:"${trialAcronym}"`];
    if (clinicalQuery) {
      // Add clinical context loosely — don't restrict too hard
      parts.push(`(TITLE:"${clinicalQuery}" OR ABSTRACT:"${clinicalQuery}")`);
    }
    // No pub type filter for named trials — we want all paper types
    // (protocol, primary, secondary) and will handle ranking ourselves
    return parts.join(' AND ');
  }

  // PICO / design_intent mode
  const parts = [];
  if (enriched) {
    if (enriched.condition)    parts.push(`(TITLE:"${enriched.condition}" OR ABSTRACT:"${enriched.condition}" OR MeSH:"${enriched.condition}")`);
    if (enriched.intervention) parts.push(`(TITLE:"${enriched.intervention}" OR ABSTRACT:"${enriched.intervention}" OR MeSH:"${enriched.intervention}")`);
    if (enriched.outcome)      parts.push(`(ABSTRACT:"${enriched.outcome}")`);
  }
  if (parts.length === 0) parts.push(`(${clinicalQuery})`);

  return `${parts.join(' AND ')} AND ${buildDesignFilter(finalDesign)}`;
}

function buildDesignFilter(design) {
  switch (design) {
    case 'crossover':
      return `(PUB_TYPE:"randomized controlled trial" OR PUB_TYPE:"controlled clinical trial" OR PUB_TYPE:"crossover study" OR TITLE:"crossover" OR TITLE:"cross-over")`;
    case 'rct':
      return `(PUB_TYPE:"randomized controlled trial" OR PUB_TYPE:"controlled clinical trial")`;
    case 'systematic_review':
      return `(PUB_TYPE:"systematic review" OR PUB_TYPE:"meta-analysis")`;
    case 'meta_analysis':
      return `(PUB_TYPE:"meta-analysis" OR PUB_TYPE:"systematic review")`;
    case 'cohort':
      return `(PUB_TYPE:"clinical trial" OR PUB_TYPE:"cohort study" OR PUB_TYPE:"observational study")`;
    case 'observational':
      return `(PUB_TYPE:"observational study" OR PUB_TYPE:"cohort study")`;
    default:
      return `(PUB_TYPE:"randomized controlled trial" OR PUB_TYPE:"clinical trial" OR PUB_TYPE:"controlled clinical trial")`;
  }
}


// =============================================================================
// STAGE 5: RE-RANKER
//
// Named trial scoring hierarchy:
//   Primary paper    = acronym in title + NOT secondary/subgroup/post-hoc  → +60
//   Protocol paper   = acronym in title + "protocol" in title               → +55
//   Secondary paper  = acronym in title + secondary/subgroup/post-hoc       → +30
//   Citing paper     = acronym in abstract only                             → +10
//
// PICO scoring as before (study design + open access + recency + term overlap)
// =============================================================================

// Phrases that mark a paper as a secondary/subgroup/post-hoc analysis
const SECONDARY_MARKERS = [
  'secondary analysis', 'secondary analyses', 'post-hoc', 'post hoc',
  'subgroup analysis', 'subgroup analyses', 'sub-group', 'exploratory analysis',
  'ancillary study', 'ancillary analysis'
];

// Phrases that mark a paper as a protocol
const PROTOCOL_MARKERS = [
  'protocol', 'study design', 'study protocol', 'rationale and design',
  'design and rationale', 'methods and design'
];

function rankResults(results, queryTerms, designIntent, trialAcronym, queryMode) {
  return results
    .map(trial => {
      let score = 0;
      const titleLower  = (trial.title || '').toLowerCase();
      const pubTypes    = getPubTypes(trial);

      if (queryMode === 'named_trial' && trialAcronym) {
        const acronymLower   = trialAcronym.toLowerCase();
        const titleHasAcronym = titleLower.includes(acronymLower);
        const isSecondary    = SECONDARY_MARKERS.some(m => titleLower.includes(m));
        const isProtocol     = PROTOCOL_MARKERS.some(m => titleLower.includes(m));

        if (titleHasAcronym) {
          if (isProtocol)        score += 55;  // protocol paper
          else if (isSecondary)  score += 30;  // secondary analysis — still relevant but demoted
          else                   score += 60;  // primary outcomes paper — top
        } else {
          score += 10;  // only mentions trial in abstract / elsewhere
        }

        // Small recency tiebreaker within same tier
        const currentYear = new Date().getFullYear();
        const age = currentYear - (parseInt(trial.pubYear) || 2000);
        score += Math.max(0, 10 - age);

      } else {
        // PICO / design_intent scoring

        // 1. Study design (max 40 pts)
        if (pubTypes.some(t => t.includes('randomized controlled trial')))   score += 40;
        else if (pubTypes.some(t => t.includes('controlled clinical trial'))) score += 35;
        else if (pubTypes.some(t => t.includes('clinical trial')))            score += 30;
        else if (pubTypes.some(t => t.includes('systematic review')))         score += 35;
        else if (pubTypes.some(t => t.includes('meta-analysis')))             score += 35;
        else if (pubTypes.some(t => t.includes('cohort')))                    score += 15;
        else if (pubTypes.some(t => t.includes('observational')))             score += 10;

        // 1a. Crossover bonus
        if (designIntent === 'crossover' &&
            (titleLower.includes('crossover') || titleLower.includes('cross-over'))) {
          score += 20;
        }

        // 2. Open access (max 15 pts)
        if (trial.pmcid || trial.isOpenAccess === 'Y') score += 15;

        // 3. Recency — linear decay over 10 years (max 20 pts)
        const currentYear = new Date().getFullYear();
        const age = currentYear - (parseInt(trial.pubYear) || 2000);
        score += Math.max(0, 20 - age * 2);

        // 4. Query term overlap in title (max 25 pts)
        if (queryTerms.length > 0) {
          const matchCount = queryTerms.filter(t => titleLower.includes(t)).length;
          score += Math.min(25, Math.round((matchCount / queryTerms.length) * 25));
        }
      }

      return { ...trial, _score: score };
    })
    .sort((a, b) => b._score - a._score);
}


// =============================================================================
// HELPERS
// =============================================================================

// Europe PMC 'core' resultType: journal is under journalInfo.journal.title
// journalTitle is only populated on the 'lite' resultType
// _journal_raw is included temporarily to debug which field is actually populated
function resolveJournal(trial) {
  return (
    trial.journalInfo?.journal?.title         ||
    trial.journalInfo?.journal?.isoabbreviation ||
    trial.journalTitle                         ||
    'Unknown Journal'
  );
}

function formatAuthors(trial) {
  if (!trial.authorString) return 'Unknown Authors';
  const authors = trial.authorString.split(',').map(a => a.trim()).filter(Boolean);
  if (authors.length <= 3) return authors.join(', ');
  return authors.slice(0, 3).join(', ') + ' et al.';
}

function extractTerms(query) {
  const stopwords = new Set([
    'a','an','the','and','or','of','in','for','with','on','at','to','is',
    'are','was','were','be','been','by','from','as','that','this','it',
    'trial','trials','study','studies','effect','effects','outcome','outcomes',
    'patients','patient','treatment','cross','vs','versus'
  ]);
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !stopwords.has(t));
}

function getPubTypes(trial) {
  const pt = trial.pubTypeList?.pubType;
  if (!pt) return [];
  return (Array.isArray(pt) ? pt : [pt]).map(t => t.toLowerCase());
}

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