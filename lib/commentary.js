// lib/commentary.js
// Node 4: Expert Context & Commentary Search
//
// Runs in parallel with Node 3 (adjudicator). Never throws — all failures
// return a graceful status object so the main pipeline is never affected.
//
// Flow:
//   Step 0  — ID mini-call (PDF inputs only): extract trial identity from reportA
//   Step 1  — PMID resolution via Europe PMC (skipped if PMID already known)
//   Step 2  — Citations fetch from Europe PMC citations API
//   Step 3  — Score, gate, filter, fetch abstracts in parallel
//   Step 4  — Synthesis call (only fires if gate passes)

import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI       = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GEMINI_MODEL = 'gemini-2.5-flash';
const EPMC_BASE    = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

// Gate constants — tune these if scoring needs adjustment
const MEANINGFUL_THRESHOLD   = 3;  // minimum score to qualify as commentary
const MIN_ITEMS_FOR_SYNTHESIS = 2;  // need at least this many qualifying items
const MAX_ITEMS_TO_FETCH      = 8;  // abstract fetch cap
const ABSTRACT_CHAR_CAP       = 1200;
const CITATIONS_PAGE_SIZE     = 100;
const NODE4_TIMEOUT_MS        = 10000;

// ─────────────────────────────────────────────
// MAIN EXPORT
// Wraps the full Node 4 flow with a hard timeout and top-level catch.
// Called from pipeline.js in parallel with the adjudicator.
// ─────────────────────────────────────────────
export async function fetchExpertContext(sourceMeta, reportA) {
  const result = await Promise.race([
    _runCommentaryFlow(sourceMeta, reportA),
    new Promise(resolve =>
      setTimeout(() => resolve({ status: 'error', reason: 'timeout' }), NODE4_TIMEOUT_MS)
    ),
  ]).catch(err => {
    console.warn('[Node 4] Uncaught error:', err.message);
    return { status: 'error', reason: err.message };
  });

  return result;
}

// ─────────────────────────────────────────────
// INTERNAL FLOW ORCHESTRATOR
// ─────────────────────────────────────────────
async function _runCommentaryFlow(sourceMeta, reportA) {

  // ── Step 0: resolve PMID ─────────────────────────────────────────────────
  let pmid        = sourceMeta.pmid  || null;
  let doi         = sourceMeta.doi   || null;
  let searchBasis = 'known_pmid';

  if (!pmid && sourceMeta.sourceType === 'full-text-pdf') {
    const identity = await _extractIdentityFromReport(reportA);
    if (!identity) {
      console.log('[Node 4] ID extraction failed — returning pmid_unresolved');
      return { status: 'pmid_unresolved' };
    }

    // If mini-call found a PMID or DOI directly in the text, use them
    if (identity.pmid) {
      pmid        = identity.pmid;
      searchBasis = 'resolved_from_pdf';
    } else if (identity.doi) {
      doi         = identity.doi;
      searchBasis = 'doi_resolved';
    } else {
      // Resolve via Europe PMC search using trial name + author + year
      pmid = await _resolvePmidFromIdentity(identity);
      if (!pmid) {
        console.log('[Node 4] PMID resolution failed — returning pmid_unresolved');
        return { status: 'pmid_unresolved' };
      }
      searchBasis = 'resolved_from_pdf';
    }
  }

  // If we have a DOI but no PMID, try to resolve PMID from DOI
  if (!pmid && doi) {
    pmid = await _resolvePmidFromDoi(doi);
    if (!pmid) {
      console.log('[Node 4] DOI resolution failed — returning pmid_unresolved');
      return { status: 'pmid_unresolved' };
    }
    searchBasis = 'doi_resolved';
  }

  if (!pmid) {
    return { status: 'pmid_unresolved' };
  }

  // ── Step 2: fetch citations ───────────────────────────────────────────────
  const { hitCount, citations } = await _fetchCitations(pmid);

  if (!citations || citations.length === 0) {
    const recencyNote = _isVeryRecent(sourceMeta);
    console.log(`[Node 4] No citations found for PMID ${pmid}`);
    return {
      status:                  'not_found',
      pmid_used:               pmid,
      search_basis:            searchBasis,
      total_citations_indexed: hitCount || 0,
      items_reviewed:          0,
      items:                   [],
      synthesis:               null,
      recency_note:            recencyNote,
    };
  }

  // ── Step 3: score, gate, fetch abstracts ─────────────────────────────────
  const scored = citations
    .map(c => ({ ...c, _score: _scoreCitation(c) }))
    .filter(c => c._score >= MEANINGFUL_THRESHOLD)
    .sort((a, b) => b._score - a._score)
    .slice(0, MAX_ITEMS_TO_FETCH);

  if (scored.length < MIN_ITEMS_FOR_SYNTHESIS) {
    const recencyNote = _isVeryRecent(sourceMeta);
    console.log(`[Node 4] Gate not passed — only ${scored.length} meaningful items (need ${MIN_ITEMS_FOR_SYNTHESIS})`);
    return {
      status:                  'not_found',
      pmid_used:               pmid,
      search_basis:            searchBasis,
      total_citations_indexed: hitCount,
      items_reviewed:          0,
      items:                   [],
      synthesis:               null,
      recency_note:            recencyNote,
    };
  }

  // Fetch abstracts for all qualifying items in parallel
  const withAbstracts = await Promise.all(
    scored.map(c => _fetchAbstract(c.id || c.pmid).then(abstract => ({ ...c, abstract })))
  );

  // ── Step 4: synthesis call ────────────────────────────────────────────────
  const synthesisResult = await _runSynthesis(withAbstracts);

  if (!synthesisResult) {
    // Synthesis Gemini call failed to parse — return items without synthesis
    return {
      status:                  'found',
      pmid_used:               pmid,
      search_basis:            searchBasis,
      total_citations_indexed: hitCount,
      items_reviewed:          withAbstracts.length,
      items:                   [],
      synthesis:               null,
      recency_note:            false,
    };
  }

  console.log(`[Node 4] Complete — ${synthesisResult.items?.length || 0} items, synthesis: ${synthesisResult.synthesis ? 'yes' : 'null'}`);

  return {
    status:                  'found',
    pmid_used:               pmid,
    search_basis:            searchBasis,
    total_citations_indexed: hitCount,
    items_reviewed:          withAbstracts.length,
    items:                   synthesisResult.items   || [],
    synthesis:               synthesisResult.synthesis || null,
    recency_note:            false,
  };
}

// ─────────────────────────────────────────────
// STEP 0: ID MINI-CALL
// Extracts trial identity from the first 2500 chars of extractor output A.
// Cheap Flash call — temp 0.0, JSON mode, 200 tokens max.
// Returns null if parse fails or all fields are null.
// ─────────────────────────────────────────────
async function _extractIdentityFromReport(reportA) {
  if (!reportA) return null;

  try {
    const model = genAI.getGenerativeModel({
      model:             GEMINI_MODEL,
      systemInstruction: 'You are a precise data extractor. Always respond with valid JSON only. No preamble, no explanation, no markdown fences.',
    });

    const prompt = `From this clinical trial extraction text, identify the trial and return ONLY this JSON — no preamble, no markdown:
{
  "trial_name": "full trial name and acronym if present, else null",
  "first_author_surname": "first author surname only, else null",
  "year": "4-digit publication year, else null",
  "pmid": "PubMed ID if explicitly stated as a number, else null",
  "doi": "DOI string if explicitly stated, else null"
}
Extract only what is explicitly stated. Do not infer or guess.

TEXT:
${reportA.slice(0, 2500)}`;

    const result = await model.generateContent({
      contents:         [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.0, maxOutputTokens: 200 },
    });

    const raw = result.response.text().replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(raw);

    // Return null if there's nothing useful to search with
    if (!parsed.trial_name && !parsed.pmid && !parsed.doi) {
      console.log('[Node 4] ID mini-call: no useful identity found');
      return null;
    }

    console.log(`[Node 4] ID mini-call: trial="${parsed.trial_name}", author="${parsed.first_author_surname}", year="${parsed.year}", pmid="${parsed.pmid}", doi="${parsed.doi}"`);
    return parsed;

  } catch (err) {
    console.warn('[Node 4] ID mini-call failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 1a: RESOLVE PMID FROM IDENTITY OBJECT
// Queries Europe PMC using trial name + first author surname + year.
// Returns pmid string or null.
// ─────────────────────────────────────────────
async function _resolvePmidFromIdentity(identity) {
  try {
    // Europe PMC REST API uses TITLE:, AUTH:, FIRST_PDATE: syntax
    // NOT PubMed [TITLE] / [AUTH] / [PDAT] field tags
    const parts = [];
    if (identity.trial_name)           parts.push(`TITLE:"${identity.trial_name}"`);
    if (identity.first_author_surname)  parts.push(`AUTH:${identity.first_author_surname}`);
    if (identity.year)                  parts.push(`FIRST_PDATE:${identity.year}`);

    if (parts.length === 0) return null;

    const query = parts.join(' AND ');
    const url   = `${EPMC_BASE}/search?query=${encodeURIComponent(query)}&resultType=core&pageSize=5&format=json`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(`Europe PMC search HTTP ${res.status}`);

    const data    = await res.json();
    const results = data.resultList?.result || [];
    if (results.length === 0) {
      // Fallback: try without year constraint in case year is off by one
      console.log('[Node 4] PMID resolution: no results with year, retrying without year...');
      return await _resolvePmidFromIdentityNoYear(identity);
    }

    // Confidence check: at least one meaningful word from the trial name
    // should appear in the result title. Use length > 2 (not > 3) to catch
    // short but meaningful acronyms like "ARM", "NOM" etc.
    const titleWords = (identity.trial_name || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'trial', 'study', 'versus'].includes(w));

    const match = results.find(r => {
      if (!r.pmid) return false;
      if (titleWords.length === 0) return true; // no meaningful words to check — trust the search
      const rTitle = (r.title || '').toLowerCase();
      return titleWords.some(w => rTitle.includes(w));
    });

    const pmid = match?.pmid || results[0]?.pmid || null;
    if (pmid) console.log(`[Node 4] PMID resolved from identity: ${pmid}`);
    return pmid;

  } catch (err) {
    console.warn('[Node 4] PMID resolution from identity failed:', err.message);
    return null;
  }
}

// Fallback: retry PMID resolution without year constraint
async function _resolvePmidFromIdentityNoYear(identity) {
  try {
    const parts = [];
    if (identity.trial_name)          parts.push(`TITLE:"${identity.trial_name}"`);
    if (identity.first_author_surname) parts.push(`AUTH:${identity.first_author_surname}`);

    if (parts.length === 0) return null;

    const query = parts.join(' AND ');
    const url   = `${EPMC_BASE}/search?query=${encodeURIComponent(query)}&resultType=core&pageSize=5&format=json`;
    const res   = await fetch(url);
    if (!res.ok) return null;

    const data    = await res.json();
    const results = data.resultList?.result || [];
    const pmid    = results[0]?.pmid || null;
    if (pmid) console.log(`[Node 4] PMID resolved (no-year fallback): ${pmid}`);
    return pmid;

  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 1b: RESOLVE PMID FROM DOI
// ─────────────────────────────────────────────
async function _resolvePmidFromDoi(doi) {
  try {
    const url = `${EPMC_BASE}/search?query=DOI:${encodeURIComponent(doi)}&resultType=core&pageSize=3&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Europe PMC DOI search HTTP ${res.status}`);

    const data  = await res.json();
    const pmid  = data.resultList?.result?.[0]?.pmid || null;
    if (pmid) console.log(`[Node 4] PMID resolved from DOI: ${pmid}`);
    return pmid;

  } catch (err) {
    console.warn('[Node 4] PMID resolution from DOI failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 2: FETCH CITATIONS
// Uses Europe PMC citations endpoint.
// Returns { hitCount, citations[] } or { hitCount: 0, citations: [] } on failure.
// ─────────────────────────────────────────────
async function _fetchCitations(pmid) {
  try {
    const url = `${EPMC_BASE}/MED/${pmid}/citations?page=1&pageSize=${CITATIONS_PAGE_SIZE}&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Europe PMC citations HTTP ${res.status}`);

    const data      = await res.json();
    const hitCount  = data.hitCount || 0;
    const citations = data.citationList?.citation || [];

    console.log(`[Node 4] Citations for PMID ${pmid}: ${hitCount} total, ${citations.length} fetched`);
    return { hitCount, citations };

  } catch (err) {
    console.warn('[Node 4] Citations fetch failed:', err.message);
    return { hitCount: 0, citations: [] };
  }
}

// ─────────────────────────────────────────────
// STEP 3a: CITATION SCORER
// Returns a numeric score 0–14. Items scoring below MEANINGFUL_THRESHOLD
// are excluded before the gate check.
// ─────────────────────────────────────────────
function _scoreCitation(citation) {
  let score = 0;
  const title = (citation.title || '').toLowerCase();

  // High-value commentary signals in title
  if (title.includes('comment')     || title.includes('commentary'))   score += 4;
  if (title.includes('editorial'))                                      score += 4;
  if (title.includes('critique')    || title.includes('critical'))     score += 4;
  if (title.includes('reanalysis')  || title.includes('re-analysis'))  score += 4;
  if (title.includes('letter'))                                         score += 3;
  if (title.includes('meta-analysis') || title.includes('systematic')) score += 3;
  if (title.includes('guideline')   || title.includes('consensus'))    score += 3;
  if (title.includes('response')    || title.includes('reply'))        score += 2;
  if (title.includes('review'))                                         score += 2;
  if (title.includes('update')      || title.includes('revisit'))      score += 2;

  // Recency bonus
  const age = new Date().getFullYear() - parseInt(citation.pubYear || '2000');
  if (age <= 2) score += 3;
  else if (age <= 5) score += 1;

  return score;
}

// ─────────────────────────────────────────────
// STEP 3b: FETCH ABSTRACT FOR A SINGLE PMID
// Returns abstract string (capped) or null.
// ─────────────────────────────────────────────
async function _fetchAbstract(pmid) {
  if (!pmid) return null;
  try {
    const url = `${EPMC_BASE}/search?query=ext_id:${pmid}&resultType=core&format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data     = await res.json();
    const article  = data.resultList?.result?.[0];
    if (!article)  return null;

    const raw = (article.abstractText || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return raw.length > 0 ? raw.slice(0, ABSTRACT_CHAR_CAP) : null;

  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 4: SYNTHESIS CALL
// Single Gemini Flash call — categorises items and writes synthesis.
// Returns parsed JSON object or null on failure.
// ─────────────────────────────────────────────
async function _runSynthesis(itemsWithAbstracts) {
  try {
    const model = genAI.getGenerativeModel({
      model:             GEMINI_MODEL,
      systemInstruction: `You are an expert clinical appraiser with deep knowledge of surgical and medical evidence.
You will be given abstracts of papers that have cited a clinical trial, and must categorise and synthesise
them to give a clinician reading the trial summary the broader evidence context they need.

Your job is NOT to summarise the trial itself — that has already been done separately.
Your job is to answer: "What has the world said about this trial since it was published,
and where does it sit in the current evidence landscape?"

Be honest. If commentators raise serious methodological concerns, say so clearly and attribute them.
If subsequent trials have confirmed or contradicted the findings, state that.
If the trial has been incorporated into guidelines, note it.
Do NOT invent positions not stated in the provided abstracts.
Do NOT speculate beyond what is evidenced.
Always respond with valid JSON only. No preamble, no explanation, no markdown fences.`,
    });

    // Build the citing papers block
    const citingPapersText = itemsWithAbstracts.map(item => [
      '---',
      `PMID: ${item.id || item.pmid || 'unknown'}`,
      `Authors: ${item.authorString || 'Unknown'}`,
      `Journal: ${item.journalAbbreviation || item.journal || 'Unknown'} (${item.pubYear || 'Unknown'})`,
      `Title: ${item.title || 'Unknown'}`,
      `Abstract: ${item.abstract || 'Not available'}`,
    ].join('\n')).join('\n\n');

    const userPrompt = `The following papers were published after, and cite, this clinical trial.
Categorise each and then write a synthesis paragraph.

CITING PAPERS:
${citingPapersText}

Return ONLY this JSON, no preamble, no markdown:
{
  "items": [
    {
      "pmid": "string",
      "authors": "Surname A, Surname B et al.",
      "journal": "string",
      "year": "string",
      "type": "critique | supporting_commentary | related_trial | meta_analysis | guideline_citation | reanalysis | other",
      "title": "string",
      "summary": "One sentence — the single most important point this paper makes about the trial"
    }
  ],
  "synthesis": "3-5 sentences or null — see rules below"
}

RULES FOR synthesis:
- Write 3-5 sentences placing this trial in the current evidence landscape.
- Cover: (1) how it has been received — contested or broadly accepted?
  (2) subsequent trials or meta-analyses that confirmed, contradicted, or superseded it;
  (3) whether it has influenced guidelines or practice;
  (4) any important methodological debates.
- Write in plain clinical English, past tense.
- Attribute specific concerns or positions to named authors from the provided abstracts.
- The synthesis must be grounded ONLY in the citing papers provided above.
  Do NOT draw on general knowledge of the trial.
  Do NOT restate what the trial itself found — that has already been done separately.
- If the citing papers do not contain enough substance to write a meaningful synthesis
  (e.g. all items are brief letters with no substantive argument, or abstracts were
  unavailable for most items), return synthesis: null rather than a vague paragraph.
- A null synthesis is correct and acceptable. A fabricated synthesis is not.`;

    const result = await model.generateContent({
      contents:         [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
    });

    const raw    = result.response.text().replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(raw);

    // Validate structure
    if (!parsed || !Array.isArray(parsed.items)) {
      console.warn('[Node 4] Synthesis returned unexpected structure');
      return null;
    }

    // Enforce valid type enum on each item
    const validTypes = new Set([
      'critique', 'supporting_commentary', 'related_trial',
      'meta_analysis', 'guideline_citation', 'reanalysis', 'other',
    ]);
    parsed.items = parsed.items.map(item => ({
      ...item,
      type: validTypes.has(item.type) ? item.type : 'other',
    }));

    // Enforce synthesis is string or null — never empty string
    if (parsed.synthesis === '' || parsed.synthesis === undefined) {
      parsed.synthesis = null;
    }

    return parsed;

  } catch (err) {
    console.warn('[Node 4] Synthesis call failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

// Returns true if trial was published within the last 12 months.
// Used to set recency_note on not_found responses.
function _isVeryRecent(sourceMeta) {
  // sourceMeta.year is not always available at this point for PDFs —
  // it gets populated by postProcess from the adjudicator output.
  // We check anyway; if not present we default to false (conservative).
  const year = parseInt(sourceMeta.year || '0');
  if (!year) return false;
  return (new Date().getFullYear() - year) < 1;
}