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

// Screens added after launch (Saved Tests, Support, Inbox) are created on the spot if the page's HTML doesn't have them
// yet, so a stale cached index.html can never leave a blank screen with no way back.
const _SCREEN_WRAPS = { savedtests: 'savedTestsPageWrap', support: 'supportPageWrap', inbox: 'inboxPageWrap' };
function _createScreen(id) {
  const wrapId = _SCREEN_WRAPS[id];
  const host = document.getElementById('screen-home')?.parentElement;
  if (!wrapId || !host) return null;
  const el = document.createElement('div');
  el.id = 'screen-' + id;
  el.className = 'screen';
  const wrap = document.createElement('div');
  wrap.className = 'page-wrap';
  wrap.id = wrapId;
  el.appendChild(wrap);
  host.appendChild(el);
  return el;
}

export function showScreen(id, pushToStack = true, preserveHistory = false) {
  // Only touch screens that need to change — avoids DOM thrashing
  const current = document.querySelector('.screen.active');
  const next = document.getElementById('screen-' + id) || _createScreen(id);
  if (!next) return;
  if (current && current !== next) current.classList.remove('active');
  next.classList.add('active');
  window.scrollTo(0, 0);
  if (pushToStack) {
    if (window.navStack[window.navStack.length - 1] !== id) {
      window.navStack.push(id);
      try { window.history.pushState({ screen: id }, ''); } catch (e) { /* browser history is optional */ }
    }
  } else if (!preserveHistory) {
    try {
      if (window.currentUser && !['splash', 'reconnecting', 'createaccount'].includes(id)) window.history.replaceState({ screen: id }, '');
      else window.history.replaceState(null, '');
    } catch (e) { /* browser history is optional */ }
  }
  _blankScreenGuard(id, next);
  updateBottomNav(id);
  if (typeof saveAppStateDebounced === 'function') saveAppStateDebounced();
  else if (typeof saveAppState === 'function') saveAppState();
  const showNavFor = ['home','modules','search','stats','ranking','profile','bookmarks','wrongattempts','planner','savedtests','support'];
  document.getElementById('bottomNav').classList.toggle('show', showNavFor.includes(id));
}
window.showScreen = showScreen;


export function restoreNavigationStack(savedStack, activeScreen) {
  const known = new Set([...document.querySelectorAll('.screen')].map(el => el.id.replace('screen-', '')));
  const stack = Array.isArray(savedStack) ? savedStack.filter(id => typeof id === 'string' && known.has(id)) : [];
  if (!stack.length) stack.push('home');
  if (stack[stack.length - 1] !== activeScreen) stack.push(activeScreen);
  window.navStack = stack;
  try {
    window.history.replaceState({ screen: window.navStack[0] }, '');
    window.navStack.slice(1).forEach(id => window.history.pushState({ screen: id }, ''));
  } catch (e) { /* in-app navigation still works without history support */ }
}
window.restoreNavigationStack = restoreNavigationStack;



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
  const stack = window.navStack;
  const targetIndex = stack.lastIndexOf(target);
  const historyDepth = targetIndex >= 0 ? stack.length - targetIndex - 1 : 0;
  // Defined inline (not as a top-level const) on purpose: these render
  // functions live in a later <script> block than this one, so building this
  // map at parse time (before that block has run) would throw. Evaluating it
  // lazily, only when _returnToScreen() is actually called, is safe.
  const renderers = {
    home: renderHome, modules: renderModulesScreen, profile: renderProfile, stats: renderStats, ranking: renderRanking, search: renderSearch, bookmarks: renderBookmarks, wrongattempts: renderWrongAttempts, planner: renderPlanner, savedtests: renderSavedTests,
    module: () => {
      if (window._moduleScreenMode === 'pastpapers') {
        // Return to the same Past Papers level used to launch the test.
        const last = window._lastOpenedPastPapers;
        if (last?.level === 'college') window.openPastPaperCollege?.(last.collegeKey);
        else openPastPapersRoot();
      } else if (window._lastOpenedModule) {
        const m = window._lastOpenedModule;
        openModule(m.moduleId, m.moduleName, m.iconUrl || '', m.color || '', m.fromYearId || null, m.fromYearName || null);
      }
    }
  };
  // Keep the logical stack equal to what is actually on screen. Without this, going "home" from a screen that
  // was opened from somewhere else left stale entries behind, so the next Back press appeared to do nothing.
  if (targetIndex >= 0) stack.length = targetIndex + 1;
  else stack.push(target);
  if (renderers[target]) renderers[target]();
  showScreen(target, false, historyDepth > 0);
  if (historyDepth > 0) {
    try { window.history.go(-historyDepth); } catch (e) { /* screen is already restored */ }
  }
}
window._returnToScreen = _returnToScreen;



// Called once, right when we know for certain whether someone is logging in
// or out — never during ordinary in-app navigation. Resets the logical screen stack.
export function _resetNavigationRoot() {
  // History is no longer tied screen-by-screen to the logical stack (see "BACK BUTTON" at the bottom of this
  // file), so a login/logout only needs the logical stack emptied.
  window.navStack = [];
  try { window.history.replaceState(null, ''); } catch (e) { /* browser history is optional */ }
}
window._resetNavigationRoot = _resetNavigationRoot;



// Back from the current screen. Each case below used to leave the stack and the screen out of step, which is why
// the Back button seemed dead on Results / after Review.
export function goBack(destination) {
  const stack = window.navStack;
  const activeEl = document.querySelector('.screen.active');
  const cur = activeEl ? activeEl.id.replace('screen-', '') : stack[stack.length - 1];

  if (destination && stack.includes(destination)) { _returnToScreen(destination); return; }
  if (_backWithinScreen(cur)) return;
  // A live test: Back = the same as the Pause / Exit button (never silently abandon it)
  if (cur === 'test' && window.activeTest && !window.activeTest.submitted) { requestExitTest(true); return; }
  // Results: Back = Done (return to wherever the test was started from)
  if (cur === 'results') { leaveFinishedTest(); return; }
  // Review (or Quick View): step back to Results / Search while keeping Results on the stack
  if (cur === 'review') {
    if (window._qvState && typeof window.closeQuickView === 'function') { window.closeQuickView(); return; }
  }
  if (stack.length > 1) {
    if (window.history.state?.screen === cur) window.history.back();
    else _returnToScreen(stack[stack.length - 2]);
    return;
  }
  if (cur === 'admin') { renderHome(); showScreen('home'); }
  // At the root, allow the browser/phone to leave normally; never add a trap entry.
}
window.goBack = goBack;


function _backWithinScreen(cur) {
  if (cur === 'module' && window._moduleScreenMode === 'pastpapers' && window._lastOpenedPastPapers?.level === 'college') {
    window.renderPastPapersCollegeList?.();
    return true;
  }
  if (cur === 'module' && window._moduleSubView) {
    window._moduleSubView = null;
    window.backToModule?.();
    return true;
  }
  if ((cur === 'bookmarks' || cur === 'wrongattempts') && window._qp) {
    const { kind } = window._qp;
    const path = window._qf?.[kind]?.path || '';
    window._qp = null;
    window.qfOpen?.(kind, path);
    return true;
  }
  const folderKind = cur === 'bookmarks' ? 'bm' : cur === 'wrongattempts' ? 'wrong' : null;
  const folder = folderKind && window._qf?.[folderKind];
  if (folder?.path) {
    folder.path = folder.path.split('/').slice(0, -1).join('/');
    window.qfOpen?.(folderKind, folder.path);
    return true;
  }
  if (cur === 'profile' && window._profileSubPage) {
    window.renderProfile?.();
    return true;
  }
  return false;
}



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
// Each screen route has a matching browser-history entry, so physical and visible Back share one route stack.
window.__lumNavReady = true;   // lets app.js detect a half-updated deployment (see the check at the end of app.js)

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

window.addEventListener('popstate', (event) => {
  const activeEl = document.querySelector('.screen.active');
  const cur = activeEl ? activeEl.id.replace('screen-', '') : '';
  if (_closeTopOverlay()) {
    if (cur && window.currentUser) window.history.pushState({ screen: cur }, '');
    return;
  }
  if (!window.currentUser) return;
  if (cur === 'test' && window.activeTest && !window.activeTest.submitted) {
    window.history.pushState({ screen: cur }, '');
    requestExitTest(true);
    return;
  }
  if (cur === 'review' && window._qvState) window._qvState = null;
  if (cur === 'results') window.activeTest = null;
  if (_backWithinScreen(cur)) {
    window.history.pushState({ screen: cur }, '');
    return;
  }
  const target = event.state?.screen;
  if (!target || target === cur) return;
  if (window._isAdminPreview && target === 'admin') {
    window.exitAdminPreview?.();
    const adminIndex = window.navStack.lastIndexOf('admin');
    if (adminIndex >= 0) window.navStack.length = adminIndex + 1;
    showScreen('admin', false);
    return;
  }
  const targetIndex = window.navStack.lastIndexOf(target);
  if (targetIndex < 0) return;
  window.navStack.length = targetIndex + 1;
  showScreen(target, false);
});
