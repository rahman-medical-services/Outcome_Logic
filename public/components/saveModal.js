// components/saveModal.js
// Save-to-Library modal.
// Shown after a successful analysis — pre-populated from data.library_meta.
// User can adjust taxonomy, display title, and tags before saving.
// Offers "Save" (unvalidated) or "Save & Validate" options.

import { DOMAINS, getSpecialties, getSubspecialties } from '../config/taxonomy.js';
import { getAccessToken, getDisplayName }             from '../modules/auth.js';
function _env(k,fb=''){return window.ENV?.[k]||fb;}
const getApiUrl=()=>_env('API_BASE_URL','https://app.rahmanmedical.co.uk/api');
const getApiToken=()=>_env('INTERNAL_API_TOKEN','');

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let _analysis      = null;   // full OutcomeLogic JSON from the last analysis
let _onSaved       = null;   // callback(savedRecord) fired on successful save
let _onClose       = null;   // callback() fired on dismiss

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

/**
 * Open the save modal.
 * @param {object} analysis  — full data object returned by api/analyze
 * @param {function} onSaved — called with the saved record on success
 * @param {function} onClose — called when modal is dismissed without saving
 */
export function openSaveModal(analysis, onSaved, onClose) {
  _analysis = analysis;
  _onSaved  = onSaved  || (() => {});
  _onClose  = onClose  || (() => {});
  _render();
}

export function closeSaveModal() {
  const el = document.getElementById('save-modal-overlay');
  if (el) el.remove();
  _analysis = null;
}

// ─────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────
function _render() {
  // Remove any existing instance
  const existing = document.getElementById('save-modal-overlay');
  if (existing) existing.remove();

  const lm           = _analysis?.library_meta   || {};
  const reportMeta   = _analysis?.reportMeta     || {};
  const displayName  = getDisplayName()          || '';

  // Pre-populate from library_meta
  const initDomain      = lm.domain        || DOMAINS[0];
  const initSpecialties = getSpecialties(initDomain);
  const initSpecialty   = lm.specialty     || initSpecialties[0] || '';
  const initSubs        = getSubspecialties(initDomain, initSpecialty);
  const initSubspecialty = lm.subspecialty || '';
  const initTitle       = lm.display_title || reportMeta.trial_identification || '';
  const initTags        = (lm.tags || []).join(', ');
  const initYear        = lm.landmark_year || '';

  const overlay = document.createElement('div');
  overlay.id    = 'save-modal-overlay';
  overlay.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-start justify-center z-50 p-4 overflow-y-auto';

  overlay.innerHTML = `
    <div class="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-lg my-8">

      <!-- Header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-slate-200">
        <div>
          <h2 class="text-lg font-bold text-slate-900">Save to Library</h2>
          <p class="text-xs text-slate-500 mt-0.5">Review and confirm before saving</p>
        </div>
        <button id="save-modal-close"
          class="text-slate-400 hover:text-slate-700 transition text-xl leading-none">✕</button>
      </div>

      <!-- Analysis summary (read-only) -->
      <div class="px-6 py-4 bg-slate-50 border-b border-slate-200 text-sm space-y-1">
        <p class="font-semibold text-slate-800 leading-snug" id="save-modal-trial-name">
          ${escHtml(reportMeta.trial_identification || 'Unknown Trial')}
        </p>
        <p class="text-slate-600 text-xs">${escHtml(reportMeta.authors || '')}</p>
        <p class="text-slate-500 text-xs">${escHtml(reportMeta.study_design || '')}</p>
        <div class="flex flex-wrap gap-1.5 mt-2">
          ${sourceBadge(reportMeta.source_type)}
          ${reportMeta.pubmed_link
            ? `<a href="${reportMeta.pubmed_link}" target="_blank"
                class="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded hover:bg-blue-100">
                PubMed ↗</a>`
            : ''}
          ${reportMeta.pmc_link
            ? `<a href="${reportMeta.pmc_link}" target="_blank"
                class="text-[10px] bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded hover:bg-green-100">
                Free Full Text ↗</a>`
            : ''}
        </div>
      </div>

      <!-- Form -->
      <div class="px-6 py-4 space-y-4">

        <!-- Display title -->
        <div>
          <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">
            Library Title
          </label>
          <input type="text" id="sm-title" value="${escHtml(initTitle)}"
            placeholder="CROSS Trial — van Hagen et al. (2012)"
            class="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-slate-900 outline-none" />
          <p class="text-[10px] text-slate-400 mt-1">Format: TRIAL NAME — First Author et al. (Year)</p>
        </div>

        <!-- Taxonomy row -->
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Domain</label>
            <select id="sm-domain"
              class="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-slate-900 outline-none bg-white">
              ${DOMAINS.map(d => `<option value="${d}" ${d === initDomain ? 'selected' : ''}>${d}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Specialty</label>
            <select id="sm-specialty"
              class="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-slate-900 outline-none bg-white">
              ${initSpecialties.map(s => `<option value="${s}" ${s === initSpecialty ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Subspecialty</label>
            <select id="sm-subspecialty"
              class="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-slate-900 outline-none bg-white">
              <option value="">— None —</option>
              ${initSubs.map(s => `<option value="${s}" ${s === initSubspecialty ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
        </div>

        <!-- Tags + year row -->
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div class="sm:col-span-2">
            <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Tags</label>
            <input type="text" id="sm-tags" value="${escHtml(initTags)}"
              placeholder="rct, neoadjuvant, survival"
              class="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-slate-900 outline-none" />
            <p class="text-[10px] text-slate-400 mt-1">Comma-separated, lowercase, max 6</p>
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Landmark Year</label>
            <input type="number" id="sm-year" value="${initYear}"
              placeholder="2012" min="1900" max="2099"
              class="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-slate-900 outline-none" />
          </div>
        </div>

        <!-- Validator name (shown for Save & Validate) -->
        <div id="sm-validator-row" class="hidden">
          <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">
            Validating Clinician
          </label>
          <input type="text" id="sm-validator-name" value="${escHtml(displayName)}"
            placeholder="Mr S Rahman FRCS PhD"
            class="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-slate-900 outline-none" />
          <p class="text-[10px] text-slate-400 mt-1">
            Your name and timestamp will be recorded against this entry.
          </p>
        </div>

        <!-- Error -->
        <div id="sm-error"
          class="hidden p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
        </div>

        <!-- Duplicate warning (shown when 409 returned) -->
        <div id="sm-duplicate-warning" class="hidden p-3 bg-amber-50 border border-amber-200 rounded text-sm">
          <p class="font-semibold text-amber-800 mb-1">⚠ Duplicate found in library</p>
          <p id="sm-duplicate-detail" class="text-amber-700 text-xs"></p>
          <label class="flex items-center gap-2 mt-2 cursor-pointer">
            <input type="checkbox" id="sm-confirm-overwrite" class="rounded" />
            <span class="text-xs text-amber-800 font-medium">Yes, overwrite the existing entry</span>
          </label>
        </div>

      </div>

      <!-- Footer buttons -->
      <div class="px-6 py-4 border-t border-slate-200 flex flex-col sm:flex-row gap-2 justify-end">
        <button id="sm-btn-cancel"
          class="order-3 sm:order-1 px-4 py-2 rounded text-sm text-slate-600 hover:bg-slate-100 transition">
          Cancel
        </button>
        <button id="sm-btn-save"
          class="order-2 px-4 py-2 rounded text-sm font-semibold bg-slate-200 text-slate-800 hover:bg-slate-300 transition">
          Save (unvalidated)
        </button>
        <button id="sm-btn-save-validate"
          class="order-1 sm:order-3 px-4 py-2 rounded text-sm font-bold bg-slate-900 text-white hover:bg-slate-700 transition">
          Save &amp; Mark Validated
        </button>
      </div>

    </div>
  `;

  document.body.appendChild(overlay);
  _wireEvents();
}

// ─────────────────────────────────────────────
// EVENT WIRING
// ─────────────────────────────────────────────
function _wireEvents() {

  // Close buttons
  document.getElementById('save-modal-close').onclick  = () => { closeSaveModal(); _onClose(); };
  document.getElementById('sm-btn-cancel').onclick     = () => { closeSaveModal(); _onClose(); };

  // Close on overlay click (outside modal)
  document.getElementById('save-modal-overlay').onclick = (e) => {
    if (e.target.id === 'save-modal-overlay') { closeSaveModal(); _onClose(); }
  };

  // Domain cascade → update specialty dropdown
  document.getElementById('sm-domain').onchange = () => {
    const domain = document.getElementById('sm-domain').value;
    _updateSpecialtyDropdown(domain);
  };

  // Specialty cascade → update subspecialty dropdown
  document.getElementById('sm-specialty').onchange = () => {
    const domain    = document.getElementById('sm-domain').value;
    const specialty = document.getElementById('sm-specialty').value;
    _updateSubspecialtyDropdown(domain, specialty);
  };

  // Save & Validate — show validator name field
  document.getElementById('sm-btn-save-validate').onclick = () => {
    document.getElementById('sm-validator-row').classList.remove('hidden');
    _submit({ validateOnSave: true });
  };

  // Save (unvalidated)
  document.getElementById('sm-btn-save').onclick = () => {
    document.getElementById('sm-validator-row').classList.add('hidden');
    _submit({ validateOnSave: false });
  };
}

// ─────────────────────────────────────────────
// DROPDOWN CASCADE HELPERS
// ─────────────────────────────────────────────
function _updateSpecialtyDropdown(domain) {
  const specs = getSpecialties(domain);
  const sel   = document.getElementById('sm-specialty');
  sel.innerHTML = specs.map(s => `<option value="${s}">${s}</option>`).join('');
  _updateSubspecialtyDropdown(domain, specs[0] || '');
}

function _updateSubspecialtyDropdown(domain, specialty) {
  const subs = getSubspecialties(domain, specialty);
  const sel  = document.getElementById('sm-subspecialty');
  sel.innerHTML = `<option value="">— None —</option>` +
    subs.map(s => `<option value="${s}">${s}</option>`).join('');
}

// ─────────────────────────────────────────────
// FORM COLLECTION
// ─────────────────────────────────────────────
function _collectForm() {
  const rawTags = document.getElementById('sm-tags').value;
  const tags    = rawTags
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 6);

  return {
    display_title:  document.getElementById('sm-title').value.trim(),
    domain:         document.getElementById('sm-domain').value,
    specialty:      document.getElementById('sm-specialty').value,
    subspecialty:   document.getElementById('sm-subspecialty').value || null,
    tags,
    landmark_year:  parseInt(document.getElementById('sm-year').value) || null,
    validator_name: document.getElementById('sm-validator-name').value.trim(),
  };
}

// ─────────────────────────────────────────────
// SUBMIT
// ─────────────────────────────────────────────
async function _submit({ validateOnSave, confirmOverwrite = false }) {
  const errorEl = document.getElementById('sm-error');
  errorEl.classList.add('hidden');

  const form = _collectForm();

  if (!form.display_title) {
    errorEl.textContent = 'Please enter a library title.';
    errorEl.classList.remove('hidden');
    return;
  }

  // Disable buttons during save
  _setButtonsLoading(true);

  try {
    const token = getAccessToken();
    if (!token) throw new Error('No active session. Please sign in again.');

    const confirmOverwriteFlag = confirmOverwrite ||
      (document.getElementById('sm-confirm-overwrite')?.checked ?? false);

    const payload = {
      analysis:          _analysis,
      library_meta:      form,
      confirm_overwrite: confirmOverwriteFlag,
      validate_on_save:  validateOnSave,
      validator_name:    validateOnSave ? form.validator_name : undefined,
    };

    const response = await fetch(`${getApiUrl()}/library-save`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-api-token': getApiToken(),
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    // Duplicate detected — show warning and let user decide
    if (response.status === 409) {
      _handleDuplicate(data, validateOnSave);
      _setButtonsLoading(false);
      return;
    }

    if (!response.ok) {
      throw new Error(data.error || 'Save failed.');
    }

    // Success
    closeSaveModal();
    _onSaved(data.record);

  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
    _setButtonsLoading(false);
  }
}

// ─────────────────────────────────────────────
// DUPLICATE HANDLING
// ─────────────────────────────────────────────
function _handleDuplicate(data, validateOnSave) {
  const warningEl = document.getElementById('sm-duplicate-warning');
  const detailEl  = document.getElementById('sm-duplicate-detail');

  const dup     = data.duplicates?.[0];
  const dupDate = dup?.saved_at
    ? new Date(dup.saved_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'unknown date';

  detailEl.textContent = `"${dup?.display_title || 'Unknown'}" was saved on ${dupDate}${dup?.validated ? ' (validated)' : ' (unvalidated)'}.`;
  warningEl.classList.remove('hidden');

  // Wire overwrite confirm checkbox to re-submit with flag
  const checkbox = document.getElementById('sm-confirm-overwrite');
  checkbox.onchange = () => {
    if (checkbox.checked) {
      _submit({ validateOnSave, confirmOverwrite: true });
    }
  };
}

// ─────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────
function _setButtonsLoading(loading) {
  const saveBtn     = document.getElementById('sm-btn-save');
  const validateBtn = document.getElementById('sm-btn-save-validate');
  const cancelBtn   = document.getElementById('sm-btn-cancel');

  if (loading) {
    saveBtn.textContent     = 'Saving…';
    validateBtn.textContent = 'Saving…';
    saveBtn.disabled        = true;
    validateBtn.disabled    = true;
    cancelBtn.disabled      = true;
  } else {
    saveBtn.textContent     = 'Save (unvalidated)';
    validateBtn.textContent = 'Save & Mark Validated';
    saveBtn.disabled        = false;
    validateBtn.disabled    = false;
    cancelBtn.disabled      = false;
  }
}

function sourceBadge(sourceType) {
  const map = {
    'full-text-pmc':  ['Full Text (PMC)',  'bg-green-100 text-green-800'],
    'full-text-jina': ['Full Text (Web)',  'bg-green-100 text-green-800'],
    'full-text-pdf':  ['Full Text (PDF)',  'bg-green-100 text-green-800'],
    'abstract-only':  ['Abstract Only',   'bg-yellow-100 text-yellow-800'],
    'pasted-text':    ['Pasted Text',     'bg-slate-100 text-slate-600'],
    'url':            ['URL',             'bg-slate-100 text-slate-600'],
  };
  const [label, cls] = map[sourceType] || ['Unknown', 'bg-slate-100 text-slate-500'];
  return `<span class="text-[10px] font-bold px-2 py-0.5 rounded uppercase ${cls}">${label}</span>`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}