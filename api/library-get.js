// api/library-get.js
// Fetches trials from the Supabase library.
// Supports three modes:
//   single   — fetch one trial by ID (returns full analysis_json)
//   browse   — fetch trial cards filtered by domain/specialty/subspecialty/validated
//   counts   — fetch counts per domain/specialty for the library navigation

import { createClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────
// SUPABASE ADMIN CLIENT
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
    const {
      mode = 'browse',       // 'single' | 'browse' | 'counts'
      id,                    // used in single mode
      domain,                // filter
      specialty,             // filter
      subspecialty,          // filter
      validated_only = false, // filter
      include_superseded = false, // if true, include overwritten versions
      order_by = 'display_title', // 'display_title' | 'landmark_year' | 'saved_at'
      order_dir = 'asc',
    } = req.body;

    const supabase = getAdminClient();

    // ────────────────────────────────────────
    // MODE: single — load one trial's full analysis JSON for instant recall
    // ────────────────────────────────────────
    if (mode === 'single') {
      if (!id) return res.status(400).json({ error: 'Missing trial id.' });

      const { data, error } = await supabase
        .from('trials')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Trial not found.' });

      return res.status(200).json({ trial: data });
    }

    // ────────────────────────────────────────
    // MODE: counts — navigation counts per domain/specialty
    // Used to populate the library sidebar/dropdowns with item counts
    // ────────────────────────────────────────
    if (mode === 'counts') {
      const { data, error } = await supabase
        .from('trials')
        .select('domain, specialty, subspecialty, validated')
        .is('superseded_by', null);  // only current records

      if (error) throw error;

      // Build nested count structure
      const counts = {};
      (data || []).forEach(row => {
        if (!counts[row.domain]) counts[row.domain] = { _total: 0, _validated: 0 };
        counts[row.domain]._total++;
        if (row.validated) counts[row.domain]._validated++;

        if (!counts[row.domain][row.specialty]) {
          counts[row.domain][row.specialty] = { _total: 0, _validated: 0 };
        }
        counts[row.domain][row.specialty]._total++;
        if (row.validated) counts[row.domain][row.specialty]._validated++;

        if (row.subspecialty) {
          if (!counts[row.domain][row.specialty][row.subspecialty]) {
            counts[row.domain][row.specialty][row.subspecialty] = { _total: 0, _validated: 0 };
          }
          counts[row.domain][row.specialty][row.subspecialty]._total++;
          if (row.validated) counts[row.domain][row.specialty][row.subspecialty]._validated++;
        }
      });

      return res.status(200).json({ counts });
    }

    // ────────────────────────────────────────
    // MODE: browse — fetch trial cards with filters
    // Returns card-level data only (no analysis_json) for performance
    // analysis_json is only fetched in single mode
    // ────────────────────────────────────────

    // Card fields — deliberately excludes analysis_json for performance
    const CARD_FIELDS = [
      'id',
      'pmid',
      'pmcid',
      'doi',
      'domain',
      'specialty',
      'subspecialty',
      'tags',
      'landmark_year',
      'display_title',
      'authors',
      'source_type',
      'saved_by',
      'saved_at',
      'validated',
      'validated_by_name',
      'validated_at',
      'version',
      'superseded_by',
    ].join(', ');

    let query = supabase
      .from('trials')
      .select(CARD_FIELDS);

    // Filter out superseded records unless explicitly requested
    if (!include_superseded) {
      query = query.is('superseded_by', null);
    }

    // Taxonomy filters
    if (domain)      query = query.eq('domain', domain);
    if (specialty)   query = query.eq('specialty', specialty);
    if (subspecialty) query = query.eq('subspecialty', subspecialty);

    // Validation filter
    if (validated_only) query = query.eq('validated', true);

    // Ordering
    const validOrderFields = ['display_title', 'landmark_year', 'saved_at', 'validated_at'];
    const validOrderDirs   = ['asc', 'desc'];
    const safeOrderField   = validOrderFields.includes(order_by)  ? order_by  : 'display_title';
    const safeOrderDir     = validOrderDirs.includes(order_dir)   ? order_dir : 'asc';

    query = query.order(safeOrderField, { ascending: safeOrderDir === 'asc', nullsFirst: false });

    // Secondary sort: always sort by display_title as tiebreaker
    if (safeOrderField !== 'display_title') {
      query = query.order('display_title', { ascending: true });
    }

    const { data, error } = await query;
    if (error) throw error;

    // ── Summary stats for the validation queue badge ──
    const total     = data.length;
    const validated = data.filter(t => t.validated).length;
    const pending   = total - validated;

    return res.status(200).json({
      trials:  data || [],
      summary: { total, validated, pending },
    });

  } catch (error) {
    console.error('[library-get] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch library.', details: error.message });
  }
}