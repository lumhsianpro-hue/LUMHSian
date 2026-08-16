import { getRankInfo, getUserStats, isFeatureEnabled, renderHome, renderModulesScreen, renderSearch, saveAppState, saveAppStateDebounced } from './app.js';
import { renderRanking } from './leaderboard.js';
import { renderBookmarks, renderPlanner, renderProfile, renderStats, renderWrongAttempts } from './profile.js';
import { requestExitTest } from './quiz.js';
import { showToast } from './utils.js';



// ==================== SCREEN ROUTING ====================
export function showScreen(id, pushToStack = true) {
  // Only touch screens that need to change — avoids DOM thrashing
  const current = document.querySelector('.screen.active');
  const next = document.getElementById('screen-' + id);
  if (!next) return;
  if (current && current !== next) current.classList.remove('active');
  next.classList.add('active');
  window.scrollTo(0, 0);
  if (pushToStack) {
    if (window.navStack[window.navStack.length - 1] !== id) {
      window.navStack.push(id);
      // Keep the browser's REAL history in sync with our own logical stack —
      // tagged with lumhsianScreen so the popstate handler below can tell
      // "a real step back through screens we pushed" apart from "stepped
      // past all of them, into whatever page history existed before this
      // app instance" (e.g. the pre-login splash, or a leftover step from
      // the Google OAuth redirect hop). Without this, the two stacks drift
      // apart and the browser's own back button can resurface that old,
      // stale state — see _resetNavigationRoot() in auth.js for the other
      // half of this fix.
      try { window.history.pushState({ lumhsianScreen: id, depth: window.navStack.length }, '', window.location.href); }
      catch (e) { /* non-fatal: in-app navigation via navStack still works even if this throws */ }
    }
    if (window.navStack.length > 30) window.navStack.shift();
  }
  updateBottomNav(id);
  if (typeof saveAppStateDebounced === 'function') saveAppStateDebounced();
  else if (typeof saveAppState === 'function') saveAppState();
  const showNavFor = ['home','modules','search','stats','ranking','profile','bookmarks','wrongattempts','planner'];
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
  const renderers = { home: renderHome, modules: renderModulesScreen, profile: renderProfile, stats: renderStats, ranking: renderRanking, search: renderSearch, bookmarks: renderBookmarks, wrongattempts: renderWrongAttempts, planner: renderPlanner };
  if (renderers[target]) renderers[target]();
  showScreen(target, false);
}
window._returnToScreen = _returnToScreen;



// Called once, right when we know for certain whether someone is logging in
// or out — never during ordinary in-app navigation. Clears the logical
// stack and REPLACES (not pushes) the current history entry, so whatever
// was there before (the splash screen's earlier load, a step left over from
// the Google OAuth redirect hop, or — on logout — the just-ended
// authenticated session's screens) is no longer reachable by pressing back.
export function _resetNavigationRoot() {
  window.navStack = [];
  try { window.history.replaceState(null, '', window.location.href); }
  catch (e) { /* non-fatal — worst case one stale entry remains reachable via back */ }
}
window._resetNavigationRoot = _resetNavigationRoot;



export function goBack() {
  if (window.navStack.length > 1) {
    window.navStack.pop();
    const prev = window.navStack[window.navStack.length - 1];
    if (prev === 'test') { requestExitTest(); return; }
    _returnToScreen(prev);
  }
  // At the root (navStack.length <= 1): deliberately do nothing further.
  // This used to re-render Home (or the splash/login screen) here, which
  // masked the real bug — every popstate ever routed through this function
  // got "handled" in-app, so the browser's own natural back-navigation
  // (which, now that history is kept in sync — see showScreen() and
  // _resetNavigationRoot() — correctly has nothing left behind Home) never
  // got a chance to actually happen. Leaving this empty lets that real exit
  // happen instead of bouncing back to a stale pre-login screen.
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
    bookmarks: renderBookmarks, wrongattempts: renderWrongAttempts, planner: renderPlanner
  };
  if (renders[id]) renders[id]();
  showScreen(id);
}
window.navGo = navGo;



// Handle back button (Android)
window.addEventListener('popstate', (event) => {
  if (!event.state || !event.state.lumhsianScreen) return;
  goBack();
});
