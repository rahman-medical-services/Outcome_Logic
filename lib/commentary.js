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
const MEANINGFUL_THRESHOLD        = 3;  // minimum score for citation items
const MEANINGFUL_THRESHOLD_NAMED  = 1;  // lower threshold for name-search items (inherently relevant)
const MIN_ITEMS_FOR_SYNTHESIS = 2;  // need at least this many qualifying items
const MAX_ITEMS_TO_FETCH      = 15; // abstract fetch cap — increased to capture more commentary
const ABSTRACT_CHAR_CAP       = 1200;
const CITATIONS_PAGE_SIZE     = 100;
const NODE4_TIMEOUT_MS        = 45000;

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

  if (!pmid && !doi && sourceMeta.sourceType === 'full-text-pdf') {
    // Try to extract PMID or DOI directly from the extractor output.
    // We ONLY accept a concrete identifier — PMID or DOI.
    // Name-based search is explicitly disabled: it is too unreliable and
    // risks returning a completely unrelated trial, which is worse than
    // returning nothing at all.
    const identity = _extractIdentityFromReport(reportA);
    if (identity?.pmid) {
      pmid        = identity.pmid;
      searchBasis = 'resolved_from_pdf';
      console.log(`[Node 4] Using PMID from report text: ${pmid}`);
    } else if (identity?.doi) {
      doi         = identity.doi;
      searchBasis = 'doi_resolved';
      console.log(`[Node 4] Using DOI from report text: ${doi}`);
    } else {
      // No concrete identifier found — fail cleanly rather than guess
      console.log('[Node 4] No PMID or DOI found in report — returning pmid_unresolved');
      return { status: 'pmid_unresolved' };
    }
  }

  // If we have a DOI but no PMID, resolve PMID from DOI
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

  // ── Step 2: fetch citations AND supplementary name search in parallel ────────
  // Citations: papers that formally cite this trial (good for established papers)
  // Name search: papers that mention the trial by name (catches concurrent
  //   editorials, invited commentaries, and letters published in same issue
  //   which never formally cite the paper they respond to)
  const trialName = _extractTrialName(sourceMeta, reportA);

  const [{ hitCount, citations }, nameResults, pubmedResults] = await Promise.all([
    _fetchCitations(pmid),
    trialName ? _searchByTrialName(trialName, pmid) : Promise.resolve([]),
    trialName ? _searchPubMed(trialName, pmid)      : Promise.resolve([]),
  ]);

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

  // Merge name search and PubMed results — deduplicate by PMID
  const seenPmids = new Set(citations.map(c => c.id || c.pmid));
  const merged = [...citations];

  for (const r of [...nameResults, ...pubmedResults]) {
    const id = r.id || r.pmid;
    if (id && !seenPmids.has(String(id))) {
      merged.push({ ...r, _from_name_search: true });
      seenPmids.add(String(id));
    }
  }

  if (nameResults.length > 0 || pubmedResults.length > 0) {
    console.log(`[Node 4] Supplementary search added ${merged.length - citations.length} new items (Europe PMC name: ${nameResults.length}, PubMed: ${pubmedResults.length})`);
  }

  // ── Step 3: score, gate, fetch abstracts ─────────────────────────────────
  const scored = merged
    .map(c => ({ ...c, _score: _scoreCitation(c) }))
    .filter(c => c._from_name_search
      ? c._score >= MEANINGFUL_THRESHOLD_NAMED   // name-search items: lower bar, already relevant
      : c._score >= MEANINGFUL_THRESHOLD          // citation items: normal threshold
    )
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
  const synthesisResult = await _runSynthesis(withAbstracts)
    || await _runSynthesis(withAbstracts);  // single retry on transient failure

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
// STEP 0: ID EXTRACTION FROM EXTRACTOR OUTPUT
// Parses trial identity directly from reportA using regex.
// No Gemini call — the extractor output has predictable structure.
// Returns null if nothing useful found.
// ─────────────────────────────────────────────
function _extractIdentityFromReport(reportA) {
  if (!reportA) return null;

  try {
    const text = reportA.slice(0, 4000);

    // ── PMID — look for explicit "PMID:" or "PubMed ID:" patterns ──────────
    const pmidMatch = text.match(/(?:PMID|PubMed\s*ID)\s*[:\-]?\s*(\d{7,8})/i);
    const pmid      = pmidMatch?.[1] || null;

    // ── DOI — look for doi.org or 10.XXXX patterns ─────────────────────────
    const doiMatch = text.match(/(?:DOI|doi)\s*[:\-]?\s*(10\.\d{4,}\/\S+)/i)
                  || text.match(/https?:\/\/doi\.org\/(10\.\d{4,}\/\S+)/i);
    const doi      = doiMatch?.[1]?.replace(/[,\.]+$/, '') || null;

    // ── Trial name — match bullet-format extractor output ──────────────────
    // Extractor writes bullets like:
    //   - Full trial name and acronym: HALT-IT (...)
    //   - Full trial name: HALT-IT
    // Also catches inline "HALT-IT trial" patterns in the text
    let trial_name = null;
    const FALSE_POSITIVES = new Set([
      'NOT', 'NULL', 'NONE', 'UNKNOWN', 'TRIAL', 'STUDY', 'GROUP',
      'RESULTS', 'METHODS', 'PATIENTS', 'DESIGN', 'ABSTRACT', 'PURPOSE',
      'BACKGROUND', 'CONCLUSION', 'INTRODUCTION', 'DISCUSSION', 'TABLE',
      'FIGURE', 'APPENDIX', 'FUNDING', 'AUTHORS', 'ETHICS', 'DATA',
    ]);

    const namePatterns = [
      /[-–]\s*(?:full\s+trial\s+name(?:\s+and\s+acronym)?|trial\s+name(?:\s+and\s+acronym)?)\s*[:\-]\s*([^\n]{3,80})/i,
      /(?:trial\s+name|acronym)\s*[:\-]\s*([^\n]{3,60})/i,
      /\b([A-Z][A-Z0-9\-]{2,15}(?:-[A-Z0-9]+)?)\b(?=\s+trial|\s+Trial)/,  // "HALT-IT trial" not just "TRIAL"
    ];
    for (const re of namePatterns) {
      const m = text.match(re);
      const candidate = m?.[1]?.trim().replace(/\.$/, '');
      if (candidate && !FALSE_POSITIVES.has(candidate.toUpperCase())) {
        trial_name = candidate;
        break;
      }
    }

    // ── First author surname ────────────────────────────────────────────────
    // Extractor writes: "- Authors: Surname INITIALS, Surname INITIALS et al."
    let first_author_surname = null;
    const authorMatch = text.match(/[-–]\s*Authors?\s*[:\-]\s*([A-Z][a-züöäßé\-']{1,30})/i)
                     || text.match(/Authors?\s*[:\-]\s*([A-Z][a-züöäßé\-']{1,30})/i);
    if (authorMatch?.[1]) first_author_surname = authorMatch[1].trim();

    // ── Year ────────────────────────────────────────────────────────────────
    // Look for "Year: YYYY", "published: YYYY", or any 20XX near journal context
    let year = null;
    const yearMatch = text.match(/[-–]\s*(?:year|published|publication\s*year)\s*[:\-]?\s*(\b20[0-2]\d\b)/i)
                   || text.match(/(?:year|published|publication)\s*[:\-]?\s*(\b20[0-2]\d\b)/i)
                   || text.match(/\b(20[0-2]\d)\b/);
    if (yearMatch?.[1]) year = yearMatch[1];

    // Strip literal "null" strings the extractor sometimes writes
    const clean = v => (v === 'null' || v === 'Not reported' || v === 'N/A') ? null : v;

    const cleanPmid = clean(pmid);
    const cleanDoi  = clean(doi);
    const cleanName = clean(trial_name);
    const cleanAuth = clean(first_author_surname);
    const cleanYear = clean(year);

    // Return null if nothing useful
    if (!cleanName && !cleanPmid && !cleanDoi) {
      console.log('[Node 4] ID extraction: nothing found in reportA');
      return null;
    }

    console.log(`[Node 4] ID extraction: trial="${cleanName}", author="${cleanAuth}", year="${cleanYear}", pmid="${cleanPmid}", doi="${cleanDoi}"`);
    return { trial_name: cleanName, first_author_surname: cleanAuth, year: cleanYear, pmid: cleanPmid, doi: cleanDoi };

  } catch (err) {
    console.warn('[Node 4] ID extraction failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 1b: RESOLVE PMID FROM DOI
// ─────────────────────────────────────────────
async function _resolvePmidFromDoi(doi) {
  try {
    // Try direct DOI query first
    const url = `${EPMC_BASE}/search?query=DOI:"${encodeURIComponent(doi)}"&resultType=core&pageSize=3&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Europe PMC DOI search HTTP ${res.status}`);

    const data = await res.json();
    let pmid   = data.resultList?.result?.[0]?.pmid || null;

    // Fallback: strip parenthetical version suffix common in Lancet DOIs
    // e.g. S1470-2045(25)00027-0 → try without the (25) part
    if (!pmid && doi.includes('(')) {
      const stripped = doi.replace(/\(\d{2}\)/g, '');
      const url2     = `${EPMC_BASE}/search?query=DOI:"${encodeURIComponent(stripped)}"&resultType=core&pageSize=3&format=json`;
      const res2     = await fetch(url2);
      if (res2.ok) {
        const data2 = await res2.json();
        pmid = data2.resultList?.result?.[0]?.pmid || null;
      }
    }

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
// STEP 2b: EXTRACT TRIAL NAME FOR NAME SEARCH
// Gets the trial acronym/name from sourceMeta or reportA.
// Used to find concurrent editorials that don't formally cite the paper.
// ─────────────────────────────────────────────
function _extractTrialName(sourceMeta, reportA) {
  // Try the identity extraction — we only want the trial acronym, not the full title
  if (reportA) {
    const identity = _extractIdentityFromReport(reportA);
    const name = identity?.trial_name;
    if (name && name !== 'null' && name.length >= 3 && name.length <= 40) {
      return name;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// STEP 2c: SUPPLEMENTARY NAME SEARCH
// Searches Europe PMC for papers mentioning the trial by name.
// Catches editorials, letters, and invited commentaries published
// in the same journal issue that never formally cite the paper.
// Returns array of result objects (same shape as citation objects).
// ─────────────────────────────────────────────
async function _searchByTrialName(trialName, pmid) {
  try {
    const currentYear = new Date().getFullYear();
    const fromYear    = currentYear - 3;

    // Full-text search for the phrase "SANO trial" — finds papers that mention
    // the trial in body text, not just title. More permissive than TITLE: but
    // specific enough when combined with the trial name + "trial" suffix.
    const phrase = trialName.toLowerCase().includes('trial')
      ? `"${trialName}"`
      : `"${trialName} trial"`;
    const query = `${phrase} AND FIRST_PDATE:[${fromYear} TO ${currentYear}]`;
    const url = `${EPMC_BASE}/search?query=${encodeURIComponent(query)}&resultType=core&pageSize=50&format=json`;
    const res   = await fetch(url);
    if (!res.ok) return [];

    const data    = await res.json();
    const results = data.resultList?.result || [];

    // Filter out the trial paper itself
    const filtered = results.filter(r =>
      r.pmid &&
      r.pmid !== pmid &&
      r.pmid !== String(pmid)
    );

    console.log(`[Node 4] Name search ${phrase}: ${results.length} results, ${filtered.length} usable`);
    return filtered;

  } catch (err) {
    console.warn('[Node 4] Name search failed:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// STEP 2d: PUBMED ENTREZ SEARCH
// PubMed indexes faster than Europe PMC citation graphs.
// Searches for the trial name in Title/Abstract, returns PMIDs,
// converts to stub objects for scoring + abstract fetching.
// ─────────────────────────────────────────────
async function _searchPubMed(trialName, pmid) {
  try {
    const ENTREZ_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

    const phrase = trialName.toLowerCase().includes('trial')
      ? `"${trialName}"`
      : `"${trialName} trial"`;
    const term = `${phrase}[Title/Abstract]`;

    const searchUrl = `${ENTREZ_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmax=25&sort=relevance&retmode=json`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return [];

    const searchData = await searchRes.json();
    const pmids = (searchData.esearchresult?.idlist || [])
      .filter(id => id !== String(pmid));

    if (pmids.length === 0) return [];
    console.log(`[Node 4] PubMed search ${phrase}: found ${pmids.length} PMIDs`);

    // Fetch summaries for all PMIDs in one call
    const summaryUrl = `${ENTREZ_BASE}/esummary.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=json`;
    const summaryRes = await fetch(summaryUrl);
    if (!summaryRes.ok) return [];

    const summaryData = await summaryRes.json();
    const uids = summaryData.result?.uids || [];

    return uids.map(uid => {
      const r = summaryData.result[uid];
      if (!r) return null;

      const authors = (r.authors || [])
        .slice(0, 3).map(a => a.name).join(', ')
        + (r.authors?.length > 3 ? ' et al.' : '');

      return {
        id:                  uid,
        pmid:                uid,
        title:               r.title || '',
        authorString:        authors,
        journalAbbreviation: r.fulljournalname || r.source || '',
        pubYear:             r.pubdate ? r.pubdate.slice(0, 4) : null,
        pubType:             r.pubtype?.[0] || '',
      };
    }).filter(Boolean);

  } catch (err) {
    console.warn('[Node 4] PubMed search failed:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────
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
      "summary": "One sentence — the single most important point this paper makes about the trial. If abstract is not available, describe what the paper likely addresses based on its title."
    }
  ],
  "synthesis": "3-5 sentences or null — see rules below"
}

RULES FOR type classification:
- Use "critique" for: invited commentaries, editorials, letters, or responses that question, challenge, or critically appraise the trial's methodology, conclusions, or applicability
- Use "supporting_commentary" for: commentaries, editorials, or letters that endorse, contextualise, or build on the trial's findings
- Use "meta_analysis" for: systematic reviews, meta-analyses, or pooled analyses that include this trial
- Use "guideline_citation" for: clinical guidelines, consensus statements, or practice recommendations that cite this trial
- Use "related_trial" for: subsequent trials testing similar interventions or populations
- Use "reanalysis" for: papers re-analysing or extending the original trial data
- IMPORTANT: If the abstract is "Not available", classify based on the title alone using the above rules.
  An "Invited Commentary" in the title = critique or supporting_commentary (default to critique unless title suggests support).
  A "Comment" or "Letter" in the title = critique or supporting_commentary (default to critique).

RULES FOR synthesis:
- Write 3-5 sentences placing this trial in the current evidence landscape.
- Cover: (1) how it has been received — contested or broadly accepted?
  (2) subsequent trials or meta-analyses that confirmed, contradicted, or superseded it;
  (3) whether it has influenced guidelines or practice;
  (4) any important methodological debates.
- Write in plain clinical English, past tense.
- Attribute specific concerns or positions to named authors from the provided papers.
- Include papers even when abstract is unavailable — their title and journal context are informative.
- The synthesis must be grounded ONLY in the citing papers provided above.
  Do NOT draw on general knowledge of the trial.
  Do NOT restate what the trial itself found — that has already been done separately.
- If the citing papers do not contain enough substance to write a meaningful synthesis
  (e.g. all items are brief letters with no substantive content and no abstracts available),
  return synthesis: null rather than a vague paragraph.
- A null synthesis is correct and acceptable. A fabricated synthesis is not.`;

    const result = await model.generateContent({
      contents:         [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.1 },
    });

    const text  = result.response.text();
    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.warn('[Node 4] Synthesis: no JSON object found in response');
      return null;
    }
    const parsed = JSON.parse(text.slice(start, end + 1));

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