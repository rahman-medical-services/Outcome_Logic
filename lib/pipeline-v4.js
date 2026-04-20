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

  // Strip Discussion / Conclusions onwards (first occurrence — these sections follow Results)
  const discMatch = result.match(/\n(Discussion|DISCUSSION|Conclusions|CONCLUSIONS|Comment|COMMENT|Interpretation|INTERPRETATION|Summary and Conclusions)\s*\n/);
  if (discMatch) {
    result = result.slice(0, discMatch.index);
  }

  // Strip Introduction (everything between start and Methods heading, keeping first ~2500 chars as abstract preamble)
  // Only strip if Methods heading found clearly beyond the abstract
  const methodsMatch = result.match(/\n(Methods|METHODS|Patients and Methods|PATIENTS AND METHODS|Study Design|STUDY DESIGN|Materials and Methods|MATERIALS AND METHODS|Subjects and Methods|SUBJECTS AND METHODS)\s*\n/);
  if (methodsMatch && methodsMatch.index > 2500) {
    const preamble = result.slice(0, 2500);           // keep abstract
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
PASS A — RULE COMPLIANCE (8 checks — patches auto-applied)
For each violation found, add a patch entry. Only add a patch if you are certain the correction is right
and can cite the paper text. Do not patch speculatively.
═══════════════════════════════════════════════════════

RULE 1 — CI COMPLETENESS
Check primary_endpoint_candidates[*].ci_lower and ci_upper.
If either is null but the confidence interval is explicitly stated in Results text or a table, patch it.
Example path: "primary_endpoint_candidates[0].ci_lower"

RULE 2 — AE CONTAMINATION
Step 1: Build the trial-specific endpoint list from the extraction JSON itself:
  - Read clinician_view.pico.primary_outcome — extract the named outcome(s)
  - Read clinician_view.pico.secondary_outcomes[] — extract every listed secondary endpoint
  - Read primary_endpoint_candidates[*].label — add any additional endpoint labels
Step 2: For each row in clinician_view.adverse_events.rows, check whether the event name
  matches (exactly or near-exactly) any endpoint from Step 1.
  Near-exact means the same clinical event under a different label (e.g. "death" matches
  "all-cause mortality"; "MI" matches "myocardial infarction"; "stroke" matches "cerebrovascular event").
Step 3: Remove any matching row. If all rows are removed, set has_data to false.
Patch: set "clinician_view.adverse_events.rows" to the cleaned array.
Path for has_data: "clinician_view.adverse_events.has_data"
Do NOT remove events that are genuine unscheduled complications (wound infection, access-site
complication, bleeding requiring transfusion, sepsis, acute kidney injury) unless they are
explicitly named as secondary endpoints in the JSON.

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

RULE 6 — COI / FUNDING
Check clinician_view.critical_appraisal.coi_funding.
If null but a funder, sponsor, or industry supporter is explicitly named in the paper text
(Methods, Funding statement, Acknowledgements): extract verbatim and patch.
Format: "[Sponsor]: [role — e.g. funded trial design and data collection]"
Path: "clinician_view.critical_appraisal.coi_funding"

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
Step 2 — Event counts (binary outcomes):
  - If arm_a_events / arm_b_events is explicitly stated in Results or a table, patch to that integer.
  - If not explicitly stated BUT arm_a_n and arm_a_value (percentage) are both available:
    calculate arm_a_events = round(arm_a_n × arm_a_value / 100) and patch.
    Do the same for arm_b. This back-calculation is mandatory when both inputs are present.
Step 3 — effect_measure: verify it matches the actual statistic reported.
  Correct misclassifications (e.g. "OR" when the paper reports an HR; "RR" when it is an MD).
Paths: "primary_endpoint_candidates[0].arm_a_n", "primary_endpoint_candidates[0].arm_a_events", etc.

═══════════════════════════════════════════════════════
PASS B — PLAUSIBILITY (quality_notes only — not auto-patched)
Flag only genuine errors you can cite. Do not flag minor wording differences or style preferences.
Maximum 6 quality_notes total.
═══════════════════════════════════════════════════════

Check:
1. Is the primary endpoint correctly identified? Does it match what the paper explicitly labels "primary"?
2. Are there secondary endpoints prominently reported in Results that were not extracted?
   Flag at most 2 specific omissions — do not list every endpoint in the paper.
3. Does the PICO (population, intervention, control) description match the paper?
4. Is the trial design classification (study_design field) correct?
5. Does the lay_summary accurately reflect the direction and magnitude of results?
6. Are there specific numeric values in the JSON that contradict the paper text?
   Only flag if you can cite the discrepancy explicitly.

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
      "rule": "CI completeness | AE contamination | subgroup grouping | RoB | GRADE | COI | per-arm values | meta-analysis completeness"
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
        if (cursor == null || cursor[key] === undefined) {
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

    // Core meta-analysis fields
    if (c.arm_a_n        == null) missing.push('arm_a_n');        else available.push('arm_a_n');
    if (c.arm_b_n        == null) missing.push('arm_b_n');        else available.push('arm_b_n');
    if (c.arm_a_events   == null) missing.push('arm_a_events');   else available.push('arm_a_events');
    if (c.arm_b_events   == null) missing.push('arm_b_events');   else available.push('arm_b_events');
    if (c.ci_lower       == null) missing.push('ci_lower');       else available.push('ci_lower');
    if (c.ci_upper       == null) missing.push('ci_upper');       else available.push('ci_upper');
    if (!c.effect_measure)        missing.push('effect_measure'); else available.push('effect_measure');

    if (!missing.length) return;

    // Diagnose likely reason for each missing field
    const diagnosis = [];
    if (missing.includes('arm_a_n') || missing.includes('arm_b_n')) {
      diagnosis.push('N not found in paper text');
    }
    if ((missing.includes('arm_a_events') || missing.includes('arm_b_events'))) {
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
    if (missing.includes('ci_lower') || missing.includes('ci_upper')) {
      diagnosis.push('CI not found in paper text');
    }
    if (missing.includes('effect_measure')) {
      diagnosis.push('effect measure not classified');
    }

    gaps.push({
      candidate:   `candidates[${i}] — ${c.label || 'unlabelled'}`,
      missing,
      available,
      diagnosis,
      // Context to help diagnose: what values ARE present
      context: {
        arm_a_value:    c.arm_a_value,
        arm_b_value:    c.arm_b_value,
        arm_a_n:        c.arm_a_n,
        arm_b_n:        c.arm_b_n,
        effect_measure: c.effect_measure,
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
  return v1Result;
}
