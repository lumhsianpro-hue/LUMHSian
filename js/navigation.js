import { getRankInfo, getUserStats, isFeatureEnabled, openModule, openPastPapersRoot, renderHome, renderModulesScreen, renderSavedTests, renderSearch, saveAppState, saveAppStateDebounced } from './app.js';
import { renderRanking } from './leaderboard.js';
import { renderBookmarks, renderPlanner, renderProfile, renderStats, renderWrongAttempts } from './profile.js';
import { leaveFinishedTest, requestExitTest } from './quiz.js';
import { showToast } from './utils.js';



// ==================== SCREEN ROUTING ====================
// Safety net: if a screen is still completely empty shortly after it was opened (a render that failed, or a screen that
// isn't wired up yet), show a Back button and a short message instead of leaving the student stuck on a blank page.
function _blankScreenGuard(id, el) {
  if (['splash', 'reconnecting', 'test', 'createaccount', 'legalpage'].includes(id)) return;
  clearTimeout(window._blankGuardTimer);
  window._blankGuardTimer = setTimeout(() => {
    if (document.querySelector('.screen.active') !== el) return;
    const wrap = el.querySelector('.page-wrap');
    if (wrap && !wrap.innerHTML.trim()) {
      wrap.innerHTML = '<button class="back-btn" onclick="goBack()">← Back</button><div class="card text-center" style="padding:36px 20px;margin-top:14px"><div style="font-size:38px">🔄</div><h3 style="margin-top:10px">Nothing to show here yet</h3><p class="mt-2 text-sm">Go back and try again. If this keeps happening, refresh the app.</p></div>';
    }
  }, 1800);
}

export function showScreen(id, pushToStack = true) {
  // Only touch screens that need to change — avoids DOM thrashing
  const current = document.querySelector('.screen.active');
  const next = document.getElementById('screen-' + id);
  if (!next) return;
  if (current && current !== next) current.classList.remove('active');
  next.classList.add('active');
  window.scrollTo(0, 0);
  if (pushToStack) {
    if (window.navStack[window.navStack.length - 1] !== id) window.navStack.push(id);
    if (window.navStack.length > 30) window.navStack.shift();
  }
  _ensureBackTrap();
  _blankScreenGuard(id, next);
  updateBottomNav(id);
  if (typeof saveAppStateDebounced === 'function') saveAppStateDebounced();
  else if (typeof saveAppState === 'function') saveAppState();
  const showNavFor = ['home','modules','search','stats','ranking','profile','bookmarks','wrongattempts','planner','savedtests','support'];
  document.getElementById('bottomNav').classList.toggle('show', showNavFor.includes(id));
}
window.showScreen = showScreen;



function updateBottomNav(id) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const map = { home: 'nav-home', modules: 'nav-modules', search: 'nav-search', stats: 'nav-stats', ranking: 'nav-ranking', profile: 'nav-profile' };
  if (map[id]) document.getElementById(map[id])?.classList.add('active');
}



// navGo is defined once, further below, with feature-flag gating for bookmarks/planner/ranking.

// Shared by goBack() and the post-test navigation (exit/submit/finish) — for
// screens whose content depends on data (not just static markup), re-render
// them fresh rather than assuming whatever's still in the DOM is current.
// Screens not in this map (e.g. a specific module's page) just get revealed
// as-is, which is correct within the same session and a reasonable fallback
// after a full app restart.
export function _returnToScreen(id) {
  const target = id || 'home';
  // showScreen() is called below with pushToStack:false, which only skips
  // PUSHING a new entry — it doesn't POP whatever test-flow screen is
  // already sitting on top (test/results/review all get pushed normally on
  // the way in). Left uncleaned, that stale entry can resurface later and
  // make goBack() think the user is returning to a live test — wrongly
  // showing "Exit Test?" on a screen that has nothing to do with a test.
  while (window.navStack.length && ['test', 'results', 'review'].includes(window.navStack[window.navStack.length - 1])) {
    window.navStack.pop();
  }
  // Defined inline (not as a top-level const) on purpose: these render
  // functions live in a later <script> block than this one, so building this
  // map at parse time (before that block has run) would throw. Evaluating it
  // lazily, only when _returnToScreen() is actually called, is safe.
  const renderers = {
    home: renderHome, modules: renderModulesScreen, profile: renderProfile, stats: renderStats, ranking: renderRanking, search: renderSearch, bookmarks: renderBookmarks, wrongattempts: renderWrongAttempts, planner: renderPlanner, savedtests: renderSavedTests,
    module: () => {
      if (window._moduleScreenMode === 'pastpapers') {
        // Deliberately always back to the college list (root), never deep into
        // a specific college — re-resolves "my year" fresh every time, so this
        // is always correct even if that changed since.
        openPastPapersRoot();
      } else if (window._lastOpenedModule) {
        const m = window._lastOpenedModule;
        openModule(m.moduleId, m.moduleName, m.iconUrl || '', m.color || '', m.fromYearId || null, m.fromYearName || null);
      }
    }
  };
  // Keep the logical stack equal to what is actually on screen. Without this, going "home" from a screen that
  // was opened from somewhere else left stale entries behind, so the next Back press appeared to do nothing.
  const at = window.navStack.lastIndexOf(target);
  if (at >= 0) window.navStack.length = at + 1; else window.navStack.push(target);
  if (renderers[target]) renderers[target]();
  showScreen(target, false);
}
window._returnToScreen = _returnToScreen;



// Called once, right when we know for certain whether someone is logging in
// or out — never during ordinary in-app navigation. Resets the logical screen stack.
export function _resetNavigationRoot() {
  // History is no longer tied screen-by-screen to the logical stack (see "BACK BUTTON" at the bottom of this
  // file), so a login/logout only needs the logical stack emptied.
  window.navStack = [];
  _ensureBackTrap();
}
window._resetNavigationRoot = _resetNavigationRoot;



// Back from the current screen. Each case below used to leave the stack and the screen out of step, which is why
// the Back button seemed dead on Results / after Review.
export function goBack() {
  const stack = window.navStack;
  const activeEl = document.querySelector('.screen.active');
  const cur = activeEl ? activeEl.id.replace('screen-', '') : stack[stack.length - 1];

  // A live test: Back = the same as the Pause / Exit button (never silently abandon it)
  if (cur === 'test' && window.activeTest && !window.activeTest.submitted) { requestExitTest(); return; }
  // Results: Back = Done (return to wherever the test was started from)
  if (cur === 'results') { leaveFinishedTest(); return; }
  // Review (or Quick View): step back to Results / Search while keeping Results on the stack
  if (cur === 'review') {
    if (window._qvState && typeof window.closeQuickView === 'function') { window.closeQuickView(); return; }
    if (stack[stack.length - 1] === 'review') stack.pop();
    showScreen('results', false);
    return;
  }
  if (stack.length > 1) {
    stack.pop();
    _returnToScreen(stack[stack.length - 1]);
  }
  // At the root (Home) there is nothing to go back to — the phone-back handler below decides about exiting.
}
window.goBack = goBack;



// navGo: routes between main tabs, gating a few behind their feature flags
// Prefetch: start loading data when user hovers/touches a nav item
// so by the time they tap, data may already be in cache
function navPrefetch(id) {
  if (!window.currentUser) return;
  if (id === 'stats') getUserStats();
  if (id === 'home' || id === 'modules') {
    getUserStats();
    if (!window._rankInfoCache) getRankInfo();
  }
}
window.navPrefetch = navPrefetch;



function navGo(id) {
  const flagMap = {
    bookmarks: 'bookmarks',
    planner: 'planner',
    ranking: 'leaderboard'
  };
  const flag = flagMap[id];
  if (flag) {
    const enabled = isFeatureEnabled(flag);
    if (!enabled) { showToast('This feature is currently disabled.'); return; }
  }
  const renders = {
    home: renderHome, modules: renderModulesScreen, search: renderSearch, stats: renderStats,
    ranking: renderRanking, profile: renderProfile,
    bookmarks: renderBookmarks, wrongattempts: renderWrongAttempts, planner: renderPlanner, savedtests: renderSavedTests
  };
  if (renders[id]) renders[id]();
  showScreen(id);
}
window.navGo = navGo;



// ==================== BACK BUTTON (phone / browser) ====================
// The browser history always holds exactly two entries for the app: a "root" entry and, in front of it, an "app"
// entry the user actually sits on. Pressing the phone's Back moves from "app" to "root" and fires popstate; we then
// do the in-app Back (close a dialog, tap the visible ← button, or pop the screen stack) and push the "app" entry
// again. Because the history never grows or shrinks with in-app navigation it can no longer drift out of step with
// navStack — the old one-history-entry-per-screen scheme left several dead Back presses behind after Done/Exit.
window.__lumNavReady = true;   // lets app.js detect a half-updated deployment (see the check at the end of app.js)
const TRAP_KEY = 'lumhsianTrap';
let _exitArmedUntil = 0;
let _trapTimer = null;

function _ensureBackTrap() {
  try {
    const st = window.history.state;
    if (st && st[TRAP_KEY] === 'app') return;
    window.history.replaceState({ [TRAP_KEY]: 'root' }, '', window.location.href);
    window.history.pushState({ [TRAP_KEY]: 'app' }, '', window.location.href);
  } catch (e) { /* non-fatal: the on-screen ← buttons still work */ }
}

function _closeTopOverlay() {
  const modals = [...document.querySelectorAll('.modal-backdrop.show')];
  if (modals.length) { modals[modals.length - 1].classList.remove('show'); return true; }
  const overlays = [...document.body.children].filter(el => {
    if (el.nodeType !== 1 || !el.style || el.style.position !== 'fixed') return false;
    if (!/inset\s*:\s*0/.test(el.getAttribute('style') || '') || el.hasAttribute('data-no-back-close')) return false;
    return (parseInt(getComputedStyle(el).zIndex, 10) || 0) >= 1000; // skips the z-index:-1 wallpaper layer
  });
  if (overlays.length) { overlays[overlays.length - 1].remove(); return true; }
  return false;
}

function _handleHardwareBack() {
  if (_closeTopOverlay()) return 'handled';
  const activeEl = document.querySelector('.screen.active');
  const cur = activeEl ? activeEl.id.replace('screen-', '') : '';
  if (cur === 'test' && window.activeTest && !window.activeTest.submitted) { requestExitTest(); return 'handled'; }
  // Every sub-view (privacy page, a subject's tests, a wrong-questions folder…) shows a ← button; use it.
  const btn = activeEl && [...activeEl.querySelectorAll('.back-btn')].find(b => b.offsetParent !== null);
  if (btn) { btn.click(); return 'handled'; }
  if (window.navStack.length > 1) { goBack(); return 'handled'; }
  return 'exit';
}

window.addEventListener('popstate', (event) => {
  const st = event.state;
  if (!st || !st[TRAP_KEY]) return;          // an entry from before the app took over — let the browser handle it
  if (st[TRAP_KEY] === 'app') return;        // (moved forward onto the app entry — nothing to do)
  // We are on the "root" entry: the user pressed Back from the app entry.
  if (_handleHardwareBack() === 'handled') {
    // showScreen() may already have put the app entry back while handling it; only add it if it is still missing,
    // otherwise every in-app Back would leave an extra history entry behind (= extra dead Back presses later).
    _ensureBackTrap();
    return;
  }
  // Nothing left to go back to inside the app (Home, or the login screen).
  if (!window.currentUser) { window.history.back(); return; }
  const now = Date.now();
  if (now < _exitArmedUntil) { _exitArmedUntil = 0; window.history.back(); return; }   // second press → really leave
  _exitArmedUntil = now + 2300;
  showToast('Press back again to exit');
  clearTimeout(_trapTimer);
  _trapTimer = setTimeout(_ensureBackTrap, 2400);   // user stayed → put the app entry back
});
