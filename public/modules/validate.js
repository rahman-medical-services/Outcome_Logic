// modules/validate.js
// Validation queue — shows all unvalidated trials with bulk validate support.
// Rendered as a collapsible panel inside the library tab.

import { getAccessToken, getDisplayName } from './auth.js';
import { LIBRARY_TABLE } from '../config/constants.js';
function _env(k,fb=''){return window.ENV?.[k]||fb;}
const getApiUrl=()=>_env('API_BASE_URL','https://app.rahmanmedical.co.uk/api');
const getApiToken=()=>_env('INTERNAL_API_TOKEN','');
import { toast } from '../components/Toasts.js';

// ─────────────────────────────────────────────
// RENDER VALIDATION QUEUE
// ─────────────────────────────────────────────
export function renderValidationQueue(containerEl, trials, onValidated) {
  const pending = trials.filter(t => !t.validated);

  if (pending.length === 0) {
    containerEl.innerHTML = `
      <div class="text-center py-6 text-slate-400 text-sm">
        <span class="text-2xl">✓</span>
        <p class="mt-1">All trials validated</p>
      </div>
    `;
    return;
  }

  containerEl.innerHTML = `
    <div class="space-y-3">

      <!-- Bulk controls -->
      <div class="flex flex-wrap items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
        <span class="text-xs font-bold text-amber-800">
          ⚠ ${pending.length} trial${pending.length !== 1 ? 's' : ''} awaiting validation
        </span>
        <div class="flex items-center gap-2 ml-auto">
          <label class="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
            <input type="checkbox" id="vq-select-all" class="rounded" />
            Select all
          </label>
        </div>
      </div>

      <!-- Validator name input -->
      <div id="vq-bulk-controls" class="hidden p-3 bg-white border border-slate-200 rounded-lg space-y-2">
        <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide">
          Validating Clinician
        </label>
        <div class="flex gap-2">
          <input type="text" id="vq-validator-name"
            value="${escHtml(getDisplayName() || '')}"
            placeholder="Mr S Rahman FRCS PhD"
            class="flex-1 min-w-0 border border-slate-300 rounded px-3 py-1.5 text-sm
                   focus:ring-2 focus:ring-slate-900 outline-none" />
          <button id="vq-bulk-validate"
            class="shrink-0 bg-green-600 text-white text-xs px-4 py-1.5 rounded
                   font-bold hover:bg-green-700 transition">
            Validate Selected
          </button>
        </div>
      </div>

      <!-- Trial list -->
      <div id="vq-list" class="space-y-2">
        ${pending.map(t => validationRowHtml(t)).join('')}
      </div>

    </div>
  `;

  _wireValidationQueue(containerEl, pending, onValidated);
}

function validationRowHtml(trial) {
  return `
    <div class="flex items-start gap-3 p-3 bg-white border border-slate-200 rounded-lg"
         data-id="${escHtml(trial.id)}">
      <input type="checkbox" class="vq-checkbox rounded border-slate-300 mt-0.5 shrink-0"
             data-id="${escHtml(trial.id)}" />
      <div class="flex-1 min-w-0">
        <p class="font-semibold text-sm text-slate-800 leading-snug">
          ${escHtml(trial.display_title)}
        </p>
        ${trial.authors
          ? `<p class="text-xs text-slate-500">${escHtml(trial.authors)}</p>`
          : ''}
        <p class="text-[10px] text-slate-400 mt-0.5">
          ${escHtml(trial.specialty || '')}
          ${trial.subspecialty ? ` · ${escHtml(trial.subspecialty)}` : ''}
          · Saved ${formatDate(trial.saved_at)}
        </p>
      </div>
      <button class="vq-single-validate shrink-0 bg-green-50 text-green-700 border border-green-200
                     text-xs px-3 py-1.5 rounded font-semibold hover:bg-green-100 transition"
              data-id="${escHtml(trial.id)}">
        Validate
      </button>
    </div>
  `;
}

function _wireValidationQueue(containerEl, pending, onValidated) {
  const selectAll   = containerEl.querySelector('#vq-select-all');
  const bulkControls = containerEl.querySelector('#vq-bulk-controls');
  const bulkBtn     = containerEl.querySelector('#vq-bulk-validate');

  let selectedIds = new Set();

  // Select all checkbox
  selectAll.onchange = () => {
    const checked = selectAll.checked;
    containerEl.querySelectorAll('.vq-checkbox').forEach(cb => {
      cb.checked = checked;
      const id   = cb.dataset.id;
      checked ? selectedIds.add(id) : selectedIds.delete(id);
    });
    bulkControls.classList.toggle('hidden', selectedIds.size === 0);
  };

  // Individual checkboxes
  containerEl.querySelectorAll('.vq-checkbox').forEach(cb => {
    cb.onchange = () => {
      cb.checked ? selectedIds.add(cb.dataset.id) : selectedIds.delete(cb.dataset.id);
      bulkControls.classList.toggle('hidden', selectedIds.size === 0);
      selectAll.checked = selectedIds.size === pending.length;
      selectAll.indeterminate = selectedIds.size > 0 && selectedIds.size < pending.length;
    };
  });

  // Bulk validate
  bulkBtn.onclick = async () => {
    if (selectedIds.size === 0) return;
    const name = containerEl.querySelector('#vq-validator-name').value.trim();
    if (!name) {
      toast.warning('Please enter a validator name.');
      return;
    }
    await _validateIds([...selectedIds], name, onValidated);
  };

  // Single validate buttons
  containerEl.querySelectorAll('.vq-single-validate').forEach(btn => {
    btn.onclick = async () => {
      const name = getDisplayName() || '';
      await _validateIds([btn.dataset.id], name, onValidated);
    };
  });
}

// ─────────────────────────────────────────────
// API CALL
// ─────────────────────────────────────────────
async function _validateIds(ids, validatorName, onValidated) {
  try {
    const token = getAccessToken();
    if (!token) throw new Error('No active session.');

    const response = await fetch(`${getApiUrl()}/library-validate`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-api-token': getApiToken(),
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        mode:           'validate',
        ids,
        validator_name: validatorName,
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Validation failed.');

    toast.success(data.message);
    onValidated?.(data.updated);

  } catch (err) {
    toast.error(err.message);
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function formatDate(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}