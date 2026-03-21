// components/toasts.js
// Lightweight toast notification system.
// Usage:
//   toast.success('Trial saved successfully.')
//   toast.error('Save failed — please try again.')
//   toast.info('3 trials awaiting validation.')
//   toast.warning('Source may not match query.')

const DURATION = 4000;   // ms before auto-dismiss
const MAX      = 4;      // max toasts visible at once

let _container = null;

function getContainer() {
  if (_container) return _container;
  _container = document.createElement('div');
  _container.id        = 'toast-container';
  _container.className = 'fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none';
  document.body.appendChild(_container);
  return _container;
}

function show(message, type = 'info') {
  const container = getContainer();

  // Enforce max — remove oldest if needed
  const existing = container.querySelectorAll('.toast-item');
  if (existing.length >= MAX) existing[0].remove();

  const configs = {
    success: { bg: 'bg-green-600',  icon: '✓' },
    error:   { bg: 'bg-red-600',    icon: '✕' },
    warning: { bg: 'bg-amber-500',  icon: '⚠' },
    info:    { bg: 'bg-slate-800',  icon: 'ℹ' },
  };
  const { bg, icon } = configs[type] || configs.info;

  const toastEl = document.createElement('div');
  toastEl.className = `toast-item pointer-events-auto flex items-start gap-3 px-4 py-3
                     ${bg} text-white text-sm rounded-lg shadow-lg
                     translate-y-2 opacity-0 transition-all duration-300`;

  toastEl.innerHTML = `
    <span class="shrink-0 font-bold mt-0.5">${icon}</span>
    <span class="flex-1 leading-snug">${escHtml(message)}</span>
    <button class="toast-close shrink-0 opacity-70 hover:opacity-100 transition ml-1 mt-0.5">✕</button>
  `;

  container.appendChild(toastEl);

  // Animate in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toastEl.classList.remove('translate-y-2', 'opacity-0');
    });
  });

  // Auto-dismiss
  const timer = setTimeout(() => dismiss(toastEl), DURATION);

  // Manual dismiss
  toastEl.querySelector('.toast-close').onclick = () => {
    clearTimeout(timer);
    dismiss(toastEl);
  };
}

function dismiss(el) {
  el.classList.add('translate-y-2', 'opacity-0');
  setTimeout(() => el.remove(), 300);
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const toast = {
  success: (msg) => show(msg, 'success'),
  error:   (msg) => show(msg, 'error'),
  warning: (msg) => show(msg, 'warning'),
  info:    (msg) => show(msg, 'info'),
};
