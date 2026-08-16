import { renderAdminPanel } from './admin.js';
import { clearAppState, renderHome, restoreAppState, startHeartbeat, stopHeartbeat } from './app.js';
import { _resetNavigationRoot, showScreen } from './navigation.js';
import { requestNotificationPermission } from './profile.js';
import { RESUME_KEY, _showResumeDialog, _showTimeExpiredResult, clearPersistedTest } from './quiz.js';
import { ADMIN_EMAIL, USERS_SAFE_COLS, _showReconnecting, db, sb } from './supabase.js';
import { cacheGet, cacheSet, rateLimited, showLoading, showToast } from './utils.js';



// Cover the splash screen with a loading spinner from the very first instant
// this script runs, before we know anything about session state yet. On a
// slow connection, the alternative is the raw "Continue with Google" splash
// sitting fully visible (no spinner at all) for however long it takes
// Supabase to confirm whether there's actually a valid session — which
// reads as "the login screen keeps showing up" even though nothing is
// actually wrong, it just hasn't finished checking. Cleared as soon as
// _handleAuthedSessionInner() starts running (it sets _authSessionHandled
// itself, further down this file) — or, if there's no session to confirm at
// all (a brand new visitor, where neither SIGNED_IN nor SIGNED_OUT has any
// reason to fire), by this timeout instead, so the spinner can never get
// stuck forever with nothing to clear it.
showLoading(true, 'Loading...');
setTimeout(() => {
  if (!window._authSessionHandled) { showLoading(false); showScreen('splash', false); }
}, 6000);



// ==================== AUTH (Google Sign-In via Supabase Auth) ====================
async function signInWithGoogle() {
  const rl = rateLimited('google_signin', 5, 15 * 60 * 1000);
  if (!rl.allowed) return showToast(`Too many sign-in attempts. Please wait ${Math.ceil(rl.waitSec / 60)} min and try again.`);
  const btn = document.getElementById('googleSignInBtn');
  if (btn) { btn.disabled = true; btn.style.opacity = '.7'; }
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href, queryParams: { prompt: 'select_account' } }
  });
  if (error) {
    showToast('Google sign-in failed: ' + error.message);
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }
  // On success the browser redirects to Google, then back here — handled by
  // the onAuthStateChange listener near the bottom of this script.
}
window.signInWithGoogle = signInWithGoogle;



// Lets someone stuck on "Complete your profile" (e.g. picked the wrong Google
// account by mistake) back out cleanly instead of being stranded with no way
// back. Signs out and returns to the splash screen to try again.
async function cancelCreateAccount() {
  showLoading(true, 'Signing out...');
  try { await sb.auth.signOut(); } catch (e) { console.warn('signOut error', e); }
  window.currentUser = null;
  _resetNavigationRoot();
  showLoading(false);
  showScreen('splash', false);
}
window.cancelCreateAccount = cancelCreateAccount;



// Populates a <select> with active colleges (alphabetical) plus an "Others"
// option. If currentValue doesn't match any active college (legacy free-text
// data, or a college that's since been deactivated), it's kept as an extra
// selected option so existing data is never silently wiped.
export async function populateCollegeSelect(selectId, currentValue = '') {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  // Colleges essentially never change day-to-day, so this is cached for 30
  // minutes in localStorage — this dropdown gets rebuilt every time a student
  // opens signup or edits their profile, and there's no reason to hit the
  // network every time, or even on every fresh page load.
  let colleges = cacheGet('colleges', 1800000);
  if (!colleges) {
    const { data } = await db(sb.from('colleges').select('name').eq('is_active', true).order('name'), 'Colleges error');
    colleges = data;
    if (colleges) cacheSet('colleges', colleges);
  }
  let html = `<option value="" disabled ${!currentValue ? 'selected' : ''}>Select your college/university...</option>`;
  let matched = currentValue === 'Others';
  for (const c of (colleges || [])) {
    if (c.name === currentValue) matched = true;
    html += `<option value="${c.name.replace(/"/g,'&quot;')}" ${c.name === currentValue ? 'selected' : ''}>${c.name}</option>`;
  }
  if (currentValue && !matched) {
    html += `<option value="${currentValue.replace(/"/g,'&quot;')}" selected>${currentValue}</option>`;
  }
  html += `<option value="Others" ${currentValue === 'Others' ? 'selected' : ''}>🌐 Others (not listed)</option>`;
  sel.innerHTML = html;
}



// Populates a <select> with active years (in display order) for the signup
// form. Same defensive pattern as populateCollegeSelect: if currentValue
// doesn't match any active year, it's kept as an extra selected option so
// existing data is never silently wiped.
async function populateYearSelect(selectId, currentValue = '') {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  // Show every year here (not just the active one) so a student can pick their
  // real year even if it's not open yet — locked years just carry a "Coming Soon"
  // tag and unlock automatically once the admin activates them.
  const { data: years } = await db(sb.from('years').select('name,is_active').order('display_order'), 'Years error');
  let html = `<option value="" disabled ${!currentValue ? 'selected' : ''}>Select your year...</option>`;
  let matched = false;
  for (const y of (years || [])) {
    if (y.name === currentValue) matched = true;
    const label = y.is_active ? y.name : `${y.name} (🔒 Coming Soon)`;
    html += `<option value="${y.name.replace(/"/g,'&quot;')}" ${y.name === currentValue ? 'selected' : ''}>${label}</option>`;
  }
  if (currentValue && !matched) {
    html += `<option value="${currentValue.replace(/"/g,'&quot;')}" selected>${currentValue}</option>`;
  }
  sel.innerHTML = html;
}



// Loads/creates the matching row in our own `users` table for the signed-in
// Google account, then routes to the right screen. Called after every
// Google sign-in (fresh or returning) and on every page refresh while
// already signed in.
window._authSessionHandled = false;


async function _handleAuthedSessionInner(session) {
  // Guard against double-fire: onAuthStateChange emits SIGNED_IN both from
  // window.onload's own getSession() check AND from Supabase's listener
  // re-confirming the very same session moments later. Without this guard,
  // this whole function — including the "unfinished test?" resume dialog
  // below — runs twice on a single page load, which creates two overlays.
  // The second one silently overwrites window._doResume/_skipResume, so the
  // first (still on screen, on top) becomes permanently unresponsive: this is
  // exactly the "Continue Test / Submit & Exit button does nothing" bug.
  // Reset on SIGNED_OUT (below) so a genuine new sign-in still runs fully.
  if (window._authSessionHandled) return;
  window._authSessionHandled = true;
  const _hasSavedState = !!localStorage.getItem('lum_app_state');
  showLoading(true, _hasSavedState ? 'Welcome back...' : 'Setting up...');
  const authUid = session.user.id;
  const email = session.user.email;
  const googleName = session.user.user_metadata?.full_name || session.user.user_metadata?.name || '';

  let { data: row } = await db(sb.from('users').select(USERS_SAFE_COLS + ',profile_completed,city,dob').eq('auth_uid', authUid).maybeSingle(), 'Profile load failed');

  if (!row) {
    // Might be an existing account created before Google sign-in was added
    // (back when signup used email+password) — link it to this Google identity
    // instead of creating a duplicate.
    const { data: linkedRows } = await sb.rpc('link_google_account', { p_email: email });
    row = Array.isArray(linkedRows) ? linkedRows[0] : linkedRows;
  }

  if (!row) {
    // Brand new account — also covers the one-time admin bootstrap for the fixed admin email.
    const isAdminEmail = email === ADMIN_EMAIL;
    const { data: created } = await db(sb.from('users').insert({
      auth_uid: authUid, email, name: googleName || email.split('@')[0],
      gender: 'male', dob: '2005-01-01', college: '', city: '',
      joined: Date.now(), show_on_leaderboard: false,
      is_admin: isAdminEmail, is_banned: false, profile_completed: false
    }).select(USERS_SAFE_COLS + ',profile_completed,city,dob').single(), 'Account creation failed');
    if (!created) { showLoading(false); showToast('Could not create your account. Please try again.'); return; }
    row = created;
    if (isAdminEmail) {
      await db(sb.from('user_stats').insert({ email, total_tests: 0, total_questions: 0, total_correct: 0, best_score: 0, streak: 0, history: [], subject_stats: {} }), 'Stats init failed');
    }
  }

  if (row.is_banned) { showLoading(false); showToast('Account banned. Contact admin.'); await sb.auth.signOut(); return; }

  window.currentUser = row;
  _resetNavigationRoot();
  showLoading(false);

  if (window.currentUser.is_admin) {
    if (await restoreAppState()) return;
    renderAdminPanel(); showScreen('admin'); return;
  }

  if (!row.profile_completed) {
    document.getElementById('ca_name').value = row.name || '';
    document.getElementById('ca_city').value = row.city || '';
    document.getElementById('ca_phone').value = row.phone || '';
    document.getElementById('ca_gender').value = row.gender || 'male';
    document.getElementById('ca_dob').value = row.dob || '2005-01-01';
    showScreen('createaccount');
    populateCollegeSelect('ca_college', row.college || '');
    populateYearSelect('ca_year', row.year_of_study || '');
    return;
  }

  if (window.maintenanceMode) { showToast('App is under maintenance. Please check back later.'); await sb.auth.signOut(); return; }
  startHeartbeat();
  requestNotificationPermission();

  // Check for in-progress test (attempt or browse/review)
  const rawTest = localStorage.getItem(RESUME_KEY);
  if (rawTest) {
    try {
      const saved = JSON.parse(rawTest);
      if (saved && !saved.submitted) {
        const elapsed = Math.floor((Date.now() - saved.startTime) / 1000);
        if (saved.mode === 'attempt') {
          const timeExpired = saved.timeLimit && elapsed >= saved.timeLimit;
          const tooOld = elapsed > 12 * 3600;
          if (tooOld) {
            clearPersistedTest();
          } else if (timeExpired) {
            clearPersistedTest();
            const savedYear = localStorage.getItem('lum_year');
            if (savedYear) window.selectedYear = JSON.parse(savedYear);
            window.activeTest = { ...saved, bookmarked: new Set(saved.bookmarked || []), timerInterval: null, submitted: false };
            showLoading(false);
            _showTimeExpiredResult();
            return;
          } else {
            const savedYear = localStorage.getItem('lum_year');
            if (savedYear) window.selectedYear = JSON.parse(savedYear);
            _showResumeDialog(saved, elapsed);
            return;
          }
        } else if (saved.mode === 'browse') {
          const tooOld = elapsed > 7 * 24 * 3600; // no time pressure in Review, so kept much longer than Attempt
          if (!tooOld) {
            const savedYear = localStorage.getItem('lum_year');
            if (savedYear) window.selectedYear = JSON.parse(savedYear);
            _showResumeDialog(saved, elapsed);
            return;
          } else {
            clearPersistedTest();
          }
        } else if (saved.mode === 'practice') {
          const tooOld = elapsed > 48 * 3600; // untimed like Review, but still a real graded session, so not kept as long
          if (!tooOld) {
            const savedYear = localStorage.getItem('lum_year');
            if (savedYear) window.selectedYear = JSON.parse(savedYear);
            _showResumeDialog(saved, elapsed);
            return;
          } else {
            clearPersistedTest();
          }
        } else {
          clearPersistedTest();
        }
      } else {
        clearPersistedTest();
      }
    } catch { clearPersistedTest(); }
  }

  const saved = localStorage.getItem('lum_year');
  if (saved) window.selectedYear = JSON.parse(saved);
  if (await restoreAppState()) return;
  // Always go to home — year_of_study is now stored on user profile, not in localStorage
  renderHome(); showScreen('home');
}



// Thin safety net around the real logic above. _authSessionHandled is set
// synchronously at the very top of _handleAuthedSessionInner (that's the
// whole point of it — block a second concurrent run) — but that means if
// the function throws partway through (a network drop mid-login being the
// realistic case), the flag is left stuck "true" forever with nothing ever
// having called showLoading(false). Every future retry (from the
// reconnecting screen, a later SIGNED_IN event, anything) would then return
// immediately via that guard and silently do nothing, stranding the person
// on a spinner. Catching here resets the guard and clears the spinner so a
// retry can actually retry, and rethrows so callers (boot / reconnect loop)
// still know it failed.
export async function handleAuthedSession(session) {
  try {
    await _handleAuthedSessionInner(session);
  } catch (e) {
    console.error('handleAuthedSession failed', e);
    window._authSessionHandled = false;
    showLoading(false);
    throw e;
  }
}



function markFieldError(inputId, errorId, show) {
  document.getElementById(inputId).classList.toggle('field-invalid', show);
  document.getElementById(errorId).classList.toggle('show', show);
}



async function submitCreateAccount() {
  const name = document.getElementById('ca_name').value.trim();
  const city = document.getElementById('ca_city').value.trim();
  const phone = document.getElementById('ca_phone').value.trim();
  const gender = document.getElementById('ca_gender').value;
  const dob = document.getElementById('ca_dob').value || '2005-01-01';
  const college = document.getElementById('ca_college').value.trim();
  const year = document.getElementById('ca_year').value.trim();

  const nameOk = !!name, collegeOk = !!college, yearOk = !!year;
  markFieldError('ca_name', 'err_ca_name', !nameOk);
  markFieldError('ca_college', 'err_ca_college', !collegeOk);
  markFieldError('ca_year', 'err_ca_year', !yearOk);
  if (!nameOk || !collegeOk || !yearOk) return showToast('Please fill the required fields');

  showLoading(true, 'Creating your account...');
  const { error } = await db(sb.from('users').update({
    name, city, phone, gender, dob, college, year_of_study: year, profile_completed: true
  }).eq('auth_uid', window.currentUser.auth_uid), 'Account setup failed');
  if (error) { showLoading(false); return; }

  await db(sb.from('user_stats').upsert({ email: window.currentUser.email, total_tests: 0, total_questions: 0, total_correct: 0, best_score: 0, history: [], streak: 0, last_practice_date: null, subject_stats: {} }, { onConflict: 'email', ignoreDuplicates: true }), 'Stats init failed');

  window.currentUser = { ...window.currentUser, name, city, phone, gender, dob, college, year_of_study: year, profile_completed: true };
  showLoading(false);
  showToast(`Welcome, Dr. ${name}! 🩺`);
  startHeartbeat();
  requestNotificationPermission();
  renderHome(); showScreen('home');
}
window.submitCreateAccount = submitCreateAccount;



export async function logout() {
  stopHeartbeat();
  clearPersistedTest();
  clearAppState();
  localStorage.removeItem('lum_year');
  window._authSessionHandled = false;
  window.currentUser = null; window.selectedYear = null; window.activeTest = null;
  _resetNavigationRoot();
  document.getElementById('bottomNav').classList.remove('show');
  try { await sb.auth.signOut(); } catch(e) { console.warn('signOut error', e); }
  showScreen('splash', false);
}
window.logout = logout;



// Fires on every sign-in (including the redirect back from Google) and on
// page refresh if a session is still valid. This replaces the old manual
// localStorage session + password-based tryAutoLogin/doLogin entirely.
let _pendingSignOutToken = null;


// Deferred by one microtask: auth.js and supabase.js import from each other
// (auth.js needs `sb`; supabase.js needs handleAuthedSession), so at module-eval
// time this file can run before supabase.js's `const sb = ...` has initialized.
// Registering the listener a microtask later guarantees the whole module graph
// has finished evaluating first, while still running before any real auth event
// (user interaction, OAuth redirect, or async network response) could occur.
queueMicrotask(() => {
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session) {
    _pendingSignOutToken = null; // a real sign-in cancels any pending sign-out doubt
    handleAuthedSession(session).catch(e => console.error('SIGNED_IN handling failed', e));
  }
  if (event === 'SIGNED_OUT') {
    // Supabase fires SIGNED_OUT both for a real, deliberate sign-out AND when a
    // background token refresh fails on a slow/flaky connection — the two are
    // indistinguishable at the event level. Confirming once more before tearing
    // down the session avoids kicking a student back to the login screen over
    // what was actually just a network hiccup, not an actual logout. A genuine
    // sign-out (the button elsewhere in this file) already clears everything
    // and shows the splash screen itself, synchronously, so this added delay
    // never makes an intentional sign-out feel slower.
    const myToken = _pendingSignOutToken = {};
    (async () => {
      await new Promise(r => setTimeout(r, 1500));
      if (_pendingSignOutToken !== myToken) return; // superseded by a newer sign-in/out
      try {
        const { data: { session: recovered } } = await sb.auth.getSession();
        if (recovered) return; // false alarm — still signed in, nothing to do
      } catch (e) { /* couldn't confirm either way — fall through */ }
      if (_pendingSignOutToken !== myToken) return;
      // Still can't confirm a session. If we know we were genuinely logged in,
      // this still reads more like a lost connection than a real sign-out —
      // show Reconnecting and keep trying quietly rather than assuming the
      // worst and bouncing straight to the login screen.
      if (window.currentUser) {
        _showReconnecting();
      } else {
        window._authSessionHandled = false;
        window.currentUser = null;
        window.selectedYear = null;
        window.activeTest = null;
        _resetNavigationRoot();
        document.getElementById('bottomNav')?.classList.remove('show');
        showScreen('splash', false);
      }
    })();
  }
});
});
