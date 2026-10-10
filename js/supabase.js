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

function _flushRequestCounts() {
  const entries = Object.entries(_requestsByScreen).map(([screen, requests]) => ({ screen, requests }));
  if (entries.length) {
    console.info(`[LUMHSian] Supabase requests for minute ${_requestMinute}`);
    console.table(entries);
  }
  _requestsByScreen = {};
  _requestMinute = Math.floor(Date.now() / 60000);
}

function _countedFetch(input, init) {
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
  return _nativeFetch(input, init);
}


export const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: window.localStorage },
  global: { fetch: _countedFetch }
});


export const ADMIN_EMAIL = 'lumhsianpro@gmail.com';

 // used as contact email fallback only
// Every column on `users` EXCEPT password_hash — use this instead of select('*') anywhere
// a browser reads from the users table, now that password_hash is locked down server-side.
export const USERS_SAFE_COLS = 'auth_uid,email,name,gender,college,joined,last_active,last_heartbeat,current_screen,show_on_leaderboard,is_admin,is_banned,profile_image,phone,year_of_study,enrollment_number';



let _lastNetworkToastAt = 0;

function _shouldTreatAsSlowNetwork(err) {
  const message = String(err?.message || err || '');
  return /timed out|timeout|Failed to fetch|NetworkError|fetch failed|load failed|connection.*slow/i.test(message);
}

function _networkToast(message, duration = 6000) {
  const now = Date.now();
  if (now - _lastNetworkToastAt < duration) return;
  _lastNetworkToastAt = now;
  showToast(message, duration);
}

function _requestTimeoutMs() {
  try {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const type = connection?.effectiveType || '';
    if (!navigator.onLine || type.includes('2g') || type.includes('slow') || type.includes('3g')) return 18000;
  } catch (e) {}
  return 8000;
}

export async function db(promise, errMsg = 'Database error') {
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Request timed out')), _requestTimeoutMs()));
    const res = await Promise.race([promise, timeout]);
    if (res.error) throw res.error;
    return res;
  } catch (err) {
    const message = String(err?.message || err || '');
    console.error(errMsg, err);
    const detail = [err.message, err.hint, err.details].filter(Boolean).join(' · ');
    const friendly = !navigator.onLine
      ? 'Offline right now — the app will retry when the connection returns.'
      : _shouldTreatAsSlowNetwork(err)
        ? 'Your connection is slow right now — the app is retrying quietly.'
        : (errMsg + ': ' + (detail || 'Unknown error'));

    if (!navigator.onLine || _shouldTreatAsSlowNetwork(err)) {
      _networkToast(friendly, 5000);
    } else {
      showToast(friendly, 9000);
    }
    return { data: null, error: err, count: null };
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


export function _showReconnecting() {
  _reconnectActive = true;
  _reconnectAttempts = 0;
  showScreen('reconnecting', false);
  document.getElementById('reconnectRetryBtn').style.display = 'none';
  document.getElementById('reconnectStatusText').textContent = "Your session is safe, just waiting for the connection to come back.";
  window.addEventListener('online', _reconnectNow);
  _reconnectLoop();
}


function _reconnectNow() {
  clearTimeout(_reconnectTimer);
  _reconnectLoop();
}


async function _reconnectLoop() {
  if (!_reconnectActive) return;
  _reconnectAttempts++;
  let session = null;
  try {
    session = await getSessionWithRetry(1, 800);
  } catch (e) { console.warn('reconnect attempt failed', e); }
  if (!_reconnectActive) return; // stopped elsewhere while this was in flight
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
  }
  if (_reconnectAttempts >= 4) {
    document.getElementById('reconnectRetryBtn').style.display = 'block';
    document.getElementById('reconnectStatusText').textContent = 'Still trying to reconnect you. You can keep waiting or retry manually.';
  }
  _reconnectTimer = setTimeout(_reconnectLoop, 4000);
}


function _reconnectStop() {
  _reconnectActive = false;
  clearTimeout(_reconnectTimer);
  window.removeEventListener('online', _reconnectNow);
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
