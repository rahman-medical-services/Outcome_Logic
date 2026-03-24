// modules/auth.js
// Supabase authentication layer.
// Handles: login, logout, password reset, magic link, session persistence,
// recovery hash detection, tier access, and all auth UI rendering.

import { APP_NAME } from '../config/constants.js';

// ─────────────────────────────────────────────
// SUPABASE CLIENT — singleton
// ─────────────────────────────────────────────
function _env(key, fb = '') { return window.ENV?.[key] || fb; }

let _supabase = null;
function getClient() {
  if (_supabase) return _supabase;
  if (!window.supabase) throw new Error('Supabase JS client not loaded.');
  _supabase = window.supabase.createClient(_env('SUPABASE_URL'), _env('SUPABASE_ANON_KEY'));
  return _supabase;
}

// ─────────────────────────────────────────────
// SESSION STATE
// ─────────────────────────────────────────────
let _session   = null;
let _user      = null;
let _listeners = [];

// ─────────────────────────────────────────────
// INIT
// Call once on app load. Returns { user, isRecovery }.
// isRecovery = true means the URL contains a password reset token —
// app.js should show the set-new-password form instead of the login modal.
// ─────────────────────────────────────────────
export async function initAuth() {
  const client = getClient();

  // ── IMPORTANT: set up the auth listener BEFORE calling getSession() ──
  // Supabase v2 exchanges the recovery token and fires PASSWORD_RECOVERY
  // synchronously during initialisation — if we call getSession() first,
  // we miss the event entirely and the hash is already cleared.
  //
  // By registering onAuthStateChange first, we catch PASSWORD_RECOVERY
  // before getSession() processes the existing session and fires SIGNED_IN.

  let _isRecovery = false;

  const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
    _session = session;
    _user    = session?.user ?? null;
    console.log(`[Auth] ${event}`, _user?.email ?? 'signed out');

    if (event === 'PASSWORD_RECOVERY') {
      _isRecovery = true;
      _listeners.forEach(fn => fn('PASSWORD_RECOVERY', _user));
      return;
    }

    _listeners.forEach(fn => fn(event, _user));
  });

  // Now restore the existing session — this fires INITIAL_SESSION
  const { data: { session } } = await client.auth.getSession();

  // Only set user from session if we are NOT in recovery mode
  // (PASSWORD_RECOVERY will have already set _user above if recovery)
  if (!_isRecovery) {
    _session = session;
    _user    = session?.user ?? null;
  }

  return { user: _isRecovery ? null : _user, isRecovery: _isRecovery };
}

// ─────────────────────────────────────────────
// RECOVERY HASH DETECTION
// Supabase puts the token in the URL hash after a reset/magic-link click.
// We detect it here and return a flag — never expose the raw token.
// ─────────────────────────────────────────────
function _detectRecoveryHash() {
  const hash   = window.location.hash;
  if (!hash)   return false;
  const params = new URLSearchParams(hash.replace('#', ''));
  const type   = params.get('type');
  return type === 'recovery' || type === 'magiclink';
}

// ─────────────────────────────────────────────
// AUTH ACTIONS
// ─────────────────────────────────────────────

/** Email + password sign in */
export async function login(email, password) {
  const { data, error } = await getClient().auth.signInWithPassword({ email, password });
  if (error) return { user: null, error: error.message };
  return { user: data.user, error: null };
}

/** Send password reset email */
export async function requestPasswordReset(email) {
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error }  = await getClient().auth.resetPasswordForEmail(email, { redirectTo });
  if (error) return { error: error.message };
  return { error: null };
}

/** Send magic link sign-in email */
export async function requestMagicLink(email) {
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error }  = await getClient().auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo, shouldCreateUser: false }
  });
  if (error) return { error: error.message };
  return { error: null };
}

/** Set a new password — called after user clicks the reset link */
export async function updatePassword(newPassword) {
  const { data, error } = await getClient().auth.updateUser({ password: newPassword });
  if (error) return { user: null, error: error.message };
  // Clear the hash from the URL once password is set
  window.history.replaceState(null, '', window.location.pathname);
  return { user: data.user, error: null };
}

/** Sign out */
export async function logout() {
  const { error } = await getClient().auth.signOut();
  if (error) console.error('[Auth] Logout error:', error.message);
  _session = null;
  _user    = null;
}

// ─────────────────────────────────────────────
// GETTERS
// ─────────────────────────────────────────────
export function getUser()         { return _user; }
export function getSession()      { return _session; }
export function getAccessToken()  { return _session?.access_token ?? null; }
export function isAuthenticated() { return !!_user; }

export function requireAuth() {
  if (!_user) throw new Error('You must be logged in to perform this action.');
  return _user;
}

export function getDisplayName() {
  if (!_user) return null;
  return (
    _user.user_metadata?.full_name ||
    _user.user_metadata?.name      ||
    _user.email?.split('@')[0]     ||
    'User'
  );
}

/** Returns the user's tier — defaults to 'free' if not set */
export function getUserTier() {
  return _user?.user_metadata?.tier || 'free';
}

// ─────────────────────────────────────────────
// EVENT SUBSCRIPTION
// ─────────────────────────────────────────────
export function onAuthChange(callback) {
  _listeners.push(callback);
  callback(_user ? 'SIGNED_IN' : 'SIGNED_OUT', _user);
  return () => { _listeners = _listeners.filter(fn => fn !== callback); };
}

// ─────────────────────────────────────────────
// AUTH MODAL
// Three modes rendered inside the same overlay:
//   'signin'   — email + password (default)
//   'reset'    — forgot password: email input → sends reset link
//   'magic'    — magic link: email input → sends sign-in link
// ─────────────────────────────────────────────
export function renderLoginModal(targetEl, initialMode = 'signin') {
  let mode = initialMode;

  function render() {
    targetEl.innerHTML = `
      <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
        <div class="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-sm p-8">

          <!-- Logo -->
          <div class="text-center mb-6">
            <h2 class="text-2xl font-bold text-slate-900">${APP_NAME}</h2>
            <p class="text-sm text-slate-500 mt-1">${_modeSubtitle(mode)}</p>
          </div>

          <!-- Error / success -->
          <div id="auth-error"   class="hidden mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700"></div>
          <div id="auth-success" class="hidden mb-4 p-3 bg-green-50 border border-green-200 rounded text-sm text-green-700"></div>

          <!-- ── SIGN IN MODE ── -->
          ${mode === 'signin' ? `
            <div class="space-y-4">
              <div>
                <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Email</label>
                <input type="email" id="auth-email" placeholder="saqib@rahmanmedical.co.uk"
                  class="w-full border border-slate-300 rounded px-4 py-2 text-sm focus:ring-2 focus:ring-slate-900 outline-none"
                  autocomplete="email" />
              </div>
              <div>
                <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Password</label>
                <input type="password" id="auth-password" placeholder="••••••••"
                  class="w-full border border-slate-300 rounded px-4 py-2 text-sm focus:ring-2 focus:ring-slate-900 outline-none"
                  autocomplete="current-password" />
              </div>
              <button id="auth-submit"
                class="w-full bg-slate-900 text-white py-2.5 rounded font-semibold text-sm hover:bg-slate-700 transition">
                Sign In
              </button>
            </div>
            <div class="mt-5 space-y-2 text-center">
              <button id="auth-to-reset"
                class="text-xs text-slate-400 hover:text-slate-700 transition underline block w-full">
                Forgot password?
              </button>
              <button id="auth-to-magic"
                class="text-xs text-slate-400 hover:text-slate-700 transition underline block w-full">
                Sign in with a magic link instead
              </button>
            </div>
          ` : ''}

          <!-- ── RESET PASSWORD MODE ── -->
          ${mode === 'reset' ? `
            <div class="space-y-4">
              <p class="text-xs text-slate-500 leading-relaxed">
                Enter your email and we'll send you a link to set a new password.
              </p>
              <div>
                <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Email</label>
                <input type="email" id="auth-email" placeholder="saqib@rahmanmedical.co.uk"
                  class="w-full border border-slate-300 rounded px-4 py-2 text-sm focus:ring-2 focus:ring-slate-900 outline-none"
                  autocomplete="email" />
              </div>
              <button id="auth-submit"
                class="w-full bg-slate-900 text-white py-2.5 rounded font-semibold text-sm hover:bg-slate-700 transition">
                Send Reset Link
              </button>
            </div>
            <div class="mt-5 text-center">
              <button id="auth-to-signin"
                class="text-xs text-slate-400 hover:text-slate-700 transition underline">
                ← Back to sign in
              </button>
            </div>
          ` : ''}

          <!-- ── MAGIC LINK MODE ── -->
          ${mode === 'magic' ? `
            <div class="space-y-4">
              <p class="text-xs text-slate-500 leading-relaxed">
                Enter your email and we'll send you a one-click sign-in link. No password needed.
              </p>
              <div>
                <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Email</label>
                <input type="email" id="auth-email" placeholder="saqib@rahmanmedical.co.uk"
                  class="w-full border border-slate-300 rounded px-4 py-2 text-sm focus:ring-2 focus:ring-slate-900 outline-none"
                  autocomplete="email" />
              </div>
              <button id="auth-submit"
                class="w-full bg-slate-900 text-white py-2.5 rounded font-semibold text-sm hover:bg-slate-700 transition">
                Send Magic Link
              </button>
            </div>
            <div class="mt-5 text-center">
              <button id="auth-to-signin"
                class="text-xs text-slate-400 hover:text-slate-700 transition underline">
                ← Back to sign in
              </button>
            </div>
          ` : ''}

          <p class="text-center text-xs text-slate-300 mt-6">${APP_NAME} · rahmanmedical.co.uk</p>
        </div>
      </div>
    `;

    _wireLoginModal(targetEl, mode, () => { mode = 'signin'; render(); }, (m) => { mode = m; render(); });
  }

  render();
}

function _modeSubtitle(mode) {
  if (mode === 'reset') return 'Reset your password';
  if (mode === 'magic') return 'Sign in with a magic link';
  return 'Sign in to continue';
}

function _wireLoginModal(targetEl, mode, onBackToSignin, onSwitchMode) {
  const emailEl   = targetEl.querySelector('#auth-email');
  const submitBtn = targetEl.querySelector('#auth-submit');
  const errorEl   = targetEl.querySelector('#auth-error');
  const successEl = targetEl.querySelector('#auth-success');

  function showError(msg)   { errorEl.textContent = msg;   errorEl.classList.remove('hidden');   successEl.classList.add('hidden'); }
  function showSuccess(msg) { successEl.textContent = msg; successEl.classList.remove('hidden'); errorEl.classList.add('hidden'); }
  function setLoading(loading, label) {
    submitBtn.disabled    = loading;
    submitBtn.textContent = loading ? 'Please wait…' : label;
  }

  // Sign in
  if (mode === 'signin') {
    const passwordEl = targetEl.querySelector('#auth-password');

    async function doSignin() {
      const email    = emailEl.value.trim();
      const password = passwordEl.value;
      if (!email || !password) { showError('Please enter your email and password.'); return; }
      setLoading(true, 'Sign In');
      const { error } = await login(email, password);
      if (error) { showError(error); setLoading(false, 'Sign In'); }
      // On success onAuthStateChange fires → app.js clears the modal
    }

    submitBtn.onclick = doSignin;
    [emailEl, passwordEl].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') doSignin(); }));
    targetEl.querySelector('#auth-to-reset').onclick = () => onSwitchMode('reset');
    targetEl.querySelector('#auth-to-magic').onclick = () => onSwitchMode('magic');
    setTimeout(() => emailEl?.focus(), 50);
  }

  // Password reset
  if (mode === 'reset') {
    async function doReset() {
      const email = emailEl.value.trim();
      if (!email) { showError('Please enter your email address.'); return; }
      setLoading(true, 'Send Reset Link');
      const { error } = await requestPasswordReset(email);
      if (error) {
        showError(error);
        setLoading(false, 'Send Reset Link');
      } else {
        showSuccess('Reset link sent — check your inbox. The link will direct you back here to set your new password.');
        submitBtn.disabled = true;
      }
    }

    submitBtn.onclick = doReset;
    emailEl.addEventListener('keydown', e => { if (e.key === 'Enter') doReset(); });
    targetEl.querySelector('#auth-to-signin').onclick = () => onSwitchMode('signin');
    setTimeout(() => emailEl?.focus(), 50);
  }

  // Magic link
  if (mode === 'magic') {
    async function doMagic() {
      const email = emailEl.value.trim();
      if (!email) { showError('Please enter your email address.'); return; }
      setLoading(true, 'Send Magic Link');
      const { error } = await requestMagicLink(email);
      if (error) {
        showError(error);
        setLoading(false, 'Send Magic Link');
      } else {
        showSuccess('Magic link sent — check your inbox and click the link to sign in instantly.');
        submitBtn.disabled = true;
      }
    }

    submitBtn.onclick = doMagic;
    emailEl.addEventListener('keydown', e => { if (e.key === 'Enter') doMagic(); });
    targetEl.querySelector('#auth-to-signin').onclick = () => onSwitchMode('signin');
    setTimeout(() => emailEl?.focus(), 50);
  }
}

// ─────────────────────────────────────────────
// SET NEW PASSWORD FORM
// Shown by app.js when a recovery hash is detected in the URL.
// Replaces the login modal until the password is successfully set.
// ─────────────────────────────────────────────
export function renderSetPasswordForm(targetEl, onSuccess) {
  targetEl.innerHTML = `
    <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-sm p-8">

        <div class="text-center mb-6">
          <h2 class="text-2xl font-bold text-slate-900">${APP_NAME}</h2>
          <p class="text-sm text-slate-500 mt-1">Set your new password</p>
        </div>

        <div id="set-pw-error"   class="hidden mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700"></div>
        <div id="set-pw-success" class="hidden mb-4 p-3 bg-green-50 border border-green-200 rounded text-sm text-green-700"></div>

        <div class="space-y-4">
          <div>
            <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">New Password</label>
            <input type="password" id="set-pw-new" placeholder="Min. 8 characters"
              class="w-full border border-slate-300 rounded px-4 py-2 text-sm focus:ring-2 focus:ring-slate-900 outline-none"
              autocomplete="new-password" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Confirm Password</label>
            <input type="password" id="set-pw-confirm" placeholder="Repeat password"
              class="w-full border border-slate-300 rounded px-4 py-2 text-sm focus:ring-2 focus:ring-slate-900 outline-none"
              autocomplete="new-password" />
          </div>
          <button id="set-pw-submit"
            class="w-full bg-slate-900 text-white py-2.5 rounded font-semibold text-sm hover:bg-slate-700 transition">
            Set Password
          </button>
        </div>

        <p class="text-center text-xs text-slate-300 mt-6">${APP_NAME} · rahmanmedical.co.uk</p>
      </div>
    </div>
  `;

  const newEl     = targetEl.querySelector('#set-pw-new');
  const confirmEl = targetEl.querySelector('#set-pw-confirm');
  const submitBtn = targetEl.querySelector('#set-pw-submit');
  const errorEl   = targetEl.querySelector('#set-pw-error');
  const successEl = targetEl.querySelector('#set-pw-success');

  async function doSet() {
    const pw1 = newEl.value;
    const pw2 = confirmEl.value;

    errorEl.classList.add('hidden');

    if (!pw1 || pw1.length < 8) {
      errorEl.textContent = 'Password must be at least 8 characters.';
      errorEl.classList.remove('hidden');
      return;
    }
    if (pw1 !== pw2) {
      errorEl.textContent = 'Passwords do not match.';
      errorEl.classList.remove('hidden');
      return;
    }

    submitBtn.disabled    = true;
    submitBtn.textContent = 'Saving…';

    const { error } = await updatePassword(pw1);
    if (error) {
      errorEl.textContent = error;
      errorEl.classList.remove('hidden');
      submitBtn.disabled    = false;
      submitBtn.textContent = 'Set Password';
    } else {
      successEl.textContent = 'Password set successfully. Signing you in…';
      successEl.classList.remove('hidden');
      setTimeout(() => {
        targetEl.innerHTML = '';
        onSuccess?.();
      }, 1500);
    }
  }

  submitBtn.onclick = doSet;
  [newEl, confirmEl].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') doSet(); }));
  setTimeout(() => newEl?.focus(), 50);
}

// ─────────────────────────────────────────────
// USER BADGE (header)
// ─────────────────────────────────────────────
export function renderUserBadge(targetEl) {
  const name = getDisplayName();
  const tier = getUserTier();
  if (!name || !targetEl) return;

  const tierColours = {
    admin:    'bg-purple-100 text-purple-700',
    pro:      'bg-blue-100 text-blue-700',
    standard: 'bg-slate-100 text-slate-600',
    free:     'bg-slate-100 text-slate-400',
  };
  const tierCls = tierColours[tier] || tierColours.free;

  targetEl.innerHTML = `
    <div class="flex items-center gap-2">
      <span class="text-xs text-slate-500 hidden sm:inline">
        <strong class="text-slate-700">${escHtml(name)}</strong>
      </span>
      <span class="text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wide ${tierCls}">
        ${tier}
      </span>
      <button id="auth-signout-btn"
        class="text-xs text-slate-400 hover:text-red-600 transition underline">
        Sign out
      </button>
    </div>
  `;

  targetEl.querySelector('#auth-signout-btn').onclick = async () => { await logout(); };
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}