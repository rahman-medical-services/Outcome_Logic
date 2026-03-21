// components/categoryPicker.js
// Renders cascading domain → specialty → subspecialty dropdowns.
// Used by the library filter bar and any other taxonomy picker.

import { DOMAINS, getSpecialties, getSubspecialties } from '../config/taxonomy.js';

/**
 * Renders taxonomy filter dropdowns into a container element.
 *
 * 
 *
 * @param {HTMLElement} containerEl
 * @param {object}      initial     — { domain, specialty, subspecialty }
 * @param {function}    onChange    — called with { domain, specialty, subspecialty } on any change
 * @param {object}      counts      — nested counts object from library-get (optional, for badges)
 * @param {object}      options     — { showAll: bool (adds "All" option), compact: bool }
 */
export function renderCategoryPicker(containerEl, initial = {}, onChange, counts = {}, options = {}) {
  const { showAll = true, compact = false } = options;

  const state = {
    domain:       initial.domain       || '',
    specialty:    initial.specialty    || '',
    subspecialty: initial.subspecialty || '',
  };

  const labelCls  = compact
    ? 'block text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1'
    : 'block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1';
  const selectCls = `w-full border border-slate-300 rounded px-3 py-2 text-sm
                     focus:ring-2 focus:ring-slate-900 outline-none bg-white`;

  function countBadge(n) {
    if (!n) return '';
    return `<span class="ml-1 text-[10px] text-slate-400">(${n})</span>`;
  }

  function domainOptions() {
    const doms = DOMAINS;
    const all  = showAll ? `<option value="">All Domains</option>` : '';
    return all + doms.map(d => {
      const total = counts[d]?._total || '';
      return `<option value="${d}" ${d === state.domain ? 'selected' : ''}>${d}${total ? ` (${total})` : ''}</option>`;
    }).join('');
  }

  function specialtyOptions() {
    const specs = state.domain ? getSpecialties(state.domain) : [];
    const all   = showAll ? `<option value="">All Specialties</option>` : '';
    if (!specs.length) return all + `<option value="" disabled>— select domain first —</option>`;
    return all + specs.map(s => {
      const total = counts[state.domain]?.[s]?._total || '';
      return `<option value="${s}" ${s === state.specialty ? 'selected' : ''}>${s}${total ? ` (${total})` : ''}</option>`;
    }).join('');
  }

  function subspecialtyOptions() {
    const subs = (state.domain && state.specialty)
      ? getSubspecialties(state.domain, state.specialty)
      : [];
    const all  = showAll ? `<option value="">All Subspecialties</option>` : '';
    if (!subs.length) return all + `<option value="" disabled>— select specialty first —</option>`;
    return all + subs.map(s => {
      const total = counts[state.domain]?.[state.specialty]?.[s]?._total || '';
      return `<option value="${s}" ${s === state.subspecialty ? 'selected' : ''}>${s}${total ? ` (${total})` : ''}</option>`;
    }).join('');
  }

  function render() {
    containerEl.innerHTML = `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label class="${labelCls}">Domain</label>
          <select id="cp-domain" class="${selectCls}">
            ${domainOptions()}
          </select>
        </div>
        <div>
          <label class="${labelCls}">Specialty</label>
          <select id="cp-specialty" class="${selectCls}">
            ${specialtyOptions()}
          </select>
        </div>
        <div>
          <label class="${labelCls}">Subspecialty</label>
          <select id="cp-subspecialty" class="${selectCls}">
            ${subspecialtyOptions()}
          </select>
        </div>
      </div>
    `;

    // Wire events
    containerEl.querySelector('#cp-domain').onchange = (e) => {
      state.domain       = e.target.value;
      state.specialty    = '';
      state.subspecialty = '';
      render();
      onChange?.(getState());
    };

    containerEl.querySelector('#cp-specialty').onchange = (e) => {
      state.specialty    = e.target.value;
      state.subspecialty = '';
      render();
      onChange?.(getState());
    };

    containerEl.querySelector('#cp-subspecialty').onchange = (e) => {
      state.subspecialty = e.target.value;
      onChange?.(getState());
    };
  }

  function getState() {
    return {
      domain:       state.domain       || null,
      specialty:    state.specialty    || null,
      subspecialty: state.subspecialty || null,
    };
  }

  // Initial render
  render();

  // Return controller so caller can read state or update counts
  return {
    getState,
    updateCounts: (newCounts) => {
      Object.assign(counts, newCounts);
      render();
    },
    reset: () => {
      state.domain       = '';
      state.specialty    = '';
      state.subspecialty = '';
      render();
      onChange?.(getState());
    },
  };
}