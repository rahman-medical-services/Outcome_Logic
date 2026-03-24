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
  // Always set up the auth listener first, passing isRecovery flag
  // so it can block SIGNED_IN events while mid-recovery
  _setupAuthListener(modalEl, isRecovery);

  // If recovery hash detected, hide the app immediately and show the
  // set-password form — the listener will handle everything from here
  if (isRecovery) {
    _hideApp();
  }
}

// ─────────────────────────────────────────────
// AUTH LISTENER
// Reacts to every login/logout event for the lifetime of the app.
// ─────────────────────────────────────────────
function _setupAuthListener(modalEl, isRecovery = false) {
  // Track whether we are mid-recovery — block SIGNED_IN until password is set
  let _awaitingPasswordSet = isRecovery;

  onAuthChange((event, user) => {

    // PASSWORD_RECOVERY: user clicked a reset link.
    // Show the set-new-password form — block app from showing.
    if (event === 'PASSWORD_RECOVERY') {
      _awaitingPasswordSet = true;
      _hideApp();
      if (modalEl) renderSetPasswordForm(modalEl, () => {
        _awaitingPasswordSet = false;
        if (modalEl) modalEl.innerHTML = '';
        // _showApp will be called when SIGNED_IN fires after password update
      });
      return;
    }

    // While mid-recovery, suppress all SIGNED_IN events — the existing
    // session fires SIGNED_IN immediately but we don't want to show the
    // app until the password has actually been set.
    if (_awaitingPasswordSet && event === 'SIGNED_IN') {
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