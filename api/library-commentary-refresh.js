// api/library-commentary-refresh.js
// Refreshes the expert_context block on a saved trial in the library.
// Runs Node 4 (commentary search) in isolation against the stored PMID.
// Writes the updated block back into analysis_json without touching anything else.
//
// Admin tier only.
// POST body: { id: "uuid" }

import { createClient }     from '@supabase/supabase-js';
import { fetchExpertContext } from '../lib/commentary.js';

function getAdminClient() {
  const url    = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svcKey) throw new Error('Supabase environment variables not configured.');
  return createClient(url, svcKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function getAnonClient() {
  const url     = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Supabase environment variables not configured.');
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function getTier(user) {
  return user?.user_metadata?.tier || 'free';
}

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method Not Allowed' });

  // ── Security layer 1: internal token ─────────────────────────────────────
  const authToken = req.headers['x-api-token'];
  if (!authToken || authToken !== process.env.INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorised.' });
  }

  // ── Security layer 2: Supabase user JWT ──────────────────────────────────
  const bearerToken = req.headers['authorization']?.replace('Bearer ', '');
  if (!bearerToken) {
    return res.status(401).json({ error: 'No user session. Please sign in.' });
  }

  const anonClient = getAnonClient();
  const { data: { user }, error: userError } = await anonClient.auth.getUser(bearerToken);
  if (userError || !user) {
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }

  // ── Tier check: admin only ────────────────────────────────────────────────
  if (getTier(user) !== 'admin') {
    return res.status(403).json({ error: 'Admin access required to refresh commentary.' });
  }

  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'Missing trial id.' });
  }

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(id)) {
    return res.status(400).json({ error: 'Invalid trial id format.' });
  }

  try {
    const supabase = getAdminClient();

    // ── Fetch the stored trial ────────────────────────────────────────────
    const { data: trial, error: fetchError } = await supabase
      .from('trials')
      .select('id, display_title, analysis_json')
      .eq('id', id)
      .is('superseded_by', null)
      .single();

    if (fetchError || !trial) {
      return res.status(404).json({ error: 'Trial not found.' });
    }

    const analysis = trial.analysis_json;
    if (!analysis) {
      return res.status(422).json({ error: 'Trial has no analysis JSON to refresh.' });
    }

    // ── Extract the PMID we will search against ───────────────────────────
    // Primary source: reportMeta (set by pipeline postProcess)
    // The refresh endpoint always operates from a known PMID — we do not
    // re-run the ID mini-call here since we already have the stored metadata.
    const pmid = analysis.reportMeta?.pubmed_id || null;
    const doi  = analysis.reportMeta?.doi       || null;
    const year = analysis.reportMeta?.year      || null;

    if (!pmid && !doi) {
      return res.status(422).json({
        error: 'No PMID or DOI found in stored analysis. Commentary refresh requires an identified trial.',
      });
    }

    // Build a minimal sourceMeta for Node 4
    const sourceMeta = {
      pmid,
      doi,
      year,
      sourceType: analysis.reportMeta?.source_type || 'unknown',
    };

    console.log(`[CommentaryRefresh] Refreshing trial ${id} (PMID: ${pmid || 'n/a'}, DOI: ${doi || 'n/a'})`);

    // ── Run Node 4 in isolation ───────────────────────────────────────────
    // Pass null for reportA — PMID is already known from sourceMeta,
    // so the ID mini-call is skipped inside fetchExpertContext.
    const freshContext = await fetchExpertContext(sourceMeta, null);

    // ── Write the updated block back ──────────────────────────────────────
    // Targeted update — only touches expert_context inside clinician_view.
    // All other fields in analysis_json are preserved exactly.
    const now         = new Date().toISOString();
    const updatedJson = {
      ...analysis,
      clinician_view: {
        ...analysis.clinician_view,
        // Only attach found/not_found; omit pmid_unresolved/error silently
        ...(freshContext.status === 'found' || freshContext.status === 'not_found'
          ? { expert_context: freshContext }
          : {}),
        expert_context_refreshed_at: now,
      },
    };

    const { error: updateError } = await supabase
      .from('trials')
      .update({ analysis_json: updatedJson })
      .eq('id', id)
      .is('superseded_by', null);

    if (updateError) throw updateError;

    console.log(`[CommentaryRefresh] Complete for trial ${id} — status: ${freshContext.status}`);

    return res.status(200).json({
      success:      true,
      trial_id:     id,
      display_title: trial.display_title,
      refreshed_at: now,
      commentary_status: freshContext.status,
      // Return the fresh block so the frontend can update the UI without a re-fetch
      expert_context: (freshContext.status === 'found' || freshContext.status === 'not_found')
        ? freshContext
        : null,
    });

  } catch (error) {
    console.error('[CommentaryRefresh] Error:', error);
    return res.status(500).json({ error: 'Refresh failed.', details: error.message });
  }
}