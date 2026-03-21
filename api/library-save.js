// api/library-save.js
// Saves a completed OutcomeLogic analysis to the Supabase trials library.
// Handles duplicate detection, overwrite confirmation, and versioning.

import { createClient } from '@supabase/supabase-js';

export const config = {
  api: { bodyParser: { sizeLimit: '8mb' } }
};

// ─────────────────────────────────────────────
// SUPABASE ADMIN CLIENT
// Uses service role key — bypasses RLS for server-side writes.
// Never expose this key in the browser.
// ─────────────────────────────────────────────
function getAdminClient() {
  const url     = process.env.SUPABASE_URL;
  const svcKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svcKey) throw new Error('Supabase environment variables not configured.');
  return createClient(url, svcKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

// ─────────────────────────────────────────────
// SUPABASE ANON CLIENT
// Used to verify the user's JWT from the frontend.
// ─────────────────────────────────────────────
function getAnonClient() {
  const url     = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Supabase environment variables not configured.');
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // --- SECURITY LAYER 1: Internal token ---
  const authToken = req.headers['x-api-token'];
  if (!authToken || authToken !== process.env.INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorised.' });
  }

  // --- SECURITY LAYER 2: Supabase user JWT ---
  // Frontend passes the Supabase access token in the Authorization header
  const bearerToken = req.headers['authorization']?.replace('Bearer ', '');
  if (!bearerToken) {
    return res.status(401).json({ error: 'No user session. Please sign in.' });
  }

  // Verify the JWT and get the user
  const anonClient = getAnonClient();
  const { data: { user }, error: userError } = await anonClient.auth.getUser(bearerToken);
  if (userError || !user) {
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }

  try {
    const {
      analysis,        // Full OutcomeLogic JSON output
      library_meta,    // { domain, specialty, subspecialty, tags, landmark_year, display_title }
      confirm_overwrite = false,  // true = user has confirmed they want to overwrite
      validate_on_save  = false,  // true = save and mark as validated immediately
      validator_name,             // string — used if validate_on_save is true
    } = req.body;

    // ── Validate required fields ──────────────────────────────────────────
    if (!analysis)     return res.status(400).json({ error: 'Missing analysis data.' });
    if (!library_meta) return res.status(400).json({ error: 'Missing library metadata.' });
    if (!library_meta.domain)    return res.status(400).json({ error: 'Missing domain.' });
    if (!library_meta.specialty) return res.status(400).json({ error: 'Missing specialty.' });
    if (!library_meta.display_title) return res.status(400).json({ error: 'Missing display title.' });

    const supabase   = getAdminClient();
    const reportMeta = analysis.reportMeta || {};
    const pmid       = reportMeta.pubmed_id || null;
    const doi        = reportMeta.doi       || null;

    // ── Duplicate detection ───────────────────────────────────────────────
    // Check if a non-superseded trial with the same PMID or DOI already exists
    if (pmid || doi) {
      let dupQuery = supabase
        .from('trials')
        .select('id, display_title, saved_at, validated, version')
        .is('superseded_by', null);   // only current (non-superseded) records

      if (pmid && doi) {
        dupQuery = dupQuery.or(`pmid.eq.${pmid},doi.eq.${doi}`);
      } else if (pmid) {
        dupQuery = dupQuery.eq('pmid', pmid);
      } else {
        dupQuery = dupQuery.eq('doi', doi);
      }

      const { data: duplicates, error: dupError } = await dupQuery;
      if (dupError) throw dupError;

      if (duplicates && duplicates.length > 0 && !confirm_overwrite) {
        // Return duplicate info so the UI can prompt the user
        return res.status(409).json({
          error:      'duplicate',
          message:    'A trial with this PMID or DOI already exists in the library.',
          duplicates: duplicates.map(d => ({
            id:            d.id,
            display_title: d.display_title,
            saved_at:      d.saved_at,
            validated:     d.validated,
            version:       d.version,
          })),
        });
      }

      // User confirmed overwrite — mark existing records as superseded
      if (duplicates && duplicates.length > 0 && confirm_overwrite) {
        // We'll update superseded_by after inserting the new record
        // Store IDs for now
        req._supersede_ids = duplicates.map(d => d.id);
      }
    }

    // ── Build the record ──────────────────────────────────────────────────
    const now     = new Date().toISOString();
    const version = req._supersede_ids?.length
      ? ((await getMaxVersion(supabase, pmid, doi)) + 1)
      : 1;

    const record = {
      // Source identifiers
      pmid:             pmid,
      pmcid:            reportMeta.pmc_id   || null,
      doi:              doi,
      authors:          reportMeta.authors  || null,

      // Taxonomy
      domain:           library_meta.domain,
      specialty:        library_meta.specialty,
      subspecialty:     library_meta.subspecialty    || null,
      tags:             library_meta.tags             || [],
      landmark_year:    library_meta.landmark_year    || null,
      display_title:    library_meta.display_title,

      // Full analysis
      analysis_json:    analysis,
      source_type:      reportMeta.source_type        || null,

      // Provenance
      saved_by:         user.id,
      saved_at:         now,

      // Validation
      validated:        validate_on_save ? true : false,
      validated_by_name: validate_on_save ? (validator_name || user.email) : null,
      validated_at:     validate_on_save ? now : null,
      validation_notes: null,

      // Versioning
      version,
      superseded_by:    null,   // will always be null on a new record
    };

    // ── Insert ────────────────────────────────────────────────────────────
    const { data: inserted, error: insertError } = await supabase
      .from('trials')
      .insert(record)
      .select()
      .single();

    if (insertError) throw insertError;

    // ── Mark old records as superseded ────────────────────────────────────
    if (req._supersede_ids?.length) {
      const { error: supError } = await supabase
        .from('trials')
        .update({ superseded_by: inserted.id })
        .in('id', req._supersede_ids);
      if (supError) console.error('[library-save] Supersede update failed:', supError.message);
    }

    return res.status(200).json({
      success:  true,
      id:       inserted.id,
      message:  validate_on_save
        ? 'Trial saved and validated.'
        : 'Trial saved. Awaiting validation.',
      record: {
        id:            inserted.id,
        display_title: inserted.display_title,
        domain:        inserted.domain,
        specialty:     inserted.specialty,
        subspecialty:  inserted.subspecialty,
        validated:     inserted.validated,
        saved_at:      inserted.saved_at,
        version:       inserted.version,
      },
    });

  } catch (error) {
    console.error('[library-save] Error:', error);
    return res.status(500).json({ error: 'Failed to save trial.', details: error.message });
  }
}

// ─────────────────────────────────────────────
// HELPER: get the highest version number for a PMID/DOI
// Used to increment version on overwrite
// ─────────────────────────────────────────────
async function getMaxVersion(supabase, pmid, doi) {
  let query = supabase
    .from('trials')
    .select('version')
    .order('version', { ascending: false })
    .limit(1);

  if (pmid && doi) {
    query = query.or(`pmid.eq.${pmid},doi.eq.${doi}`);
  } else if (pmid) {
    query = query.eq('pmid', pmid);
  } else if (doi) {
    query = query.eq('doi', doi);
  }

  const { data } = await query;
  return data?.[0]?.version || 0;
}