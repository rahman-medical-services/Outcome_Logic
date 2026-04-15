// api/study.js
// Consolidated study admin API — replaces study-papers.js, study-output.js, study-run.js.
// Routes via ?resource= query param.
//
// GET    /api/study?resource=papers              → list all papers with extraction status
// POST   /api/study?resource=papers              → add a paper
// PATCH  /api/study?resource=papers&id=<uuid>    → update a paper
// DELETE /api/study?resource=papers&id=<uuid>    → delete a paper
// GET    /api/study?resource=output&id=<uuid>    → get full output_json for one extraction
// POST   /api/study?resource=run                 → run pipeline on a paper

import { createClient } from '@supabase/supabase-js';
import pdfParse         from 'pdf-parse/lib/pdf-parse.js';
import { runPipeline, buildSourceContext } from '../lib/pipeline.js';

export const config = {
  api: { bodyParser: { sizeLimit: '8mb' } }  // required for PDF uploads via study-run
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
  if ((user.user_metadata?.tier || 'free') !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return null;
  }
  return user;
}

// ─────────────────────────────────────────────
// RESOURCE: papers
// ─────────────────────────────────────────────
async function handlePapers(req, res) {
  const supabase = getAdminClient();
  const { id }   = req.query;

  // GET: list all papers with extraction status
  if (req.method === 'GET') {
    const { data: papers, error } = await supabase
      .from('study_papers')
      .select('*, study_extractions(id, version, source_type, generated_at)')
      .order('phase', { ascending: true })
      .order('added_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const result = (papers || []).map(p => {
      const extractions = p.study_extractions || [];
      return {
        ...p,
        study_extractions: undefined,
        v3_output: extractions.find(o => o.version === 'v3') || extractions.find(o => o.version === 'v2') || null,
        v1_output: extractions.find(o => o.version === 'v1') || null,
      };
    });

    return res.status(200).json({ papers: result });
  }

  // POST: add a paper
  if (req.method === 'POST') {
    const { pmid, title, authors, journal, year, specialty, phase = 0, is_pilot = false } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required.' });

    const { data, error } = await supabase
      .from('study_papers')
      .insert({ pmid: pmid || null, title, authors, journal, year, specialty, phase, is_pilot })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ paper: data });
  }

  // PATCH: update a paper (e.g. set/correct PMID)
  if (req.method === 'PATCH') {
    if (!id) return res.status(400).json({ error: 'id query param required.' });
    const allowed = ['pmid', 'title', 'authors', 'journal', 'year', 'specialty', 'phase', 'is_pilot', 'status'];
    const updates = {};
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update.' });

    const { data, error } = await supabase
      .from('study_papers')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ paper: data });
  }

  // DELETE: remove a paper (cascades to extractions/grades)
  if (req.method === 'DELETE') {
    if (!id) return res.status(400).json({ error: 'id query param required.' });
    const { error } = await supabase.from('study_papers').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

// ─────────────────────────────────────────────
// RESOURCE: output
// GET /api/study?resource=output&id=<extraction_uuid>
// ─────────────────────────────────────────────
async function handleOutput(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id query param required.' });

  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('study_extractions')
    .select('id, paper_id, version, pipeline_version, output_json, source_type, generated_at')
    .eq('id', id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Output not found.' });
  return res.status(200).json({ output: data });
}

// ─────────────────────────────────────────────
// RESOURCE: run
// POST /api/study?resource=run
// Body: { paper_id?, version?, force?, pdf_base64 }
//
// Phase 0 and Phase 1 require uploaded PDFs.
// DOI/PMID-based text fetching is not used for study runs — it introduces
// source-type variability that would confound the validation study.
// All study extractions must have source_type = 'full-text-pdf'.
// ─────────────────────────────────────────────

async function sourceFromPdf(pdf_base64, paper) {
  const buf  = Buffer.from(pdf_base64, 'base64');
  const data = await pdfParse(buf);
  const text = data.text;
  if (!text || text.length < 500) {
    throw new Error('PDF appears to be empty or image-only — could not extract text.');
  }
  console.log(`[study-run PDF] Extracted ${text.length} chars`);
  return { text, sourceType: 'full-text-pdf', pmid: paper.pmid || null, pmcid: null, doi: null, authors: paper.authors || null };
}

async function handleRun(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { paper_id, version = 'v3', force = false, pdf_base64 } = req.body;

  // PDF is mandatory — no PMID/DOI fallback for study runs
  if (!pdf_base64) {
    return res.status(400).json({
      error: 'pdf_base64 is required. Study runs must use uploaded PDFs — PMID/DOI fetching is not permitted for Phase 0/1 to ensure source-type consistency.',
    });
  }

  const supabase = getAdminClient();
  let paper = null;

  if (paper_id) {
    const { data, error: paperErr } = await supabase
      .from('study_papers')
      .select('*')
      .eq('id', paper_id)
      .single();
    if (paperErr || !data) return res.status(404).json({ error: 'Paper not found.' });
    paper = data;

    if (!force) {
      const { data: existing } = await supabase
        .from('study_extractions')
        .select('id, generated_at, source_type')
        .eq('paper_id', paper_id)
        .eq('version', version)
        .maybeSingle();
      if (existing) {
        return res.status(409).json({
          error: 'Analysis already exists. Pass force: true to overwrite.',
          output_id: existing.id, source_type: existing.source_type, generated_at: existing.generated_at,
        });
      }
    }
  }

  let source;
  console.log(`[study-run] Parsing uploaded PDF`);
  try {
    source = await sourceFromPdf(pdf_base64, paper || {});
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }

  console.log(`[study-run] Source: ${source.sourceType}, ${source.text.length} chars`);

  let pipelineResult;
  try {
    const sourceMeta = {
      sourceType: source.sourceType,
      pmid:       source.pmid    || paper?.pmid    || null,
      pmcid:      source.pmcid   || null,
      doi:        source.doi     || null,
      authors:    source.authors || paper?.authors || null,
    };
    pipelineResult = await runPipeline(
      buildSourceContext(source.text, sourceMeta),
      sourceMeta
    );
  } catch (err) {
    console.error(`[study-run] Pipeline error:`, err.message);
    if ((err.message || '').startsWith('GEMINI_UNAVAILABLE')) {
      return res.status(503).json({ error: err.message });
    }
    return res.status(500).json({ error: `Pipeline failed: ${err.message}` });
  }

  // Mode B: auto-create study_papers row from pipeline output (PDF upload without paper_id)
  if (!paper_id) {
    const rm = pipelineResult.reportMeta   || {};
    const lm = pipelineResult.library_meta || {};
    const { data: newPaper, error: createErr } = await supabase
      .from('study_papers')
      .insert({
        pmid:      rm.pubmed_id    || null,
        title:     lm.display_title || rm.trial_identification || 'Unknown trial',
        authors:   rm.authors      || null,
        journal:   rm.journal      || null,
        year:      rm.year         || null,
        specialty: lm.specialty    || null,
        phase:     0,
        is_pilot:  true,
      })
      .select()
      .single();
    if (createErr) {
      console.error(`[study-run] Paper create error:`, createErr.message);
      return res.status(500).json({ error: `Failed to create paper record: ${createErr.message}` });
    }
    paper = newPaper;
    console.log(`[study-run] Auto-created paper ${paper.id}: ${paper.title}`);
  }

  const { data: output, error: saveErr } = await supabase
    .from('study_extractions')
    .upsert(
      {
        paper_id:     paper.id,
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

  console.log(`[study-run] Saved extraction ${output.id} for paper ${paper.id}`);

  return res.status(200).json({
    ok:            true,
    paper_id:      paper.id,
    output_id:     output.id,
    source_type:   source.sourceType,
    display_title: pipelineResult?.library_meta?.display_title || paper.title,
    generated_at:  output.generated_at,
  });
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET,POST,PATCH,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAdmin(req, res);
  if (!user) return;

  const { resource } = req.query;

  if (resource === 'papers') return handlePapers(req, res);
  if (resource === 'output') return handleOutput(req, res);
  if (resource === 'run')    return handleRun(req, res);

  return res.status(400).json({ error: 'resource param required: papers | output | run' });
}
