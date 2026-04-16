// lib/pipeline.js
// Shared 3-node OutcomeLogic analysis pipeline.
// Imported by api/analyze.js, api/library-batch.js, api/study-run.js — single source of truth.
//
// IMPORTANT: All Gemini calls use raw fetch() — NO SDK.
// Both @google/generative-ai and @google/genai cause systematic 503s on this account.
// See docs/LEARNINGS.md "Gemini API — Systematic 503 Failures" before touching this file.
//
// Extractor B uses OpenAI gpt-4o-mini (raw fetch, no SDK) for cross-model diversity.
// This ensures correlated table misreads between A and B become detectable discrepancies.

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const GEMINI_MODEL         = 'gemini-2.5-flash';      // primary — thinkingBudget:0, no thinking overhead
const GEMINI_MODEL_PRO     = 'gemini-2.5-pro';         // not used in current pipeline
const OPENAI_MODEL_B       = 'gpt-4o-mini';            // Extractor B — cross-model diversity
const EXTRACTOR_OUTPUT_CAP = 40000;

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENAI_API_BASE = 'https://api.openai.com/v1/chat/completions';

// ─────────────────────────────────────────────
// GEMINI RAW FETCH — 5-retry exponential backoff + jitter
// thinkingBudget: 0 disables thinking on gemini-2.5-flash — no overhead, faster responses.
// flash-lite required minimum 512; flash supports 0. Escalation path uses higher budget.
// Sequential callers (runPipeline) must await each call — parallel calls trigger 503s.
// ─────────────────────────────────────────────
async function callGemini(model, systemInstruction, userContent, options = {}) {
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig: {
      temperature:    options.temperature ?? 0.05,
      thinkingConfig: { thinkingBudget: options.thinkingBudget ?? 0 },
      ...(options.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
    },
  };

  const MAX_RETRIES = 2; // 1 retry only — within 60s Vercel budget, more retries burn all available time
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 500, 15000);
      await new Promise(r => setTimeout(r, delay));
      console.log(`[callGemini] Retry ${attempt}/${MAX_RETRIES - 1} after ${Math.round(delay)}ms (${model})`);
    }
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err     = new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
        err.status    = res.status;
        if ([400, 401, 403, 404].includes(res.status)) throw err; // non-retryable
        lastError = err;
        continue;
      }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Gemini: empty response body');
      return text;
    } catch (err) {
      if ([400, 401, 403, 404].includes(err.status)) throw err;
      lastError = err;
    }
  }
  const isQuota = lastError?.status === 429 ||
                  (lastError?.message || '').toLowerCase().includes('quota') ||
                  (lastError?.message || '').toLowerCase().includes('resource exhausted');
  if (isQuota) throw new Error('GEMINI_UNAVAILABLE: Gemini API quota limit reached — your project may have exhausted its RPM allowance. Check Google Cloud Console → Gemini API → Quotas, or wait a few minutes and retry.');
  throw lastError || new Error('Gemini: all retries exhausted');
}

// ─────────────────────────────────────────────
// OPENAI RAW FETCH — Extractor B only
// gpt-4o-mini: supports temperature, no reasoning tokens, ~3s on full papers.
// Use max_completion_tokens (not max_tokens — unsupported on newer models).
// Non-retryable on 400/401/403. Retryable on 429/500/503.
// ─────────────────────────────────────────────
async function callOpenAI(systemInstruction, userContent, options = {}) {
  const body = {
    model:                  OPENAI_MODEL_B,
    temperature:            options.temperature ?? 0.05,
    max_completion_tokens:  options.max_completion_tokens ?? 8000,
    messages: [
      { role: 'user',   content: userContent },
    ],
  };

  // System instruction: prepend as system message if provided
  if (systemInstruction) {
    body.messages.unshift({ role: 'system', content: systemInstruction });
  }

  const MAX_RETRIES = 5;
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 500, 15000);
      await new Promise(r => setTimeout(r, delay));
      console.log(`[callOpenAI] Retry ${attempt}/${MAX_RETRIES - 1} after ${Math.round(delay)}ms`);
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
        const err     = new Error(`OpenAI ${res.status}: ${errText.slice(0, 300)}`);
        err.status    = res.status;
        if ([400, 401, 403].includes(res.status)) throw err; // non-retryable
        lastError = err;
        continue;
      }
      const data   = await res.json();
      const text   = data.choices?.[0]?.message?.content;
      const reason = data.choices?.[0]?.finish_reason;
      if (!text) throw new Error('OpenAI: empty response content');
      if (reason === 'length') console.warn('[callOpenAI] finish_reason=length — output may be truncated');
      return text;
    } catch (err) {
      if ([400, 401, 403].includes(err.status)) throw err;
      lastError = err;
    }
  }
  const isQuota = lastError?.status === 429 ||
                  (lastError?.message || '').toLowerCase().includes('quota') ||
                  (lastError?.message || '').toLowerCase().includes('rate limit');
  if (isQuota) throw new Error('OPENAI_UNAVAILABLE: OpenAI API rate limit reached. Wait a moment and retry.');
  throw lastError || new Error('OpenAI: all retries exhausted');
}

const TAXONOMY_DOMAINS = [
  'Surgery', 'Orthopaedics', 'Medicine', 'Critical Care', 'Anaesthesia'
];

const TAXONOMY_SPECIALTIES = {
  Surgery:         ['Upper GI', 'Hernia', 'Colorectal', 'Breast', 'Endocrine', 'Vascular', 'Hepatobiliary'],
  Orthopaedics:    ['Hip', 'Knee', 'Spine', 'Shoulder', 'Trauma'],
  Medicine:        ['Cardiology', 'Oncology', 'Respiratory', 'Gastroenterology', 'Endocrinology', 'Neurology', 'Infectious Disease'],
  'Critical Care': ['ICU', 'Emergency Medicine'],
  Anaesthesia:     ['Regional', 'General'],
};

function getTaxonomyPromptText() {
  return Object.entries(TAXONOMY_SPECIALTIES)
    .map(([domain, specs]) => `  ${domain}: ${specs.join(', ')}`)
    .join('\n');
}

// ─────────────────────────────────────────────
// SOURCE CONTEXT BUILDER — SHARED EXPORT
// Fix C1: was duplicated inline in analyze.js, study-run.js, library-batch.js.
// All endpoints must call this function to ensure the pipeline receives identical
// structured input regardless of which endpoint initiates the run.
// ─────────────────────────────────────────────
export function buildSourceContext(text, meta = {}) {
  return [
    `[SOURCE: ${meta.sourceType || 'unknown'}]`,
    meta.pmid  ? `[PMID: ${meta.pmid}]`   : '',
    meta.pmcid ? `[PMCID: ${meta.pmcid}]` : '',
    meta.doi   ? `[DOI: ${meta.doi}]`     : '',
    meta.extractionWarning ? `[WARNING: ${meta.extractionWarning}]` : '',
    '',
    text,
  ].filter(Boolean).join('\n');
}

// ─────────────────────────────────────────────
// EXTRACTOR PROMPTS
// Two divergent prompts — same extraction targets, different priority rules.
// Extractor A: analytical priority (adjusted estimates, ITT, pre-specified primary).
// Extractor B: face value (first-reported, as-labelled, no analytical preference).
// The adjudicator reconciles discrepancies and flags suspicious agreement.
// ─────────────────────────────────────────────
const _EXTRACTOR_SHARED_SECTIONS = `
Extract the following with precision. Only extract what is explicitly stated — write "Not reported" rather than infer.

SOURCE CITATION REQUIREMENT
For every numeric value you extract (effect sizes, CIs, p-values, event rates, arm counts), immediately append a citation marker:
  [SRC: "verbatim quote ≤20 words" | Location]
Location must be one of: Abstract | Results para N | Table N | Figure N legend | Methods
If two locations give the same value: [SRC: AMBIGUOUS | location-1 vs location-2]
Example: HR 0.72 (95% CI 0.60–0.86) [SRC: "hazard ratio 0.72, 95% CI 0.60 to 0.86, p<0.001" | Results para 2]

1. TRIAL IDENTIFICATION
   - Full trial name and acronym
   - Authors (first 3 then et al.), journal name, year, DOI
   - Study design (RCT, cohort, single-arm, crossover, non-inferiority, factorial etc.)
   - Trial registration number if stated

2. PICO
   - Population: exact eligibility criteria including staging, performance status, prior therapy
   - Intervention: full name, dose, schedule, route
   - Control/Comparator: full name, dose, schedule (or "No comparator" for single-arm)
   - Primary outcome: exact definition as stated in the paper
   - Secondary outcomes: list all pre-specified secondary endpoints

3. BASELINE CHARACTERISTICS
   - Sample size per arm, median age, sex distribution
   - Key disease characteristics (stage, histology, prior treatment)
   - Note any significant imbalances between arms

4. PRIMARY ENDPOINT — extract all of the following:
   - Result (e.g. median OS 48.6 vs 23.2 months, or rate 3.7% vs 3.8%)
   - Effect measure with 95% CI: HR, OR, RR, rate ratio, or risk difference — use whichever the paper reports as primary
   - Absolute difference (e.g. ARR 15%) if reported
   - P-value (exact, not just "significant")
   - Statistical significance threshold used (e.g. p<0.05)
   - For rate/proportion outcomes: extract the EXACT percentages for each arm
   - Number of events and total N per arm where reported
   - NON-INFERIORITY TRIALS: If the primary analysis uses a non-inferiority design, you MUST additionally extract:
     (a) the pre-specified non-inferiority margin as stated in the methods section
     (b) whether the 95% CI excludes the NI margin — state "CI excludes NI margin: YES" or "CI excludes NI margin: NO"
     (c) label the p-value explicitly as "NI test p=" — do NOT present this as a superiority result
     Do NOT conflate NI success with superiority.

   CANDIDATE VALUES — MANDATORY for primary endpoint effect size:
   List ALL numeric values that could plausibly be the primary result (maximum 3). This is the single
   most important step for preventing undetected extraction error — if you omit a plausible alternative,
   the adjudicator cannot detect it. Be exhaustive: include adjusted vs unadjusted estimates, ITT vs
   per-protocol analyses, interim vs final timepoints, and any prominently reported secondary that
   could be mistaken for the primary. Even if only one value exists, list it as a single candidate.
   Format immediately after the main effect size extraction:
     candidate_values:
       1. value=X.XX | label="[e.g. adjusted HR, Cox model, Table 2]" | population=[ITT/PP/mITT] | [SRC: ...]
       2. value=X.XX | label="[e.g. unadjusted HR, abstract Results]" | population=[ITT/PP/mITT] | [SRC: ...]

   CANDIDATE COMPLETENESS CHECK — before finalising candidate_values, explicitly verify:
   - Have I included the adjusted primary analysis value (if one exists in the methods or results)?
   - Have I included the value reported in the abstract results (even if it differs from the full-text table)?
   - Have I included any alternative value present in a table that could plausibly be the primary?
   If any category is missing and a value for it exists in the paper, add it. Do not skip this check.

5. SECONDARY ENDPOINTS — for each pre-specified secondary endpoint:
   - Name and definition
   - Result with effect measure, 95% CI, p-value
   - For rate outcomes: extract percentages for each arm
   - Note if statistically significant

6. SURVIVAL / TIME-TO-EVENT DATA:
   - For OS, DFS, PFS and similar endpoints
   - Extract reported survival % at each EXPLICITLY STATED time point (e.g. "74% at 2 years", "55% at 3 years")
   - Do NOT interpolate or estimate values between reported time points
   - Record the exact time labels as stated (e.g. "6 months", "1 year", "2 years")
   - If only a single time point is reported (e.g. "2-year OS: 74% vs 71%"), record only that point
   - NOTE: If the primary outcome is a simple rate comparison (e.g. "mortality 3.7% vs 3.8%"), this is NOT survival data

7. SUBGROUP ANALYSES — extract ALL subgroups with a statistically significant interaction (p<0.05):
   - Include BOTH pre-specified and post-hoc subgroups — but flag each explicitly
   - State the subgroup variable (e.g. "PD-L1 status", "time from fracture to hospital arrival")
   - For each subgroup arm: HR, 95% CI, and absolute event counts (e.g. "17/163 (10%) vs 36/159 (23%)")
   - Interaction p-value
   - If the interaction p-value is between 0.04 and 0.06, flag it as BORDERLINE
   - Flag whether all individual subgroup CIs cross 1 (i.e. no individual arm is statistically significant)
   - If the paper states the observed direction contradicts the pre-specified hypothesis, note this
   - The interaction p-value tests whether the treatment effect VARIES across subgroups — it does NOT
     confirm that any individual subgroup has a proven effect. Note this distinction explicitly.

8. ADVERSE EVENTS — Grade 3 or higher only:
   - List each Grade ≥3 AE occurring in ≥5% of either arm
   - Percentage for BOTH intervention and control arms
   - Treatment-related mortality rate for both arms
   - Discontinuation due to AE rate for both arms

9. CRITICAL APPRAISAL
   - Risk of Bias: assess each Cochrane domain (randomisation, allocation concealment, blinding, outcome adjudication, attrition)
   - Classify as exactly one of: Low | Moderate | High | Unclear
   - GRADE certainty: exactly one of: High | Moderate | Low | Very Low
   - Key limitations stated by authors
   - Any important industry funding or COI disclosures

10. SOURCE CITATIONS — MANDATORY FOR ALL EXTRACTED VALUES
For every extracted numeric value or categorical judgment, record its source location.
Format each citation as:
  source_citation: { "text": "<verbatim sentence or table caption, max 30 words>", "location": "<Abstract | Results paragraph N | Table N | Figure N legend>" }

Example:
  HR 0.68 → source_citation: { "text": "The hazard ratio for PFS was 0.68 (95% CI 0.53–0.87; p=0.002)", "location": "Results paragraph 2" }

If two plausible source locations exist for the same value, cite BOTH and append "(AMBIGUOUS_SOURCE)" to the location string.
This is not optional. Unsourced extractions cannot be adjudicated.

Keep output focused. Do not reproduce full sections of source text.`;

const EXTRACTOR_PROMPT_A = `You are Extractor A — Analytical Priority. You are an elite Surgical Data Extraction Agent analysing a FULL-TEXT clinical trial.

PRIORITY RULES — apply these before extracting any value:
- If both adjusted and unadjusted estimates are reported: extract the ADJUSTED value
- If both ITT and per-protocol analyses are reported: extract ITT
- Select the analysis pre-specified as primary in the Methods or statistical analysis plan
- If the abstract and Results section report different values: prefer the Results section value
- For composite outcomes: extract the composite as the primary endpoint, not individual components
` + _EXTRACTOR_SHARED_SECTIONS;

const EXTRACTOR_PROMPT_B = `You are Extractor B — Face Value. You are an elite Surgical Data Extraction Agent analysing a FULL-TEXT clinical trial.

PRIORITY RULES — apply these before extracting any value:
- Extract the primary outcome EXACTLY as labelled "primary" in the Results section — do NOT infer primacy from Methods
- Extract the FIRST-REPORTED effect size for each endpoint in the order it appears in the full-text Results section
- If both adjusted and unadjusted estimates are reported: extract WHICHEVER appears first in Results
- If both ITT and per-protocol analyses are reported: extract WHICHEVER appears first in Results
- If the abstract and full-text Results section differ: note BOTH values with their locations — do not choose between them
- Do NOT select between multiple reported analyses — report the first one you encounter in the FULL TEXT
- ABSTRACT VS FULL TEXT: The abstract is a summary and may report a different value than the full text.
  When they differ, your job is to record both. Do NOT default to the abstract value — always check the
  full-text Results section for the authoritative number. Flag the discrepancy explicitly.
- If the paper uses a co-primary endpoint design (two or more outcomes both labelled "primary"), list ALL
  of them — do not select one. Mark each as co-primary in your output.
` + _EXTRACTOR_SHARED_SECTIONS;

// ─────────────────────────────────────────────
// ADJUDICATOR PROMPT — Adversarial framing
// Fix C4: adjudicator now always runs on GEMINI_MODEL_PRO.
// Fix M1 acknowledged: adjudicator cannot detect omissions absent from both reports.
//   Suspicious agreement is flagged only when multiple candidates appear in the
//   extractor text and both chose the same one. Omission detection requires PI review.
// ─────────────────────────────────────────────
const ADJUDICATOR_PROMPT_BASE = `You are the Chief of Surgery and an EBM expert acting as an ADVERSARIAL adjudicator.
Your job is to find extraction errors, not confirm agreement.

Extractor A prioritised adjusted estimates and methods-specified primary analyses.
Extractor B prioritised first-reported values from the results section.
Disagreements between them are expected and informative — resolve each by citing which source location is correct.

For each discrepancy, identify why EACH extractor might be wrong before determining the correct value.
Favour the more specific and numerically precise value, but justify your choice.

For fields where both extractors agree, apply this check:
(a) Do they cite different source locations for the same value? If yes, set source_conflict: true.
(b) Do the extractor reports mention multiple candidate values (e.g. adjusted and unadjusted HR, ITT and per-protocol), and both chose the same one? If yes, set suspicious_agreement: true and note the alternative.

Do NOT treat agreement as correctness — treat it as a hypothesis to verify against the cited sources within the reports.

Important constraint: You do not have access to the original source document. Suspicious agreement can only be detected from evidence within the two extractor reports. Omissions that neither extractor mentioned cannot be detected at this stage — that requires Phase 0 PI review.

CANDIDATE VALUE RANKING — MANDATORY:
Both extractor reports should include candidate_values lists for the primary endpoint effect size.
Compile all candidates from both reports into primary_endpoint_candidates in the output schema.
For each candidate:
- Record value, label, and which extractor cited it (source_a from Extractor A, source_b from Extractor B).
- If one extractor listed a candidate the other did not, include it with only the relevant source populated.
- Rank by appropriateness as primary endpoint result. Mark selected: true for the chosen value only.
- Ranking priority (apply in order, unless the methods section explicitly contradicts):
    1. Adjusted > unadjusted estimate
    2. ITT > per-protocol > mITT
    3. Final timepoint > interim
    4. Pre-specified primary > post-hoc or sensitivity analysis
  Do NOT rely solely on label text — a candidate labelled "secondary analysis" may still be the
  correct primary if it matches the pre-specified primary endpoint in the methods section.
- ANTI-BIAS RULE — do NOT rank a candidate higher because:
    • It is further from the null (more extreme HR, larger effect size)
    • It appeared earlier in the abstract or is more prominent in the narrative
  These are presentation artefacts, not markers of analytic correctness.
  Rank by trial design hierarchy only (rules 1–4 above) and source grounding (table > abstract when conflict exists).
- If the correct value appears in the candidate list but was NOT selected by either extractor as their
  primary result, select it now and document why in suspicious_agreement_note.
- If both extractors reported identical candidates and selected the same one, still populate the array —
  this confirms the field but the candidates remain visible for PI review.

Create a single unified synthesis. Output STRICTLY in the JSON schema below — no preamble, no markdown fences:

{
  "reportMeta": {
    "trial_identification": "String — full trial name and acronym",
    "study_design": "String — e.g. Multicentre open-label RCT | Non-inferiority RCT | Single-arm phase 2",
    "authors": "String — First Author, Second Author, Third Author et al. — null if not found",
    "journal": "String — full journal name — null if not found",
    "year": "String — year of publication — null if not found",
    "source_type": "full-text-pmc | full-text-jina | full-text-pdf | abstract-only | pasted-text | url",
    "pubmed_id": "String or null",
    "pmc_id": "String or null",
    "doi": "String or null",
    "pubmed_link": "String or null",
    "pmc_link": "String or null",
    "generated_at": "ISO timestamp string"
  },
  "extraction_flags": {
    "suspicious_agreement": false,
    "suspicious_agreement_note": null,
    "ambiguous_source": false,
    "source_conflict": false,
    "source_conflict_note": null,
    "selection_uncertain": false,
    "ni_trial": false
  },
  "source_citations": {
    "primary_result": { "text": "String or null", "location": "String or null" },
    "effect_size": { "text": "String or null", "location": "String or null" },
    "ni_margin": { "text": "String or null", "location": "String or null" }
  },
  "primary_endpoint_candidates": [
    {
      "value": 0.0,
      "label": "String — e.g. 'adjusted HR, Cox model, Table 2' or 'unadjusted HR, abstract'",
      "population": "ITT | PP | mITT | null",
      "arm_a_name": "String — intervention group label e.g. 'PCI', 'Surgery'",
      "arm_a_rate": 0.0,
      "arm_b_name": "String — control group label e.g. 'OMT', 'Conservative'",
      "arm_b_rate": 0.0,
      "ci_lower": 0.0,
      "ci_upper": 0.0,
      "source_a": "String or null — verbatim [SRC:] citation from Extractor A",
      "source_b": "String or null — verbatim [SRC:] citation from Extractor B",
      "selected": true
    }
  ],
  "clinician_view": {
    "context": {
      "already_known": "String — max 1 sentence",
      "what_this_adds": "String — max 1 sentence"
    },
    "pico": {
      "population": "String",
      "intervention": "String",
      "control": "String",
      "primary_outcome": "String — include result, effect measure, CI, p-value. For NI trials, include NI margin and whether CI excludes it.",
      "secondary_outcomes": ["String — include result and p-value — max 4 items"]
    },
    "baseline_characteristics": "String — 2-3 sentences covering N, age, sex, key disease characteristics",
    "critical_appraisal": {
      "grade_certainty": "High | Moderate | Low | Very Low",
      "risk_of_bias": "Low | Moderate | High | Unclear",
      "risk_of_bias_rationale": "String — max 2 sentences covering key RoB domains",
      "limitations": "String — max 2 sentences"
    },
    "adverse_events": {
      "has_data": true,
      "rows": [
        {
          "event": "String — AE name e.g. Neutropenia",
          "intervention_pct": 0,
          "control_pct": 0,
          "note": "String or null — e.g. Grade 3-4 only"
        }
      ],
      "discontinuation": {
        "intervention_pct": 0,
        "control_pct": 0
      },
      "treatment_related_mortality": {
        "intervention_pct": 0,
        "control_pct": 0,
        "note": "String or null"
      }
    },
    "subgroups": {
      "has_significant_interactions": false,
      "items": [
        {
          "variable": "String — e.g. PD-L1 expression ≥1%",
          "outcome": "String — which outcome this subgroup applies to, e.g. mortality | composite",
          "interaction_p": "String — e.g. p=0.02",
          "borderline": false,
          "pre_specified": true,
          "post_hoc": false,
          "cis_all_cross_one": false,
          "direction_vs_hypothesis": "String or null — e.g. 'Observed direction contradicts pre-specified hypothesis (expected larger benefit in early arrivals)'",
          "interaction_note": "String — plain language: what the interaction p means and what it does NOT prove",
          "arms": [
            {
              "subgroup_name": "String — e.g. PD-L1 ≥1%",
              "hr": "String — e.g. 0.62",
              "ci_95": "String — e.g. 0.48–0.79",
              "ci_crosses_one": true,
              "absolute_events": "String or null — e.g. 17/163 (10%) vs 36/159 (23%)"
            }
          ]
        }
      ]
    },
    "interactive_data": {
      "endpoints": [
        {
          "id": "String",
          "label": "String",
          "chart_priority": 1,
          "recommended_chart_type": "bar",
          "clinical_synthesis": "String — 1-2 sentences on clinical meaning",
          "axes": { "x_label": "String", "y_label": "String" },
          "arms": [
            {
              "group_name": "String",
              "data_points": [ { "x": "String", "y": 0 } ]
            }
          ],
          "effect_measure": "HR | OR | RR | MD | SMD | RD | null — exact string from this list or null",
          "point_estimate": 0.0,
          "ci_lower": 0.0,
          "ci_upper": 0.0,
          "p_value_str": "String e.g. '0.023' or '<0.001' — null if not reported",
          "arm_a_n": 0,
          "arm_b_n": 0,
          "arm_a_events": null,
          "arm_b_events": null,
          "time_point_weeks": null,
          "analysis_population": "ITT | mITT | PP | null",
          "adjusted": true,
          "source_citation_a": { "verbatim": "String ≤20 words", "location": "Abstract | Results para N | Table N | Figure N" },
          "source_citation_b": { "verbatim": "String ≤20 words", "location": "Abstract | Results para N | Table N | Figure N" }
        }
      ]
    }
  },
  "patient_view": {
    "lay_summary": "String — 4-6 sentences in plain English. Explain what the trial studied, what was found, what the numbers mean in practical terms (e.g. 'out of 100 patients who received X, approximately Y more were alive at 3 years compared to standard treatment'), and what this means for treatment decisions.",
    "shared_decision_making_takeaway": "String — 2-3 sentences on what a patient should understand when considering this evidence. Do not recommend a specific treatment — describe what this trial's results contribute to an informed conversation with their clinical team."
  },
  "library_meta": {
    "domain": "Surgery | Orthopaedics | Medicine | Critical Care | Anaesthesia",
    "specialty": "String — must be valid for the domain",
    "subspecialty": "String or null",
    "tags": ["String — 3 to 6 lowercase keywords"],
    "landmark_year": 0,
    "display_title": "String — TRIAL NAME — First Author et al. (Year)"
  }
}

CRITICAL INSTRUCTIONS FOR ENUMS:
- grade_certainty: MUST be exactly one of: "High" | "Moderate" | "Low" | "Very Low"
- risk_of_bias: MUST be exactly one of: "Low" | "Moderate" | "High" | "Unclear"

CRITICAL INSTRUCTIONS FOR EXTRACTION FLAGS:
- Set ni_trial: true whenever the study uses a non-inferiority design
- Set selection_uncertain: true if either extractor flagged "(SELECTION_UNCERTAIN)"
- Set ambiguous_source: true if either extractor flagged "(AMBIGUOUS_SOURCE)" for the primary result
- Set suspicious_agreement: true if both extractors agreed on a value but the reports mention an alternative candidate that was not selected

CRITICAL INSTRUCTIONS FOR CHARTS:
- ALWAYS include at least one endpoint for the PRIMARY outcome if ANY numeric data is available
- ALWAYS use recommended_chart_type: "bar" for ALL endpoints — including survival and time-to-event data
- Never use "stepped-line" — it is not supported
- chart_priority 1 = primary endpoint (MANDATORY if data exists)
- chart_priority 2 = second chart — ONLY include if there is a meaningful pre-specified secondary endpoint with distinct data
- Maximum 2 endpoints in the array

DATA FORMAT RULES:
- ALL y-values are PERCENTAGES as raw numbers (74 means 74%, NOT 0.74)
- For survival/time-to-event data: extract reported survival % at each EXPLICITLY STATED time point only
- For rate/proportion comparisons: use the reported percentage for each arm
- x values are time-point labels as strings (e.g. "6 months", "1 year", "2 years") OR arm names for single time-point comparisons
- For single time-point outcomes (e.g. "mortality 3.7% vs 3.8%"), provide one data point per arm using arm name as x value
- For multi-time-point survival data, provide one data point per arm per reported time point
- If insufficient data for ANY chart, output an empty endpoints array — but this should be rare for published trials

ENDPOINT EXAMPLES:

Example A — Rate comparison (single time point):
Trial reports: "Death due to bleeding: 3.7% in TXA vs 3.8% in placebo"
Output:
  recommended_chart_type: "bar"
  axes: { x_label: "Treatment", y_label: "Death rate (%)" }
  arms: [
    { group_name: "Tranexamic acid", data_points: [{ x: "TXA", y: 3.7 }] },
    { group_name: "Placebo",         data_points: [{ x: "Placebo", y: 3.8 }] }
  ]

Example B — Survival data with multiple reported time points:
Trial reports: "OS at 1y: 75% vs 65%; at 2y: 55% vs 42%; at 3y: 45% vs 32%; at 5y: 38% vs 24%"
Output:
  recommended_chart_type: "bar"
  axes: { x_label: "Time", y_label: "Overall Survival (%)" }
  arms: [
    { group_name: "Chemotherapy", data_points: [
      { x: "1 year", y: 75 }, { x: "2 years", y: 55 }, { x: "3 years", y: 45 }, { x: "5 years", y: 38 }
    ]},
    { group_name: "Surgery alone", data_points: [
      { x: "1 year", y: 65 }, { x: "2 years", y: 42 }, { x: "3 years", y: 32 }, { x: "5 years", y: 24 }
    ]}
  ]

Example C — Only a single reported survival time point:
Trial reports: "2-year OS: 74% (active surveillance) vs 71% (standard surgery)"
Output:
  recommended_chart_type: "bar"
  axes: { x_label: "Treatment", y_label: "2-Year Overall Survival (%)" }
  arms: [
    { group_name: "Active Surveillance", data_points: [{ x: "Active Surveillance", y: 74 }] },
    { group_name: "Standard Surgery",    data_points: [{ x: "Standard Surgery",    y: 71 }] }
  ]

CRITICAL INSTRUCTIONS FOR ANALYSIS FIELDS (in each endpoint):
- effect_measure: MUST be exactly one of "HR" | "OR" | "RR" | "MD" | "SMD" | "RD" — or null if not applicable
- point_estimate, ci_lower, ci_upper: numeric floats — never strings. e.g. 0.72, 0.60, 0.86
- p_value_str: string preserving exact format from paper e.g. "0.023", "<0.001", "0.14" — null if not reported
- arm_a_n / arm_b_n: total randomised N per arm as integer — extract from baseline table if not in results
- arm_a_events / arm_b_events: integer count of outcome events per arm — null for continuous outcomes
- time_point_weeks: primary follow-up duration in weeks as float (e.g. 52.0 for 1 year, 26.0 for 6 months) — null if not a time-specific outcome
- analysis_population: "ITT" | "mITT" | "PP" — null if not stated
- adjusted: true if the reported effect estimate is from an adjusted model; false if unadjusted; null if unclear
- source_citation_a / source_citation_b: populate from the corresponding extractor report's [SRC:] markers — null if no citation was provided

CRITICAL INSTRUCTIONS FOR ADVERSE EVENTS:
- Only include Grade ≥3 AEs occurring in ≥5% of either arm
- If no AE data available, set has_data to false and rows to empty array
- control_pct should be null for single-arm trials

CRITICAL INSTRUCTIONS FOR SUBGROUPS:
- Include ALL subgroups with a statistically significant interaction (p<0.05), both pre-specified and post-hoc
- Set pre_specified: true / post_hoc: false for subgroups defined in the methods or statistical analysis plan
- Set pre_specified: false / post_hoc: true for subgroups described as post-hoc, exploratory, or not pre-specified
- Set borderline: true when interaction p is between 0.04 and 0.06
- Set cis_all_cross_one: true if every individual arm CI includes 1.0 — this means no individual subgroup has
  a statistically significant effect, even though the interaction pattern is significant
- Set ci_crosses_one: true/false on each arm individually
- Always include absolute_events where reported (e.g. "17/163 (10%) vs 36/159 (23%)")
- interaction_note MUST explain: (1) what the interaction p tests (variation in treatment effect across groups),
  (2) what it does NOT prove (that any individual subgroup has a confirmed effect), and (3) if cis_all_cross_one
  is true, explicitly state that no individual subgroup reached statistical significance
- If direction_vs_hypothesis is applicable, note it — this substantially lowers credibility of the subgroup finding
- If no significant interactions, set has_significant_interactions to false and items to empty array

CRITICAL INSTRUCTIONS FOR LAY SUMMARY:
- Write for a patient with no medical background
- 4-6 sentences minimum
- Include at least one absolute number to convey effect size (e.g. "X more patients out of 100")
- Avoid jargon — if you must use a technical term, explain it immediately
- LANGUAGE CONSTRAINTS (liability): Do NOT use "X is better", "recommends", "confirms", "establishes",
  "you should", or any prescriptive phrasing. Use "this trial showed", "the results suggest",
  "the evidence indicates", "the data from this trial". This is a research summarisation tool —
  clinical decisions require discussion with a qualified healthcare professional.

CRITICAL INSTRUCTIONS FOR reportMeta:
- journal: extract the full journal name from the paper (e.g. "The New England Journal of Medicine")
- year: 4-digit publication year as a string
- authors: first 3 authors then "et al." — use the format "Surname INITIALS" e.g. "van Hagen PDEM, Hulshof MCCM, van Lanschot JJB et al."
- Populate pubmed_id, pmc_id, doi, pubmed_link, pmc_link from source context
- source_type must be exactly one of the allowed values

CRITICAL INSTRUCTIONS FOR library_meta:
- domain must be exactly one of the valid domains
- display_title: "TRIAL NAME — First Author et al. (Year)"
- tags: 3-6 lowercase keywords`;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function capOutput(text, max = EXTRACTOR_OUTPUT_CAP) {
  if (text.length <= max) return { text, truncated: false };
  console.warn(`[Pipeline] Extractor unusually long (${text.length} chars) — truncating at ${max}`);
  const trimmed = text.slice(0, max);
  const last    = trimmed.lastIndexOf('.');
  return { text: last > 0 ? trimmed.slice(0, last + 1) : trimmed, truncated: true };
}

function buildLinks(pmid, pmcid) {
  return {
    pubmed_link: pmid  ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`            : null,
    pmc_link:    pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/` : null,
  };
}

// ─────────────────────────────────────────────
// POST-PROCESS
// Normalises, validates, and enriches the adjudicator JSON output.
// ─────────────────────────────────────────────
function postProcess(parsed, sourceMeta) {
  const links = buildLinks(sourceMeta.pmid, sourceMeta.pmcid);

  // ── reportMeta ───────────────────────────────────────────────────────────
  parsed.reportMeta = {
    ...parsed.reportMeta,
    authors:      parsed.reportMeta?.authors      || sourceMeta.authors    || null,
    journal:      parsed.reportMeta?.journal      || null,
    year:         parsed.reportMeta?.year         || null,
    source_type:  parsed.reportMeta?.source_type  || sourceMeta.sourceType || null,
    pubmed_id:    parsed.reportMeta?.pubmed_id     || sourceMeta.pmid       || null,
    pmc_id:       parsed.reportMeta?.pmc_id        || sourceMeta.pmcid      || null,
    doi:          parsed.reportMeta?.doi            || sourceMeta.doi        || null,
    pubmed_link:  parsed.reportMeta?.pubmed_link    || links.pubmed_link     || null,
    pmc_link:     parsed.reportMeta?.pmc_link       || links.pmc_link        || null,
    generated_at: parsed.reportMeta?.generated_at  || new Date().toISOString(),
  };

  if (sourceMeta.extractionWarning) {
    parsed.reportMeta.extraction_warning = sourceMeta.extractionWarning;
  }

  // ── Enum enforcement ─────────────────────────────────────────────────────
  const ca = parsed.clinician_view?.critical_appraisal;
  if (ca) {
    const validGrade = ['High', 'Moderate', 'Low', 'Very Low'];
    const validRoB   = ['Low', 'Moderate', 'High', 'Unclear'];
    if (!validGrade.includes(ca.grade_certainty)) ca.grade_certainty = 'Very Low';
    if (!validRoB.includes(ca.risk_of_bias))      ca.risk_of_bias    = 'Unclear';
  }

  // ── Ensure extraction_flags block exists ──────────────────────────────────
  if (!parsed.extraction_flags) {
    parsed.extraction_flags = {
      suspicious_agreement:      false,
      suspicious_agreement_note: null,
      ambiguous_source:          false,
      source_conflict:           false,
      source_conflict_note:      null,
      selection_uncertain:       false,
      ni_trial:                  false,
    };
  }

  // ── Ensure source_citations block exists ──────────────────────────────────
  if (!parsed.source_citations) {
    parsed.source_citations = {
      primary_result: { text: null, location: null },
      effect_size:    { text: null, location: null },
      ni_margin:      { text: null, location: null },
    };
  }

  // ── Ensure adverse_events block exists ───────────────────────────────────
  if (!parsed.clinician_view?.adverse_events) {
    parsed.clinician_view.adverse_events = {
      has_data:                     false,
      rows:                         [],
      discontinuation:              { intervention_pct: null, control_pct: null },
      treatment_related_mortality:  { intervention_pct: null, control_pct: null, note: null },
    };
  }

  // ── Ensure subgroups block exists ─────────────────────────────────────────
  if (!parsed.clinician_view?.subgroups) {
    parsed.clinician_view.subgroups = {
      has_significant_interactions: false,
      items:                        [],
    };
  }

  // ── Enforce max 2 charts, sorted by priority ──────────────────────────────
  const endpoints = parsed.clinician_view?.interactive_data?.endpoints;
  if (Array.isArray(endpoints)) {
    parsed.clinician_view.interactive_data.endpoints = endpoints
      .sort((a, b) => (a.chart_priority || 1) - (b.chart_priority || 1))
      .slice(0, 2);
  }

  // ── Synthetic endpoint fallback ───────────────────────────────────────────
  // When interactive_data.endpoints is empty (truncated or omitted), build a
  // minimal bar chart from primary_endpoint_candidates + PICO arm names.
  // Only fires when no model-produced endpoint exists — never overwrites one.
  const currentEndpoints = parsed.clinician_view?.interactive_data?.endpoints;
  if (!currentEndpoints?.length) {
    const pico      = parsed.clinician_view?.pico || {};
    const selected  = (parsed.primary_endpoint_candidates || []).find(c => c.selected)
                    || (parsed.primary_endpoint_candidates || [])[0]
                    || null;

    if (selected && selected.arm_a_rate != null && selected.arm_b_rate != null) {
      const armAName = selected.arm_a_name || pico.intervention || 'Intervention';
      const armBName = selected.arm_b_name || pico.control      || 'Control';
      const syntheticEndpoint = {
        id:                    'synthetic_primary',
        label:                 parsed.library_meta?.display_title || 'Primary Outcome',
        chart_priority:        1,
        recommended_chart_type:'bar',
        clinical_synthesis:    pico.primary_outcome || '',
        axes: { x_label: 'Treatment Group', y_label: 'Event Rate (%)' },
        arms: [
          { group_name: armAName, data_points: [{ x: armAName, y: selected.arm_a_rate }] },
          { group_name: armBName, data_points: [{ x: armBName, y: selected.arm_b_rate }] },
        ],
        effect_measure:  null,
        point_estimate:  selected.value   ?? null,
        ci_lower:        selected.ci_lower ?? null,
        ci_upper:        selected.ci_upper ?? null,
        _synthetic:      true,
      };
      if (!parsed.clinician_view.interactive_data) {
        parsed.clinician_view.interactive_data = {};
      }
      parsed.clinician_view.interactive_data.endpoints = [syntheticEndpoint];
      console.log('[postProcess] Synthetic endpoint built from primary_endpoint_candidates');
    } else {
      console.log('[postProcess] No synthetic endpoint — arm rates not available in candidates');
    }
  }

  // ── Expert context — not loaded by default (on-demand via /api/commentary) ─
  parsed.clinician_view.expert_context = { status: 'not_loaded' };
  console.log('[postProcess] expert_context: not_loaded (on-demand)');

  // ── library_meta ─────────────────────────────────────────────────────────
  const lm        = parsed.library_meta || {};
  const domain    = TAXONOMY_DOMAINS.includes(lm.domain) ? lm.domain : TAXONOMY_DOMAINS[0];
  const specs     = TAXONOMY_SPECIALTIES[domain] || [];
  const specialty = specs.includes(lm.specialty) ? lm.specialty : (specs[0] || null);

  parsed.library_meta = {
    domain,
    specialty,
    subspecialty:  lm.subspecialty  || null,
    tags:          Array.isArray(lm.tags) ? lm.tags.slice(0, 6) : [],
    landmark_year: lm.landmark_year  || null,
    display_title: lm.display_title  ||
                   parsed.reportMeta?.trial_identification ||
                   'Unknown Trial',
  };

  // ── Legacy aliases ────────────────────────────────────────────────────────
  parsed.metadata = {
    trial_identification: parsed.reportMeta?.trial_identification || '',
    study_design:         parsed.reportMeta?.study_design         || '',
  };

  parsed._provenance = {
    source:    sourceMeta.sourceType || 'unknown',
    timestamp: new Date().toISOString(),
  };

  return parsed;
}

// ─────────────────────────────────────────────
// MAIN EXPORT: runPipeline
// ─────────────────────────────────────────────
export async function runPipeline(sourceContext, sourceMeta = {}, adjMeta = {}, isEscalation = false) {

  // Escalation uses thinking enabled (budget 8000) for higher reasoning capacity.
  const extractModel      = GEMINI_MODEL;
  const thinkingBudget    = isEscalation ? 8000 : 0;

  console.log(`[Pipeline] Mode: ${isEscalation ? 'ESCALATION' : 'normal'}`);
  console.log(`[Pipeline] Model: ${extractModel}`);

  const adjudicatorPrompt = ADJUDICATOR_PROMPT_BASE + `\n\nVALID TAXONOMY:\n${getTaxonomyPromptText()}`;

  const escalationWarning = isEscalation
    ? `\nWARNING: A previous extraction attempt produced a critical error. Read with extreme caution.
       Pay special attention to: absolute vs relative risk, p-values (do not assume significance),
       complex tables where columns may be misaligned, and survival curve reconstruction.\n`
    : '';

  // ── Pre-scan sourceContext for PMID/DOI (PDF uploads only) ───────────────
  if (sourceMeta.sourceType === 'full-text-pdf' && !sourceMeta.pmid && !sourceMeta.doi) {
    const scanHead = sourceContext.slice(0, 4000);
    const scanTail = sourceContext.slice(-2000);
    const scanText = scanHead + '\n' + scanTail;

    const pmidScan = scanText.match(/(?:PMID|PubMed\s*ID)\s*[:\-]?\s*(\d{7,8})/i);
    if (pmidScan?.[1]) {
      sourceMeta.pmid = pmidScan[1];
      console.log(`[Pipeline] Pre-scan found PMID: ${sourceMeta.pmid}`);
    }

    if (!sourceMeta.pmid) {
      const doiScan = scanText.match(/(?:DOI|doi)\s*[:\-]?\s*(10\.\d{4,}\/\S+)/i)
                   || scanText.match(/https?:\/\/doi\.org\/(10\.\d{4,}\/\S+)/i)
                   || scanText.match(/\b(10\.\d{4,}\/[^\s,;>"']{4,})/);
      if (doiScan?.[1]) {
        sourceMeta.doi = doiScan[1].replace(/[,\.\]"'>]+$/, '');
        console.log(`[Pipeline] Pre-scan found DOI: ${sourceMeta.doi}`);
      }
    }
  }

  // ── Node 1 + 2: Extractors A and B ───────────────────────────────────────
  // When OPENAI_API_KEY is set: A (Gemini) and B (OpenAI) run in parallel — different
  // providers, no concurrency conflict. Saves ~20s on full papers.
  // When OPENAI_API_KEY is absent (fallback): both use Gemini and must run sequentially
  // to avoid same-key concurrency 503s.
  const modelB = process.env.OPENAI_API_KEY ? OPENAI_MODEL_B : extractModel;
  console.log(`[Pipeline] Extractors starting — A: ${extractModel}, B: ${modelB}`);

  // Run A first — if Gemini is rate-limited it throws here before B is called,
  // so failed runs cost zero gpt-4o-mini tokens. ~10s slower on success but
  // B (~10s) + adjudicator (~15s) still fits comfortably inside 60s.
  const rawA = await callGemini(extractModel, EXTRACTOR_PROMPT_A + escalationWarning, sourceContext, { thinkingBudget });
  const rawB = process.env.OPENAI_API_KEY
    ? await callOpenAI(EXTRACTOR_PROMPT_B + escalationWarning, sourceContext)
    : await callGemini(extractModel, EXTRACTOR_PROMPT_B + escalationWarning, sourceContext, { thinkingBudget });

  const { text: reportA, truncated: truncatedA } = capOutput(rawA);
  const { text: reportB, truncated: truncatedB } = capOutput(rawB);
  console.log(`[Pipeline] Extractor A complete${truncatedA ? ' [TRUNCATED]' : ''}`);
  console.log(`[Pipeline] Extractor B complete${truncatedB ? ' [TRUNCATED]' : ''}`);

  // ── Node 3: Adjudicator ────────────────────────────────────────────────────
  const links     = buildLinks(sourceMeta.pmid, sourceMeta.pmcid);
  const metaLines = [
    `source_type:  ${sourceMeta.sourceType || 'unknown'}`,
    `pubmed_id:    ${sourceMeta.pmid        || 'unknown'}`,
    `pmc_id:       ${sourceMeta.pmcid       || 'unknown'}`,
    `doi:          ${sourceMeta.doi         || 'unknown'}`,
    `pubmed_link:  ${links.pubmed_link      || ''}`,
    `pmc_link:     ${links.pmc_link         || ''}`,
    `generated_at: ${new Date().toISOString()}`,
    sourceMeta.extractionWarning ? `WARNING: ${sourceMeta.extractionWarning}` : null,
    ...Object.entries(adjMeta).map(([k, v]) => `${k}: ${v}`),
  ].filter(Boolean).join('\n');

  // Propagate truncation status — adjudicator must not treat truncated absence as omission.
  const truncationNote = (truncatedA || truncatedB)
    ? `\nTRUNCATION NOTICE:${truncatedA ? ' Extractor A output was truncated at character limit.' : ''}${truncatedB ? ' Extractor B output was truncated at character limit.' : ''} Treat any field absent from a truncated report as UNKNOWN — do not infer from absence. Do not flag omissions in truncated fields as extraction errors. IMPORTANT: the candidate_values list from a truncated report may be incomplete — if only one extractor provides candidates, note this in suspicious_agreement_note and treat the candidate set as potentially partial.`
    : '';

  const adjInput = [
    'Compare these two extraction reports and generate the final unified JSON.',
    'Extractor A used adjusted/ITT priority. Extractor B used first-reported/results-section priority.',
    'Disagreements between A and B on numeric values are expected — resolve each with a cited reason.',
    truncationNote,
    '',
    'Source metadata to populate in reportMeta:',
    metaLines,
    '',
    'REPORT A (adjusted/ITT priority):',
    reportA,
    '',
    'REPORT B (first-reported priority):',
    reportB,
  ].filter(s => s !== null).join('\n');

  console.log(`[Pipeline] Adjudicator starting (${extractModel})`);
  const adjText = await callGemini(
    extractModel,
    adjudicatorPrompt,
    adjInput,
    { responseMimeType: 'application/json', temperature: 0.0, thinkingBudget },
  );
  const parsed = JSON.parse(adjText);
  console.log('[Pipeline] Adjudicator complete');

  return postProcess(parsed, sourceMeta);
}
