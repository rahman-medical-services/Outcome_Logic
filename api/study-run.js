// api/study-run.js
// Runs the V2 pipeline on a registered study paper and stores the output.
// Admin-only: requires INTERNAL_API_TOKEN + admin-tier JWT.
//
// POST /api/study-run
//   Body (PMID fetch):  { paper_id, version?: "v2", force?: false }
//   Body (PDF upload):  { paper_id, version?: "v2", force?: false, pdf_base64: "<base64>" }
//
// If pdf_base64 is present, skips Europe PMC fetch and parses the PDF directly.
// Source type is set to "full-text-pdf".

import { createClient } from '@supabase/supabase-js';
import pdfParse         from 'pdf-parse/lib/pdf-parse.js';
import { runPipeline }  from '../lib/pipeline.js';

export const config = {
  api: { bodyParser: { sizeLimit: '8mb' } }   // large enough for typical paper PDFs
};

// ─────────────────────────────────────────────
// SUPABASE CLIENTS
// ─────────────────────────────────────────────
function getAdminClient() {
  const url    = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svcKey) throw new Error('Supabase env not configured.');
  return createClient(url, svcKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

function getAnonClient() {
  const url     = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Supabase env not configured.');
  return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

// ─────────────────────────────────────────────
// AUTH HELPER
// ─────────────────────────────────────────────
async function requireAdmin(req, res) {
  const apiToken = req.headers['x-api-token'];
  if (!apiToken || apiToken !== process.env.INTERNAL_API_TOKEN) {
    res.status(401).json({ error: 'Unauthorised.' });
    return null;
  }
  const bearer = req.headers['authorization']?.replace('Bearer ', '');
  if (!bearer) {
    res.status(401).json({ error: 'No user session.' });
    return null;
  }
  const { data: { user }, error } = await getAnonClient().auth.getUser(bearer);
  if (error || !user) {
    res.status(401).json({ error: 'Invalid or expired session.' });
    return null;
  }
  const tier = user.user_metadata?.tier || 'free';
  if (tier !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return null;
  }
  return user;
}

// ─────────────────────────────────────────────
// SOURCE: PDF (base64)
// ─────────────────────────────────────────────
async function sourceFromPdf(pdf_base64, paper) {
  const buf  = Buffer.from(pdf_base64, 'base64');
  const data = await pdfParse(buf);
  const text = data.text;
  if (!text || text.length < 500) {
    throw new Error('PDF appears to be empty or image-only — could not extract text.');
  }
  console.log(`[study-run PDF] Extracted ${text.length} chars from PDF`);
  return {
    text,
    sourceType: 'full-text-pdf',
    pmid:    paper.pmid    || null,
    pmcid:   null,
    doi:     null,
    authors: paper.authors || null,
  };
}

// ─────────────────────────────────────────────
// SOURCE: Europe PMC tiered fetch (PMID → PMC XML → Jina → abstract)
// ─────────────────────────────────────────────
const MIN_CHARS = { FULLTEXT: 2000, ABSTRACT: 200 };

async function fetchFullTextPMC(pmcid, pmid) {
  if (!pmcid) return null;
  try {
    const res  = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml  = await res.text();
    const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_CHARS.FULLTEXT) return null;
    console.log(`[study-run Tier 1] PMC full text: ${text.length} chars`);
    return { text, sourceType: 'full-text-pmc', pmcid, pmid: pmid || null };
  } catch (err) {
    console.log(`[study-run Tier 1] PMC failed: ${err.message}`);
    return null;
  }
}

async function fetchFullTextJina(pmcid) {
  if (!pmcid) return null;
  try {
    const res  = await fetch(`https://r.jina.ai/https://europepmc.org/article/PMC/${pmcid}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text || text.includes('Access Denied') || text.length < 1000) return null;
    console.log(`[study-run Tier 2] Jina/PMC: ${text.length} chars`);
    return { text, sourceType: 'full-text-jina', pmcid };
  } catch (err) {
    console.log(`[study-run Tier 2] Jina failed: ${err.message}`);
    return null;
  }
}

async function fetchAbstract(pmid) {
  try {
    const url  = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`ext_id:${pmid}`)}&resultType=core&format=json`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data    = await res.json();
    const article = data.resultList?.result?.[0];
    if (!article) return null;
    const abstract = article.abstractText
      ? article.abstractText.replace(/<[^>]*>?/gm, '')
      : null;
    if (!abstract || abstract.length < MIN_CHARS.ABSTRACT) return null;
    console.log(`[study-run Tier 4] Abstract: ${abstract.length} chars`);
    const authorList = (article.authorString || '').split(',').map(a => a.trim()).filter(Boolean);
    const authorsStr = authorList.length === 0  ? null
      : authorList.length <= 3 ? authorList.join(', ')
      : authorList.slice(0, 3).join(', ') + ' et al.';
    return {
      text:       `TITLE: ${article.title}\n\n[ABSTRACT ONLY]\n${abstract}`,
      sourceType: 'abstract-only',
      pmid:       article.pmid  || pmid || null,
      pmcid:      article.pmcid || null,
      doi:        article.doi   || null,
      authors:    authorsStr,
    };
  } catch (err) {
    console.log(`[study-run Tier 4] Abstract failed: ${err.message}`);
    return null;
  }
}

async function fetchTrialByPmid(pmid) {
  let meta = { pmid, pmcid: null, doi: null, authors: null };
  try {
    const url  = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`ext_id:${pmid}`)}&resultType=core&format=json`;
    const res  = await fetch(url);
    if (res.ok) {
      const data    = await res.json();
      const article = data.resultList?.result?.[0];
      if (article) {
        const authorList = (article.authorString || '').split(',').map(a => a.trim()).filter(Boolean);
        meta = {
          pmid:    article.pmid   || pmid,
          pmcid:   article.pmcid  || null,
          doi:     article.doi    || null,
          authors: authorList.length === 0 ? null
            : authorList.length <= 3 ? authorList.join(', ')
            : authorList.slice(0, 3).join(', ') + ' et al.',
        };
      }
    }
  } catch (err) {
    console.log(`[study-run Meta] ${err.message}`);
  }

  const tier1 = await fetchFullTextPMC(meta.pmcid, meta.pmid);
  if (tier1) return { ...meta, ...tier1 };

  const tier2 = await fetchFullTextJina(meta.pmcid);
  if (tier2) return { ...meta, ...tier2 };

  const tier4 = await fetchAbstract(pmid);
  if (tier4) return { ...meta, ...tier4 };

  return null;
}

// ─────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const user = await requireAdmin(req, res);
  if (!user) return;

  const { paper_id, version = 'v2', force = false, pdf_base64 } = req.body;
  if (!paper_id) return res.status(400).json({ error: 'paper_id required.' });
  if (version !== 'v2') return res.status(400).json({ error: 'Only version v2 supported for now.' });

  const supabase = getAdminClient();

  // ── Look up paper ─────────────────────────────────────────────────────────
  const { data: paper, error: paperErr } = await supabase
    .from('study_papers')
    .select('*')
    .eq('id', paper_id)
    .single();

  if (paperErr || !paper) return res.status(404).json({ error: 'Paper not found.' });

  // If no PDF supplied we need a PMID to fetch from Europe PMC
  if (!pdf_base64 && !paper.pmid) {
    return res.status(400).json({
      error: 'No PMID on record.',
      message: 'Add a PMID first, or upload a PDF directly.',
    });
  }

  // ── Guard: don't re-run unless force=true ────────────────────────────────
  if (!force) {
    const { data: existing } = await supabase
      .from('study_outputs')
      .select('id, generated_at, source_type')
      .eq('paper_id', paper_id)
      .eq('version', version)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        error:        'Analysis already exists.',
        message:      'Pass force: true to overwrite.',
        output_id:    existing.id,
        source_type:  existing.source_type,
        generated_at: existing.generated_at,
      });
    }
  }

  // ── Resolve source ────────────────────────────────────────────────────────
  let source;
  if (pdf_base64) {
    console.log(`[study-run] Using uploaded PDF for paper ${paper_id} (${paper.title})`);
    try {
      source = await sourceFromPdf(pdf_base64, paper);
    } catch (err) {
      return res.status(422).json({ error: err.message });
    }
  } else {
    console.log(`[study-run] Fetching source for PMID ${paper.pmid} (${paper.title})`);
    source = await fetchTrialByPmid(paper.pmid);
    if (!source) {
      return res.status(422).json({
        error:   'Source fetch failed.',
        message: `Could not retrieve content for PMID ${paper.pmid}. Upload a PDF instead.`,
      });
    }
  }

  console.log(`[study-run] Source: ${source.sourceType}, ${source.text.length} chars`);

  // ── Run V2 pipeline ───────────────────────────────────────────────────────
  let pipelineResult;
  try {
    pipelineResult = await runPipeline(
      source.text,
      {
        sourceType: source.sourceType,
        pmid:       source.pmid    || paper.pmid    || null,
        pmcid:      source.pmcid   || null,
        doi:        source.doi     || null,
        authors:    source.authors || paper.authors || null,
      }
    );
  } catch (err) {
    console.error(`[study-run] Pipeline error:`, err.message);
    const msg = err.message || '';
    if (msg.startsWith('GEMINI_UNAVAILABLE')) {
      return res.status(503).json({ error: err.message });
    }
    return res.status(500).json({ error: `Pipeline failed: ${err.message}` });
  }

  // ── Upsert to study_outputs ───────────────────────────────────────────────
  const { data: output, error: saveErr } = await supabase
    .from('study_outputs')
    .upsert(
      {
        paper_id,
        version,
        output_json:  pipelineResult,
        source_type:  source.sourceType,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'paper_id,version' }
    )
    .select('id, generated_at')
    .single();

  if (saveErr) {
    console.error(`[study-run] Save error:`, saveErr.message);
    return res.status(500).json({ error: `Failed to save output: ${saveErr.message}` });
  }

  console.log(`[study-run] Saved output ${output.id} for paper ${paper_id}`);

  return res.status(200).json({
    ok:            true,
    output_id:     output.id,
    source_type:   source.sourceType,
    display_title: pipelineResult?.library_meta?.display_title || paper.title,
    generated_at:  output.generated_at,
  });
}
