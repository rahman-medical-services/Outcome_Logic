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
  // If recovery hash detected — show set-password form immediately
  // Do not wait for any Supabase event — just render the form now.
  if (isRecovery) {
    console.log('[App] Recovery detected — showing set-password form immediately');
    _hideApp();
    if (modalEl) {
      renderSetPasswordForm(modalEl, () => {
        console.log('[App] Password set — clearing modal');
        if (modalEl) modalEl.innerHTML = '';
      });
    }
    // Still set up listener so SIGNED_IN after password update shows the app
    _setupAuthListener(modalEl, true);
    return;
  }

  // Normal flow
  _setupAuthListener(modalEl, false);
}

// ─────────────────────────────────────────────
// AUTH LISTENER
// Reacts to every login/logout event for the lifetime of the app.
// ─────────────────────────────────────────────
function _setupAuthListener(modalEl, isRecovery = false) {
  // Track whether we are mid-recovery — block SIGNED_IN until password is set
  let _awaitingPasswordSet = isRecovery;

  console.log('[App] setupAuthListener — isRecovery:', isRecovery);

  onAuthChange((event, user) => {
    console.log('[App] onAuthChange event:', event, '| awaitingPasswordSet:', _awaitingPasswordSet, '| user:', user?.email ?? 'none');

    // PASSWORD_RECOVERY: user clicked a reset link.
    // Show the set-new-password form — block app from showing.
    if (event === 'PASSWORD_RECOVERY') {
      _awaitingPasswordSet = true;
      _hideApp();
      console.log('[App] Showing set-password form');
      if (modalEl) {
        renderSetPasswordForm(modalEl, () => {
          console.log('[App] Password set — clearing modal');
          _awaitingPasswordSet = false;
          if (modalEl) modalEl.innerHTML = '';
        });
        console.log('[App] Modal innerHTML after render:', modalEl.innerHTML.slice(0, 100));
      } else {
        console.error('[App] modalEl is null — cannot render set-password form');
      }
      return;
    }

    // While mid-recovery, suppress all SIGNED_IN events
    if (_awaitingPasswordSet && event === 'SIGNED_IN') {
      console.log('[App] Suppressing SIGNED_IN while awaiting password set');
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