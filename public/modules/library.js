// modules/library.js
// Library tab — browse, filter, load, validate, and export saved trials.

import { getAccessToken }                         from './auth.js';
import { LIBRARY_TABLE }                          from '../config/constants.js';
import { renderCategoryPicker }                   from '../components/categoryPicker.js';
import { renderTrialCards }                       from '../components/trialCard.js';
import { renderValidationQueue }                  from './validate.js';
import { openBatchModal }                         from './batch.js';
import { exportJson, exportPdfCompendium }        from './export.js';
import { toast }                                  from '../components/toasts.js';

function _env(k,fb=''){return window.ENV?.[k]||fb;}
const getApiUrl=()=>_env('API_BASE_URL','https://app.rahmanmedical.co.uk/api');
const getApiToken=()=>_env('INTERNAL_API_TOKEN','');

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let _state = {
  trials:        [],
  counts:        {},
  filters:       { domain: null, specialty: null, subspecialty: null, validated_only: false },
  loading:       false,
  pickerCtrl:    null,
  onLoadTrial:   null,   // callback(analysis) — passed in from app.js
};

// ─────────────────────────────────────────────
// INITIALISE
// Called by app.js when the library tab is shown
// ─────────────────────────────────────────────
export async function initLibrary(containerEl, { onLoadTrial } = {}) {
  _state.onLoadTrial = onLoadTrial;
  _render(containerEl);
  await _loadCounts(containerEl);
  await _loadTrials(containerEl);
}

// ─────────────────────────────────────────────
// RENDER SHELL
// ─────────────────────────────────────────────
function _render(containerEl) {
  containerEl.innerHTML = `
    <div class="max-w-5xl mx-auto py-6 px-4 space-y-6">

      <!-- Filter bar -->
      <div class="bg-white border border-slate-200 rounded-lg shadow-sm p-4 sm:p-6">

        <!-- Category picker -->
        <div id="lib-category-picker"></div>

        <!-- Keyword search -->
        <div class="mt-4">
          <input type="text" id="lib-search-input"
            placeholder="Search by title, author, tag…"
            class="w-full border border-slate-300 rounded px-4 py-2 text-sm
                   focus:ring-2 focus:ring-slate-900 outline-none" />
        </div>

        <!-- Second filter row -->
        <div class="flex flex-wrap items-center justify-between gap-3 mt-3">
          <label class="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
            <input type="checkbox" id="lib-validated-only" class="rounded" />
            Validated only
          </label>
          <div class="flex flex-wrap gap-2">
            <button id="lib-btn-batch"
              class="bg-slate-100 text-slate-700 text-xs px-3 py-1.5 rounded font-semibold
                     hover:bg-slate-200 transition">
              📤 Batch Upload
            </button>
            <button id="lib-btn-export-json"
              class="bg-slate-100 text-slate-700 text-xs px-3 py-1.5 rounded font-semibold
                     hover:bg-slate-200 transition">
              ↓ Export JSON
            </button>
            <button id="lib-btn-export-pdf"
              class="bg-slate-900 text-white text-xs px-3 py-1.5 rounded font-semibold
                     hover:bg-slate-700 transition">
              📖 Export Compendium
            </button>
          </div>
        </div>
      </div>

      <!-- Summary stats -->
      <div id="lib-stats" class="flex flex-wrap gap-4 text-sm"></div>

      <!-- Validation queue (collapsible) -->
      <div id="lib-validation-wrapper" class="hidden">
        <button id="lib-validation-toggle"
          class="w-full flex items-center justify-between p-3 bg-amber-50 border border-amber-200
                 rounded-lg text-sm font-semibold text-amber-800 hover:bg-amber-100 transition">
          <span id="lib-validation-badge">⚠ 0 trials awaiting validation</span>
          <span id="lib-validation-chevron" class="transition-transform">▼</span>
        </button>
        <div id="lib-validation-queue" class="hidden mt-2"></div>
      </div>

      <!-- Trial cards -->
      <div id="lib-loading" class="text-center py-12 text-slate-400 text-sm hidden">
        <div class="animate-pulse">Loading library…</div>
      </div>
      <div id="lib-cards" class="space-y-3"></div>

    </div>
  `;

  // Category picker
  const pickerEl    = containerEl.querySelector('#lib-category-picker');
  _state.pickerCtrl = renderCategoryPicker(
    pickerEl,
    _state.filters,
    (newFilters) => {
      _state.filters = { ..._state.filters, ...newFilters };
      _loadTrials(containerEl);
    },
    _state.counts,
    { showAll: true }
  );

  // Keyword search — client-side filter on loaded cards
  const searchInput = containerEl.querySelector('#lib-search-input');
  if (searchInput) {
    searchInput.oninput = () => {
      const term = searchInput.value.toLowerCase().trim();
      const cards = containerEl.querySelectorAll('.trial-card');
      cards.forEach(card => {
        const text = card.innerText.toLowerCase();
        card.style.display = (!term || text.includes(term)) ? '' : 'none';
      });
    };
  }

  // Validated only checkbox
  containerEl.querySelector('#lib-validated-only').onchange = (e) => {
    _state.filters.validated_only = e.target.checked;
    _loadTrials(containerEl);
  };

  // Batch upload
  containerEl.querySelector('#lib-btn-batch').onclick = () => {
    openBatchModal(() => {
      toast.info('Batch complete — refreshing library…');
      _loadCounts(containerEl);
      _loadTrials(containerEl);
    });
  };

  // Export JSON
  containerEl.querySelector('#lib-btn-export-json').onclick = () => {
    exportJson(_state.filters);
  };

  // Export compendium
  containerEl.querySelector('#lib-btn-export-pdf').onclick = () => {
    exportPdfCompendium(_state.filters, { validatedOnly: true });
  };

  // Validation queue toggle
  containerEl.querySelector('#lib-validation-toggle').onclick = () => {
    const queueEl   = containerEl.querySelector('#lib-validation-queue');
    const chevronEl = containerEl.querySelector('#lib-validation-chevron');
    const hidden    = queueEl.classList.toggle('hidden');
    chevronEl.style.transform = hidden ? 'rotate(0deg)' : 'rotate(180deg)';
  };
}

// ─────────────────────────────────────────────
// LOAD COUNTS (for navigation badges)
// ─────────────────────────────────────────────
async function _loadCounts(containerEl) {
  try {
    const token = getAccessToken();
    if (!token) return;

    const res  = await fetch(`${getApiUrl()}/library-get`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-api-token': getApiToken(),
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ mode: 'counts' }),
    });

    if (!res.ok) return;
    const data = await res.json();
    _state.counts = data.counts || {};

    // Update category picker with new counts
    _state.pickerCtrl?.updateCounts(_state.counts);

  } catch (err) {
    console.warn('[Library] Counts fetch failed:', err.message);
  }
}

// ─────────────────────────────────────────────
// LOAD TRIALS
// ─────────────────────────────────────────────
async function _loadTrials(containerEl) {
  if (_state.loading) return;
  _state.loading = true;

  const loadingEl = containerEl.querySelector('#lib-loading');
  const cardsEl   = containerEl.querySelector('#lib-cards');
  loadingEl.classList.remove('hidden');
  cardsEl.innerHTML = '';

  try {
    const token = getAccessToken();
    if (!token) throw new Error('Not signed in.');

    const res  = await fetch(`${getApiUrl()}/library-get`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-api-token': getApiToken(),
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        mode:           'browse',
        domain:         _state.filters.domain       || undefined,
        specialty:      _state.filters.specialty    || undefined,
        subspecialty:   _state.filters.subspecialty || undefined,
        validated_only: _state.filters.validated_only,
        order_by:       'display_title',
        order_dir:      'asc',
      }),
    });

    if (!res.ok) throw new Error('Failed to load library.');
    const data     = await res.json();
    _state.trials  = data.trials || [];

    // Update stats bar
    _renderStats(containerEl, data.summary || {});

    // Update validation queue
    _renderValidationSection(containerEl, _state.trials);

    // Render cards
    renderTrialCards(cardsEl, _state.trials, {
      onLoad:       (id) => _loadTrial(id),
      onValidate:   (id) => _validateTrial(id, containerEl),
      onUnvalidate: (id) => _unvalidateTrial(id, containerEl),
      onDelete:     (id) => _deleteTrial(id, containerEl),
    });

  } catch (err) {
    cardsEl.innerHTML = `
      <div class="text-center py-12 text-red-500 text-sm">
        Failed to load library: ${escHtml(err.message)}
      </div>
    `;
  } finally {
    _state.loading = false;
    loadingEl.classList.add('hidden');
  }
}

// ─────────────────────────────────────────────
// STATS BAR
// ─────────────────────────────────────────────
function _renderStats(containerEl, summary) {
  const statsEl = containerEl.querySelector('#lib-stats');
  if (!summary.total && summary.total !== 0) { statsEl.innerHTML = ''; return; }

  statsEl.innerHTML = `
    <div class="flex flex-wrap gap-4 text-sm text-slate-600">
      <span><strong class="text-slate-900">${summary.total}</strong> trial${summary.total !== 1 ? 's' : ''}</span>
      <span class="text-green-700"><strong>${summary.validated}</strong> validated</span>
      ${summary.pending > 0
        ? `<span class="text-amber-600"><strong>${summary.pending}</strong> awaiting review</span>`
        : ''}
    </div>
  `;
}

// ─────────────────────────────────────────────
// VALIDATION QUEUE SECTION
// ─────────────────────────────────────────────
function _renderValidationSection(containerEl, trials) {
  const wrapperEl = containerEl.querySelector('#lib-validation-wrapper');
  const badgeEl   = containerEl.querySelector('#lib-validation-badge');
  const queueEl   = containerEl.querySelector('#lib-validation-queue');
  const pending   = trials.filter(t => !t.validated);

  if (pending.length === 0) {
    wrapperEl.classList.add('hidden');
    return;
  }

  wrapperEl.classList.remove('hidden');
  badgeEl.textContent = `⚠ ${pending.length} trial${pending.length !== 1 ? 's' : ''} awaiting validation`;

  renderValidationQueue(queueEl, trials, (updatedRecords) => {
    // Update local state and re-render
    updatedRecords.forEach(updated => {
      const idx = _state.trials.findIndex(t => t.id === updated.id);
      if (idx !== -1) _state.trials[idx] = { ..._state.trials[idx], ...updated };
    });
    _loadTrials(containerEl);
  });
}

// ─────────────────────────────────────────────
// LOAD TRIAL (instant recall)
// ─────────────────────────────────────────────
async function _loadTrial(id) {
  try {
    const token = getAccessToken();
    const res   = await fetch(`${getApiUrl()}/library-get`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-api-token': getApiToken(),
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ mode: 'single', id }),
    });

    if (!res.ok) throw new Error('Failed to load trial.');
    const data = await res.json();
    if (!data.trial?.analysis_json) throw new Error('No analysis data found.');

    // Pass analysis to app.js → populate the analyse tab
    _state.onLoadTrial?.(data.trial.analysis_json);
    toast.success('Trial loaded into Analyse tab.');

  } catch (err) {
    toast.error(err.message);
  }
}

// ─────────────────────────────────────────────
// VALIDATE / UNVALIDATE
// ─────────────────────────────────────────────
async function _validateTrial(id, containerEl) {
  const name = prompt('Validator name:', window._currentUserDisplayName || '');
  if (name === null) return;   // cancelled
  await _callValidate([id], 'validate', name.trim(), containerEl);
}

async function _unvalidateTrial(id, containerEl) {
  if (!confirm('Remove validation from this trial?')) return;
  await _callValidate([id], 'unvalidate', '', containerEl);
}

async function _callValidate(ids, mode, validatorName, containerEl) {
  try {
    const token = getAccessToken();
    const res   = await fetch(`${getApiUrl()}/library-validate`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-api-token': getApiToken(),
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ mode, ids, validator_name: validatorName }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed.');
    toast.success(data.message);
    await _loadTrials(containerEl);

  } catch (err) {
    toast.error(err.message);
  }
}

// ─────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────
async function _deleteTrial(id, containerEl) {
  const trial = _state.trials.find(t => t.id === id);
  const title = trial?.display_title || 'this trial';
  if (!confirm(`Delete "${title}" from the library? This cannot be undone.`)) return;

  try {
    const token = getAccessToken();
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    const supabase = createClient(window.ENV?.SUPABASE_URL, window.ENV?.SUPABASE_ANON_KEY);
    await supabase.auth.setSession({ access_token: token, refresh_token: '' });
    const { error } = await supabase.from('trials').delete().eq('id', id);
    if (error) throw new Error(error.message);

    toast.success(`"${title}" deleted.`);
    _state.trials = _state.trials.filter(t => t.id !== id);
    await _loadTrials(containerEl);

  } catch (err) {
    toast.error(`Delete failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// PUBLIC: refresh the library (called after save)
// ─────────────────────────────────────────────
export async function refreshLibrary(containerEl) {
  await _loadCounts(containerEl);
  await _loadTrials(containerEl);
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}