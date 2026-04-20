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
    temperature:           options.temperature ?? 0.1,
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
If either is null but the confidence interval is explicitly stated in Results text or a table, patch it.
Example path: "primary_endpoint_candidates[0].ci_lower"
SCALE GUARD — MANDATORY when multiple candidates coexist:
  If a candidate has effect_measure HR, OR, or RR (ratio scale): CI values MUST be positive numbers
  close to 1 (typically 0.3–3.0). Negative CI values or values >10 are wrong for this scale — they
  belong to a difference-scale candidate (MD, RD) and must NOT be applied here.
  If a candidate has effect_measure MD, RD, or SMD (difference scale): CI values may be negative.
  Verify that the CI you are patching is from the same row/analysis as this candidate's effect_measure
  before writing. When in doubt, do NOT patch.

RULE 2 — AE CONTAMINATION
Step 1: Build the PRIMARY endpoint list only from the extraction JSON:
  - Read clinician_view.pico.primary_outcome — extract the named primary outcome and all its
    components (for composite primaries, each component is individually excluded).
  - Read primary_endpoint_candidates[*].label for selected: true candidates only.
  Do NOT include secondary_outcomes in this list.
Step 2: For each row in clinician_view.adverse_events.rows, check whether the event name
  matches (exactly or near-exactly) any PRIMARY endpoint component from Step 1.
  Near-exact means the same clinical event under a different label (e.g. "death" matches
  "all-cause mortality"; "MI" matches "myocardial infarction"; "stroke" matches "cerebrovascular event").
Step 3: Remove only rows matching primary endpoint components.
  - Always patch "clinician_view.adverse_events.rows" to the cleaned array.
  - Only patch "clinician_view.adverse_events.has_data" to false if the cleaned array is empty.
    If any rows remain after cleaning, do NOT touch has_data.
IMPORTANT: Secondary endpoints may appear in the AE table — they represent both efficacy and safety
data and are clinically appropriate in both sections. Do NOT remove events that are secondary endpoints.
Do NOT remove events that are genuine unscheduled complications (wound infection, access-site
complication, bleeding requiring transfusion, sepsis, acute kidney injury).

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
Format: "[Sponsor]: [role — e.g. funded trial design and data collection]"
Path: "clinician_view.critical_appraisal.coi_funding"
Do NOT record the funding source only in quality_notes — generate the patch.
If coi_funding is already non-null (any non-empty string), do NOT overwrite it — leave it unchanged.

RULE 7 — PER-ARM VALUES (chart rendering)
Check primary_endpoint_candidates[*].arm_a_value and arm_b_value.
If either is null but a per-arm event rate, mean, or median is stated in Results: patch to the number.
- Binary outcome: event rate as a percentage (e.g. 5.4 for 5.4%)
- Continuous: mean or median value
- Survival: survival % at primary timepoint
Paths: "primary_endpoint_candidates[0].arm_a_value", "primary_endpoint_candidates[0].arm_b_value"

RULE 8 — META-ANALYSIS COMPLETENESS
Check primary_endpoint_candidates[*]: arm_a_n, arm_b_n, arm_a_events, arm_b_events, effect_measure.
These fields are required for meta-analysis pooling and must be populated wherever possible.

Step 1 — Sample sizes: if arm_a_n or arm_b_n is null, extract from Results text or baseline table.
Step 2 — Event counts (binary outcomes only — skip if effect_measure is HR or MD/SMD):
  - If arm_a_events / arm_b_events is explicitly stated in Results or a table, patch to that integer.
  - If not explicitly stated BUT arm_a_n and arm_a_value (percentage) are both available:
    calculate arm_a_events = round(arm_a_n × arm_a_value / 100) and patch.
    Do the same for arm_b. This back-calculation is mandatory when both inputs are present.
Step 3 — effect_measure: verify it matches the actual statistic reported.
  Correct misclassifications (e.g. "OR" when the paper reports an HR; "RR" when it is an MD).
Paths: "primary_endpoint_candidates[0].arm_a_n", "primary_endpoint_candidates[0].arm_a_events", etc.

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
For each primary_endpoint_candidates entry, infer outcome_type from effect_measure and context.
Set this field even if it is currently absent from the JSON (it is a new field):
  "time-to-event" — effect_measure is HR, or paper reports Kaplan-Meier or log-rank test
  "binary"        — effect_measure is OR, RR, or RD; or arm_a_events is populated
  "continuous"    — effect_measure is MD or SMD; or paper reports means ± SD per arm
  "ordinal"       — paper uses proportional odds model or ordinal regression
Patch each candidate individually.
Paths: "primary_endpoint_candidates[0].outcome_type", "primary_endpoint_candidates[1].outcome_type", etc.

RULE 13 — SD PER ARM (continuous outcomes only)
For each candidate where outcome_type is "continuous" (or effect_measure is MD or SMD):
  If arm_a_sd or arm_b_sd is null but the paper text explicitly reports SD or SE for each arm:
    - If SD is stated directly: patch to that value.
    - If SE is stated and arm_n is known: SD = SE × √(arm_n). Calculate and patch.
  Do NOT estimate or fabricate SD. Only patch if the value is explicitly stated or directly calculable.
Paths: "primary_endpoint_candidates[0].arm_a_sd", "primary_endpoint_candidates[0].arm_b_sd"

═══════════════════════════════════════════════════════
PASS B — PLAUSIBILITY (holistic review)
Flag genuine errors you can cite. Do not flag minor wording differences or style preferences.
Maximum 6 quality_notes total.
IMPORTANT: If Pass B identifies a fixable error that was not caught by the rules above,
add a patch for it as well as a quality note. Do not leave fixable errors as notes only.
DO NOT write confirmatory notes. A note saying "the primary endpoint is correctly identified"
or "the PICO matches the paper" wastes a slot. Only write notes when something is WRONG or MISSING.
═══════════════════════════════════════════════════════

Check:
1. Is the primary endpoint correctly identified? Only flag if it is WRONG — do not note if correct.
2. Does the PICO match the paper? Only flag if there is a genuine mismatch.
3. Is the trial design classification (study_design field) correct? Only flag if wrong.
4. Are there specific numeric values in the JSON that contradict the paper text?
   Only flag if you can cite the discrepancy explicitly.
5. Is there any remaining secondary endpoint with data in the Results that was missed by Rule 9?
   If fixable (you can extract the result), add a patch. If not (data not in the stripped text), add a note.

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
    temperature:           0.1,
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

    // Sample sizes — universal
    if (c.arm_a_n == null) missing.push('arm_a_n'); else available.push('arm_a_n');
    if (c.arm_b_n == null) missing.push('arm_b_n'); else available.push('arm_b_n');

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
        diagnosis.push('events back-calculable but critic did not patch (arm_n and arm_value present)');
      } else if (!hasN) {
        diagnosis.push('events not calculable — arm_n also missing');
      } else {
        diagnosis.push('event counts not stated and arm_value null — no back-calculation possible');
      }
    }
    if (missing.includes('arm_a_sd') || missing.includes('arm_b_sd')) {
      diagnosis.push('SD per arm missing for continuous outcome — critic Rule 13 did not patch');
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
    patches_applied:    applied.length,
    patches_skipped:    skipped.length,
    patches:            applied,
    skipped_patches:    skipped,
    quality_notes:      criticResult.quality_notes,
    violations_found:   criticResult.violations_found,
    model:              OPENAI_CRITIC_MODEL,
    meta_analysis_gaps: metaAnalysisGaps,
  };

  console.log(`[V4 Pipeline] Complete. ${applied.length} patches applied, ${skipped.length} skipped, ${criticResult.quality_notes.length} quality notes.`);

  // Return both outputs:
  //   v4 — patched result with _critic audit trail (the final V4 extraction)
  //   v1 — pre-patch snapshot (identical to what runPipelineV1 would have returned)
  return { v4: v1Result, v1: v1Snapshot };
}
