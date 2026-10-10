import { handleAuthedSession } from './auth.js';
import { showScreen } from './navigation.js';
import { showToast } from './utils.js';

// ==================== CONFIG ====================
export const SUPABASE_URL = 'https://svdgsbydducyvluvankh.supabase.co';


export const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2ZGdzYnlkZHVjeXZsdXZhbmtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0Mjg2NjAsImV4cCI6MjA5NzAwNDY2MH0.HzTgOyYXcUkibvyX0mEIYuaFtMuOGDG8M6I7ocmWemI';


const _nativeFetch = window.fetch.bind(window);
let _requestMinute = Math.floor(Date.now() / 60000);
let _requestsByScreen = {};
let _requestLogTimer = null;
let _lastNetworkToastAt = 0;
const _retryDelays = [1000, 3000, 6000];
const _requestTimeoutMs = 25000;
const _buttonRequests = new WeakMap();

function _flushRequestCounts() {
  const entries = Object.entries(_requestsByScreen).map(([screen, requests]) => ({ screen, requests }));
  if (entries.length) {
    console.info(`[LUMHSian] Supabase requests for minute ${_requestMinute}`);
    console.table(entries);
  }
  _requestsByScreen = {};
  _requestMinute = Math.floor(Date.now() / 60000);
}

function _countSupabaseRequest(input) {
  try {
    const requestUrl = new URL(typeof input === 'string' ? input : input.url);
    if (requestUrl.origin === SUPABASE_URL) {
      const minute = Math.floor(Date.now() / 60000);
      if (minute !== _requestMinute) _flushRequestCounts();
      const activeScreen = document.querySelector('.screen.active')?.id?.replace('screen-', '') || 'startup';
      _requestsByScreen[activeScreen] = (_requestsByScreen[activeScreen] || 0) + 1;
      if (!_requestLogTimer) {
        _requestLogTimer = setTimeout(() => {
          _flushRequestCounts();
          _requestLogTimer = null;
        }, 60000 - (Date.now() % 60000));
      }
    }
  } catch (e) {}
}

function _networkToast(retry) {
  const now = Date.now();
  if (now - _lastNetworkToastAt < 8000) return;
  _lastNetworkToastAt = now;
  showToast('Slow internet, please try again', 8000, retry ? async () => {
    showToast('Retrying...', 25000);
    try {
      const response = await retry();
      if (response && ('ok' in response ? response.ok : !response.error)) showToast('Request completed', 2500);
      else showToast('Slow internet, please try again', 8000);
    } catch (e) {
      showToast('Slow internet, please try again', 8000);
    }
  } : null);
}

function _retryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function _wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function _supabaseFetchRequest(input, init = {}, { notify = true, retryReads = true } = {}) {
  let url;
  try { url = new URL(typeof input === 'string' ? input : input.url); } catch (e) {}
  if (url?.origin !== SUPABASE_URL) return _nativeFetch(input, init);

  const method = String(init.method || input.method || 'GET').toUpperCase();
  const canRetry = retryReads && (method === 'GET' || method === 'HEAD');
  const maxAttempts = canRetry ? _retryDelays.length + 1 : 1;
  const sourceSignal = init.signal || (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null);
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    _countSupabaseRequest(input);
    const controller = new AbortController();
    const abortFromSource = () => controller.abort(sourceSignal?.reason);
    if (sourceSignal?.aborted) abortFromSource();
    else sourceSignal?.addEventListener('abort', abortFromSource, { once: true });
    const timeoutId = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), _requestTimeoutMs);
    try {
      const requestInput = typeof Request !== 'undefined' && input instanceof Request ? input.clone() : input;
      const response = await _nativeFetch(requestInput, { ...init, signal: controller.signal });
      const body = await response.arrayBuffer();
      const responseBody = [204, 205, 304].includes(response.status) ? null : body;
      const completedResponse = new Response(responseBody, { status: response.status, statusText: response.statusText, headers: response.headers });
      if (!canRetry || !_retryableStatus(completedResponse.status)) return completedResponse;
      lastError = new Error(`Supabase request failed with status ${completedResponse.status}`);
      if (attempt === maxAttempts - 1) {
        if (notify) _networkToast(() => _supabaseFetch(input, init, { notify: false }));
        return completedResponse;
      }
    } catch (error) {
      lastError = error;
      if (sourceSignal?.aborted || attempt === maxAttempts - 1) {
        if (notify && !sourceSignal?.aborted) _networkToast(() => _supabaseFetch(input, init, { notify: false }));
        throw error;
      }
    } finally {
      clearTimeout(timeoutId);
      sourceSignal?.removeEventListener('abort', abortFromSource);
    }
    await _wait(_retryDelays[attempt]);
  }
  throw lastError || new Error('Supabase request failed');
}


async function _supabaseFetch(input, init = {}, options) {
  const button = _lockActiveButton();
  try { return await _supabaseFetchRequest(input, init, options); }
  finally { _unlockButton(button); }
}


export const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: window.localStorage },
  global: { fetch: _supabaseFetch }
});


export const ADMIN_EMAIL = 'lumhsianpro@gmail.com';

 // used as contact email fallback only
// Every column on `users` EXCEPT password_hash — use this instead of select('*') anywhere
// a browser reads from the users table, now that password_hash is locked down server-side.
export const USERS_SAFE_COLS = 'auth_uid,email,name,gender,college,joined,last_active,last_heartbeat,current_screen,show_on_leaderboard,is_admin,is_banned,profile_image,phone,year_of_study,enrollment_number';



function _lockActiveButton() {
  const button = document.activeElement;
  if (!(button instanceof HTMLButtonElement)) return null;
  let state = _buttonRequests.get(button);
  if (button.disabled && !state) return null;
  if (!state) {
    state = { count: 0, wasDisabled: button.disabled };
    _buttonRequests.set(button, state);
  }
  state.count++;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  return button;
}

function _unlockButton(button) {
  if (!button) return;
  const state = _buttonRequests.get(button);
  if (!state) return;
  state.count--;
  if (state.count <= 0) {
    button.disabled = state.wasDisabled;
    button.removeAttribute('aria-busy');
    _buttonRequests.delete(button);
  }
}

export async function db(promise, errMsg = 'Database error') {
  const button = _lockActiveButton();
  try {
    const res = await promise;
    if (res.error) throw res.error;
    return res;
  } catch (err) {
    console.warn(errMsg, err);
    _networkToast(() => db(promise, errMsg));
    return { data: null, error: err, count: null };
  } finally {
    _unlockButton(button);
  }
}
window.db = db;



// ==================== ADMIN ACTIONS ====================
// Privileged actions (ban a user, promote to admin, approve a subscription)
// run through SQL functions that check the *real, signed-in* admin's identity
// server-side (via their Google-authenticated session) — not a password typed
// into the browser. A student calling the same function directly gets
// rejected because their own account isn't flagged is_admin in the database.
export async function adminRPC(fnName, params) {
  return sb.rpc(fnName, params);
}

// ==================== FINAL STARTUP ====================
// Session restore is kept separate from settings/flags loading, with its own
// retry. If Wi-Fi/mobile data hasn't fully reconnected yet right after the
// app comes back from the background, a Promise.all here would let that
// transient failure bubble up and skip straight past a perfectly valid
// saved session — dumping the user back on the login screen for no reason.
//
// getSession() reads from localStorage first and only hits the network when
// the access token needs refreshing — so a slow connection doesn't always
// throw, it can just resolve with session:null if the refresh attempt times
// out quietly. Retrying only on a caught error missed that case, which is
// exactly the "asks to sign in again on slow internet" bug. Now every empty
// result gets retried too, and if there's a Supabase session actually saved
// in localStorage (meaning this device really has signed in before) we're
// far more patient before giving up — a brand-new visitor with nothing
// stored still gets to the login screen immediately, with no wait.
//
// And if we're STILL patient and it's still not back (very slow/dropped
// connection), we no longer fall back to the login screen at all — that's
// what was training people to tap "Continue with Google" again on a slow
// day and re-auth needlessly. Instead we show a neutral "Reconnecting..."
// screen and keep quietly retrying in the background (and instantly the
// moment the browser reports the connection is back), only ever reaching
// the real login screen if there was genuinely no saved session to begin
// with, or the person explicitly chooses to sign in again from there.
export function _hasStoredSupabaseSession() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) return true;
    }
  } catch (e) {}
  return false;
}


export async function getSessionWithRetry(retries, delayMs) {
  for (let i = 0; i <= retries; i++) {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session) return session;
    } catch (e) {
      console.warn('getSession attempt failed', i, e);
    }
    if (i < retries) await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}



let _reconnectActive = false;


let _reconnectTimer = null;


let _reconnectAttempts = 0;
let _reconnectDelayIndex = 0;
let _reconnectBusy = false;
const _reconnectDelays = [4000, 8000, 15000, 30000, 60000];


export function _showReconnecting() {
  _reconnectActive = true;
  _reconnectAttempts = 0;
  _reconnectDelayIndex = 0;
  showScreen('reconnecting', false);
  document.getElementById('reconnectRetryBtn').style.display = 'none';
  document.getElementById('reconnectStatusText').textContent = "Your session is safe, just waiting for the connection to come back.";
  window.addEventListener('online', _reconnectNow);
  document.addEventListener('visibilitychange', _reconnectVisibilityChanged);
  _reconnectLoop();
}


function _reconnectNow() {
  clearTimeout(_reconnectTimer);
  if (document.hidden) return;
  _reconnectLoop();
}


function _reconnectVisibilityChanged() {
  if (document.hidden) clearTimeout(_reconnectTimer);
  else _reconnectNow();
}


function _scheduleReconnect() {
  if (!_reconnectActive || document.hidden) return;
  clearTimeout(_reconnectTimer);
  const delay = _reconnectDelays[Math.min(_reconnectDelayIndex, _reconnectDelays.length - 1)];
  _reconnectDelayIndex++;
  _reconnectTimer = setTimeout(_reconnectLoop, delay);
}


async function _reconnectLoop() {
  if (!_reconnectActive || _reconnectBusy || document.hidden) return;
  clearTimeout(_reconnectTimer);
  if (!navigator.onLine) {
    _scheduleReconnect();
    return;
  }

  _reconnectBusy = true;
  let connectionWorks = false;
  let session = null;
  try {
    const health = await _supabaseFetch(`${SUPABASE_URL}/auth/v1/health`, { method: 'GET', headers: { apikey: SUPABASE_KEY } }, { notify: false, retryReads: false });
    connectionWorks = health.ok;
    if (connectionWorks) {
      const { data, error } = await sb.auth.getSession();
      if (error) throw error;
      session = data?.session || null;
    }
  } catch (e) {
    console.warn('reconnect check failed', e);
  } finally {
    _reconnectBusy = false;
  }
  if (!_reconnectActive) return;
  if (session) {
    try {
      await handleAuthedSession(session);
      _reconnectStop();
      return;
    } catch (e) {
      // Had a session but applying it also failed — most likely the same
      // flaky connection. Fall through and keep retrying rather than
      // stranding the person on this screen.
      console.warn('reconnect: handleAuthedSession failed, will retry', e);
      if (!_reconnectActive) return;
    }
  } else if (connectionWorks) {
    _reconnectStop();
    showScreen('splash', false);
    return;
  }
  _reconnectAttempts++;
  if (_reconnectAttempts >= 4) {
    document.getElementById('reconnectRetryBtn').style.display = 'block';
    document.getElementById('reconnectStatusText').textContent = 'Still trying to reconnect you. You can keep waiting or retry manually.';
  }
  _scheduleReconnect();
}


function _reconnectStop() {
  _reconnectActive = false;
  clearTimeout(_reconnectTimer);
  window.removeEventListener('online', _reconnectNow);
  document.removeEventListener('visibilitychange', _reconnectVisibilityChanged);
}


function _manualReconnectRetry() {
  document.getElementById('reconnectRetryBtn').style.display = 'none';
  document.getElementById('reconnectStatusText').textContent = "Your session is safe, just waiting for the connection to come back.";
  clearTimeout(_reconnectTimer);
  _reconnectLoop();
}
window._manualReconnectRetry = _manualReconnectRetry;


// Escape hatch shown on the reconnecting screen after several failed
// attempts, in case the session really is gone (revoked, or signed out on
// another device) rather than just a slow connection — never shown as the
// first/default response to a network blip.
function _reconnectGiveUpAndSignIn() {
  _reconnectStop();
  window._authSessionHandled = false;
  window.currentUser = null; window.selectedYear = null; window.activeTest = null; window.navStack = [];
  document.getElementById('bottomNav')?.classList.remove('show');
  showScreen('splash', false);
}
window._reconnectGiveUpAndSignIn = _reconnectGiveUpAndSignIn;
