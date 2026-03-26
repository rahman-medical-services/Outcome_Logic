// ==========================================
// ANALYSE TAB SCRIPTS — v4.1.0
// Extracted from index.html inline <script> block.
// Loaded via <script src="/analyse.js"> (non-module, global scope).
//
// Functions exposed globally for onclick handlers in HTML:
//   searchDatabase, analyzePdf, exportReport
// Functions exposed on window for cross-module access:
//   window.populateDashboard (used by app.js library-load)
//   window._lastAnalysis     (used by app.js save-to-library)
// ==========================================

// ── Config ──────────────────────────────────────────────────────────
const API_BASE_URL       = window.ENV?.API_BASE_URL       || 'https://outcome-logic.vercel.app/api';
const INTERNAL_API_TOKEN = window.ENV?.INTERNAL_API_TOKEN || 'surgeon-secure-key-99';

let currentChart  = null;
let currentChart2 = null;
window._lastAnalysis = null;

// ── Loading stage helpers ────────────────────────────────────────────
const LOADING_STAGES = [
  { label: 'Retrieving source…',    dots: [1,0,0] },
  { label: 'Extracting data…',      dots: [1,1,0] },
  { label: 'Synthesising report…',  dots: [1,1,1] },
];
let _stageTimer = null;

function showLoading() {
  const el = document.getElementById('loadingState');
  if (!el) return;
  el.classList.remove('hidden');
  let stage = 0;
  _setStage(stage);
  _stageTimer = setInterval(() => {
    stage = Math.min(stage + 1, LOADING_STAGES.length - 1);
    _setStage(stage);
  }, 8000);
}

function hideLoading() {
  const el = document.getElementById('loadingState');
  if (el) el.classList.add('hidden');
  if (_stageTimer) { clearInterval(_stageTimer); _stageTimer = null; }
}

function _setStage(i) {
  const s = LOADING_STAGES[i];
  const lbl = document.getElementById('loading-stage');
  if (lbl) lbl.textContent = s.label;
  [1,2,3].forEach(n => {
    const dot = document.getElementById(`stage-dot-${n}`);
    if (dot) dot.className = `w-2 h-2 rounded-full ${s.dots[n-1] ? 'bg-slate-900' : 'bg-slate-300'}`;
  });
}

// ── Enum helpers ────────────────────────────────────────────────────
const ROB_CONFIG = {
  'Low':      { bg: 'bg-green-100',  text: 'text-green-800',  label: 'Low Risk'      },
  'Moderate': { bg: 'bg-yellow-100', text: 'text-yellow-800', label: 'Moderate Risk' },
  'High':     { bg: 'bg-red-100',    text: 'text-red-800',    label: 'High Risk'     },
  'Unclear':  { bg: 'bg-slate-100',  text: 'text-slate-600',  label: 'Unclear'       },
};
const GRADE_CONFIG = {
  'High':     { bg: 'bg-green-100',  text: 'text-green-800',  bars: 4, colour: 'bg-green-500'  },
  'Moderate': { bg: 'bg-blue-100',   text: 'text-blue-800',   bars: 3, colour: 'bg-blue-500'   },
  'Low':      { bg: 'bg-yellow-100', text: 'text-yellow-800', bars: 2, colour: 'bg-yellow-500' },
  'Very Low': { bg: 'bg-red-100',    text: 'text-red-800',    bars: 1, colour: 'bg-red-500'    },
};
const PUB_TYPE_CONFIG = {
  'RCT':               { bg: 'bg-green-100',  text: 'text-green-800'  },
  'Clinical Trial':    { bg: 'bg-blue-100',   text: 'text-blue-800'   },
  'Meta-analysis':     { bg: 'bg-purple-100', text: 'text-purple-800' },
  'Systematic Review': { bg: 'bg-purple-50',  text: 'text-purple-700' },
  'Cohort Study':      { bg: 'bg-yellow-100', text: 'text-yellow-800' },
  'Publication':       { bg: 'bg-slate-100',  text: 'text-slate-500'  },
};

function robBadge(rob) {
  const c = ROB_CONFIG[rob] || ROB_CONFIG['Unclear'];
  const el = document.getElementById('ui-rob-badge');
  if (el) { el.className = `text-xs font-bold px-2 py-1 rounded uppercase tracking-wide ${c.bg} ${c.text}`; el.innerText = c.label; }
}
function gradeBadge(grade) {
  const c = GRADE_CONFIG[grade] || GRADE_CONFIG['Very Low'];
  const el = document.getElementById('ui-grade-badge');
  if (el) { el.className = `text-xs font-bold px-2 py-1 rounded uppercase tracking-wide ${c.bg} ${c.text}`; el.innerText = grade; }
  for (let i = 1; i <= 4; i++) {
    const bar = document.getElementById(`grade-bar-${i}`);
    if (bar) bar.className = `h-2 flex-1 rounded ${i <= c.bars ? c.colour : 'bg-slate-200'}`;
  }
}
function setLink(id, href, label) {
  const el = document.getElementById(id);
  if (!el) return;
  if (href) { el.href = href; if (label) el.innerText = label; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
}

// ── Search ──────────────────────────────────────────────────────────
async function searchDatabase() {
  const query = document.getElementById('searchInput').value.trim();
  if (!query) return alert('Enter a search term.');
  const resultsBox = document.getElementById('searchResults');
  resultsBox.innerHTML = '<div class="text-sm text-slate-500 p-2">Searching…</div>';
  resultsBox.classList.remove('hidden');
  resultsBox.classList.add('flex');
  try {
    const res  = await fetch(`${API_BASE_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-token': INTERNAL_API_TOKEN },
      body:    JSON.stringify({ query }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error.');
    if (!data.results?.length) { resultsBox.innerHTML = '<div class="text-sm text-slate-500 p-2">No trials found.</div>'; return; }
    resultsBox.innerHTML = '';
    data.results.forEach(trial => {
      const ftBadge = trial.has_free_full_text
        ? `<span class="bg-green-100 text-green-800 text-[10px] font-bold px-2 py-0.5 rounded uppercase">Free Full Text</span>` : '';
      const ptCfg   = PUB_TYPE_CONFIG[trial.pub_type] || PUB_TYPE_CONFIG['Publication'];
      const ptBadge = trial.pub_type
        ? `<span class="${ptCfg.bg} ${ptCfg.text} text-[10px] font-bold px-2 py-0.5 rounded uppercase">${trial.pub_type}</span>` : '';
      const pmUrl   = trial.pubmed_url || `https://pubmed.ncbi.nlm.nih.gov/${trial.id}/`;
      const item    = document.createElement('div');
      item.className = 'p-3 bg-white border border-slate-200 rounded hover:border-slate-400 cursor-pointer transition';
      item.innerHTML = `
        <div class="flex justify-between items-start gap-3">
          <div class="flex-1 min-w-0">
            <div class="font-bold text-sm text-slate-800 leading-snug">${trial.title}</div>
            <div class="text-xs text-slate-500 mt-1">${trial.authors} • ${trial.journal} (${trial.year || '—'})</div>
            <div class="flex flex-wrap gap-1 mt-1.5">${ftBadge}${ptBadge}</div>
          </div>
          <div class="flex flex-col gap-1 shrink-0">
            <button class="bg-slate-900 text-white text-xs px-3 py-1.5 rounded font-bold hover:bg-slate-700 transition">Extract</button>
            <a href="${pmUrl}" target="_blank" onclick="event.stopPropagation()"
               class="text-center bg-slate-100 text-slate-600 text-xs px-3 py-1.5 rounded font-medium hover:bg-slate-200 transition">PubMed ↗</a>
          </div>
        </div>`;
      item.querySelector('button').onclick = (e) => { e.stopPropagation(); executeEngine({ inputPayload: trial.id, isPdf: false }); };
      resultsBox.appendChild(item);
    });
  } catch (err) {
    resultsBox.innerHTML = `<div class="text-sm text-red-500 p-2">Search failed: ${err.message}</div>`;
  }
}

// ── PDF Upload ──────────────────────────────────────────────────────
async function analyzePdf() {
  const file = document.getElementById('pdfInput').files[0];
  if (!file) return alert('Please select a PDF file first.');
  const base64 = await new Promise((res, rej) => {
    const r = new FileReader(); r.readAsDataURL(file);
    r.onload = () => res(r.result.split(',')[1]); r.onerror = rej;
  });
  executeEngine({ inputPayload: base64, isPdf: true });
}

// ── Retry State ──────────────────────────────────────────────────────
let retryCancelled = false;

function showRetryStatus(attempt, maxAttempts, waitSeconds) {
  const retryStatus    = document.getElementById('retry-status');
  const retryAttempt   = document.getElementById('retry-attempt');
  const retryCountdown = document.getElementById('retry-countdown');
  const cancelBtn      = document.getElementById('retry-cancel-btn');

  retryStatus.classList.remove('hidden');
  retryAttempt.textContent   = attempt;
  retryCountdown.textContent = waitSeconds;

  cancelBtn.onclick = () => {
    retryCancelled = true;
    hideRetryStatus();
  };

  let remaining = waitSeconds;
  const countdownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0 || retryCancelled) {
      clearInterval(countdownInterval);
    } else {
      retryCountdown.textContent = remaining;
    }
  }, 1000);

  return countdownInterval;
}

function hideRetryStatus() {
  document.getElementById('retry-status')?.classList.add('hidden');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(errorMsg) {
  const msg = (errorMsg || '').toLowerCase();
  return msg.includes('rate') ||
         msg.includes('quota') ||
         msg.includes('busy') ||
         msg.includes('overload') ||
         msg.includes('resource exhausted') ||
         msg.includes('503') ||
         msg.includes('temporarily');
}

// ── Core Engine ─────────────────────────────────────────────────────
async function executeEngine(payload) {
  document.getElementById('searchResults').classList.add('hidden');
  showLoading();
  document.getElementById('reportContainer').classList.add('hidden');
  document.getElementById('exportBar').classList.add('hidden');

  const MAX_RETRIES = 3;
  const BASE_WAIT   = 30;
  let attempt       = 0;
  retryCancelled    = false;

  while (attempt < MAX_RETRIES) {
    attempt++;

    try {
      const res = await fetch(`${API_BASE_URL}/analyze`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-token': INTERNAL_API_TOKEN },
        body:    JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 429) {
          throw new Error('Daily analysis limit reached. Please try again tomorrow.');
        }
        const errorMsg = data.error || data.details || '';
        if (isRetryableError(errorMsg) && attempt < MAX_RETRIES) {
          throw { retryable: true, message: errorMsg };
        }
        throw new Error(errorMsg || 'Server failed to process request.');
      }

      hideRetryStatus();
      window._lastAnalysis = data;
      populateDashboard(data);
      return;

    } catch (err) {
      hideRetryStatus();

      if (retryCancelled) {
        hideLoading();
        return;
      }

      if (err.retryable && attempt < MAX_RETRIES) {
        const waitTime = BASE_WAIT * attempt;
        console.log(`[Engine] Retry ${attempt}/${MAX_RETRIES} in ${waitTime}s...`);
        showRetryStatus(attempt, MAX_RETRIES, waitTime);
        await sleep(waitTime * 1000);

        if (retryCancelled) {
          hideRetryStatus();
          hideLoading();
          return;
        }
        hideRetryStatus();
        continue;
      }

      hideLoading();
      const msg = err.message || (err.retryable ? 'Service unavailable after multiple attempts.' : String(err));

      if (msg.includes('limit') && msg.includes('Daily')) {
        alert('\u{1F6AB} ' + msg);
      } else if (isRetryableError(msg)) {
        alert('\u23F3 AI service is busy. Please try again in a few minutes.');
      } else {
        alert('\u274C Analysis Error: ' + msg);
      }
      return;
    }
  }

  hideLoading();
  alert('\u274C Analysis failed after multiple attempts. Please try again later.');
}

// ── Dashboard Population ─────────────────────────────────────────────
function populateDashboard(data) {
  const rm   = data.reportMeta || {};
  const view = data.clinician_view;

  // ── Header ──
  const titleEl = document.getElementById('trialTitle');
  if (titleEl) titleEl.innerText = data.metadata?.trial_identification || rm.trial_identification || 'Trial Synthesis';

  document.getElementById('studyDesign').innerText = rm.study_design || data.metadata?.study_design || '';

  const authorsEl = document.getElementById('reportAuthors');
  if (authorsEl) authorsEl.innerText = rm.authors || '';

  const journalEl = document.getElementById('reportJournal');
  if (journalEl) {
    const parts = [rm.journal, rm.year].filter(Boolean);
    journalEl.innerText = parts.length ? parts.join(' · ') : '';
  }

  document.getElementById('dataSourceBadge').innerText = rm.source_type ? `Source: ${rm.source_type}` : '';

  setLink('pubmedLink', rm.pubmed_link, 'PubMed ↗');
  setLink('pmcLink',    rm.pmc_link,    'Free Full Text ↗');
  if (rm.doi) { setLink('doiLink', `https://doi.org/${rm.doi}`, 'DOI ↗'); }

  const warningEl = document.getElementById('extractionWarning');
  if (rm.extraction_warning) {
    document.getElementById('extractionWarningText').innerText = rm.extraction_warning;
    warningEl.classList.remove('hidden');
  } else warningEl.classList.add('hidden');

  // ── PICO ──
  document.getElementById('ui-known').innerText    = view.context.already_known;
  document.getElementById('ui-adds').innerText     = view.context.what_this_adds;
  document.getElementById('ui-pop').innerText      = view.pico.population;
  document.getElementById('ui-baseline').innerText = view.baseline_characteristics;
  document.getElementById('ui-int-con').innerText  = `${view.pico.intervention} vs ${view.pico.control}`;
  document.getElementById('ui-out').innerText      = view.pico.primary_outcome;

  const secOutUl = document.getElementById('ui-sec-out');
  secOutUl.innerHTML = '';
  (view.pico.secondary_outcomes || []).forEach(o => {
    const li = document.createElement('li'); li.innerText = o; secOutUl.appendChild(li);
  });

  // ── Critical appraisal ──
  const ca = view.critical_appraisal;
  robBadge(ca.risk_of_bias || 'Unclear');
  gradeBadge(ca.grade_certainty || 'Very Low');
  document.getElementById('ui-rob-rationale').innerText = ca.risk_of_bias_rationale || '';
  document.getElementById('ui-limitations').innerText   = ca.limitations            || '';

  // ── Adverse Events Table ──
  renderAETable(view.adverse_events, view.pico);

  // ── Subgroups ──
  renderSubgroups(view.subgroups);

  // ── Charts ──
  if (currentChart)  { currentChart.destroy();  currentChart  = null; }
  if (currentChart2) { currentChart2.destroy(); currentChart2 = null; }

  const endpoints     = view.interactive_data?.endpoints || [];
  const chartSection  = document.getElementById('chartSection');
  const chart2Section = document.getElementById('chart2Section');

  console.log('[Dashboard] Endpoints received:', endpoints.length, endpoints.map(e => e.label));

  document.getElementById('chartTitle').innerText    = '';
  document.getElementById('ui-synthesis').innerText  = '';
  document.getElementById('chartTitle2').innerText   = '';
  document.getElementById('ui-synthesis2').innerText = '';
  chartSection.classList.remove('chart-visible');
  chartSection.style.display = 'none';
  chart2Section.classList.add('hidden');

  if (endpoints.length > 0) {
    const ep1 = endpoints[0];
    console.log('[Dashboard] Chart 1 attempting:', ep1.label, ep1.recommended_chart_type);
    currentChart = renderChart('endpointChart', ep1);
    if (currentChart) {
      chartSection.classList.add('chart-visible');
      chartSection.style.display = 'block';
      document.getElementById('chartTitle').innerText   = ep1.label || '';
      document.getElementById('ui-synthesis').innerText = ep1.clinical_synthesis || '';
      console.log('[Dashboard] Chart 1 displayed:', ep1.label);
    } else {
      console.warn('[Dashboard] Chart 1 failed to render:', ep1.label);
    }
  }

  if (endpoints.length > 1) {
    const ep2 = endpoints[1];
    console.log('[Dashboard] Chart 2 attempting:', ep2.label, ep2.recommended_chart_type);
    currentChart2 = renderChart('endpointChart2', ep2);
    if (currentChart2) {
      document.getElementById('chartTitle2').innerText   = ep2.label || '';
      document.getElementById('ui-synthesis2').innerText = ep2.clinical_synthesis || '';
      chart2Section.classList.remove('hidden');
      console.log('[Dashboard] Chart 2 displayed:', ep2.label);
    } else {
      console.warn('[Dashboard] Chart 2 failed to render:', ep2.label);
    }
  }

  // ── Patient view ──
  document.getElementById('ui-lay').innerText = data.patient_view.lay_summary;
  document.getElementById('ui-sdm').innerText = data.patient_view.shared_decision_making_takeaway;

  document.getElementById('reportContainer').classList.remove('hidden');
  document.getElementById('exportBar').classList.remove('hidden');
  document.getElementById('mdtSection').style.display    = 'block';
  document.getElementById('patientSection').style.display = 'block';
}

// Expose for library load
window.populateDashboard = populateDashboard;

// ── Adverse Events Table ─────────────────────────────────────────────

function extractArmName(picoText, fallback = 'Arm') {
  if (!picoText) return fallback;

  const text      = picoText.trim();
  const lowerText = text.toLowerCase();

  if (lowerText.includes('placebo')) return 'Placebo';
  if (lowerText.includes('surgery alone')) return 'Surgery';
  if (lowerText.startsWith('surgery')) return 'Surgery';

  const drugPatterns = [
    /tranexamic\s*acid/i,
    /chemotherapy/i,
    /cisplatin/i,
    /fluorouracil/i,
    /nivolumab/i,
    /pembrolizumab/i,
    /docetaxel/i,
    /paclitaxel/i,
    /oxaliplatin/i,
    /irinotecan/i,
    /bevacizumab/i,
    /trastuzumab/i,
    /cetuximab/i,
  ];

  for (const pattern of drugPatterns) {
    const match = text.match(pattern);
    if (match) {
      return match[0].split(/\s+/).map(w =>
        w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      ).join(' ');
    }
  }

  const words = text.split(/\s+/).filter(w =>
    w.length > 2 && !/^\d+\s*(mg|g|ml|mcg|iu)/i.test(w)
  );

  if (words.length >= 2) return words.slice(0, 2).join(' ');
  if (words.length === 1) return words[0];

  return fallback;
}

function renderAETable(ae, pico) {
  const section = document.getElementById('aeSection');
  if (!section) return;

  if (!ae?.has_data || !ae.rows?.length) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  const intHeader = document.getElementById('ae-header-intervention');
  const conHeader = document.getElementById('ae-header-control');
  if (intHeader) intHeader.textContent = extractArmName(pico?.intervention, 'Intervention');
  if (conHeader) {
    const hasControlData = ae.rows.some(r => r.control_pct != null);
    conHeader.textContent = hasControlData ? extractArmName(pico?.control, 'Control') : '—';
  }

  const tbody = document.getElementById('ae-table-body');
  tbody.innerHTML = ae.rows.map((row, i) => `
    <tr class="${i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}">
      <td class="p-2 text-slate-700">${row.event}${row.note ? `<span class="text-[10px] text-slate-400 ml-1">(${row.note})</span>` : ''}</td>
      <td class="p-2 text-center font-semibold text-slate-800">${row.intervention_pct != null ? row.intervention_pct + '%' : '—'}</td>
      <td class="p-2 text-center text-slate-600">${row.control_pct != null ? row.control_pct + '%' : '—'}</td>
    </tr>
  `).join('');

  const tfoot    = document.getElementById('ae-table-foot');
  const footRows = [];
  if (ae.discontinuation?.intervention_pct != null) {
    footRows.push(`
      <tr class="border-t border-slate-200">
        <td class="p-2 text-slate-500 text-xs italic">Discontinuation due to AE</td>
        <td class="p-2 text-center text-slate-500 text-xs">${ae.discontinuation.intervention_pct}%</td>
        <td class="p-2 text-center text-slate-500 text-xs">${ae.discontinuation.control_pct != null ? ae.discontinuation.control_pct + '%' : '—'}</td>
      </tr>
    `);
  }
  if (ae.treatment_related_mortality?.intervention_pct != null) {
    footRows.push(`
      <tr>
        <td class="p-2 text-slate-500 text-xs italic">Treatment-related mortality</td>
        <td class="p-2 text-center text-slate-500 text-xs">${ae.treatment_related_mortality.intervention_pct}%</td>
        <td class="p-2 text-center text-slate-500 text-xs">${ae.treatment_related_mortality.control_pct != null ? ae.treatment_related_mortality.control_pct + '%' : '—'}</td>
      </tr>
    `);
  }
  if (tfoot) tfoot.innerHTML = footRows.join('');
}

// ── Subgroups ────────────────────────────────────────────────────────
function renderSubgroups(subgroups) {
  const section = document.getElementById('subgroupSection');
  const content = document.getElementById('subgroup-content');
  if (!section || !content) return;

  if (!subgroups?.has_significant_interactions || !subgroups.items?.length) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  content.innerHTML = subgroups.items.map(item => `
    <div class="p-3 bg-slate-50 border border-slate-200 rounded">
      <div class="flex items-center justify-between mb-2">
        <span class="font-semibold text-slate-700">${item.variable}</span>
        <span class="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
          Interaction ${item.interaction_p}
        </span>
      </div>
      <div class="flex flex-wrap gap-3">
        ${(item.arms || []).map(arm => `
          <div class="text-xs text-slate-600">
            <span class="font-medium">${arm.subgroup_name}:</span>
            HR ${arm.hr} (95% CI ${arm.ci_95})
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

// ══════════════════════════════════════════════════════════════════════
// CHART RENDERER
// Handles:
// 1. Time-series (KM curves) - multiple data points per arm over time
// 2. Comparative bar charts - each arm is a single value to compare
// ══════════════════════════════════════════════════════════════════════
function renderChart(canvasId, endpointData) {
  try {
    console.log('renderChart RAW:', canvasId, JSON.stringify(endpointData, null, 2).slice(0, 500));

    const canvas = document.getElementById(canvasId);
    if (!canvas) { console.warn('renderChart: Canvas not found:', canvasId); return null; }
    if (!endpointData?.arms?.length) { console.warn('renderChart: No arms data for:', canvasId); return null; }

    const hasValidData = endpointData.arms.some(arm => arm.data_points?.length > 0);
    if (!hasValidData) {
      console.warn('renderChart: No valid data points for:', canvasId,
        'arms:', endpointData.arms.map(a => ({ name: a.group_name, pts: a.data_points })));
      return null;
    }

    const ctx = canvas.getContext('2d');
    let isKM = endpointData.recommended_chart_type === 'stepped-line';

    const isBarChart          = !isKM && endpointData.recommended_chart_type === 'bar';
    const isSinglePointPerArm = endpointData.arms.every(arm => (arm.data_points?.length || 0) <= 1);

    let forceBarChart = false;
    if (isKM && !isSinglePointPerArm) {
      const allPoints = endpointData.arms.flatMap(arm =>
        (arm.data_points || []).map(p => p.y)
      );
      if (allPoints.length > 0) {
        const minY  = Math.min(...allPoints);
        const maxY  = Math.max(...allPoints);
        const range = maxY - minY;
        const isFlat = (minY > 0.85 || maxY < 0.15) && range < 0.1;

        const finalPoints = endpointData.arms.map(arm => {
          const pts = arm.data_points || [];
          return pts.length > 0 ? pts[pts.length - 1].y : null;
        }).filter(v => v !== null);

        const armDiff = finalPoints.length >= 2
          ? Math.abs(finalPoints[0] - finalPoints[1])
          : 0;

        if (isFlat && armDiff < 0.05) {
          forceBarChart = true;
          console.log('renderChart: Overriding KM to bar chart (flat curve, small arm difference)');
        }
      }
    }

    const useComparativeBar = isBarChart || (!isKM && isSinglePointPerArm) || forceBarChart;

    console.log('renderChart:', canvasId, {
      type: endpointData.recommended_chart_type,
      isKM, isBarChart, isSinglePointPerArm, forceBarChart, useComparativeBar,
      arms: endpointData.arms.map(a => ({ name: a.group_name, points: a.data_points?.length }))
    });

    if (useComparativeBar) {
      // ══ COMPARATIVE BAR CHART ══
      const labels = endpointData.arms.map(arm => arm.group_name || 'Unknown');

      let values = endpointData.arms.map(arm => {
        const pts = arm.data_points || [];
        if (pts.length === 0) return 0;
        if (forceBarChart && pts.length > 1) {
          return pts[pts.length - 1]?.y ?? 0;
        }
        return pts[0]?.y ?? 0;
      });

      console.log('renderChart BAR: raw values:', values);

      let yLabel  = endpointData.axes?.y_label || 'Percentage (%)';
      const maxVal = Math.max(...values);

      if (forceBarChart) {
        const avgValue = values.reduce((a, b) => a + b, 0) / values.length;
        if (avgValue > 0.5) {
          values = values.map(v => (1 - v) * 100);
          yLabel = 'Event Rate (%)';
          console.log('renderChart: Converted survival to event rate:', values);
        } else if (maxVal <= 1) {
          values = values.map(v => v * 100);
          console.log('renderChart: Converted proportion to percentage:', values);
        }
      }

      console.log('renderChart BAR: final values:', values, 'yLabel:', yLabel);

      const colors = [
        { bg: 'rgba(15,23,42,0.8)',   border: '#0f172a' },
        { bg: 'rgba(14,165,233,0.8)', border: '#0ea5e9' },
        { bg: 'rgba(34,197,94,0.8)',  border: '#22c55e' },
        { bg: 'rgba(249,115,22,0.8)', border: '#f97316' },
      ];

      return new Chart(ctx, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: endpointData.label || 'Rate',
            data:  values,
            backgroundColor: endpointData.arms.map((_, i) => colors[i % colors.length].bg),
            borderColor:     endpointData.arms.map((_, i) => colors[i % colors.length].border),
            borderWidth:     2,
            borderRadius:    4,
            barPercentage:   0.7,
            categoryPercentage: 0.8,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          devicePixelRatio: 4,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (context) => {
                  const val = context.parsed.y;
                  return val.toFixed(1) + '%';
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              title: { display: true, text: yLabel },
              ticks: { callback: (value) => value.toFixed(1) + '%' }
            },
            x: {
              title: { display: true, text: endpointData.axes?.x_label || 'Treatment Arm' },
              grid:  { display: false }
            },
          },
        },
      });
    }

    // ══ TIME-SERIES CHART (Kaplan-Meier or grouped line) ══
    if (!endpointData.arms[0].data_points?.length) {
      console.warn('renderChart: First arm has no data points for time-series chart');
      return null;
    }

    const processedArms = endpointData.arms.map(arm => {
      let points = [...(arm.data_points || [])];

      points.sort((a, b) => {
        const xA = typeof a.x === 'number' ? a.x : parseFloat(a.x) || 0;
        const xB = typeof b.x === 'number' ? b.x : parseFloat(b.x) || 0;
        return xA - xB;
      });

      if (isKM) {
        let maxY = 1.0;
        points = points.map(p => {
          const y = Math.min(p.y, maxY);
          maxY = y;
          return { ...p, y };
        });
      }

      return { ...arm, data_points: points };
    });

    const xLabels = processedArms[0].data_points.map(dp => dp.x);

    return new Chart(ctx, {
      type: isKM ? 'line' : 'bar',
      data: {
        labels: xLabels,
        datasets: processedArms.map((arm, i) => ({
          label:  arm.group_name || `Arm ${i + 1}`,
          data:   (arm.data_points || []).map(dp => dp.y),
          backgroundColor: i === 0 ? 'rgba(15,23,42,0.1)' : 'rgba(14,165,233,0.1)',
          borderColor:     i === 0 ? '#0f172a' : '#0ea5e9',
          borderWidth:     2.5,
          stepped:         false,
          tension:         0,
          fill:            false,
          pointRadius:     isKM ? 4 : 0,
          pointBackgroundColor: i === 0 ? '#0f172a' : '#0ea5e9',
          pointBorderColor: '#fff',
          pointBorderWidth: 1,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        devicePixelRatio: 4,
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { usePointStyle: true, padding: 15 }
          }
        },
        scales: {
          y: {
            beginAtZero: !isKM,
            max: isKM ? 1 : undefined,
            min: isKM ? 0 : undefined,
            title: { display: true, text: endpointData.axes?.y_label || '' }
          },
          x: {
            title: { display: true, text: endpointData.axes?.x_label || '' }
          },
        },
      },
    });
  } catch (err) {
    console.error('renderChart error:', err, 'for canvas:', canvasId);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════
// PDF EXPORT — NATIVE PRINT APPROACH
// ══════════════════════════════════════════════════════════════════════
function exportReport() {
  window.print();
}