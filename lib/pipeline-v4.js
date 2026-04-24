// lib/pipeline-v4.js
// V4: single-node extractor (V1 architecture) + gpt-4o-mini critic + local merge
//
// Architecture:
//   Node 1: Gemini flash-lite (identical to V1, thinkingBudget:1024) — ~15–20s
//   Node 2: gpt-4o-mini critic (paper text minus References + draft JSON) — ~12–15s
//   Node 3: local patch merge — <1s
//   Total: ~27–35s — fits within 60s Vercel limit.
//
// The critic performs two passes:
//   PASS A — Rule compliance (8 deterministic checks → auto-patched onto JSON)
//   PASS B — Plausibility (holistic review → quality_notes, surfaced in UI, not auto-patched)
//
// Critic output is stored in result._critic for UI display and audit.
//
// V4 independence: callGPT4Mini is self-contained here — it does NOT import from pipeline.js
// so that changes to V3's callOpenAI cannot alter V4 critic behaviour.

import { runPipelineV1 } from './pipeline-v1.js';

const OPENAI_API_BASE     = 'https://api.openai.com/v1/chat/completions';
const OPENAI_CRITIC_MODEL = 'gpt-4o-mini';

// ─────────────────────────────────────────────
// GPT-4O-MINI CALL — critic node only
// Duplicated for V4 independence. Retries on 429/500/503, fails fast on 4xx.
// ─────────────────────────────────────────────
async function callGPT4Mini(systemInstruction, userContent, options = {}) {
  const body = {
    model:                 OPENAI_CRITIC_MODEL,
    temperature:           options.temperature ?? 0,
    max_completion_tokens: options.max_completion_tokens ?? 4000,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user',   content: userContent },
    ],
  };

  const MAX_RETRIES = 3;
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 500, 8000);
      await new Promise(r => setTimeout(r, delay));
      console.log(`[callGPT4Mini] Retry ${attempt}/${MAX_RETRIES - 1} after ${Math.round(delay)}ms`);
    }
    try {
      const res = await fetch(OPENAI_API_BASE, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err     = new Error(`GPT4Mini ${res.status}: ${errText.slice(0, 200)}`);
        err.status    = res.status;
        if ([400, 401, 403].includes(res.status)) throw err;
        lastError = err;
        continue;
      }
      const data   = await res.json();
      const text   = data.choices?.[0]?.message?.content;
      const reason = data.choices?.[0]?.finish_reason;
      if (!text) throw new Error('GPT4Mini: empty response content');
      if (reason === 'length') console.warn('[callGPT4Mini] finish_reason=length — response may be truncated');
      return text;
    } catch (err) {
      if ([400, 401, 403].includes(err.status)) throw err;
      lastError = err;
    }
  }
  throw lastError || new Error('GPT4Mini: all retries exhausted');
}

// ─────────────────────────────────────────────
// TEXT STRIPPING UTILITIES
//
// stripReferences: used for BOTH Node 1 (extractor) and Node 2 (critic).
//   Removes the reference list — no clinical data, reduces tokens.
//   Matches the LAST occurrence of a References heading to avoid false matches.
//
// stripForCritic: additional stripping for Node 2 only.
//   After stripping references, also removes Introduction (pre-Methods) and
//   Discussion/Conclusions (post-Results). Keeps Abstract + Methods + Results,
//   which is all the critic needs for its 8-rule checks.
//   Target: reduce critic paper input from ~23k → ~8-12k chars to stay within 60s.
// ─────────────────────────────────────────────
function stripReferences(text) {
  const pattern = /\n(References|REFERENCES|Bibliography|BIBLIOGRAPHY|Reference List|REFERENCE LIST)\s*\n/g;
  let lastMatch = null;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    lastMatch = match;
  }
  if (lastMatch) {
    const saved = text.length - lastMatch.index;
    console.log(`[V4] Stripped references (saved ${saved} chars)`);
    return text.slice(0, lastMatch.index);
  }
  return text;
}

function stripForCritic(text) {
  let result = stripReferences(text);
  const before = result.length;

  // Strip Discussion / Conclusions onwards.
  // MINIMUM POSITION GUARD: structured abstracts often contain a "Conclusions" subsection
  // in the first 10 000 chars. We only treat a heading as a real section break if it
  // appears after 15 000 chars — well past any abstract and deep enough into the body
  // to be a genuine post-Results section heading.
  const MIN_DISC_POSITION = 15000;
  const discMatch = result.match(/\n(Discussion|DISCUSSION|Conclusions|CONCLUSIONS|Comment|COMMENT|Interpretation|INTERPRETATION|Summary and Conclusions)\s*\n/);
  if (discMatch && discMatch.index > MIN_DISC_POSITION) {
    result = result.slice(0, discMatch.index);
  } else if (discMatch) {
    console.log(`[V4 Critic] Discussion/Conclusions heading at position ${discMatch.index} — below threshold, not stripped (likely structured abstract)`);
  }

  // Strip Introduction (everything between start and Methods heading, keeping first ~2500 chars as abstract preamble).
  // Only strip if Methods heading found clearly beyond the abstract.
  const methodsMatch = result.match(/\n(Methods|METHODS|Patients and Methods|PATIENTS AND METHODS|Study Design|STUDY DESIGN|Materials and Methods|MATERIALS AND METHODS|Subjects and Methods|SUBJECTS AND METHODS)\s*\n/);
  if (methodsMatch && methodsMatch.index > 2500) {
    const preamble = result.slice(0, 2500);
    const methodsOnward = result.slice(methodsMatch.index);
    result = preamble + '\n\n[Introduction omitted]\n\n' + methodsOnward;
  }

  const saved = before - result.length;
  console.log(`[V4 Critic] Stripped for critic: ${result.length} chars (saved additional ${saved} chars vs ref-only strip)`);
  return result;
}

// ─────────────────────────────────────────────
// CRITIC SYSTEM PROMPT
// Task instructions live in the system prompt (fixed across calls) so OpenAI
// can cache them. User content contains only variable data (paper + JSON).
// ─────────────────────────────────────────────
const CRITIC_SYSTEM = `You are a clinical trial extraction critic reviewing an AI-generated structured extraction.
Your job is to find errors — not to confirm that the extraction looks reasonable.
You have access to the paper text (Abstract, Methods, Results — Introduction, Discussion, and References are omitted).
Output STRICTLY valid JSON as defined below. No preamble, no markdown fences, no text outside the JSON.

Review the extraction against the paper text. Perform two passes.

═══════════════════════════════════════════════════════
PASS A — RULE COMPLIANCE (13 checks — patches auto-applied)
For each violation found, add a patch entry. Only add a patch if you are certain the correction is right
and can cite the paper text. Do not patch speculatively.
═══════════════════════════════════════════════════════

RULE 1 — CI COMPLETENESS
Check primary_endpoint_candidates[*].ci_lower and ci_upper.
ONLY patch if the current value is null. If ci_lower or ci_upper already contains a number, do NOT
generate a patch for it — leave it unchanged regardless of what the paper says.
If a value IS null and the CI is explicitly stated in Results text or a table: patch it.
Example path: "primary_endpoint_candidates[0].ci_lower"
MULTI-CANDIDATE GUARD: When multiple candidates coexist (e.g. one HR candidate, one RD candidate),
each CI must come from the same paper row/analysis as that candidate's effect_measure. Do NOT
transplant a CI from one candidate's row onto a different candidate. If you cannot unambiguously
confirm which paper row the CI belongs to, do NOT patch.

RULE 2 — AE CONTAMINATION
Step 1: Build the PRIMARY endpoint component list only:
  - Read clinician_view.pico.primary_outcome — extract named components.
    For a simple primary (e.g. "all-cause mortality"), that one event is excluded.
    For a named composite (e.g. "death, stroke, or MI"), each named component is excluded.
  - Do NOT include secondary_outcomes in this list. Secondary endpoints may legitimately
    appear in both the outcomes section and the AE table — do not remove them.
Step 2: For each row in clinician_view.adverse_events.rows, check whether the event name
  matches a PRIMARY component from Step 1 explicitly and unambiguously.
  Near-exact means the same clinical event (e.g. "death" matches "all-cause mortality";
  "MI" matches "myocardial infarction"). Do NOT remove based on loose interpretation.
  When in doubt, leave the row in.
Step 3: Remove only confirmed primary-component matches.
  - Patch "clinician_view.adverse_events.rows" to the cleaned array.
  - Only patch "clinician_view.adverse_events.has_data" to false if the cleaned array is empty.
    If any rows remain after cleaning, do NOT touch has_data.

RULE 3 — SUBGROUP GROUPING
Check clinician_view.subgroups.items[*].arms.
Each item must have ≥2 arms. If two items represent complementary strata of the same variable
(e.g. one item "Age <75" with one arm, and another item "Age ≥75" with one arm), they must be merged
into one item with two arms.
Patch: set "clinician_view.subgroups.items" to the corrected array.

RULE 4 — ROB CALIBRATION
Check clinician_view.critical_appraisal.risk_of_bias.
If "Unclear": patch based on Cochrane domain defaults from the Methods text:
  Randomisation — Low if method stated (computer-generated, block, minimisation); Moderate if only "randomised".
  Allocation concealment — Low if central/pharmacy/SNOSE; Moderate if not described.
  Blinding — Low if patients AND providers blinded; Moderate if open-label + objective outcome; High if open-label + subjective outcome.
  Outcome adjudication — Low if independent blinded committee stated; Moderate if unclear.
  Attrition — Low if <10%; Moderate if 10-20%; High if >20% or differential.
  Overall: LOW if ≥4 domains Low and no High; MODERATE if 1-2 Moderate and no High; HIGH if any High.
If the value seems clearly wrong given what the Methods section states, patch with reasoning.
Path: "clinician_view.critical_appraisal.risk_of_bias"

RULE 5 — GRADE CALIBRATION
Check clinician_view.critical_appraisal.grade_certainty.
"Very Low" for an RCT: always patch (to "Low" if ≥2 serious limitations, else "Moderate").
"Low" for a large well-conducted RCT with only one limitation: consider patching to "Moderate".
Path: "clinician_view.critical_appraisal.grade_certainty"

RULE 6 — COI / FUNDING (MANDATORY PATCH)
Check clinician_view.critical_appraisal.coi_funding.
If it is null AND a funder, sponsor, or industry supporter is explicitly named in the paper text
(Methods, Funding statement, Acknowledgements, Disclosures): you MUST generate a patch.
Do NOT record funding only in quality_notes — generate the patch.
Format: "[Sponsor]: [role — e.g. funded trial design and data collection]"
Path: "clinician_view.critical_appraisal.coi_funding"
If coi_funding is already non-null (any non-empty string), do NOT overwrite it.

RULE 7 — PER-ARM VALUES (chart rendering)
Check primary_endpoint_candidates[*].arm_a_value and arm_b_value.
If either is null but a per-arm event rate, mean, or median is stated in Results: patch to the number.
- Binary outcome: event rate as a percentage (e.g. 5.4 for 5.4%)
- Continuous: mean or median value
- Survival: survival % at primary timepoint
Paths: "primary_endpoint_candidates[0].arm_a_value", "primary_endpoint_candidates[0].arm_b_value"

RULE 8 — META-ANALYSIS COMPLETENESS
Check primary_endpoint_candidates[*]: arm_a_n, arm_b_n, effect_measure.

Step 1 — Sample sizes: if arm_a_n or arm_b_n is null, extract from Results text or baseline table.
  Look in: (1) Table 1 column headers e.g. "TAVI (n=496)"; (2) CONSORT flow diagram;
  (3) Results opening sentence. Patch if found.
  Paths: "primary_endpoint_candidates[0].arm_a_n", "primary_endpoint_candidates[0].arm_b_n"

Step 2 — effect_measure: verify it matches the actual statistic reported.
  Correct misclassifications (e.g. "OR" when the paper reports an HR; "RR" when it is an MD).

DO NOT patch arm_a_events or arm_b_events. These are computed deterministically in the
pipeline after your patches are applied, using arm_n × arm_value / 100. Patching them here
introduces hallucination risk — the arithmetic will be done in code instead.

RULE 9 — SECONDARY ENDPOINT COMPLETENESS
Check clinician_view.pico.secondary_outcomes[] against primary_endpoint_candidates[*].label.
For each named secondary outcome that:
  (a) appears in pico.secondary_outcomes AND
  (b) has result data reported in the paper text (at minimum: a point estimate, p-value, or per-arm rates) AND
  (c) does NOT have a matching entry in primary_endpoint_candidates (match by label similarity)
— add it as a new entry in primary_endpoint_candidates with all available fields populated:
  label, arm_a_value, arm_b_value, point_estimate, ci_lower, ci_upper, p_value, effect_measure, selected: false.
  Set any fields you cannot find to null — do not fabricate values.
Patch: set "primary_endpoint_candidates" to the complete updated array (all existing entries + new entries).

CRITICAL — PRESERVE EXISTING ENTRIES: When constructing the patch array, copy ALL fields from
each existing candidate VERBATIM. Do NOT reconstruct existing candidates from scratch.
In particular: the "value" field (point estimate) MUST be preserved from the original.
Omitting any field from an existing candidate is a data loss error.
Only new secondary candidates should have fewer fields — existing candidates must be complete.

Do NOT add a secondary outcome if its results are absent from the paper text (i.e. listed but not yet reported).
Do NOT patch if all secondary outcomes with data are already represented.

RULE 10 — NI TRIAL FRAMING
Determine if this is a non-inferiority trial: look for "non-inferiority", "NI margin", or "margin" in
reportMeta fields or primary_result_synthesis.
If NI trial:
  Step 1 — Extract the stated NI margin from the paper text (e.g. "NI margin was 1.14", "margin of 10%").
  Step 2 — Find ci_upper of the primary candidate (or the margin-side CI bound for the relevant direction).
  Step 3 — Determine NI result:
    For ratio scales (HR, OR, RR): NI demonstrated if ci_upper < ni_margin.
    For difference scales (MD, RD): NI demonstrated if ci_upper < ni_margin (upper bound within margin).
  Step 4 — Check reportMeta.primary_result_synthesis. If it inverts the logic (claims NI demonstrated when
    ci_upper > ni_margin, or claims NI not demonstrated when ci_upper < ni_margin), patch with the correct statement.
  Example: NI margin = 1.14, ci_upper = 0.79 → 0.79 < 1.14 → NI demonstrated. If synthesis says otherwise, patch it.
Path: "reportMeta.primary_result_synthesis"
Only patch if the error is clear and you can cite both the NI margin and ci_upper from the text.

RULE 11 — LAY SUMMARY DIRECTION
Check patient_view.lay_summary and patient_view.shared_decision_making_takeaway against the primary result.
  Significant result (p < 0.05): summary may state direction of benefit/harm. Must NOT use "is better",
    "recommends", "confirms", or "establishes".
  Non-significant result (p ≥ 0.05 or CI crosses null value): summary MUST NOT claim the treatment
    "reduces", "improves", "is better than", or "is superior to". Required language: "did not show a
    statistically significant difference" or equivalent.
  NI trial specifically: "non-inferior" is correct when NI is demonstrated; do not use "equivalent" or "better".
If lay_summary contradicts the actual direction or significance of the primary result, patch it with
a corrected statement that accurately reflects the result without overclaiming.
Paths: "patient_view.lay_summary", "patient_view.shared_decision_making_takeaway"

RULE 12 — OUTCOME TYPE
For each primary_endpoint_candidates entry, set outcome_type based on effect_measure:
  "time-to-event" — effect_measure is HR. ALWAYS. arm_a_events being populated does NOT change this.
                    Also applies if paper reports Kaplan-Meier curves or log-rank test.
  "binary"        — effect_measure is OR, RR, or RD (not HR).
  "continuous"    — effect_measure is MD or SMD; or paper reports means ± SD per arm.
  "ordinal"       — paper uses proportional odds model or ordinal regression.
Only patch if outcome_type is currently absent or null. Do NOT overwrite a correct existing value.
Do NOT downgrade time-to-event to binary — HR outcomes are always time-to-event.
Patch each candidate individually.
Paths: "primary_endpoint_candidates[0].outcome_type", "primary_endpoint_candidates[1].outcome_type", etc.

RULE 13 — SD PER ARM (audit flag only — do NOT patch)
For continuous outcomes, arm_a_sd and arm_b_sd are required for meta-analysis pooling.
Do NOT generate patches for these fields. The risk of cross-variable contamination is too high:
an LLM scanning a table for an SD value may retrieve the SD of age, BMI, or another baseline
characteristic rather than the SD of the outcome measurement. This has been confirmed as a
systematic failure mode.

If arm_a_sd or arm_b_sd is missing, the meta_analysis_gaps audit will flag it automatically.
Do NOT add any patch with path containing "arm_a_sd" or "arm_b_sd".

═══════════════════════════════════════════════════════
PASS B — PLAUSIBILITY (holistic review)
Only flag genuine errors you can cite with specific paper text.
Maximum 6 quality_notes total.
CRITICAL: Do NOT write a note if the extraction is correct. "The primary endpoint is correctly
identified" is not a note — it is noise. Every note must describe a specific error or omission.
If you have nothing wrong to report, write zero notes. Quality over quantity.
IMPORTANT: If Pass B identifies a fixable error not caught by the rules above,
add a patch for it as well as a quality note. Do not leave fixable errors as notes only.
═══════════════════════════════════════════════════════

Check for genuine errors only:
1. Is the primary endpoint WRONG? Only flag if it contradicts what the paper labels "primary".
2. Does the PICO contain a factual error — wrong drug, wrong population, wrong comparator?
3. Is the trial design classification factually wrong?
4. Are there specific numeric values in the JSON that contradict the paper text?
   Only flag if you can cite the exact discrepancy.
5. Is there a secondary endpoint with reported results in the text that was missed by Rule 9?
   If fixable, add a patch. If not, add a note.

═══════════════════════════════════════════════════════
OUTPUT — strict JSON, no markdown fences:
═══════════════════════════════════════════════════════
{
  "patches": [
    {
      "path": "dot.notation.path or array[N].field",
      "current_value": null,
      "corrected_value": null,
      "reason": "One sentence citing the paper text that supports this correction.",
      "rule": "CI completeness | AE contamination | subgroup grouping | RoB | GRADE | COI | per-arm values | meta-analysis completeness | secondary endpoint completeness | NI framing | lay summary direction | outcome type | SD per arm"
    }
  ],
  "quality_notes": [
    "String — one specific observation per note, with a paper text citation. Max 6."
  ],
  "violations_found": 0
}`;

// ─────────────────────────────────────────────
// NUMERIC COERCION — runs first, before any back-calculation
// V1 LLM sometimes outputs integers as strings (e.g. n_arm_a: "602").
// This pass coerces all count/size fields to Number so arithmetic is safe.
// ─────────────────────────────────────────────
function coerceNumericFields(result) {
  const cands = result?.primary_endpoint_candidates;
  if (!Array.isArray(cands)) return;

  const numericFields = [
    'n_arm_a', 'n_arm_b', 'arm_a_n', 'arm_b_n',
    'events_arm_a', 'events_arm_b', 'arm_a_events', 'arm_b_events',
    'n_randomised_arm_a', 'n_randomised_arm_b', 'total_events',
  ];

  cands.forEach(c => {
    numericFields.forEach(f => {
      if (typeof c[f] === 'string' && c[f] !== '' && !isNaN(c[f])) {
        c[f] = Number(c[f]);
      }
    });
  });
}

// ─────────────────────────────────────────────
// BACK-CALCULATION — events — deterministic JS arithmetic
// Runs AFTER applyPatches() and coerceNumericFields(), BEFORE auditMetaAnalysisFields().
//
// Priority order per arm:
//   1. If events_arm_a (V1 legacy direct extraction) is non-null → copy to arm_a_events,
//      tag source as "extracted". Preserves direct paper extraction over arithmetic.
//   2. If arm_a_events still null AND arm_n + arm_value (%) both present → back-calculate,
//      tag source as "back-calculated". Only fires when no direct extraction exists.
//
// Continuous and ordinal outcomes: skipped — events not applicable.
// Provenance tag: _arm_a_events_source / _arm_b_events_source on each candidate.
// ─────────────────────────────────────────────
function backCalculateEvents(result) {
  const cands = result?.primary_endpoint_candidates;
  if (!Array.isArray(cands)) return;

  cands.forEach(c => {
    // Only back-calculate for outcome types where event counts are meaningful
    const isApplicable = c.outcome_type === 'binary' ||
                         c.outcome_type === 'time-to-event' ||
                         c.outcome_type === 'time_to_event' ||
                         (c.effect_measure && ['OR', 'RR', 'RD', 'HR'].includes(c.effect_measure));
    if (!isApplicable) return;

    // Resolve arm n — critic may have patched arm_a_n; V1 uses n_arm_a
    const nA = c.arm_a_n ?? (c.n_arm_a != null ? Number(c.n_arm_a) : null);
    const nB = c.arm_b_n ?? (c.n_arm_b != null ? Number(c.n_arm_b) : null);

    // ARM A — Priority 1: copy direct extraction from V1 legacy field
    if (c.arm_a_events == null && c.events_arm_a != null) {
      c.arm_a_events = Number(c.events_arm_a);
      c._arm_a_events_source = 'extracted';
    }
    // ARM A — Priority 2: back-calculate only when no direct extraction exists
    if (c.arm_a_events == null && nA != null && c.arm_a_value != null) {
      const rate = parseFloat(c.arm_a_value);
      if (!isNaN(rate) && rate >= 0 && rate <= 100) {
        c.arm_a_events = Math.round(nA * rate / 100);
        c._arm_a_events_source = 'back-calculated';
      }
    }

    // ARM B — Priority 1: copy direct extraction from V1 legacy field
    if (c.arm_b_events == null && c.events_arm_b != null) {
      c.arm_b_events = Number(c.events_arm_b);
      c._arm_b_events_source = 'extracted';
    }
    // ARM B — Priority 2: back-calculate only when no direct extraction exists
    if (c.arm_b_events == null && nB != null && c.arm_b_value != null) {
      const rate = parseFloat(c.arm_b_value);
      if (!isNaN(rate) && rate >= 0 && rate <= 100) {
        c.arm_b_events = Math.round(nB * rate / 100);
        c._arm_b_events_source = 'back-calculated';
      }
    }
  });
}

// ─────────────────────────────────────────────
// BACK-CALCULATION — SD — Cochrane §6.5.2 method
// Runs AFTER backCalculateEvents(), BEFORE normaliseOutcomeTypes().
//
// For continuous outcomes:
//   SE  = (ci_upper − ci_lower) / (2 × 1.96)
//   pooled_SD = SE / √(1/nA + 1/nB)
//
// Sets BOTH arm_a_sd and arm_b_sd to the pooled SD (equal by this method).
// Tags with _sd_source.
//
// PLAUSIBILITY CHECK: if arm_a_sd is already present, compute the back-calc
// value anyway and compare. If they differ by >2× (ratio outside 0.5–2.0),
// the extracted SD is almost certainly cross-variable contamination (e.g. age SD).
// In that case: override with the back-calculated value and flag _sd_conflict.
// Confirmed failure mode: ORBITA arm_a_sd=178.7 (baseline exercise time SD)
// vs back-calc=90.2 (from CI and N) — ratio 1.98 just passes; >2× would override.
// ─────────────────────────────────────────────
function backCalculateSD(result) {
  const cands = result?.primary_endpoint_candidates;
  if (!Array.isArray(cands)) return;

  cands.forEach(c => {
    // Only for continuous outcomes
    const isContinuous = c.outcome_type === 'continuous' ||
                         ['MD', 'SMD'].includes(c.effect_measure);
    if (!isContinuous) return;

    const nA  = c.arm_a_n ?? (c.n_arm_a != null ? Number(c.n_arm_a) : null);
    const nB  = c.arm_b_n ?? (c.n_arm_b != null ? Number(c.n_arm_b) : null);
    const ciL = c.ci_lower;
    const ciU = c.ci_upper;

    if (nA == null || nB == null || ciL == null || ciU == null) return;
    if (nA <= 0 || nB <= 0) return;

    const se = (ciU - ciL) / (2 * 1.96);
    if (se <= 0) return; // degenerate or inverted CI

    const pooledSD = se / Math.sqrt((1 / nA) + (1 / nB));
    if (!isFinite(pooledSD) || pooledSD <= 0) return;

    const rounded = Math.round(pooledSD * 10) / 10; // 1 d.p.

    if (c.arm_a_sd != null) {
      // Plausibility check: compare existing SD with back-calculated value
      const existing = parseFloat(c.arm_a_sd);
      if (!isNaN(existing) && existing > 0) {
        const ratio = Math.max(existing, rounded) / Math.min(existing, rounded);
        if (ratio > 1.75) {
          // Existing SD is implausible — almost certainly cross-variable contamination
          console.warn(`[V4 backCalculateSD] Contamination detected on "${c.label}": existing SD=${existing}, back-calc=${rounded} (ratio=${ratio.toFixed(1)}×). Overriding.`);
          c._sd_conflict    = `extracted SD=${existing} vs back-calc SD=${rounded} (ratio ${ratio.toFixed(1)}×) — back-calculated value used`;
          c.arm_a_sd        = rounded;
          c.arm_b_sd        = rounded;
          c._sd_source      = 'back-calculated from CI and N (Cochrane §6.5.2) — overrode implausible extracted value';
        }
        // If ratio ≤ 2.0, trust the extracted value (minor discrepancy, no override)
      }
      return; // Either kept existing or overrode — don't fall through
    }

    // arm_a_sd was null — populate from back-calculation
    c.arm_a_sd   = rounded;
    c.arm_b_sd   = rounded;
    c._sd_source = 'back-calculated from CI and N (Cochrane §6.5.2)';
    console.log(`[V4 backCalculateSD] ${c.label || 'candidate'}: pooledSD=${rounded} from CI=(${ciL}–${ciU}), N=(${nA},${nB})`);
  });
}

// ─────────────────────────────────────────────
// OUTCOME TYPE NORMALISATION
// Standardises outcome_type to underscore form throughout all candidates.
// V1 schema uses 'time_to_event' (underscore). Critic patches occasionally
// produce 'time-to-event' (hyphen). This creates cosmetic instability across
// runs and breaks rule-based downstream logic. Canonical form: underscore.
// ─────────────────────────────────────────────
function normaliseOutcomeTypes(result) {
  const cands = result?.primary_endpoint_candidates;
  if (!Array.isArray(cands)) return;

  cands.forEach(c => {
    if (c.outcome_type === 'time-to-event') {
      c.outcome_type = 'time_to_event';
    }
  });
}

// ─────────────────────────────────────────────
// AMBIGUOUS SELECTION FLAG
// Detects papers where multiple plausible primary analyses exist with different
// effect measures — e.g. a NI trial reporting both RD (primary) and HR (secondary),
// where both are extractable and the pipeline may select either across runs.
//
// Sets extraction_flags.selection_uncertain = true with a descriptive note when:
//   - ≥2 candidates have non-null values AND
//   - those candidates have ≥2 different effect measures
//
// This is an "obvious flag" for clinical review — tells the user that the pipeline
// is not malfunctioning but the paper itself has multiple defensible analyses and
// a human decision is needed to lock in the primary.
// ─────────────────────────────────────────────
function flagAmbiguousSelection(result) {
  const flags = result?.extraction_flags;
  const cands = result?.primary_endpoint_candidates;
  if (!flags || !Array.isArray(cands)) return;

  // Already flagged by V1 extractor — respect it
  if (flags.selection_uncertain) return;

  // Candidates with actual numeric results
  const withData = cands.filter(c => c.value != null || c.arm_a_value != null);
  if (withData.length < 2) return;

  // Check for ≥2 distinct effect measures among those candidates
  const measures = [...new Set(withData.map(c => c.effect_measure).filter(Boolean))];
  if (measures.length < 2) return;

  // Build a clear human-readable note
  const candidateSummary = withData
    .map(c => `"${c.label || 'unlabelled'}" (${c.effect_measure || '?'}, value=${c.value ?? c.arm_a_value})`)
    .join('; ');

  flags.selection_uncertain      = true;
  flags.selection_uncertain_note = `Multiple plausible primary analyses with different effect measures detected: ${candidateSummary}. ` +
    `Pipeline may select either across runs. Human review required to confirm which analysis is the intended primary.`;

  console.log(`[V4 flagAmbiguousSelection] selection_uncertain flagged: ${measures.join(' vs ')}`);
}

// ─────────────────────────────────────────────
// CANDIDATE FIELD RESTORATION — guards against Rule 9 data loss
// When the critic patches the entire primary_endpoint_candidates array (to add secondary
// endpoints), it sometimes reconstructs existing candidates and drops fields like `value`.
// This function merges the pre-patch snapshot back into each existing candidate so that
// no original field is silently lost. New candidates added by the critic are left as-is.
// Matching: by array index first; fallback to label match for shifted arrays.
// ─────────────────────────────────────────────
function restoreDroppedCandidateFields(result, snapshot) {
  const cands    = result?.primary_endpoint_candidates;
  const origCands = snapshot?.primary_endpoint_candidates;
  if (!Array.isArray(cands) || !Array.isArray(origCands)) return;

  cands.forEach((c, i) => {
    // Find the corresponding original candidate (by index, then by label)
    let orig = origCands[i];
    if (!orig || orig.label !== c.label) {
      orig = origCands.find(o => o.label === c.label);
    }
    if (!orig) return; // genuinely new candidate added by critic — skip

    // Restore any field present in original that is missing or null in current
    let restored = [];
    for (const [key, origVal] of Object.entries(orig)) {
      if (origVal != null && (c[key] == null || c[key] === undefined)) {
        c[key] = origVal;
        restored.push(key);
      }
    }
    if (restored.length) {
      console.log(`[V4] Restored dropped fields on candidate[${i}] "${c.label}": ${restored.join(', ')}`);
    }
  });
}

// ─────────────────────────────────────────────
// PATCH APPLICATION — Node 3 (local JS merge)
// Handles dot-path notation including array indices: "foo.bar[2].baz"
// Validates path before writing. Logs every applied and skipped patch.
// ─────────────────────────────────────────────
function applyPatches(obj, patches) {
  const applied = [];
  const skipped = [];

  for (const patch of patches) {
    try {
      // "foo[2].bar.baz" → ["foo", 2, "bar", "baz"]
      const parts = patch.path
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .filter(Boolean)
        .map(p => isNaN(p) ? p : Number(p));

      let cursor = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (cursor == null) throw new Error(`Null parent at segment "${key}"`);
        // Allow appending to arrays: if key is a number one past the end, push a new object
        if (typeof key === 'number' && Array.isArray(cursor) && key === cursor.length) {
          cursor.push({});
        }
        if (cursor[key] === undefined) {
          throw new Error(`Path not found at segment "${key}"`);
        }
        cursor = cursor[key];
      }

      const lastKey = parts[parts.length - 1];
      if (cursor == null) throw new Error('Null parent at final segment');

      const before = cursor[lastKey];

      // GRADE guard: only allow downgrades for grade_certainty.
      // The critic sometimes flips GRADE laterally or upgrades — introducing
      // instability on papers where GRADE is already correctly assigned by V1.
      // Confirmed: UK FASHIoN "Moderate" → "Low" fires in 1/5 runs only.
      // Downgrades (e.g. High→Moderate, Moderate→Low) are always allowed.
      // Upgrades or lateral changes (same level, different run) are blocked.
      if (patch.path.endsWith('grade_certainty') && before != null && patch.corrected_value != null) {
        const gradeOrder = { 'Very Low': 0, 'Low': 1, 'Moderate': 2, 'High': 3 };
        const currentLevel = gradeOrder[before];
        const patchedLevel = gradeOrder[patch.corrected_value];
        if (currentLevel !== undefined && patchedLevel !== undefined && patchedLevel > currentLevel) {
          skipped.push({ path: patch.path, rule: patch.rule,
            reason: `grade-guard: upgrade blocked (${before} → ${patch.corrected_value})` });
          console.warn(`[V4 Critic] Patch blocked by grade-guard: ${before} → ${patch.corrected_value}`);
          continue;
        }
      }

      // Hard null-guard: never overwrite a non-null value with null.
      // The LLM prompt instructs the critic not to do this, but it fires anyway on
      // ambiguous papers (confirmed: PARTNER 1, PARTNER 3 CI regressions). Enforcing
      // here in JS is the only reliable defence — prompt-level guards are not sufficient.
      if (patch.corrected_value === null && before !== null && before !== undefined) {
        skipped.push({ path: patch.path, rule: patch.rule,
          reason: 'null-guard: would overwrite non-null value (' + JSON.stringify(before) + ') with null' });
        console.warn(`[V4 Critic] Patch blocked by null-guard: ${patch.path} current=${JSON.stringify(before)}`);
        continue;
      }

      cursor[lastKey] = patch.corrected_value;
      applied.push({
        path:   patch.path,
        before,
        after:  patch.corrected_value,
        rule:   patch.rule,
        reason: patch.reason,
      });
      console.log(`[V4 Critic] Patch applied: ${patch.path} [${patch.rule}]`);
    } catch (err) {
      skipped.push({ path: patch.path, reason: err.message });
      console.warn(`[V4 Critic] Patch skipped for "${patch.path}": ${err.message}`);
    }
  }

  return { applied, skipped };
}

// ─────────────────────────────────────────────
// RUN CRITIC — Node 2
// ─────────────────────────────────────────────
async function runCritic(draftJSON, paperText) {
  // Strip Introduction, Discussion, and References — keeps Abstract + Methods + Results only.
  // Task instructions are in CRITIC_SYSTEM (cached by OpenAI). User content = variable data only.
  const stripped = stripForCritic(paperText);

  const draftStr = JSON.stringify(draftJSON, null, 2);
  console.log(`[V4 Critic] Input: ${stripped.length} chars paper + ${draftStr.length} chars JSON`);

  const userContent = `<EXTRACTION>\n${draftStr}\n</EXTRACTION>\n\n<PAPER>\n${stripped}\n</PAPER>`;

  const raw = await callGPT4Mini(CRITIC_SYSTEM, userContent, {
    temperature:           0,
    max_completion_tokens: 4000,
  });

  // Strip accidental markdown fences from JSON response
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let criticResult;
  try {
    criticResult = JSON.parse(clean);
  } catch (parseErr) {
    console.warn('[V4 Critic] JSON parse failed:', parseErr.message, '— snippet:', raw.slice(0, 300));
    criticResult = {
      patches:          [],
      quality_notes:    ['Critic output could not be parsed — no patches applied.'],
      violations_found: 0,
    };
  }

  // Normalise fields
  if (!Array.isArray(criticResult.patches))       criticResult.patches       = [];
  if (!Array.isArray(criticResult.quality_notes)) criticResult.quality_notes = [];
  if (typeof criticResult.violations_found !== 'number') {
    criticResult.violations_found = criticResult.patches.length;
  }

  console.log(`[V4 Critic] Result: ${criticResult.patches.length} patches, ${criticResult.quality_notes.length} quality notes`);
  return criticResult;
}

// ─────────────────────────────────────────────
// POST-MERGE AUDIT — meta-analysis field completeness
// Runs after patches are applied. Records which fields are still null
// so we can aggregate failure patterns across runs.
// ─────────────────────────────────────────────
function auditMetaAnalysisFields(result) {
  const candidates = result?.primary_endpoint_candidates || [];
  const gaps = [];

  candidates.forEach((c, i) => {
    const missing   = [];
    const available = [];

    // outcome_type — new field patched by Rule 12
    if (!c.outcome_type) missing.push('outcome_type'); else available.push('outcome_type');

    // effect_measure and CI — universal
    if (!c.effect_measure)  missing.push('effect_measure'); else available.push('effect_measure');
    if (c.ci_lower == null) missing.push('ci_lower');       else available.push('ci_lower');
    if (c.ci_upper == null) missing.push('ci_upper');       else available.push('ci_upper');

    // Sample sizes — universal. V1 may store these as n_arm_a/n_arm_b (legacy names);
    // JS back-calculation normalises to arm_a_n/arm_b_n after patches are applied.
    const aN = c.arm_a_n ?? (c.n_arm_a != null ? Number(c.n_arm_a) : null);
    const bN = c.arm_b_n ?? (c.n_arm_b != null ? Number(c.n_arm_b) : null);
    if (aN == null) missing.push('arm_a_n'); else available.push('arm_a_n');
    if (bN == null) missing.push('arm_b_n'); else available.push('arm_b_n');

    // Outcome-type-specific fields
    const isContinuous   = c.outcome_type === 'continuous'    || ['MD', 'SMD'].includes(c.effect_measure);
    const isBinary       = c.outcome_type === 'binary'        || ['OR', 'RR', 'RD'].includes(c.effect_measure);
    const isTimeToEvent  = c.outcome_type === 'time-to-event' || c.effect_measure === 'HR';

    if (isContinuous) {
      // Need SD per arm for MA pooling (Rule 13)
      if (c.arm_a_sd == null) missing.push('arm_a_sd'); else available.push('arm_a_sd');
      if (c.arm_b_sd == null) missing.push('arm_b_sd'); else available.push('arm_b_sd');
    } else if (isBinary) {
      // Need event counts for binary MA pooling (Rule 8)
      if (c.arm_a_events == null) missing.push('arm_a_events'); else available.push('arm_a_events');
      if (c.arm_b_events == null) missing.push('arm_b_events'); else available.push('arm_b_events');
    }
    // Time-to-event: events not required (HR + CI sufficient for most pooling methods)

    if (!missing.length) return;

    // Diagnose likely reason for each missing field
    const diagnosis = [];
    if (missing.includes('outcome_type')) {
      diagnosis.push('outcome type not inferred — critic Rule 12 did not fire');
    }
    if (missing.includes('arm_a_n') || missing.includes('arm_b_n')) {
      diagnosis.push('N not found in paper text');
    }
    if (missing.includes('arm_a_events') || missing.includes('arm_b_events')) {
      const hasN    = !missing.includes('arm_a_n') && !missing.includes('arm_b_n');
      const hasRate = c.arm_a_value != null && c.arm_b_value != null;
      if (hasN && hasRate) {
        diagnosis.push('events back-calculable (arm_n and arm_value present) — JS back-calculation should have run');
      } else if (!hasN) {
        diagnosis.push('events not calculable — arm_n missing');
      } else {
        diagnosis.push('event counts not back-calculable — arm_value null');
      }
    }
    if (missing.includes('arm_a_sd') || missing.includes('arm_b_sd')) {
      const hasCI = c.ci_lower != null && c.ci_upper != null;
      const hasN  = (c.arm_a_n ?? c.n_arm_a) != null && (c.arm_b_n ?? c.n_arm_b) != null;
      if (hasCI && hasN) {
        diagnosis.push('SD back-calculation attempted but produced no result — check CI direction and N values');
      } else if (!hasN) {
        diagnosis.push('SD not back-calculable — arm N missing (SPORT/ambiguous-N design)');
      } else {
        diagnosis.push('SD not back-calculable — CI missing; requires direct extraction from paper');
      }
    }
    if (missing.includes('ci_lower') || missing.includes('ci_upper')) {
      diagnosis.push('CI not found in paper text');
    }
    if (missing.includes('effect_measure')) {
      diagnosis.push('effect measure not classified');
    }

    gaps.push({
      candidate:   `candidates[${i}] — ${c.label || 'unlabelled'}`,
      outcome_type: c.outcome_type || null,
      missing,
      available,
      diagnosis,
      context: {
        arm_a_value:    c.arm_a_value,
        arm_b_value:    c.arm_b_value,
        arm_a_n:        c.arm_a_n,
        arm_b_n:        c.arm_b_n,
        effect_measure: c.effect_measure,
        arm_a_sd:       c.arm_a_sd ?? null,
        arm_b_sd:       c.arm_b_sd ?? null,
      },
    });
  });

  return gaps;
}

// ─────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────
export async function runPipelineV4(sourceContext, sourceMeta = {}) {
  console.log('[V4 Pipeline] Starting Node 1 (Gemini flash-lite extractor)');

  // Strip references from extractor input — reference lists contain no clinical data.
  // This reduces Node 1 token input (can save ~25k chars on a typical 50k paper).
  const extractorContext = stripReferences(sourceContext);

  // Node 1: V1 extraction — Gemini flash-lite, thinkingBudget:1024
  const v1Result = await runPipelineV1(extractorContext, sourceMeta);
  console.log('[V4 Pipeline] Node 1 complete. Starting Node 2 (gpt-4o-mini critic)');

  // Node 2: Critic review — stripForCritic further removes Introduction and Discussion.
  let criticResult;
  try {
    criticResult = await runCritic(v1Result, extractorContext);
  } catch (err) {
    console.error('[V4 Pipeline] Critic failed:', err.message, '— using V1 output with error noted');
    criticResult = {
      patches:          [],
      quality_notes:    [`Critic node failed: ${err.message}`],
      violations_found: 0,
      critic_error:     err.message,
    };
  }

  // Snapshot V1 output before patches mutate it — saved separately for comparison.
  const v1Snapshot = JSON.parse(JSON.stringify(v1Result));

  // Node 3: Apply patches (local merge — no LLM call)
  console.log('[V4 Pipeline] Node 3: applying patches');
  const { applied, skipped } = applyPatches(v1Result, criticResult.patches);

  // Node 3b: Restore any fields dropped from existing candidates by Rule 9 array replacement.
  // When the critic patches the entire primary_endpoint_candidates array (e.g. to add secondary
  // endpoints), it sometimes reconstructs existing candidates and omits fields like `value`.
  // This pass re-merges from the pre-patch snapshot so no original field is lost.
  restoreDroppedCandidateFields(v1Result, v1Snapshot);

  // Node 3c: Coerce string integers to Number (e.g. n_arm_a: "602" → 602).
  // Must run before back-calculation so arithmetic operates on numbers, not strings.
  coerceNumericFields(v1Result);

  // Node 3c: Deterministic event back-calculation (JS arithmetic — no LLM).
  // Priority: copy V1 direct extraction (events_arm_a) → arm_a_events first.
  // Falls back to arm_n × arm_value / 100 only when no direct extraction exists.
  // Tags each field with _arm_a_events_source / _arm_b_events_source for provenance.
  backCalculateEvents(v1Result);

  // Node 3d: SD back-calculation for continuous outcomes (Cochrane §6.5.2).
  // Also runs plausibility check on existing SDs — overrides with back-calc
  // if existing SD is >2× different (cross-variable contamination signal).
  backCalculateSD(v1Result);

  // Node 3e: Normalise outcome_type spelling.
  // 'time-to-event' (hyphen, from critic patches) → 'time_to_event' (underscore, canonical).
  normaliseOutcomeTypes(v1Result);

  // Node 3f: Flag papers with multiple plausible primary analyses.
  // Sets extraction_flags.selection_uncertain + note when ≥2 candidates have
  // different effect measures — tells the reviewer a human decision is needed.
  flagAmbiguousSelection(v1Result);

  // Post-merge audit: scan final JSON for null meta-analysis fields.
  // Records exactly what is still missing after all patches — used to identify
  // where the critic is failing across runs so prompts can be targeted.
  const metaAnalysisGaps = auditMetaAnalysisFields(v1Result);
  if (metaAnalysisGaps.length) {
    console.log(`[V4 Audit] ${metaAnalysisGaps.length} meta-analysis gap(s):`,
      metaAnalysisGaps.map(g => `${g.candidate} — ${g.missing.join(', ')}`).join(' | '));
  }

  // Attach critic metadata for UI display and audit trail
  v1Result._critic = {
    patches_applied:      applied.length,
    patches_skipped:      skipped.length,
    patches:              applied,
    skipped_patches:      skipped,
    quality_notes:        criticResult.quality_notes,
    violations_found:     criticResult.violations_found,
    model:                OPENAI_CRITIC_MODEL,
    meta_analysis_gaps:   metaAnalysisGaps,
    // Prominent flag: selection_uncertain surfaces here AND in extraction_flags
    // so it is visible at the top level of the audit trail without drilling in.
    selection_uncertain:  v1Result.extraction_flags?.selection_uncertain ?? false,
    selection_uncertain_note: v1Result.extraction_flags?.selection_uncertain_note ?? null,
  };

  console.log(`[V4 Pipeline] Complete. ${applied.length} patches applied, ${skipped.length} skipped, ${criticResult.quality_notes.length} quality notes.`);

  // Return both outputs:
  //   v4 — patched result with _critic audit trail (the final V4 extraction)
  //   v1 — pre-patch snapshot (identical to what runPipelineV1 would have returned)
  return { v4: v1Result, v1: v1Snapshot };
}
