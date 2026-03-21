// api/library-validate.js
// Marks one or more trials as validated (or removes validation).
// Supports single trial validation, bulk validation, and un-validation.
// Validator name and timestamp are recorded for provenance.

import { createClient } from '@supabase/supabase-js';

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
      mode = 'validate',        // 'validate' | 'unvalidate'
      ids,                      // array of trial UUIDs — required
      validator_name,           // display name — falls back to user email
      validation_notes = null,  // optional free text notes
    } = req.body;

    // ── Validate inputs ───────────────────────────────────────────────────
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Missing or empty ids array.' });
    }

    // Sanity check — UUIDs only, no SQL injection risk but good practice
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const invalidIds  = ids.filter(id => !uuidPattern.test(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({ error: `Invalid trial IDs: ${invalidIds.join(', ')}` });
    }

    const supabase = getAdminClient();
    const now      = new Date().toISOString();
    const name     = validator_name || user.email || 'Unknown';

    // ── Build update payload ──────────────────────────────────────────────
    let updatePayload;

    if (mode === 'unvalidate') {
      updatePayload = {
        validated:         false,
        validated_by_name: null,
        validated_at:      null,
        validation_notes:  null,
      };
    } else {
      // mode === 'validate'
      updatePayload = {
        validated:         true,
        validated_by_name: name,
        validated_at:      now,
        validation_notes:  validation_notes || null,
      };
    }

    // ── Execute update ────────────────────────────────────────────────────
    const { data: updated, error: updateError } = await supabase
      .from('trials')
      .update(updatePayload)
      .in('id', ids)
      .is('superseded_by', null)   // never update superseded records
      .select('id, display_title, validated, validated_by_name, validated_at');

    if (updateError) throw updateError;

    // Check if any requested IDs were not found or were superseded
    const updatedIds  = (updated || []).map(r => r.id);
    const missingIds  = ids.filter(id => !updatedIds.includes(id));

    const action  = mode === 'validate' ? 'validated' : 'un-validated';
    const count   = updated?.length || 0;

    return res.status(200).json({
      success: true,
      message: `${count} trial${count !== 1 ? 's' : ''} ${action} successfully.`,
      updated: updated || [],
      ...(missingIds.length > 0 && {
        warning: `${missingIds.length} ID(s) not found or already superseded: ${missingIds.join(', ')}`,
      }),
    });

  } catch (error) {
    console.error('[library-validate] Error:', error);
    return res.status(500).json({ error: 'Validation failed.', details: error.message });
  }
}