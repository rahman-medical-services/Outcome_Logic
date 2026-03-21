// app.js
// Application router and global state.
// Handles tab switching, auth gating, and wires together all modules.

import { initAuth, onAuthChange, renderLoginModal, renderUserBadge } from './modules/auth.js';
import { openSaveModal }   from './components/saveModal.js';
import { initLibrary, refreshLibrary } from './modules/library.js';
import { toast }           from './components/toasts.js';
import { APP_VERSION }     from './config/constants.js';

// ─────────────────────────────────────────────
// GLOBAL STATE
// ─────────────────────────────────────────────
const state = {
  currentTab:      'analyse',   // 'analyse' | 'library'
  lastAnalysis:    null,        // last successful analysis JSON
  libraryEl:       null,        // library tab container
  analyseEl:       null,        // analyse tab container
};

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────
export async function boot() {
  // Update version badge
  const versionEl = document.getElementById('app-version');
  if (versionEl) versionEl.textContent = `v${APP_VERSION}`;

  // Init auth — restores session from localStorage
  const user = await initAuth();

  // React to auth state changes
  onAuthChange((event, user) => {
    const modalEl = document.getElementById('auth-modal-root');
    if (!user) {
      // Not logged in — show login modal
      if (modalEl) renderLoginModal(modalEl);
      _hideApp();
    } else {
      // Logged in — remove modal, show app
      if (modalEl) modalEl.innerHTML = '';
      _showApp(user);
    }
  });
}

// ─────────────────────────────────────────────
// SHOW / HIDE APP
// ─────────────────────────────────────────────
function _hideApp() {
  document.getElementById('app-shell')?.classList.add('hidden');
}

function _showApp(user) {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  shell.classList.remove('hidden');

  // Render user badge in header
  const badgeEl = document.getElementById('user-badge');
  if (badgeEl) renderUserBadge(badgeEl);

  // Store display name globally for validate prompts
  window._currentUserDisplayName = user.user_metadata?.full_name || user.email?.split('@')[0] || '';

  // Wire tabs
  _wireTabs();

  // Show the current tab
  _showTab(state.currentTab);
}

// ─────────────────────────────────────────────
// TAB ROUTING
// ─────────────────────────────────────────────
function _wireTabs() {
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => _showTab(btn.dataset.tab));
  });
}

function _showTab(tabName) {
  state.currentTab = tabName;

  // Update tab button styles
  document.querySelectorAll('[data-tab]').forEach(btn => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('border-b-2',         active);
    btn.classList.toggle('border-slate-900',   active);
    btn.classList.toggle('text-slate-900',     active);
    btn.classList.toggle('font-semibold',      active);
    btn.classList.toggle('text-slate-400',     !active);
  });

  // Show/hide tab panels
  document.querySelectorAll('[data-tab-panel]').forEach(panel => {
    panel.classList.toggle('hidden', panel.dataset.tabPanel !== tabName);
  });

  // Lazy-init library tab on first open
  if (tabName === 'library') {
    const libEl = document.getElementById('tab-panel-library');
    if (libEl && !state.libraryEl) {
      state.libraryEl = libEl;
      initLibrary(libEl, {
        onLoadTrial: (analysis) => {
          // Switch to analyse tab and populate dashboard
          _showTab('analyse');
          window.populateDashboard?.(analysis);
          toast.success('Trial loaded from library.');
        },
      });
    }
  }
}

// ─────────────────────────────────────────────
// SAVE TO LIBRARY
// Called from the analyse tab after a successful analysis
// ─────────────────────────────────────────────
export function promptSaveToLibrary(analysis) {
  state.lastAnalysis = analysis;
  openSaveModal(
    analysis,
    (savedRecord) => {
      toast.success(`"${savedRecord.display_title}" saved to library.`);
      // Refresh library if it's been initialised
      if (state.libraryEl) refreshLibrary(state.libraryEl);
    },
    () => {}  // dismissed — no action
  );
}

// Expose globally so the analyse tab inline onclick can call it
window.promptSaveToLibrary = promptSaveToLibrary;