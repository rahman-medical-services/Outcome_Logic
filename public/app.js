// app.js
// Application router and global state.
// Handles tab switching, auth gating, recovery hash detection,
// and wires together all modules.

import {
  initAuth, onAuthChange,
  renderLoginModal, renderSetPasswordForm,
  renderUserBadge, getUserTier,
} from './modules/auth.js';
import { openSaveModal }               from './components/saveModal.js';
import { initLibrary, refreshLibrary } from './modules/library.js';
import { toast }                       from './components/toasts.js';
import { APP_VERSION }                 from './config/constants.js';
import { can, upgradeMessage }         from './config/tiers.js';

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
    _hideApp();
    if (modalEl) {
      renderSetPasswordForm(modalEl, () => {
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


  onAuthChange((event, user) => {

    // PASSWORD_RECOVERY: user clicked a reset link.
    // Show the set-new-password form — block app from showing.
    if (event === 'PASSWORD_RECOVERY') {
      _awaitingPasswordSet = true;
      _hideApp();
      if (modalEl) {
        renderSetPasswordForm(modalEl, () => {
          _awaitingPasswordSet = false;
          if (modalEl) modalEl.innerHTML = '';
        });
      } else {
      }
      return;
    }

    // While mid-recovery, suppress all SIGNED_IN events
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

  // Store display name and tier globally
  window._currentUserDisplayName =
    user.user_metadata?.full_name ||
    user.email?.split('@')[0]     || '';

  const tier = getUserTier();
  window._currentUserTier = tier;

  _wireTabs();
  _applyTierUI(tier);
  _showTab(state.currentTab);
}

// ─────────────────────────────────────────────
// TIER-AWARE UI
// Show/hide elements based on user permissions
// ─────────────────────────────────────────────
function _applyTierUI(tier) {
  // Save to Library button
  const saveBtn = document.getElementById('btn-save-library');
  if (saveBtn) {
    if (can(tier, 'canAddToLib')) {
      saveBtn.classList.remove('hidden');
    } else {
      saveBtn.classList.add('hidden');
    }
  }

  // Analyse tab — search and PDF upload
  const analyseControls = document.getElementById('ui-controls');
  if (analyseControls) {
    if (!can(tier, 'canAnalyse')) {
      // Replace controls with upgrade message
      const searchArea = analyseControls.querySelector('.bg-white');
      if (searchArea) {
        searchArea.innerHTML = `
          <div class="text-center py-8">
            <p class="text-slate-500 text-sm">${upgradeMessage('canAnalyse')}</p>
          </div>
        `;
      }
    }
  }

  // Library tab button — always visible (free gets landmark papers)
  // But show a badge indicating limited access for free tier
  const libTab = document.querySelector('[data-tab="library"]');
  if (libTab && tier === 'free') {
    libTab.textContent = 'Library (Preview)';
  }
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
  const tier = getUserTier();
  if (!can(tier, 'canAddToLib')) {
    toast.warning(upgradeMessage('canAddToLib'));
    return;
  }
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