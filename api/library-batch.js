// api/library-batch.js
// Processes multiple PDFs sequentially through the shared OutcomeLogic pipeline
// and auto-saves each result to the Supabase library as unvalidated.
//
// All pipeline logic lives in lib/pipeline.js — this file is purely:
//   1. Auth + input validation
//   2. PDF text extraction
//   3. Sequential job loop calling runPipeline()
//   4. Saving each result to Supabase
//   5. Returning the job manifest

import { createClient }       from '@supabase/supabase-js';
import pdfParse               from 'pdf-parse/lib/pdf-parse.js';
import { runPipeline }        from '../lib/pipeline.js';

export const config = {
  api:         { bodyParser: { sizeLimit: '50mb' } },
  maxDuration: 300,   // Vercel max — batches are long-running
};

const BATCH_JOB_DELAY_MS = 3000;
const BATCH_MAX_FILES    = 20;

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────
// SUPABASE CLIENTS
// ─────────────────────────────────────────────
function getAdminClient() {
  const url    = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svcKey) throw new Error('Supabase environment variables not configured.');
  return createClient(url, svcKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

function getAnonClient() {
  const url     = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Supabase environment variables not configured.');
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

// ─────────────────────────────────────────────
// SAVE ONE RESULT TO SUPABASE
// ─────────────────────────────────────────────
async function saveToLibrary(supabase, analysis, userId) {
  const lm         = analysis.library_meta || {};
  const reportMeta = analysis.reportMeta   || {};

  const record = {
    pmid:              reportMeta.pubmed_id  || null,
    pmcid:             reportMeta.pmc_id     || null,
    doi:               reportMeta.doi         || null,
    authors:           reportMeta.authors     || null,
    domain:            lm.domain             || 'Surgery',
    specialty:         lm.specialty          || 'Upper GI',
    subspecialty:      lm.subspecialty       || null,
    tags:              lm.tags               || [],
    landmark_year:     lm.landmark_year      || null,
    display_title:     lm.display_title      || reportMeta.trial_identification || 'Unknown Trial',
    analysis_json:     analysis,
    source_type:       'full-text-pdf',
    saved_by:          userId,
    saved_at:          new Date().toISOString(),
    validated:         false,
    validated_by_name: null,
    validated_at:      null,
    validation_notes:  null,
    version:           1,
    superseded_by:     null,
  };

  const { data, error } = await supabase
    .from('trials')
    .insert(record)
    .select('id, display_title')
    .single();

  if (error) throw error;
  return data;
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────
export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // Security Layer 1: internal token
  const authToken = req.headers['x-api-token'];
  if (!authToken || authToken !== process.env.INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorised.' });
  }

  // Security Layer 2: Supabase user JWT
  const bearerToken = req.headers['authorization']?.replace('Bearer ', '');
  if (!bearerToken) {
    return res.status(401).json({ error: 'No user session. Please sign in.' });
  }

  const anonClient = getAnonClient();
  const { data: { user }, error: userError } = await anonClient.auth.getUser(bearerToken);
  if (userError || !user) {
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }

  try {
    const { files } = req.body;
    // files: [{ name: "CROSS.pdf", base64: "..." }, ...]

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files provided.' });
    }
    if (files.length > BATCH_MAX_FILES) {
      return res.status(400).json({
        error: `Maximum ${BATCH_MAX_FILES} files per batch. You sent ${files.length}.`
      });
    }

    const supabase = getAdminClient();

    // Initialise job manifest
    const jobs = files.map((f, i) => ({
      index:         i,
      filename:      f.name || `file_${i + 1}.pdf`,
      status:        'pending',  // pending | running | complete | failed
      trial_id:      null,
      display_title: null,
      error:         null,
    }));

    // Process sequentially
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      jobs[i].status = 'running';

      try {
        // Extract text from PDF
        const pdfBuffer = Buffer.from(file.base64, 'base64');
        const pdfData   = await pdfParse(pdfBuffer);
        const text      = pdfData.text || '';

        if (text.trim().length < 500) {
          throw new Error('PDF appears to be empty or image-only (no extractable text).');
        }

        // Build source context — same format as analyze.js
        const sourceMeta = { sourceType: 'full-text-pdf' };
        const sourceContext = [
          `[SOURCE: full-text-pdf]`,
          `[FILE: ${jobs[i].filename}]`,
          '',
          text,
        ].join('\n');

        // Run shared pipeline
        const analysis = await runPipeline(sourceContext, sourceMeta);

        // Save to library
        const saved = await saveToLibrary(supabase, analysis, user.id);

        jobs[i].status        = 'complete';
        jobs[i].trial_id      = saved.id;
        jobs[i].display_title = saved.display_title;

      } catch (jobError) {
        console.error(`[library-batch] Job ${i} (${jobs[i].filename}):`, jobError.message);
        jobs[i].status = 'failed';
        jobs[i].error  = jobError.message;
      }

      // Delay between jobs — skip after last
      if (i < files.length - 1) await delay(BATCH_JOB_DELAY_MS);
    }

    const completed = jobs.filter(j => j.status === 'complete').length;
    const failed    = jobs.filter(j => j.status === 'failed').length;

    return res.status(200).json({
      success: true,
      message: `Batch complete. ${completed} saved, ${failed} failed.`,
      jobs,
      summary: { total: files.length, completed, failed },
    });

  } catch (error) {
    console.error('[library-batch] Fatal error:', error);
    return res.status(500).json({ error: 'Batch processing failed.', details: error.message });
  }
}