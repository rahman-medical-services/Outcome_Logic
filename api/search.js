// api/search.js
// v7: PubMed Entrez backend — fully hardened against esummary type inconsistencies

const NCBI_TOOL  = 'rahmanmedical-trial-visualiser';
const NCBI_EMAIL = 'saqib@rahmanmedical.co.uk';
const NCBI_BASE  = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

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
    // STAGE 1: Classify query
    // -----------------------------------------------------------------------
    const {
      clinicalQuery,
      designIntent,
      trialAcronym,
      queryMode,
      isAmbiguousAcronym
    } = classifyQuery(query);

    // -----------------------------------------------------------------------
    // STAGE 2: Gemini PICO enrichment (skipped for named_trial mode)
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
    // STAGE 3: Build PubMed query string
    // -----------------------------------------------------------------------
    const pubmed_query = buildPubmedQuery(
      clinicalQuery, enriched, finalDesign,
      trialAcronym, queryMode, isAmbiguousAcronym
    );

    // -----------------------------------------------------------------------
    // STAGE 4a: esearch — get PMIDs from PubMed
    // -----------------------------------------------------------------------
    const retmax     = queryMode === 'named_trial' ? 40 : 25;
    const esearchUrl = `${NCBI_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(pubmed_query)}&retmax=${retmax}&retmode=json&usehistory=y&tool=${encodeURIComponent(NCBI_TOOL)}&email=${encodeURIComponent(NCBI_EMAIL)}`;

    const esearchRes = await fetch(esearchUrl);
    if (!esearchRes.ok) throw new Error(`PubMed esearch failed: ${esearchRes.status}`);
    const esearchData = await esearchRes.json();

    const pmids = esearchData?.esearchresult?.idlist || [];
    if (pmids.length === 0) {
      return res.status(200).json({ results: [], query_used: pubmed_query, query_mode: queryMode });
    }

    // -----------------------------------------------------------------------
    // STAGE 4b: esummary — fetch metadata for all PMIDs in one call
    // -----------------------------------------------------------------------
    const esummaryUrl = `${NCBI_BASE}/esummary.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=json&tool=${encodeURIComponent(NCBI_TOOL)}&email=${encodeURIComponent(NCBI_EMAIL)}`;

    const esummaryRes = await fetch(esummaryUrl);
    if (!esummaryRes.ok) throw new Error(`PubMed esummary failed: ${esummaryRes.status}`);
    const esummaryData = await esummaryRes.json();

    const docs = esummaryData?.result;
    if (!docs) {
      return res.status(200).json({ results: [], query_used: pubmed_query, query_mode: queryMode });
    }

    // Build result array — skip the 'uids' metadata key and any error records
    const results = pmids
      .filter(id => docs[id] && !docs[id].error)
      .map(id => docs[id]);

    if (results.length === 0) {
      return res.status(200).json({ results: [], query_used: pubmed_query, query_mode: queryMode });
    }

    // -----------------------------------------------------------------------
    // STAGE 5: Re-rank by clinical relevance
    // -----------------------------------------------------------------------
    const queryTerms = extractTerms(clinicalQuery);
    const ranked     = rankResults(results, queryTerms, finalDesign, trialAcronym, queryMode);

    // -----------------------------------------------------------------------
    // STAGE 6: Primary paper confidence check
    // If no result in top 10 scored as a primary paper, warn the UI
    // -----------------------------------------------------------------------
    const top10        = ranked.slice(0, 10);
    const primaryFound = queryMode === 'named_trial'
      ? top10.some(r => r._score >= 60)
      : true;

    // -----------------------------------------------------------------------
    // STAGE 7: Format for UI
    // -----------------------------------------------------------------------
    const formattedResults = top10.map(doc => {
      const pmid           = doc.uid;
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
        _score:             doc._score,
      };
    });

    return res.status(200).json({
      results:             formattedResults,
      query_used:          pubmed_query,
      query_mode:          queryMode,
      primary_paper_found: primaryFound,
    });

  } catch (error) {
    console.error('Search API Error:', error);
    return res.status(500).json({ error: 'Search failed.', details: error.message });
  }
}


// =============================================================================
// STAGE 1: QUERY CLASSIFIER
// =============================================================================

// Trial acronyms that are also common English words — require clinical context
// as a hard AND constraint to avoid noise
const AMBIGUOUS_ACRONYMS = new Set([
  'CROSS', 'MAGIC', 'CHARM', 'HOPE', 'CARE', 'GRACE', 'STAR', 'IMPACT',
  'SIGNAL', 'ADVANCE', 'ACCORD', 'FIELD', 'CARDS', 'CORONA', 'MERIT',
  'SHARP', 'TOTAL', 'RAPID', 'ACTIVE', 'ARTIST', 'CAST', 'SPORT',
  'LIMIT', 'PILOT', 'PRIME', 'PROVEN', 'TARGET', 'CHEST'
]);

// Caps words that are NOT trial acronyms
const EXCLUDED_CAPS = new Set([
  'RCT','OR','AND','NOT','VS','CT','MRI','IV','UK','US','EU','ICU',
  'BMI','HR','CI','SD','IQR','DNA','RNA','PCR','HIV','HPV',
  'TNF','CRP','ECG','EEG','PET','GI','GU','UTI','DVT','PE','MI'
]);

// Design-intent words that should not be mistaken for trial names
const DESIGN_WORDS = new Set([
  'cross','crossover','randomised','randomized','controlled','pilot',
  'pragmatic','open','blind','blinded','double','single','phase'
]);

function classifyQuery(rawQuery) {
  const trimmed = rawQuery.trim();

  // Pattern A: ALL-CAPS word adjacent to "trial"
  const adjacentCapsPattern = /\b([A-Z]{3,8})\s+trial\b|\btrial\s+([A-Z]{3,8})\b/;
  const adjacentCapsMatch   = trimmed.match(adjacentCapsPattern);

  // Pattern B: standalone ALL-CAPS word (3–8 chars) not in exclusion list
  const capsPattern = /\b([A-Z]{3,8})\b/g;
  let capsMatch = null, m;
  while ((m = capsPattern.exec(trimmed)) !== null) {
    if (!EXCLUDED_CAPS.has(m[1])) { capsMatch = m[1]; break; }
  }

  // Pattern C: mixed-case word before "trial" that isn't a design word
  const beforeTrialPattern = /\b(\w{3,8})\s+trial\b/i;
  const beforeTrialMatch   = trimmed.match(beforeTrialPattern);
  const beforeTrialWord    = beforeTrialMatch?.[1];
  const isDesignWord       = beforeTrialWord && DESIGN_WORDS.has(beforeTrialWord.toLowerCase());

  let trialAcronym = null;
  if (adjacentCapsMatch)
    trialAcronym = (adjacentCapsMatch[1] || adjacentCapsMatch[2]).toUpperCase();
  else if (capsMatch)
    trialAcronym = capsMatch.toUpperCase();
  else if (beforeTrialMatch && !isDesignWord)
    trialAcronym = beforeTrialMatch[1].toUpperCase();

  const isAmbiguousAcronym = trialAcronym ? AMBIGUOUS_ACRONYMS.has(trialAcronym) : false;

  // Design intent detection (only when no named trial found)
  const designPatterns = [
    { pattern: /\b(crossover|cross[\s-]over)\b/gi,                                       design: 'crossover'        },
    { pattern: /\b(rct|randomis[e]?d[\s-]controlled|randomiz[e]?d[\s-]controlled)\b/gi,  design: 'rct'              },
    { pattern: /\b(randomis[e]?d|randomiz[e]?d)\b/gi,                                    design: 'rct'              },
    { pattern: /\b(systematic[\s-]review)\b/gi,                                           design: 'systematic_review'},
    { pattern: /\b(meta[\s-]analysis)\b/gi,                                               design: 'meta_analysis'    },
    { pattern: /\b(cohort)\b/gi,                                                          design: 'cohort'           },
    { pattern: /\b(observational)\b/gi,                                                   design: 'observational'    },
    { pattern: /\b(trial|trials)\b/gi,                                                    design: 'trial'            },
  ];

  let designIntent     = null;
  let cleanedForDesign = trimmed;

  if (!trialAcronym) {
    for (const { pattern, design } of designPatterns) {
      if (pattern.test(trimmed)) {
        designIntent     = design;
        cleanedForDesign = trimmed.replace(pattern, '').replace(/\s{2,}/g, ' ').trim();
        break;
      }
    }
  }

  // Strip acronym + the word "trial" from clinical query
  let clinicalQuery = trimmed;
  if (trialAcronym) {
    const acronymRe   = new RegExp(`\\b${trialAcronym}\\b`, 'gi');
    const trialWordRe = /\btrial\b/gi;
    clinicalQuery = trimmed
      .replace(acronymRe, '')
      .replace(trialWordRe, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  } else {
    clinicalQuery = cleanedForDesign;
  }

  let queryMode = 'pico';
  if (trialAcronym)      queryMode = 'named_trial';
  else if (designIntent) queryMode = 'design_intent';

  return { clinicalQuery, designIntent, trialAcronym, queryMode, isAmbiguousAcronym };
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
  const raw        = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Empty Gemini response');

  const cleaned = raw.replace(/```json|```/gi, '').trim();
  const parsed  = JSON.parse(cleaned);
  const hasContent = parsed.condition || parsed.intervention || parsed.outcome;
  return hasContent ? parsed : null;
}


// =============================================================================
// STAGE 3: PUBMED QUERY BUILDER
// PubMed field tags: [ti] title, [tiab] title+abstract, [mh] MeSH, [pt] pub type
// =============================================================================
function buildPubmedQuery(clinicalQuery, enriched, finalDesign, trialAcronym, queryMode, isAmbiguousAcronym) {

  if (queryMode === 'named_trial') {
    if (!isAmbiguousAcronym) {
      // Unambiguous acronym: title anchor is precise enough
      const parts = [`${trialAcronym}[ti]`];
      if (clinicalQuery) parts.push(`${clinicalQuery}[tiab]`);
      return parts.join(' AND ');
    } else {
      // Ambiguous acronym: require clinical context as hard AND
      if (!clinicalQuery) return `${trialAcronym}[ti]`;
      return `${trialAcronym}[ti] AND ${clinicalQuery}[tiab]`;
    }
  }

  // PICO / design_intent mode
  const parts = [];
  if (enriched) {
    if (enriched.condition)
      parts.push(`(${enriched.condition}[ti] OR ${enriched.condition}[mh])`);
    if (enriched.intervention)
      parts.push(`(${enriched.intervention}[ti] OR ${enriched.intervention}[mh])`);
    if (enriched.outcome)
      parts.push(`${enriched.outcome}[tiab]`);
  }
  if (parts.length === 0) parts.push(`${clinicalQuery}[tiab]`);

  return `(${parts.join(' AND ')}) AND ${buildDesignFilter(finalDesign)}`;
}

function buildDesignFilter(design) {
  switch (design) {
    case 'crossover':
      return `("crossover study"[pt] OR "randomized controlled trial"[pt] OR "cross-over"[ti] OR "crossover"[ti])`;
    case 'rct':
      return `("randomized controlled trial"[pt] OR "controlled clinical trial"[pt])`;
    case 'systematic_review':
      return `("systematic review"[pt] OR "meta-analysis"[pt])`;
    case 'meta_analysis':
      return `("meta-analysis"[pt] OR "systematic review"[pt])`;
    case 'cohort':
      return `("clinical trial"[pt] OR "observational study"[pt])`;
    case 'observational':
      return `("observational study"[pt] OR "cohort"[tiab])`;
    default:
      return `("randomized controlled trial"[pt] OR "clinical trial"[pt] OR "controlled clinical trial"[pt])`;
  }
}


// =============================================================================
// STAGE 5: RE-RANKER
// =============================================================================
const SECONDARY_MARKERS = [
  'secondary analysis', 'secondary analyses', 'post-hoc', 'post hoc',
  'subgroup analysis', 'subgroup analyses', 'sub-group', 'exploratory analysis',
  'ancillary study', 'ancillary analysis', 'secondary outcome'
];

const PROTOCOL_MARKERS = [
  'protocol', 'study design', 'study protocol', 'rationale and design',
  'design and rationale', 'methods and design'
];

const NOISE_MARKERS = [
  'cross-sectional', 'cross sectional', 'cross-cultural',
  'cross cultural', 'cross-national'
];

function rankResults(results, queryTerms, designIntent, trialAcronym, queryMode) {
  return results
    .map(doc => {
      let score        = 0;
      const titleLower = (doc.title || '').toLowerCase();
      const pubTypes   = getPubTypes(doc);

      if (queryMode === 'named_trial' && trialAcronym) {
        const acronymLower    = trialAcronym.toLowerCase();
        const titleHasAcronym = titleLower.includes(acronymLower);
        const isSecondary     = SECONDARY_MARKERS.some(m => titleLower.includes(m));
        const isProtocol      = PROTOCOL_MARKERS.some(m => titleLower.includes(m));
        const isNoise         = NOISE_MARKERS.some(m => titleLower.includes(m));

        if (isNoise) {
          score = -50;
        } else if (titleHasAcronym) {
          if (isProtocol)       score += 55;
          else if (isSecondary) score += 30;
          else                  score += 60;
        } else {
          score += 10;
        }

        // Recency tiebreaker within tiers
        const age = new Date().getFullYear() - (parseInt(extractYear(doc)) || 2000);
        score += Math.max(0, 10 - age);

      } else {
        // PICO / design_intent scoring

        // 1. Study design (max 40 pts)
        if (pubTypes.some(t => t.includes('randomized controlled trial')))    score += 40;
        else if (pubTypes.some(t => t.includes('controlled clinical trial'))) score += 35;
        else if (pubTypes.some(t => t.includes('clinical trial')))            score += 30;
        else if (pubTypes.some(t => t.includes('systematic review')))         score += 35;
        else if (pubTypes.some(t => t.includes('meta-analysis')))             score += 35;
        else if (pubTypes.some(t => t.includes('cohort')))                    score += 15;
        else if (pubTypes.some(t => t.includes('observational')))             score += 10;

        // 1a. Crossover title bonus
        if (designIntent === 'crossover' &&
            (titleLower.includes('crossover') || titleLower.includes('cross-over'))) {
          score += 20;
        }

        // 2. Open access — PMC ID present (max 15 pts)
        if (doc.pmcid) score += 15;

        // 3. Recency — linear decay over 10 years (max 20 pts)
        const age = new Date().getFullYear() - (parseInt(extractYear(doc)) || 2000);
        score += Math.max(0, 20 - age * 2);

        // 4. Query term overlap in title (max 25 pts)
        if (queryTerms.length > 0) {
          const matchCount = queryTerms.filter(t => titleLower.includes(t)).length;
          score += Math.min(25, Math.round((matchCount / queryTerms.length) * 25));
        }
      }

      return { ...doc, _score: score };
    })
    .sort((a, b) => b._score - a._score);
}


// =============================================================================
// HELPERS
// All array fields are normalised with toArray() to defend against PubMed
// esummary's habit of collapsing single-element arrays into bare objects.
// =============================================================================

// Safe coercion — always returns an array regardless of input type
function toArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

// Journal: esummary provides fulljournalname and source as flat strings — no path ambiguity
function resolveJournal(doc) {
  return doc.fulljournalname || doc.source || 'Unknown Journal';
}

// Authors: doc.authors can be array or single object
function formatAuthors(doc) {
  const authors = toArray(doc.authors);
  if (authors.length === 0) return 'Unknown Authors';
  const named   = authors.filter(a => a && a.authtype === 'Author').map(a => a.name);
  const display = named.length > 0 ? named : authors.map(a => a.name).filter(Boolean);
  if (display.length === 0) return 'Unknown Authors';
  if (display.length <= 3)  return display.join(', ');
  return display.slice(0, 3).join(', ') + ' et al.';
}

// Year: pubdate is a string like "2023 Jan 15" or "2023"
function extractYear(doc) {
  const raw   = doc.pubdate || doc.epubdate || '';
  const match = raw.match(/\b(\d{4})\b/);
  return match ? match[1] : null;
}

// DOI: elocationid can be array, single object, or string
function extractDoi(doc) {
  const locations = toArray(doc.elocationid);
  const doiEntry  = locations.find(e => e && typeof e === 'object' && e.eidtype === 'doi');
  return doiEntry ? doiEntry.value : null;
}

// Pub types: doc.pubtype can be array or single string
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

// Title: PubMed sometimes appends a trailing period
function cleanTitle(title) {
  return (title || 'Untitled').replace(/\.$/, '').trim();
}

// Terms for title overlap scoring — strips clinical stopwords
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