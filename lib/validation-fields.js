// lib/validation-fields.js
//
// Single source of truth for the 20 meta-analysis (MA) fields graded
// in Phase 1a / 2a / 3 of the validation study (PROTOCOL.md §3.1).
//
// PROTOCOL §3.1 lists 19 fields with `primary_ci` as one row;
// per Session 20 design call (2026-04-29), CI is split into
// `primary_ci_lower` and `primary_ci_upper` for cleaner export and
// independent grading. Net count: 20.
//
// Field input types:
//   text         — single-line free text
//   textarea     — multi-line free text
//   number       — numeric input (still stored as TEXT in DB; cast in app)
//   select       — closed dropdown (no override)
//   datalist     — dropdown suggestions but rater can type anything
//                  (used for primary_effect_measure per design call)
//
// `applies_to`: optional hint for the rater. The schema does NOT
// enforce conditionality — every rater fills every field, with
// `cannot_determine: true` for non-applicable fields. Prevents the
// form from accidentally guiding the rater (blinding).

export const MA_FIELDS = [
  // PICO
  { id: 'pico_population',         label: 'Population',                       type: 'textarea', section: 'pico',     help: 'Who was enrolled. Eligibility criteria summary.' },
  { id: 'pico_intervention',       label: 'Intervention',                     type: 'textarea', section: 'pico',     help: 'Including key delivery details.' },
  { id: 'pico_control',            label: 'Control / Comparator',             type: 'textarea', section: 'pico' },

  // Primary outcome definition
  { id: 'primary_outcome_def',     label: 'Primary outcome: definition',      type: 'textarea', section: 'outcome',  help: 'Event definition + measurement instrument + timepoint.' },

  // Primary result
  { id: 'primary_effect_measure',  label: 'Effect measure',                   type: 'datalist', section: 'result',   options: ['HR', 'OR', 'RR', 'RD', 'MD', 'SMD'], help: 'Pick from list, or type any other measure used in the paper.' },
  { id: 'primary_effect_estimate', label: 'Primary result: point estimate',   type: 'number',   section: 'result',   help: 'Numeric point estimate of the effect.' },
  { id: 'primary_ci_lower',        label: 'Primary result: 95% CI lower',     type: 'number',   section: 'result' },
  { id: 'primary_ci_upper',        label: 'Primary result: 95% CI upper',     type: 'number',   section: 'result' },
  { id: 'primary_p_value',         label: 'Primary result: p-value',          type: 'text',     section: 'result',   help: 'Verbatim string. e.g. "P<0.001", "P=0.03".' },

  // Arm-level data
  { id: 'arm_a_n',                 label: 'Sample size: intervention arm',    type: 'number',   section: 'arms',     help: 'Randomised N preferred over analysed N.' },
  { id: 'arm_b_n',                 label: 'Sample size: control arm',         type: 'number',   section: 'arms',     help: 'Randomised N preferred over analysed N.' },
  { id: 'arm_a_events',            label: 'Events: intervention arm',         type: 'number',   section: 'arms',     applies_to: 'binary or time-to-event outcomes', help: 'If continuous outcome, mark Cannot determine.' },
  { id: 'arm_b_events',            label: 'Events: control arm',              type: 'number',   section: 'arms',     applies_to: 'binary or time-to-event outcomes', help: 'If continuous outcome, mark Cannot determine.' },
  { id: 'arm_a_sd',                label: 'SD: intervention arm',             type: 'number',   section: 'arms',     applies_to: 'continuous outcomes',              help: 'If binary or TTE, mark Cannot determine.' },
  { id: 'arm_b_sd',                label: 'SD: control arm',                  type: 'number',   section: 'arms',     applies_to: 'continuous outcomes',              help: 'If binary or TTE, mark Cannot determine.' },

  // Methods
  { id: 'follow_up',               label: 'Follow-up duration',               type: 'text',     section: 'methods',  help: 'Primary outcome assessment timepoint. Verbatim if possible.' },
  { id: 'allocation_concealment',  label: 'Allocation concealment',           type: 'textarea', section: 'methods',  help: 'Verbatim description from the methods section, or "not reported".' },
  { id: 'blinding',                label: 'Blinding',                         type: 'textarea', section: 'methods',  help: 'Who was blinded — patients, clinicians, outcome assessors. Or "open-label" / "not reported".' },

  // Evaluative (arbitrated separately per PROTOCOL §3.3)
  // External canonical references rendered as ⓘ links — no inline definitions
  // (anchoring two raters to the same paraphrase would compress the
  // inter-rater variability the kappa analysis is meant to capture).
  { id: 'rob_overall',             label: 'Risk of Bias — overall',           type: 'select',   section: 'judgement', options: ['Low', 'Some concerns', 'High'], help: 'Cochrane RoB 2.0 overall judgement for the primary outcome.', reference_url: 'https://www.riskofbias.info/welcome/rob-2-0-tool', reference_label: 'Cochrane RoB 2.0' },
  { id: 'grade_certainty',         label: 'GRADE certainty of evidence',      type: 'select',   section: 'judgement', options: ['Very low', 'Low', 'Moderate', 'High'], help: 'Your independent GRADE assessment for the primary outcome.', reference_url: 'https://gdt.gradepro.org/app/handbook/handbook.html', reference_label: 'GRADE handbook' },
];

export const MA_FIELD_IDS = MA_FIELDS.map(f => f.id);

export const SECTIONS = [
  { id: 'pico',      label: 'PICO' },
  { id: 'outcome',   label: 'Primary outcome' },
  { id: 'result',    label: 'Primary result' },
  { id: 'arms',      label: 'Arm-level data' },
  { id: 'methods',   label: 'Methods (RoB inputs)' },
  { id: 'judgement', label: 'Methodological judgement' },
];
