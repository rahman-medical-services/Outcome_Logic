// lib/validation-fields.js
//
// Single source of truth for validation-study field definitions.
//
// MA_FIELDS    — 20 meta-analysis fields graded in Phase 1a / 2a / 3
//                (PROTOCOL §3.1 — primary_ci split into ci_lower/ci_upper)
// NON_MA_FIELDS — sectional fields graded in Phase 2b only (PROTOCOL §3.2)
//
// `v4_path` syntax:
//   - "a.b.c"             → straight dot path into the V4 JSON
//   - "$primary.field"    → look up the `selected:true` candidate inside
//                            primary_endpoint_candidates[], then .field
//   - omit `v4_path`      → field is not pipeline-extractable; rater
//                            answers from PDF only (Phase 1a) and Phase 2
//                            shows "not extracted" placeholder.
//
// Field input types:
//   text | textarea | number | select | datalist | json (Phase 2 read-only
//   pretty-printed structured value)

export const MA_FIELDS = [
  // PICO
  { id: 'pico_population',         label: 'Population',                       type: 'textarea', section: 'pico',     v4_path: 'clinician_view.pico.population',                          help: 'Who was enrolled. Eligibility criteria summary.' },
  { id: 'pico_intervention',       label: 'Intervention',                     type: 'textarea', section: 'pico',     v4_path: 'clinician_view.pico.intervention',                        help: 'Including key delivery details.' },
  { id: 'pico_control',            label: 'Control / Comparator',             type: 'textarea', section: 'pico',     v4_path: 'clinician_view.pico.control' },

  // Primary outcome definition
  { id: 'primary_outcome_def',     label: 'Primary outcome: definition',      type: 'textarea', section: 'outcome',  v4_path: 'clinician_view.pico.primary_outcome',                     help: 'Event definition + measurement instrument + timepoint.' },

  // Primary result
  { id: 'primary_effect_measure',  label: 'Effect measure',                   type: 'datalist', section: 'result',   v4_path: '$primary.effect_measure', options: ['HR', 'OR', 'RR', 'RD', 'MD', 'SMD'], help: 'Pick from list, or type any other measure used in the paper.' },
  { id: 'primary_effect_estimate', label: 'Primary result: point estimate',   type: 'number',   section: 'result',   v4_path: '$primary.value',                                          help: 'Numeric point estimate of the effect.' },
  { id: 'primary_ci_lower',        label: 'Primary result: 95% CI lower',     type: 'number',   section: 'result',   v4_path: '$primary.ci_lower' },
  { id: 'primary_ci_upper',        label: 'Primary result: 95% CI upper',     type: 'number',   section: 'result',   v4_path: '$primary.ci_upper' },
  { id: 'primary_p_value',         label: 'Primary result: p-value',          type: 'text',     section: 'result',   v4_path: '$primary.p_value',                                        help: 'Verbatim string. e.g. "P<0.001", "P=0.03".' },

  // Arm-level data
  { id: 'arm_a_n',                 label: 'Sample size: intervention arm',    type: 'number',   section: 'arms',     v4_path: '$primary.arm_a_n',                                        help: 'Randomised N preferred over analysed N.' },
  { id: 'arm_b_n',                 label: 'Sample size: control arm',         type: 'number',   section: 'arms',     v4_path: '$primary.arm_b_n',                                        help: 'Randomised N preferred over analysed N.' },
  { id: 'arm_a_events',            label: 'Events: intervention arm',         type: 'number',   section: 'arms',     v4_path: '$primary.arm_a_events',                                   applies_to: 'binary or time-to-event outcomes', help: 'If continuous outcome, mark Cannot determine.' },
  { id: 'arm_b_events',            label: 'Events: control arm',              type: 'number',   section: 'arms',     v4_path: '$primary.arm_b_events',                                   applies_to: 'binary or time-to-event outcomes', help: 'If continuous outcome, mark Cannot determine.' },
  { id: 'arm_a_sd',                label: 'SD: intervention arm',             type: 'number',   section: 'arms',     v4_path: '$primary.arm_a_sd',                                       applies_to: 'continuous outcomes',              help: 'If binary or TTE, mark Cannot determine.' },
  { id: 'arm_b_sd',                label: 'SD: control arm',                  type: 'number',   section: 'arms',     v4_path: '$primary.arm_b_sd',                                       applies_to: 'continuous outcomes',              help: 'If binary or TTE, mark Cannot determine.' },

  // Methods
  { id: 'follow_up',               label: 'Follow-up duration',               type: 'text',     section: 'methods',  v4_path: 'clinician_view.follow_up_duration',                       help: 'Primary outcome assessment timepoint. Verbatim if possible.' },
  { id: 'allocation_concealment',  label: 'Allocation concealment',           type: 'textarea', section: 'methods',  v4_path: 'clinician_view.critical_appraisal.risk_of_bias_rationale', help: 'Domain extraction from the RoB rationale, or "not reported".' },
  { id: 'blinding',                label: 'Blinding',                         type: 'textarea', section: 'methods',  v4_path: 'clinician_view.critical_appraisal.risk_of_bias_rationale', help: 'Who was blinded — patients, clinicians, outcome assessors. Or "open-label" / "not reported".' },

  // Evaluative (arbitrated separately per PROTOCOL §3.3)
  // External canonical references rendered as ⓘ links — no inline definitions
  // (anchoring two raters to the same paraphrase would compress the
  // inter-rater variability the kappa analysis is meant to capture).
  { id: 'rob_overall',             label: 'Risk of Bias — overall',           type: 'select',   section: 'judgement', v4_path: 'clinician_view.critical_appraisal.risk_of_bias',          options: ['Low', 'Some concerns', 'High'], help: 'Cochrane RoB 2.0 overall judgement for the primary outcome.', reference_url: 'https://www.riskofbias.info/welcome/rob-2-0-tool', reference_label: 'Cochrane RoB 2.0' },
  { id: 'grade_certainty',         label: 'GRADE certainty of evidence',      type: 'select',   section: 'judgement', v4_path: 'clinician_view.critical_appraisal.grade_certainty',       options: ['Very low', 'Low', 'Moderate', 'High'], help: 'Your independent GRADE assessment for the primary outcome.', reference_url: 'https://gdt.gradepro.org/app/handbook/handbook.html', reference_label: 'GRADE handbook' },
];

export const MA_FIELD_IDS = MA_FIELDS.map(f => f.id);

// Non-MA fields graded in Phase 2b. Sectional, not granular — each field
// shows a whole pipeline section to the rater for a holistic match_status
// judgement. Some fields lack v4_path and the API resolves them from
// multiple top-level keys (e.g. bibliographic metadata is title + year +
// authors + journal aggregated).
export const NON_MA_FIELDS = [
  { id: 'bibliographic_metadata',         label: 'Bibliographic metadata',          section: 'metadata', display_type: 'json',     help: 'Title, year, authors, journal. Verify against the source PDF / PubMed entry.' },
  { id: 'study_design',                   label: 'Study design',                    section: 'metadata', display_type: 'text',     v4_path: 'clinician_view.study_design',                  help: 'RCT type, allocation ratio, blinding, sites, etc.' },
  { id: 'secondary_outcomes',             label: 'Secondary outcomes',              section: 'outcomes', display_type: 'json',     v4_path: 'clinician_view.secondary_outcomes',            help: 'Whole array. Check completeness, naming, direction of effect.' },
  { id: 'baseline_characteristics',       label: 'Baseline characteristics',        section: 'outcomes', display_type: 'json',     v4_path: 'clinician_view.baseline_characteristics',      help: 'Table of baseline arms. Check for clinically important imbalances.' },
  { id: 'subgroups',                      label: 'Subgroup analyses',               section: 'outcomes', display_type: 'json',     v4_path: 'clinician_view.subgroups',                     help: 'Pre-specified vs post-hoc, interaction p-values, direction.' },
  { id: 'adverse_events',                 label: 'Adverse events table',            section: 'outcomes', display_type: 'json',     v4_path: 'clinician_view.adverse_events',                help: 'Should not contain primary endpoint components (Rule 2 enforced).' },
  { id: 'primary_result_synthesis',       label: 'Primary result synthesis',        section: 'narrative', display_type: 'text',    v4_path: 'clinician_view.primary_result_synthesis',      help: 'One- or two-sentence plain-English summary with estimate, CI, p-value.' },
  { id: 'lay_summary',                    label: 'Lay summary',                     section: 'narrative', display_type: 'text',    v4_path: 'clinician_view.lay_summary',                   help: 'Patient-facing language. Direction of effect must match the result.' },
  { id: 'shared_decision_making',         label: 'Shared decision-making takeaway', section: 'narrative', display_type: 'text',    v4_path: 'clinician_view.shared_decision_making_takeaway', help: 'Hedged, option-presenting language. No "recommends" / "is better".' },
  { id: 'expert_context',                 label: 'Expert context (Node 4)',         section: 'context',  display_type: 'json',     v4_path: 'expert_context',                               help: 'Related citations, commentary, synthesis. Often partial — annotate accordingly.' },
  { id: 'extraction_flags',               label: 'Extraction flags',                section: 'flags',    display_type: 'json',     v4_path: 'extraction_flags',                             help: 'NI trial flag, suspicious_agreement, selection_uncertain, etc.' },
  { id: 'source_citations',               label: 'Source citations',                section: 'flags',    display_type: 'json',     v4_path: 'source_citations',                             help: 'Verbatim snippets + paper locations for the primary outcome and effect size.' },
];

export const NON_MA_FIELD_IDS = NON_MA_FIELDS.map(f => f.id);

// Section labels for both phases
export const SECTIONS = [
  // MA
  { id: 'pico',      label: 'PICO' },
  { id: 'outcome',   label: 'Primary outcome' },
  { id: 'result',    label: 'Primary result' },
  { id: 'arms',      label: 'Arm-level data' },
  { id: 'methods',   label: 'Methods (RoB inputs)' },
  { id: 'judgement', label: 'Methodological judgement' },
  // Non-MA
  { id: 'metadata',  label: 'Bibliographic + design' },
  { id: 'outcomes',  label: 'Outcomes & subgroups' },
  { id: 'narrative', label: 'Narrative outputs' },
  { id: 'context',   label: 'Expert context' },
  { id: 'flags',     label: 'Flags & citations' },
];

// Match status / taxonomy / pipeline_section / severity enums — kept here
// so phase2.html and the API agree without duplicating constants.
export const MATCH_STATUSES = ['exact_match', 'partial_match', 'fail', 'hallucinated', 'cannot_determine'];

// Taxonomy classes for V4 (Class 2 deprecated — single extractor).
// IDs match the strings stored in phase2_grades.error_taxonomy.
export const TAXONOMY = [
  { id: '1',  label: 'Class 1 — Recall failure (V1 missed it)' },
  { id: '3a', label: 'Class 3a — Ranking: hierarchy violation' },
  { id: '3b', label: 'Class 3b — Ranking: ambiguity' },
  { id: '4',  label: 'Class 4 — Misclassification (label/timeframe wrong)' },
  { id: '5',  label: 'Class 5 — Interpretation failure (RoB / GRADE / NI / lay direction)' },
  { id: '6',  label: 'Class 6 — Hallucination (not in source)' },
  { id: '7',  label: 'Class 7 — Formatting / enum error' },
  { id: '8',  label: 'Class 8 — Critic regression (V1 was correct, critic changed it)' },
];

export const PIPELINE_SECTIONS = [
  { id: 'extractor',       label: 'Extractor (V1)' },
  { id: 'critic',          label: 'Critic (gpt-4o-mini)' },
  { id: 'post-processing', label: 'Post-processing (deterministic JS)' },
];

export const ROOT_CAUSE_STAGES = [
  { id: 'extractor',         label: 'Extractor — coverage / labelling' },
  { id: 'critic',            label: 'Critic — rule prompt or scope' },
  { id: 'schema_design',     label: 'Schema — no slot for the right value' },
  { id: 'prompt_guidance',   label: 'Prompt guidance — ambiguous / missing rule' },
  { id: 'document_structure', label: 'Document structure — no pipeline fix possible' },
];

// V4 path resolver. Used both server-side (api/validation.js) and
// optionally client-side. Shared here so both agree.
export function resolveV4Path(v4, path) {
  if (!path || v4 == null) return undefined;
  let cur = v4;
  let p = path;
  if (p.startsWith('$primary.')) {
    const cands = Array.isArray(v4.primary_endpoint_candidates) ? v4.primary_endpoint_candidates : [];
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

// Strip internal/provenance fields from V4 output before sending to a
// Phase 2 rater. PROTOCOL §2.3 requires the _critic audit trail be hidden.
// We strip any key starting with '_' — this captures _critic, _<field>_source,
// _md_fabrication_blocked, _outcome_type_source, etc. without an explicit
// allow-list. Forward-compatible: any future internal key prefixed with _
// will be hidden automatically.
export function stripInternalFields(obj) {
  if (Array.isArray(obj)) return obj.map(stripInternalFields);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k === 'string' && k.startsWith('_')) continue;
      out[k] = stripInternalFields(v);
    }
    return out;
  }
  return obj;
}

// Build a plain object of pipeline values keyed by field_id, suitable for
// rendering to a Phase 2a or 2b rater. For NON_MA bibliographic_metadata
// (no single v4_path), aggregate from top-level fields.
export function extractPipelineValues(v4, fields) {
  const out = {};
  if (!v4) return out;
  const stripped = stripInternalFields(v4);
  for (const f of fields) {
    if (f.id === 'bibliographic_metadata') {
      out[f.id] = {
        title:    stripped.title || stripped.bibliographic?.title || null,
        year:     stripped.year  || stripped.bibliographic?.year  || null,
        authors:  stripped.authors || stripped.bibliographic?.authors || null,
        journal:  stripped.journal || stripped.bibliographic?.journal || null,
      };
    } else if (f.v4_path) {
      out[f.id] = resolveV4Path(stripped, f.v4_path);
    } else {
      out[f.id] = undefined;
    }
  }
  return out;
}
