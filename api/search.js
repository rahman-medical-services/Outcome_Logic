// api/search.js
// v6: PubMed Entrez backend (esearch + esummary) — better named trial resolution

// NCBI courtesy parameters — required by terms of use (no API key needed at this usage level)
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
    const { clinicalQuery, designIntent, trialAcronym, queryMode, isAmbiguousAcronym } = classifyQuery(query);

    // -----------------------------------------------------------------------
    // STAGE 2: Gemini PICO enrichment (skipped for named_trial mode)
    // -----------------------------------------------------------------------
    let enriched = null;
    if (queryMode !== 'named_trial') {
      try {
        enriched = await enrichQueryWithGemini(clinicalQuery);
      } catch (e) {
        console.warn('Gemini enrichment failed:', e.message);
      }
    }

    const finalDesign = designIntent || enriched?.study_design || null;

    // -----------------------------------------------------------------------
    // STAGE 3: Build PubMed query string
    // PubMed supports field tags: [ti] [tiab] [mh] [pt] [tw]
    // -----------------------------------------------------------------------
    const pubmed_query = buildPubmedQuery(clinicalQuery, enriched, finalDesign, trialAcronym, queryMode, isAmbiguousAcronym);

    // -----------------------------------------------------------------------
    // STAGE 4a: esearch — get ranked PMIDs from PubMed
    // usehistory=y caches results server-side; retmax=40 for named trials
    // -----------------------------------------------------------------------
    const retmax   = queryMode === 'named_trial' ? 40 : 25;
    const esearchUrl = `${NCBI_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(pubmed_query)}&retmax=${retmax}&retmode=json&usehistory=y&tool=${NCBI_TOOL}&email=${NCBI_EMAIL}`;

    const esearchRes = await fetch(esearchUrl);
    if (!esearchRes.ok) throw new Error('PubMed esearch failed.');
    const esearchData = await esearchRes.json();

    const pmids = esearchData?.esearchresult?.idlist || [];
    if (pmids.length === 0) {
      return res.status(200).json({ results: [], query_used: pubmed_query });
    }

    // -----------------------------------------------------------------------
    // STAGE 4b: esummary — fetch metadata for all PMIDs in one call
    // esummary returns a clean JSON document summary (title, authors, journal,
    // pub date, pub types, DOI, PMC ID) without needing to parse XML
    // -----------------------------------------------------------------------
    const esummaryUrl = `${NCBI_BASE}/esummary.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=json&tool=${NCBI_TOOL}&email=${NCBI_EMAIL}`;

    const esummaryRes = await fetch(esummaryUrl);
    if (!esummaryRes.ok) throw new Error('PubMed esummary failed.');
    const esummaryData = await esummaryRes.json();

    const docs = esummaryData?.result;
    if (!docs) return res.status(200).json({ results: [], query_used: pubmed_query });

    // Build result array from the summary docs (skip the 'uids' key)
    const results = pmids
      .filter(id => docs[id] && !docs[id].error)
      .map(id => docs[id]);

    if (results.length === 0) {
      return res.status(200).json({ results: [], query_used: pubmed_query });
    }

    // -----------------------------------------------------------------------
    // STAGE 5: Re-rank
    // -----------------------------------------------------------------------
    const queryTerms = extractTerms(clinicalQuery);
    const ranked     = rankResults(results, queryTerms, finalDesign, trialAcronym, queryMode);

    // -----------------------------------------------------------------------
    // STAGE 6: Primary paper confidence check
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
      const hasFreeFullText = !!doc.pmcid;  // PMC ID present = free full text

      return {
        id:                 pmid,
        title:              doc.title?.replace(/\.$/, '') || 'Untitled',
        authors:            formatAuthors(doc),
        journal:            doc.fulljournalname || doc.source || 'Unknown Journal',
        year:               extractYear(doc),
        abstract:           null,   // esummary doesn't include abstract; fetch separately if needed
        doi:                extractDoi(doc),
        pmcid:              doc.pmcid || null,
        pubmed_url:         `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        pmc_url:            doc.pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${doc.pmcid}/` : null,
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
// STAGE 1: QUERY CLASSIFIER (unchanged from v5)
// =============================================================================
const AMBIGUOUS_ACRONYMS = new Set([
  'CROSS', 'MAGIC', 'CHARM', 'HOPE', 'CARE', 'GRACE', 'STAR', 'IMPACT',
  'SIGNAL', 'ADVANCE', 'ACCORD', 'FIELD', 'CARDS', 'CORONA', 'MERIT',
  'SHARP', 'TOTAL', 'RAPID', 'ACTIVE', 'ARTIST', 'CAST', 'SPORT',
  'LIMIT', 'PILOT', 'PRIME', 'PROVEN', 'TARGET', 'CHEST'
]);

const EXCLUDED_CAPS = new Set([
  'RCT','OR','AND','NOT','VS','CT','MRI','IV','UK','US','EU','ICU',
  'BMI','HR','CI','SD','IQR','DNA','RNA','PCR','HIV','HPV',
  'TNF','CRP','ECG','EEG','PET','GI','GU','UTI','DVT','PE','MI'
]);

const DESIGN_WORDS = new Set([
  'cross','crossover','randomised','randomized','controlled','pilot',
  'pragmatic','open','blind','blinded','double','single','phase'
]);

function classifyQuery(rawQuery) {
  const trimmed = rawQuery.trim();

  const adjacentCapsPattern = /\b([A-Z]{3,8})\s+trial\b|\btrial\s+([A-Z]{3,8})\b/;
  const adjacentCapsMatch   = trimmed.match(adjacentCapsPattern);

  const capsPattern = /\b([A-Z]{3,8})\b/g;
  let capsMatch = null, m;
  while ((m = capsPattern.exec(trimmed)) !== null) {
    if (!EXCLUDED_CAPS.has(m[1])) { capsMatch = m[1]; break; }
  }

  const beforeTrialPattern = /\b(\w{3,8})\s+trial\b/i;
  const beforeTrialMatch   = trimmed.match(beforeTrialPattern);
  const beforeTrialWord    = beforeTrialMatch?.[1];
  const isDesignWord       = beforeTrialWord && DESIGN_WORDS.has(beforeTrialWord.toLowerCase());

  let trialAcronym = null;
  if (adjacentCapsMatch)                          trialAcronym = (adjacentCapsMatch[1] || adjacentCapsMatch[2]).toUpperCase();
  else if (capsMatch)                             trialAcronym = capsMatch.toUpperCase();
  else if (beforeTrialMatch && !isDesignWord)     trialAcronym = beforeTrialMatch[1].toUpperCase();

  const isAmbiguousAcronym = trialAcronym ? AMBIGUOUS_ACRONYMS.has(trialAcronym) : false;

  const designPatterns = [
    { pattern: /\b(crossover|cross[\s-]over)\b/gi,                                      design: 'crossover' },
    { pattern: /\b(rct|randomis[e]?d[\s-]controlled|randomiz[e]?d[\s-]controlled)\b/gi, design: 'rct' },
    { pattern: /\b(randomis[e]?d|randomiz[e]?d)\b/gi,                                   design: 'rct' },
    { pattern: /\b(systematic[\s-]review)\b/gi,                                          design: 'systematic_review' },
    { pattern: /\b(meta[\s-]analysis)\b/gi,                                              design: 'meta_analysis' },
    { pattern: /\b(cohort)\b/gi,                                                         design: 'cohort' },
    { pattern: /\b(observational)\b/gi,                                                  design: 'observational' },
    { pattern: /\b(trial|trials)\b/gi,                                                   design: 'trial' },
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

  let clinicalQuery = trimmed;
  if (trialAcronym) {
    const acronymRe   = new RegExp(`\\b${trialAcronym}\\b`, 'gi');
    const trialWordRe = /\btrial\b/gi;
    clinicalQuery = trimmed.replace(acronymRe, '').replace(trialWordRe, '').replace(/\s{2,}/g, ' ').trim();
  } else {
    clinicalQuery = cleanedForDesign;
  }

  let queryMode = 'pico';
  if (trialAcronym)      queryMode = 'named_trial';
  else if (designIntent) queryMode = 'design_intent';

  return { clinicalQuery, designIntent, trialAcronym, queryMode, isAmbiguousAcronym };
}


// =============================================================================
// STAGE 2: GEMINI PICO ENRICHMENT (unchanged from v5)
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
  const parsed  = JSON.parse(cleaned);
  const hasContent = parsed.condition || parsed.intervention || parsed.outcome;
  return hasContent ? parsed : null;
}


// =============================================================================
// STAGE 3: PUBMED QUERY BUILDER
// PubMed field tags:
//   [ti]   = title only
//   [tiab] = title or abstract
//   [mh]   = MeSH heading
//   [pt]   = publication type
//   [tw]   = text word (anywhere)
// =============================================================================
function buildPubmedQuery(clinicalQuery, enriched, finalDesign, trialAcronym, queryMode, isAmbiguousAcronym) {

  if (queryMode === 'named_trial') {
    if (!isAmbiguousAcronym) {
      // Unambiguous: title anchor alone is precise
      const parts = [`${trialAcronym}[ti]`];
      if (clinicalQuery) parts.push(`${clinicalQuery}[tiab]`);
      return parts.join(' AND ');
    } else {
      // Ambiguous: require clinical context as hard AND
      if (!clinicalQuery) return `${trialAcronym}[ti]`;
      return `${trialAcronym}[ti] AND ${clinicalQuery}[tiab]`;
    }
  }

  // PICO / design_intent mode
  const parts = [];

  if (enriched) {
    if (enriched.condition)    parts.push(`(${enriched.condition}[ti] OR ${enriched.condition}[mh])`);
    if (enriched.intervention) parts.push(`(${enriched.intervention}[ti] OR ${enriched.intervention}[mh])`);
    if (enriched.outcome)      parts.push(`${enriched.outcome}[tiab]`);
  }

  if (parts.length === 0) parts.push(`${clinicalQuery}[tiab]`);

  const designFilter = buildDesignFilter(finalDesign);
  return `(${parts.join(' AND ')}) AND ${designFilter}`;
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
// STAGE 5: RE-RANKER (adapted for PubMed esummary doc structure)
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
  'cross-sectional', 'cross sectional', 'cross-cultural', 'cross cultural',
  'cross-national'
];

function rankResults(results, queryTerms, designIntent, trialAcronym, queryMode) {
  return results
    .map(doc => {
      let score    = 0;
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
// HELPERS — PubMed esummary doc field mapping
// =============================================================================

// esummary authors: array of { name, authtype, clusterid }
function formatAuthors(doc) {
  const authors = doc.authors || [];
  if (authors.length === 0) return 'Unknown Authors';
  const names = authors.filter(a => a.authtype === 'Author').map(a => a.name);
  if (names.length === 0) return authors.slice(0, 3).map(a => a.name).join(', ');
  if (names.length <= 3) return names.join(', ');
  return names.slice(0, 3).join(', ') + ' et al.';
}

// esummary pub date is in doc.pubdate ("2023 Jan 15") or doc.epubdate
function extractYear(doc) {
  const raw = doc.pubdate || doc.epubdate || '';
  const match = raw.match(/\b(\d{4})\b/);
  return match ? match[1] : null;
}

// esummary DOI is in doc.elocationid array: [{ eidtype: "doi", value: "10.xxx" }]
function extractDoi(doc) {
  if (!doc.elocationid) return null;
  const doiEntry = doc.elocationid.find(e => e.eidtype === 'doi');
  return doiEntry ? doiEntry.value : null;
}

// esummary pub types: doc.pubtype array of strings
function getPubTypes(doc) {
  if (!doc.pubtype) return [];
  return doc.pubtype.map(t => t.toLowerCase());
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