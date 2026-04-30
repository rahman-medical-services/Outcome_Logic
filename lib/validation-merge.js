// lib/validation-merge.js
//
// Pure merge function: builds a final V4-shape JSON from
//   (a) the V4 pipeline output,
//   (b) Phase 2b sectional corrections (per-rater free-text fixes
//       to non-MA sections, after both raters and the arbitrator),
//   (c) Phase 3 arbitrated MA-field values (the validated ground truth).
//
// Output is V4-shape so the existing index.html renderer can consume it.
// MA-field arbitration writes into the `selected` primary_endpoint_candidate
// (or onto clinician_view.* for the non-$primary MA paths). 2b corrections
// for `display_type='text'` overwrite the underlying path; corrections for
// `display_type='json'` are recorded as a sibling `_arbitrator_correction`
// annotation rather than attempting to mutate structured objects from free
// text. The renderer ignores `_`-prefixed fields, so this is harmless.
//
// Internal _-prefixed fields (the _critic audit trail, _<field>_source
// provenance) are stripped from the merged output — the merged JSON
// represents validated ground truth, not pipeline introspection.

import {
  MA_FIELDS, NON_MA_FIELDS, stripInternalFields,
} from './validation-fields.js';

// Deep-clone via JSON. V4 output is plain JSON — no Dates, no functions,
// no circular refs.
function clone(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

// Walk a dot path; create intermediate objects as needed. Returns the
// parent object and the final key, or null if traversal hits a non-object.
function ensureParent(root, path) {
  const parts = path.split('.');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) {
      cur[k] = {};
    }
    cur = cur[k];
  }
  return { parent: cur, key: parts[parts.length - 1] };
}

// Resolve $primary.X → write into the selected candidate of
// primary_endpoint_candidates[]. Falls back to first candidate if none
// is marked selected, and creates the array if absent.
function ensurePrimaryCandidate(root) {
  if (!Array.isArray(root.primary_endpoint_candidates)) {
    root.primary_endpoint_candidates = [];
  }
  const arr = root.primary_endpoint_candidates;
  let sel = arr.find(c => c && c.selected);
  if (!sel) sel = arr[0];
  if (!sel) {
    sel = { selected: true };
    arr.push(sel);
  }
  return sel;
}

// Coerce a phase1a/arbitrated TEXT value into the right runtime type for
// the field. MA-field types are number | text | textarea | select |
// datalist. Numbers come back as Number (NaN if unparseable, then null).
// Booleans aren't in scope. Empty/null stays null.
function coerceForField(field, value) {
  if (value === null || value === undefined || value === '') return null;
  if (field.type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return String(value);
}

// Apply one arbitrated MA field value onto the merged JSON.
// arbitratedValue is a TEXT string from phase3_arbitrations.arbitrated_value
// (or null if `cannot_determine` style); decision = 'exact_match_confirmed'
// means leave the V4 value alone.
function applyMaField(merged, field, arbitrated, decision) {
  if (decision === 'exact_match_confirmed' || decision === 'both_correct') {
    return; // V4 value stands
  }
  const path = field.v4_path;
  if (!path) return;

  const value = coerceForField(field, arbitrated);

  if (path.startsWith('$primary.')) {
    const sel = ensurePrimaryCandidate(merged);
    const sub = path.slice('$primary.'.length);
    const { parent, key } = ensureParent(sel, sub);
    parent[key] = value;
  } else {
    const { parent, key } = ensureParent(merged, path);
    parent[key] = value;
  }
}

// Apply one Phase 2b non-MA arbitrated correction. Two regimes:
//   - text-display fields: overwrite the underlying path with the
//     correction string.
//   - json-display fields: leave the V4 structure intact, attach a
//     sibling `_arbitrator_correction` so the source-of-truth for any
//     downstream re-extraction is preserved without breaking the
//     renderer's expected shape. (Renderer drops _-prefixed keys.)
function applyNonMaField(merged, field, arbitrated, decision) {
  if (decision === 'exact_match_confirmed' || decision === 'both_correct') return;
  const path = field.v4_path;
  if (!path) return;
  const value = arbitrated == null ? null : String(arbitrated);

  if (field.display_type === 'text') {
    const { parent, key } = ensureParent(merged, path);
    parent[key] = value;
    return;
  }

  // json display — annotate without mutating structure
  const { parent, key } = ensureParent(merged, path + '_arbitrator_correction');
  // ensureParent expects the full path of the leaf; reuse for simple set
  parent[key] = value;
}

// Build the merged V4-shape JSON.
//
// args:
//   v4Json       — the raw V4 output_json from study_extractions
//   arbitrations — array of phase3_arbitrations rows for the paper
//                  ({ field_name, arbitrated_value, arbitrator_decision, ... })
//
// Phase 2b grades are not consumed directly here — the arbitrator's
// arbitrated_value for a non-MA field is what flows into the merged
// JSON. The arbitrator sees both raters' 2b corrections and decides.
export function buildMergedJson(v4Json, arbitrations) {
  if (!v4Json) return null;

  // Strip internal fields first so _critic etc. don't end up in the
  // validated ground truth.
  const merged = clone(stripInternalFields(v4Json));

  if (!Array.isArray(arbitrations) || !arbitrations.length) return merged;

  const maById  = new Map(MA_FIELDS.map(f => [f.id, f]));
  const nonMaById = new Map(NON_MA_FIELDS.map(f => [f.id, f]));

  for (const a of arbitrations) {
    const ma = maById.get(a.field_name);
    if (ma) { applyMaField(merged, ma, a.arbitrated_value, a.arbitrator_decision); continue; }
    const nm = nonMaById.get(a.field_name);
    if (nm) { applyNonMaField(merged, nm, a.arbitrated_value, a.arbitrator_decision); continue; }
    // unknown field — silently ignore (e.g. legacy bibliographic_metadata
    // composite which has no v4_path)
  }

  // Tag the merged JSON so library / renderer consumers can identify it
  merged.validation_provenance = {
    source: 'phase3_arbitration',
    arbitrated_field_count: arbitrations.length,
    merged_at: new Date().toISOString(),
  };

  return merged;
}

// Build a flat field summary suitable for the Phase 3 UI: per-field
// rows showing pipeline value, both raters' Phase 1a or Phase 2 inputs,
// match-status pills, discrepancy flag, and the arbitrator's stored
// decision (if any).
//
// Used by api/validation.js phase3_session.
export function buildPhase3FieldRows({
  v4Json,
  phase1aA, phase1aB,         // arrays of phase1a_extractions rows
  phase2aA, phase2aB,         // arrays of phase2_grades rows (phase='2a')
  phase2bA, phase2bB,         // arrays of phase2_grades rows (phase='2b')
  arbitrations,               // array of phase3_arbitrations rows
}) {
  const stripped = v4Json ? stripInternalFields(v4Json) : null;
  const arbBy = new Map((arbitrations || []).map(a => [a.field_name, a]));

  function lookup(rows, fieldId) {
    return (rows || []).find(r => r.field_name === fieldId) || null;
  }

  // pipeline_values resolution (mirrors validation-fields extractPipelineValues
  // but inlined per-row to keep one source of truth)
  function resolvePath(path) {
    if (!stripped || !path) return undefined;
    let cur = stripped;
    let p = path;
    if (p.startsWith('$primary.')) {
      const cands = Array.isArray(stripped.primary_endpoint_candidates)
        ? stripped.primary_endpoint_candidates : [];
      const sel = cands.find(c => c && c.selected) || cands[0] || null;
      if (!sel) return undefined;
      cur = sel;
      p = p.slice('$primary.'.length);
    }
    for (const part of p.split('.')) {
      if (cur == null) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  const maRows = MA_FIELDS.map(f => {
    const a1 = lookup(phase1aA, f.id);
    const b1 = lookup(phase1aB, f.id);
    return {
      field: f,
      kind: 'ma',
      pipeline_value: resolvePath(f.v4_path),
      rater_a: a1 ? { value: a1.extracted_value, cannot_determine: a1.cannot_determine, uncertain: a1.uncertain, notes: a1.notes } : null,
      rater_b: b1 ? { value: b1.extracted_value, cannot_determine: b1.cannot_determine, uncertain: b1.uncertain, notes: b1.notes } : null,
      arbitration: arbBy.get(f.id) || null,
    };
  });

  // Non-MA: Phase 2b corrections from each rater (paired by rater pair).
  const nonMaRows = NON_MA_FIELDS.map(f => {
    const a2b = lookup(phase2bA, f.id);
    const b2b = lookup(phase2bB, f.id);
    return {
      field: f,
      kind: 'non_ma',
      pipeline_value: f.v4_path ? resolvePath(f.v4_path) : undefined,
      rater_a: a2b ? { match_status: a2b.match_status, correction: a2b.correction_value, taxonomy: a2b.error_taxonomy, severity: a2b.harm_severity, notes: a2b.notes } : null,
      rater_b: b2b ? { match_status: b2b.match_status, correction: b2b.correction_value, taxonomy: b2b.error_taxonomy, severity: b2b.harm_severity, notes: b2b.notes } : null,
      arbitration: arbBy.get(f.id) || null,
    };
  });

  // Also expose Phase 2a grade pairs alongside the MA rows so the
  // arbitrator sees what each Phase 2a rater said about the same field
  // (match_status / severity / taxonomy from pipeline-comparison view).
  for (const r of maRows) {
    const a2a = lookup(phase2aA, r.field.id);
    const b2a = lookup(phase2aB, r.field.id);
    r.phase2a_a = a2a ? { match_status: a2a.match_status, correction: a2a.correction_value, taxonomy: a2a.error_taxonomy, severity: a2a.harm_severity, notes: a2a.notes } : null;
    r.phase2a_b = b2a ? { match_status: b2a.match_status, correction: b2a.correction_value, taxonomy: b2a.error_taxonomy, severity: b2a.harm_severity, notes: b2a.notes } : null;
  }

  return { maRows, nonMaRows };
}
