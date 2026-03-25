// components/trialCard.js
// Renders a single trial card for the library browser.
// Returns an HTML string — caller inserts into DOM.

// ─────────────────────────────────────────────
// SPECIALTY COLOUR MAP
// Consistent colour accent per specialty across all cards
// ─────────────────────────────────────────────
const SPECIALTY_COLOURS = {
  // Surgery
  'Upper GI':       'bg-blue-500',
  'Hernia':         'bg-emerald-500',
  'Colorectal':     'bg-orange-500',
  'Breast':         'bg-pink-500',
  'Endocrine':      'bg-purple-500',
  'Vascular':       'bg-red-500',
  'Hepatobiliary':  'bg-amber-500',
  // Orthopaedics
  'Hip':            'bg-cyan-500',
  'Knee':           'bg-teal-500',
  'Spine':          'bg-indigo-500',
  'Shoulder':       'bg-violet-500',
  'Trauma':         'bg-rose-500',
  // Medicine
  'Cardiology':     'bg-red-600',
  'Oncology':       'bg-purple-600',
  'Respiratory':    'bg-sky-500',
  'Gastroenterology': 'bg-lime-600',
  'Endocrinology':  'bg-yellow-600',
  'Neurology':      'bg-indigo-600',
  'Infectious Disease': 'bg-green-600',
  // Critical Care
  'ICU':            'bg-slate-600',
  'Emergency Medicine': 'bg-red-700',
  // Anaesthesia
  'Regional':       'bg-teal-600',
  'General':        'bg-slate-500',
};

function specialtyColour(specialty) {
  return SPECIALTY_COLOURS[specialty] || 'bg-slate-400';
}

// ─────────────────────────────────────────────
// BADGE HELPERS
// ─────────────────────────────────────────────
const ROB_BADGE = {
  'Low':      'bg-green-100 text-green-800',
  'Moderate': 'bg-yellow-100 text-yellow-800',
  'High':     'bg-red-100 text-red-800',
  'Unclear':  'bg-slate-100 text-slate-600',
};

const GRADE_BADGE = {
  'High':     'bg-green-100 text-green-800',
  'Moderate': 'bg-blue-100 text-blue-800',
  'Low':      'bg-yellow-100 text-yellow-800',
  'Very Low': 'bg-red-100 text-red-800',
};

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

function tagBadges(tags) {
  if (!tags || tags.length === 0) return '';
  return tags.slice(0, 4).map(t =>
    `<span class="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">${escHtml(t)}</span>`
  ).join('');
}

// ─────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────

/**
 * Returns the HTML string for a trial card.
 * @param {object} trial   — row from Supabase trials table (card fields)
 * @param {object} options — { selectable: bool, selected: bool }
 */
export function trialCardHtml(trial, options = {}) {
  const { selectable = false, selected = false } = options;

  const validated     = trial.validated;
  const robRaw        = trial.analysis_json?.clinician_view?.critical_appraisal?.risk_of_bias;
  const gradeRaw      = trial.analysis_json?.clinician_view?.critical_appraisal?.grade_certainty;
  const robCls        = ROB_BADGE[robRaw]   || '';
  const gradeCls      = GRADE_BADGE[gradeRaw] || '';

  const validatedBadge = validated
    ? `<span class="flex items-center gap-1 text-[10px] font-bold text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded">
         <span>✓</span> Validated
       </span>`
    : `<span class="text-[10px] font-medium text-slate-400 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded">
         Awaiting review
       </span>`;

  const pubmedLink = trial.analysis_json?.reportMeta?.pubmed_link
    ? `<a href="${escHtml(trial.analysis_json.reportMeta.pubmed_link)}" target="_blank"
          onclick="event.stopPropagation()"
          class="text-[10px] text-blue-600 hover:underline">PubMed ↗</a>`
    : '';

  const pmcLink = trial.analysis_json?.reportMeta?.pmc_link
    ? `<a href="${escHtml(trial.analysis_json.reportMeta.pmc_link)}" target="_blank"
          onclick="event.stopPropagation()"
          class="text-[10px] text-green-600 hover:underline">Full Text ↗</a>`
    : '';

  const checkbox = selectable
    ? `<input type="checkbox" class="trial-card-checkbox rounded border-slate-300 mt-0.5 shrink-0"
         data-id="${escHtml(trial.id)}" ${selected ? 'checked' : ''}
         onclick="event.stopPropagation()" />`
    : '';

  const validationMeta = validated
    ? `<span class="text-[10px] text-slate-400">
         Validated by ${escHtml(trial.validated_by_name || '—')} · ${formatDate(trial.validated_at)}
       </span>`
    : `<span class="text-[10px] text-slate-400">
         Saved ${formatDate(trial.saved_at)}
       </span>`;

  return `
    <div class="trial-card group bg-white border border-slate-200 rounded-lg
                hover:border-slate-400 hover:shadow-sm cursor-pointer transition overflow-hidden
                ${selected ? 'border-slate-500 bg-slate-50' : ''}"
         data-id="${escHtml(trial.id)}">

      <!-- Specialty colour accent bar -->
      <div class="h-1 w-full ${specialtyColour(trial.specialty)}"></div>

      <div class="flex items-start gap-3 p-4">
        ${checkbox}
        <div class="flex-1 min-w-0">

          <!-- Title row -->
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="font-bold text-sm text-slate-900 leading-snug">
                ${escHtml(trial.display_title)}
              </p>
              ${trial.authors
                ? `<p class="text-xs text-slate-500 mt-0.5">${escHtml(trial.authors)}</p>`
                : ''}
            </div>
            <div class="shrink-0 flex flex-col items-end gap-1">
              ${validatedBadge}
            </div>
          </div>

          <!-- Taxonomy + year -->
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2">
            <span class="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
              ${escHtml(trial.specialty || trial.domain || '—')}
              ${trial.subspecialty ? `· ${escHtml(trial.subspecialty)}` : ''}
            </span>
            ${trial.landmark_year
              ? `<span class="text-[10px] text-slate-400">${trial.landmark_year}</span>`
              : ''}
          </div>

          <!-- Tags -->
          ${trial.tags?.length
            ? `<div class="flex flex-wrap gap-1 mt-1.5">${tagBadges(trial.tags)}</div>`
            : ''}

          <!-- Bottom row: RoB, GRADE, links, meta -->
          <div class="flex flex-wrap items-center justify-between gap-2 mt-3">
            <div class="flex flex-wrap items-center gap-1.5">
              ${robRaw
                ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${robCls}">
                     RoB: ${escHtml(robRaw)}
                   </span>`
                : ''}
              ${gradeRaw
                ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${gradeCls}">
                     GRADE: ${escHtml(gradeRaw)}
                   </span>`
                : ''}
              ${pubmedLink}
              ${pmcLink}
            </div>
            <div class="flex items-center gap-3">
              ${validationMeta}
            </div>
          </div>

        </div>
      </div>

      <!-- Action buttons — visible on hover -->
      <div class="flex gap-2 px-4 pb-4 pt-0 border-t border-slate-100
                  opacity-0 group-hover:opacity-100 transition-opacity">
        <button class="trial-card-load flex-1 bg-slate-900 text-white text-xs
                        px-3 py-1.5 rounded font-semibold hover:bg-slate-700 transition"
                data-id="${escHtml(trial.id)}"
                onclick="event.stopPropagation()">
          Load Analysis
        </button>
        ${!validated
          ? `<button class="trial-card-validate bg-green-600 text-white text-xs
                            px-3 py-1.5 rounded font-semibold hover:bg-green-700 transition"
                    data-id="${escHtml(trial.id)}"
                    onclick="event.stopPropagation()">
               Validate
             </button>`
          : `<button class="trial-card-unvalidate bg-slate-100 text-slate-600 text-xs
                            px-3 py-1.5 rounded font-medium hover:bg-slate-200 transition"
                    data-id="${escHtml(trial.id)}"
                    onclick="event.stopPropagation()">
               Un-validate
             </button>`
        }
        <button class="trial-card-delete text-red-400 text-xs
                        px-3 py-1.5 rounded font-medium hover:bg-red-50 hover:text-red-600 transition"
                data-id="${escHtml(trial.id)}"
                onclick="event.stopPropagation()">
          Delete
        </button>
      </div>

    </div>
  `;
}

/**
 * Renders a list of trial cards into a container element.
 * Wires click handlers for load, validate, unvalidate, delete, and checkbox.
 *
 * @param {HTMLElement} containerEl
 * @param {Array}       trials
 * @param {object}      handlers — { onLoad, onValidate, onUnvalidate, onDelete, onSelect }
 * @param {object}      options  — { selectable, selectedIds }
 */
export function renderTrialCards(containerEl, trials, handlers = {}, options = {}) {
  const { selectable = false, selectedIds = new Set() } = options;

  if (!trials || trials.length === 0) {
    containerEl.innerHTML = `
      <div class="text-center py-16 text-slate-400">
        <p class="text-4xl mb-3">📚</p>
        <p class="font-medium text-slate-500">No trials found</p>
        <p class="text-sm mt-1">Try adjusting your filters or save an analysis to the library</p>
      </div>
    `;
    return;
  }

  containerEl.innerHTML = trials
    .map(t => trialCardHtml(t, { selectable, selected: selectedIds.has(t.id) }))
    .join('');

  // Wire click handlers
  containerEl.querySelectorAll('.trial-card').forEach(card => {
    const id = card.dataset.id;

    // Card click → load
    card.addEventListener('click', () => handlers.onLoad?.(id));

    // Load button
    card.querySelector('.trial-card-load')
      ?.addEventListener('click', (e) => { e.stopPropagation(); handlers.onLoad?.(id); });

    // Validate button
    card.querySelector('.trial-card-validate')
      ?.addEventListener('click', (e) => { e.stopPropagation(); handlers.onValidate?.(id); });

    // Un-validate button
    card.querySelector('.trial-card-unvalidate')
      ?.addEventListener('click', (e) => { e.stopPropagation(); handlers.onUnvalidate?.(id); });

    // Delete button
    card.querySelector('.trial-card-delete')
      ?.addEventListener('click', (e) => { e.stopPropagation(); handlers.onDelete?.(id); });

    // Checkbox
    card.querySelector('.trial-card-checkbox')
      ?.addEventListener('change', (e) => {
        handlers.onSelect?.(id, e.target.checked);
      });
  });
}