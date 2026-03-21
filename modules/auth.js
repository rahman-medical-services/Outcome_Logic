// modules/auth.js
// Supabase authentication layer.
// Handles login, logout, session persistence, and current user access.
// All other modules call getUser() / requireAuth() rather than touching Supabase directly.

import { SUPABASE_URL, SUPABASE_ANON_KEY, APP_NAME } from '../config/constants.js';

// ─────────────────────────────────────────────
// SUPABASE CLIENT
// Loaded from CDN in index.html — no npm required for the browser build.
// The client is a singleton — initialised once, reused everywhere.
// ─────────────────────────────────────────────
let _supabase = null;

function getClient() {
  if (_supabase) return _supabase;
  if (!window.supabase) {
    throw new Error('Supabase JS client not loaded. Ensure the CDN script is in index.html.');
  }
  _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _supabase;
}

// ─────────────────────────────────────────────
// SESSION STATE
// Kept in memory — restored from Supabase's own localStorage persistence on init.
// ─────────────────────────────────────────────
let _session  = null;
let _user     = null;
let _listeners = [];   // callbacks registered by other modules

// ─────────────────────────────────────────────
// INITIALISE
// Call once on app load. Restores any existing session and wires up
// the auth state change listener so all modules react to login/logout.
// ─────────────────────────────────────────────
export async function initAuth() {
  const client = getClient();

  // Restore existing session from localStorage
  const { data: { session } } = await client.auth.getSession();
  _session = session;
  _user    = session?.user ?? null;

  // Listen for future auth state changes (login, logout, token refresh)
  client.auth.onAuthStateChange((event, session) => {
    _session = session;
    _user    = session?.user ?? null;
    console.log(`[Auth] ${event}`, _user?.email ?? 'signed out');
    _listeners.forEach(fn => fn(event, _user));
  });

  return _user;
}

// ─────────────────────────────────────────────
// LOGIN
// Email + password. Returns { user, error }.
// ─────────────────────────────────────────────
export async function login(email, password) {
  const client = getClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) return { user: null, error: error.message };
  return { user: data.user, error: null };
}

// ─────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────
export async function logout() {
  const client = getClient();
  const { error } = await client.auth.signOut();
  if (error) console.error('[Auth] Logout error:', error.message);
  _session = null;
  _user    = null;
}

// ─────────────────────────────────────────────
// GETTERS
// ─────────────────────────────────────────────

/** Returns the current user object or null if not logged in */
export function getUser() {
  return _user;
}

/** Returns the current session (contains access_token for API calls) */
export function getSession() {
  return _session;
}

/** Returns the access token for authenticated API calls */
export function getAccessToken() {
  return _session?.access_token ?? null;
}

/** Returns true if a user is currently logged in */
export function isAuthenticated() {
  return !!_user;
}

/**
 * Throws if not authenticated.
 * Call at the top of any function that requires a logged-in user.
 */
export function requireAuth() {
  if (!_user) throw new Error('You must be logged in to perform this action.');
  return _user;
}

/**
 * Returns a display name for the current user.
 * Falls back gracefully if full name not set.
 */
export function getDisplayName() {
  if (!_user) return null;
  return (
    _user.user_metadata?.full_name ||
    _user.user_metadata?.name      ||
    _user.email?.split('@')[0]     ||
    'User'
  );
}

// ─────────────────────────────────────────────
// EVENT SUBSCRIPTION
// Other modules register callbacks here to react to auth state changes
// without coupling directly to Supabase.
//
// Usage:
//   onAuthChange((event, user) => {
//     if (user) showApp(); else showLogin();
//   });
// ─────────────────────────────────────────────
export function onAuthChange(callback) {
  _listeners.push(callback);
  // Fire immediately with current state so caller doesn't miss it
  callback(_user ? 'SIGNED_IN' : 'SIGNED_OUT', _user);
  // Return unsubscribe function
  return () => {
    _listeners = _listeners.filter(fn => fn !== callback);
  };
}

// ─────────────────────────────────────────────
// LOGIN UI
// Renders a minimal login modal into a target element.
// Called by app.js when auth is required and no session exists.
// ─────────────────────────────────────────────
export function renderLoginModal(targetEl) {
  targetEl.innerHTML = `
    <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-sm p-8">

        <div class="text-center mb-6">
          <h2 class="text-2xl font-bold text-slate-900">${APP_NAME}</h2>
          <p class="text-sm text-slate-500 mt-1">Sign in to continue</p>
        </div>

        <div id="auth-error"
          class="hidden mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
        </div>

        <div class="space-y-4">
          <div>
            <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">
              Email
            </label>
            <input type="email" id="auth-email"
              placeholder="saqib@rahmanmedical.co.uk"
              class="w-full border border-slate-300 rounded px-4 py-2 text-sm
                     focus:ring-2 focus:ring-slate-900 outline-none"
              autocomplete="email" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">
              Password
            </label>
            <input type="password" id="auth-password"
              placeholder="••••••••"
              class="w-full border border-slate-300 rounded px-4 py-2 text-sm
                     focus:ring-2 focus:ring-slate-900 outline-none"
              autocomplete="current-password" />
          </div>
          <button id="auth-submit"
            onclick="window._authSubmit()"
            class="w-full bg-slate-900 text-white py-2.5 rounded font-semibold text-sm
                   hover:bg-slate-700 transition">
            Sign In
          </button>
        </div>

        <p class="text-center text-xs text-slate-400 mt-6">
          ${APP_NAME} · rahmanmedical.co.uk
        </p>
      </div>
    </div>
  `;

  // Wire up submit — enter key or button click
  const emailEl    = document.getElementById('auth-email');
  const passwordEl = document.getElementById('auth-password');
  const errorEl    = document.getElementById('auth-error');
  const submitBtn  = document.getElementById('auth-submit');

  async function submit() {
    const email    = emailEl.value.trim();
    const password = passwordEl.value;
    if (!email || !password) {
      errorEl.textContent = 'Please enter your email and password.';
      errorEl.classList.remove('hidden');
      return;
    }

    submitBtn.textContent = 'Signing in…';
    submitBtn.disabled    = true;
    errorEl.classList.add('hidden');

    const { error } = await login(email, password);
    if (error) {
      errorEl.textContent = error;
      errorEl.classList.remove('hidden');
      submitBtn.textContent = 'Sign In';
      submitBtn.disabled    = false;
    }
    // On success, onAuthStateChange fires → app.js removes the modal
  }

  // Expose to inline onclick (avoids module scope issues in plain HTML)
  window._authSubmit = submit;

  // Enter key on either field
  [emailEl, passwordEl].forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  });

  // Focus email field
  setTimeout(() => emailEl?.focus(), 50);
}

// ─────────────────────────────────────────────
// LOGOUT BUTTON HELPER
// Call this to render a small logout button in the app header.
// ─────────────────────────────────────────────
export function renderUserBadge(targetEl) {
  const name = getDisplayName();
  if (!name || !targetEl) return;
  targetEl.innerHTML = `
    <div class="flex items-center gap-3">
      <span class="text-xs text-slate-500">
        Signed in as <strong class="text-slate-700">${name}</strong>
      </span>
      <button onclick="window._authLogout()"
        class="text-xs text-slate-400 hover:text-red-600 transition underline">
        Sign out
      </button>
    </div>
  `;
  window._authLogout = async () => {
    await logout();
    // onAuthStateChange will fire and app.js will re-render the login modal
  };
}