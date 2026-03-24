// app.js
// Application router and global state.
// Handles tab switching, auth gating, recovery hash detection,
// and wires together all modules.

import {
  initAuth, onAuthChange,
  renderLoginModal, renderSetPasswordForm,
  renderUserBadge,
} from './modules/auth.js';
import { openSaveModal }               from './components/saveModal.js';
import { initLibrary, refreshLibrary } from './modules/library.js';
import { toast }                       from './components/toasts.js';
import { APP_VERSION }                 from './config/constants.js';

// ─────────────────────────────────────────────
// GLOBAL STATE
// ─────────────────────────────────────────────
const state = {
  currentTab:   'analyse',
  lastAnalysis: null,
  libraryEl:    null,
};

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────
export async function boot() {
  // Version badge
  const versionEl = document.getElementById('app-version');
  if (versionEl) versionEl.textContent = `v${APP_VERSION}`;

  // Init auth — restores session and detects recovery hash
  const { user, isRecovery } = await initAuth();

  const modalEl = document.getElementById('auth-modal-root');

  // ── Recovery flow: URL contains a password reset token ──────────────────
  // Show the set-new-password form regardless of session state.
  // Once the password is set, Supabase automatically signs the user in
  // and onAuthStateChange fires → _showApp() is called.
  if (isRecovery) {
    if (modalEl) {
      renderSetPasswordForm(modalEl, () => {
        // Password set — onAuthStateChange will handle showing the app
        // but clear the modal just in case it fires before the callback
        if (modalEl) modalEl.innerHTML = '';
      });
    }
    // Don't proceed with normal auth flow — wait for the password to be set
    _setupAuthListener(modalEl);
    return;
  }

  // ── Normal flow ──────────────────────────────────────────────────────────
  _setupAuthListener(modalEl);
}

// ─────────────────────────────────────────────
// AUTH LISTENER
// Reacts to every login/logout event for the lifetime of the app.
// ─────────────────────────────────────────────
function _setupAuthListener(modalEl) {
  onAuthChange((event, user) => {

    // PASSWORD_RECOVERY: user clicked a reset link.
    // Show the set-new-password form — do NOT show the app yet.
    if (event === 'PASSWORD_RECOVERY') {
      if (modalEl) renderSetPasswordForm(modalEl, () => {
        // Password set successfully — clear the modal.
        // Supabase will fire SIGNED_IN next which will call _showApp().
        if (modalEl) modalEl.innerHTML = '';
      });
      _hideApp();
      return;
    }

    if (!user) {
      if (modalEl) renderLoginModal(modalEl);
      _hideApp();
    } else {
      // Normal sign-in — clear modal and show app
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

  // Render user badge
  const badgeEl = document.getElementById('user-badge');
  if (badgeEl) renderUserBadge(badgeEl);

  // Store display name globally for validate prompts
  window._currentUserDisplayName =
    user.user_metadata?.full_name ||
    user.email?.split('@')[0]     || '';

  _wireTabs();
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

  document.querySelectorAll('[data-tab]').forEach(btn => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('border-b-2',       active);
    btn.classList.toggle('border-slate-900', active);
    btn.classList.toggle('text-slate-900',   active);
    btn.classList.toggle('font-semibold',    active);
    btn.classList.toggle('text-slate-400',   !active);
  });

  document.querySelectorAll('[data-tab-panel]').forEach(panel => {
    panel.classList.toggle('hidden', panel.dataset.tabPanel !== tabName);
  });

  // Lazy-init library on first open
  if (tabName === 'library') {
    const libEl = document.getElementById('tab-panel-library');
    if (libEl && !state.libraryEl) {
      state.libraryEl = libEl;
      initLibrary(libEl, {
        onLoadTrial: (analysis) => {
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
      if (state.libraryEl) refreshLibrary(state.libraryEl);
    },
    () => {}
  );
}

// Expose globally so inline onclick in index.html can reach it
window.promptSaveToLibrary = promptSaveToLibrary;