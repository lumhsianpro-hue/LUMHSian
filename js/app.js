import { adminContentTab, adminShowTab, applyWallpaper, renderAdminPanel, timeAgo } from './admin.js';
import { handleAuthedSession } from './auth.js';
import { goBack, restoreNavigationStack, showScreen } from './navigation.js';
import { applyDarkMode, renderBookmarks, renderPlanner, renderProfile, renderStats, renderWrongAttempts } from './profile.js';
import { checkExpiredAttemptOnRender, clearPersistedTest, getResumableSnapshot, persistActiveTest, renderQuickView, renderResults, renderReview, startCustomTest } from './quiz.js';
import { _hasStoredSupabaseSession, _showReconnecting, db, getSessionWithRetry, sb } from './supabase.js';
import { ICON_BELL, ICON_BOOK, ICON_BOOKMARK, ICON_BUILDING, ICON_CALENDAR, ICON_EDIT, ICON_FIRE, ICON_LOCK, ICON_ROBOT, ICON_STETHOSCOPE, ICON_TARGET, ICON_X_CIRCLE, _debounce, attemptBadgeHtml, attemptLineHtml, cacheGet, cacheSet, esc, escJs, showConfirm, showLoading, showToast, skeletonList } from './utils.js';



// Bump this string on every deploy where you want every logged-in user to be
// forced back to the login screen once (e.g. after a meaningful update).
// They do NOT need to sign up again — their account stays, this only clears
// the saved auto-login session so they re-enter their password once.
export const APP_VERSION = '2026-10-10.1';


const PENDING_STATS_KEY = 'lum_pending_stats_v1';


function _pendingStats() {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_STATS_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch (e) { return []; }
}


function _queuePendingStats(email, stats) {
  const entry = { email, stats, queuedAt: Date.now() };
  try {
    const pending = _pendingStats().filter(item => item.email !== email);
    pending.push(entry);
    localStorage.setItem(PENDING_STATS_KEY, JSON.stringify(pending));
  } catch (e) {
    console.error('Could not save pending test results locally', e);
    showToast('Could not save your result on this device. Free storage and try again.', 6000);
  }
  return entry;
}


function _clearPendingStats(entry) {
  try {
    const pending = _pendingStats().filter(item => item.email !== entry.email || item.queuedAt !== entry.queuedAt);
    if (pending.length) localStorage.setItem(PENDING_STATS_KEY, JSON.stringify(pending));
    else localStorage.removeItem(PENDING_STATS_KEY);
  } catch (e) { console.warn('Could not clear synced result queue', e); }
}


let _flushingPendingStats = false;


export async function flushPendingStats() {
  if (_flushingPendingStats || !navigator.onLine || !window.currentUser?.email) return;
  const entry = _pendingStats().find(item => item.email === window.currentUser.email);
  if (!entry?.stats) return;
  _flushingPendingStats = true;
  try { await saveUserStats(entry.stats); }
  finally { _flushingPendingStats = false; }
}
window.flushPendingStats = flushPendingStats;


window.addEventListener('online', flushPendingStats);


function _updateOfflineBanner() {
  const banner = document.getElementById('offlineBanner');
  if (banner) banner.hidden = navigator.onLine;
}
window.addEventListener('online', _updateOfflineBanner);
window.addEventListener('offline', _updateOfflineBanner);
_updateOfflineBanner();



// ==================== CLIENT ERROR LOGGING ====================
// Sends uncaught JS errors and unhandled promise rejections straight from
// students' devices into the error_logs table (see error_logs_setup.sql),
// so problems can be caught and fixed before a student even has to notice
// something's wrong and go report it. Capped at 20 + de-duplicated per page
// load so a broken loop can never flood the database with the same error.
let _errorLogCount = 0;


const _loggedErrorSignatures = new Set();


async function logClientError(message, stack, source) {
  try {
    if (!navigator.onLine || _errorLogCount >= 5) return;
    const sig = String(message || '').slice(0, 150);
    if (_loggedErrorSignatures.has(sig)) return;
    const userKey = window.currentUser?.auth_uid || window.currentUser?.email || 'anonymous';
    const storageKey = `lum_error_log_${encodeURIComponent(userKey)}_${encodeURIComponent(sig)}`;
    const lastLogged = Number(localStorage.getItem(storageKey) || 0);
    if (Date.now() - lastLogged < 10 * 60 * 1000) return;
    const sessionKey = `lum_error_log_count_${encodeURIComponent(userKey)}`;
    const sessionCount = Number(sessionStorage.getItem(sessionKey) || 0);
    if (sessionCount >= 5) return;
    _loggedErrorSignatures.add(sig);
    _errorLogCount++;
    localStorage.setItem(storageKey, String(Date.now()));
    sessionStorage.setItem(sessionKey, String(sessionCount + 1));
    await sb.from('error_logs').insert({
      message: String(message || 'Unknown error').slice(0, 2000),
      stack: stack ? String(stack).slice(0, 4000) : null,
      source,
      screen: (typeof window.navStack !== 'undefined' && window.navStack.length) ? window.navStack[window.navStack.length - 1] : null,
      user_email: (typeof window.currentUser !== 'undefined' && window.currentUser?.email) || null,
      app_version: APP_VERSION,
      user_agent: navigator.userAgent
    });
  } catch (e) { /* logging must never itself crash the app */ }
}


window.addEventListener('error', (e) => {
  logClientError(e.message, e.error?.stack, 'window.onerror');
});


window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  logClientError(r?.message || String(r), r?.stack, 'unhandledrejection');
});



// ==================== STATE ====================
window.currentUser = null;


window.selectedYear = null;


// True only while an admin is inside "View as Student" (Preview) mode — lets
// year-gated content (openModule/openModuleTestGroup/openSubjectTestGroup)
// unlock Attempt/Review for every year, not just whichever one is currently
// selected. Never true for a real student. Set/cleared only by
// adminViewAsStudent()/exitAdminPreview() in admin.js.
window._isAdminPreview = false;


window.activeTest = null;


window.navStack = [];


window.maintenanceMode = false;


let announcementText = '';


window.aiConversation = [];


window.currentAIContext = null;





// ==================== YEAR SELECTION ====================
export async function loadYearScreen() {
  const wrap = document.getElementById('yearPageWrap');
  wrap.innerHTML = `<button class="back-btn mb-3" onclick="goBack()">← Back</button>${skeletonList(4)}`;
  showLoading(true, 'Loading years...');
  try {
  const { data: years, error } = await db(sb.from('years').select('*').order('display_order'), 'Failed to load years');
    if (error) {
      wrap.innerHTML = `<button class="back-btn mb-3" onclick="goBack()">← Back</button><div class="card">Could not load years. Please try again.</div><button class="btn btn-primary mt-3" onclick="loadYearScreen()">Retry</button>`;
      showScreen('year');
      return;
    }
    if (!years?.length) { wrap.innerHTML = `<button class="back-btn" onclick="goBack()">← Back</button><div class="card"><p>No years configured yet. Contact admin.</p></div>`; showScreen('year'); return; }
  let html = `<div class="card-teal" style="margin-bottom:20px"><h2>Select Your Year</h2><p>MBBS Program</p></div>`;
    html = `<button class="back-btn mb-3" onclick="goBack()">← Back</button>` + html;
  for (const y of years) {
    const active = y.is_active;
    html += `<div class="module-card ${!active ? 'locked' : ''}" onclick="${active ? `selectYear(${y.id},'${y.name.replace(/'/g,"\\'")}')` : `showToast('${String(y.coming_soon_text || 'Coming soon').replace(/'/g, "\\'").replace(/"/g, '&quot;')}') `}">
      <div class="list-item-icon">${active ? '📘' : '🔒'}</div>
      <div class="module-info">
        <div class="module-title">${y.name}</div>
        <div class="module-sub">${active ? 'Tap to enter' : (y.coming_soon_text || 'Coming soon')}</div>
      </div>
      <span style="font-size:20px">${active ? '→' : '⏳'}</span>
    </div>`;
  }
  wrap.innerHTML = html;
  showScreen('year');
  } catch(e) {
    console.error('loadYearScreen error:', e);
    wrap.innerHTML = `<button class="back-btn mb-3" onclick="goBack()">← Back</button><div class="card">Could not load years. Please try again.</div><button class="btn btn-primary mt-3" onclick="loadYearScreen()">Retry</button>`;
    showScreen('year');
  } finally {
    showLoading(false);
  }
}



async function selectYear(id, name) {
  const isChange = !!window.selectedYear && window.selectedYear.id !== id;
  const oldYearName = window.selectedYear?.name;
  window.selectedYear = { id, name };
  localStorage.setItem('lum_year', JSON.stringify(window.selectedYear));
  if (window.currentUser) {
    window.currentUser = { ...window.currentUser, year_of_study: name };
    // Persisted even during admin preview — on purpose. Skipping this write
    // used to mean any refresh while previewing silently reverted back to
    // whatever year was last stored in the DB, which looked exactly like
    // "changing the year doesn't work." The (harmless) tradeoff is that the
    // admin's own account's year_of_study reflects whichever year they last
    // previewed as.
    db(sb.from('users').update({ year_of_study: name }).eq('email', window.currentUser.email), 'Year update failed');
  }

  // A genuine year change (not just picking a year for the very first time)
  // resets this student's visible progress to zero — matching the warning
  // shown in changeYear() below ("you'll start over like a new student").
  // The old numbers are archived first rather than dropped outright, as a
  // safety net (support requests, or switching back later) — written in a
  // SEPARATE call from the zero-reset itself, and allowed to fail quietly if
  // the archived_years column hasn't been migrated in yet (see the note near
  // the schema block further down this file), so a missing column there can
  // never block the actual reset the student is waiting on.
  if (isChange && window.currentUser) {
    showLoading(true, 'Setting up your new year...');
    try {
      const stats = await getUserStats(true);
      db(sb.from('user_stats').update({
        archived_years: { ...(stats.archived_years || {}), [oldYearName || 'previous']: {
          archived_at: new Date().toISOString(), total_tests: stats.total_tests, total_questions: stats.total_questions,
          total_correct: stats.total_correct, best_score: stats.best_score, streak: stats.streak, history: stats.history,
          subject_stats: stats.subject_stats, paper_stats: stats.paper_stats, test_stats: stats.test_stats,
          completed_attempt_tests: stats.completed_attempt_tests
        } }
      }).eq('email', window.currentUser.email)).then(({ error }) => {
        if (error) console.warn('archived_years not saved — run the migration in Supabase SQL Editor (see SQL reference section). The reset itself still went through.', error);
      });
      await saveUserStats({
        total_tests: 0, total_questions: 0, total_correct: 0, best_score: 0,
        streak: 0, last_practice_date: null, history: [],
        subject_stats: {}, paper_stats: {}, test_stats: {}, completed_attempt_tests: 0
      });
      // A test paused under the OLD year no longer makes sense once switching
      // years — clear it so it can't be silently resumed into a module that
      // isn't "this year" for the student anymore.
      clearPersistedTest();
    } finally {
      showLoading(false);
    }
  }

  // Invalidate stats cache so home shows fresh data
  window._lastStatsFetchedAt = 0;
  renderHome();
  showScreen('home');
  if (isChange) showToast(`✅ Year changed to ${name} — starting fresh`);
}
window.selectYear = selectYear;



// Lets a logged-in student switch to a different year at any time
// (e.g. Profile → Change Year, or tapping the year badge on Home).
function changeYear() {
  const current = window.currentUser?.year_of_study;
  if (current) {
    showConfirm(`You're currently set to <strong>${current}</strong>. Switching years locks you out of ${current}'s modules and practice tests entirely, and resets your stats to zero — you'll effectively start fresh in the new year, like a brand new student. This can't be easily undone. Continue?`, () => loadYearScreen(), 'Change Year', true);
  } else {
    loadYearScreen();
  }
}
window.changeYear = changeYear;

// ==================== HOME / DASHBOARD ====================
// Shared module-card HTML builder — used by both the Home teaser and the
// dedicated Modules tab so they always render identically.
function buildModuleCardHtml(m, subjectCount, mAcc, yearId, yearName) {
  const safeYearName = escJs(yearName||'');
  // A module the student hasn't started yet shows how many subjects it has
  // instead of a bare "Not started" with no other information on the card.
  const subLine = mAcc !== null && mAcc !== undefined
    ? `${mAcc}% accuracy`
    : `${subjectCount} subject${subjectCount === 1 ? '' : 's'}`;
  return `
    <div class="module-card" onclick="openModule(${m.id},'${escJs(m.name)}','${escJs(m.icon_url||'')}','${escJs(m.color||'')}',${yearId||'null'},'${safeYearName}')">
      <img class="module-thumb" src="${esc(m.icon_url) || 'https://placehold.co/96x96/fdf3c0/c9980a?text=📚'}" onerror="this.src='https://placehold.co/96x96/fdf3c0/c9980a?text=📚'">
      <div class="module-info">
        <div class="module-title">${esc(m.name)}</div>
        <div class="module-sub">${subLine}</div>
        ${mAcc !== null && mAcc !== undefined ? `<div class="progress-track" style="margin-top:6px;height:4px"><div class="progress-fill" style="width:${mAcc}%"></div></div>` : ''}
      </div>
      <span style="color:var(--ink-4);font-size:18px">›</span>
    </div>`;
}



// Pinned card at the top of the Modules tab, styled like a module-card but
// gold-tinted so it reads as distinct from the actual modules below it.
// Opens the global Past Papers hierarchy (College → Year → Papers) — see
// openPastPapersRoot() further down.
function buildPastPapersCardHtml() {
  return `
    <div class="module-card" onclick="openPastPapersRoot()">
      <div class="module-thumb" style="display:flex;align-items:center;justify-content:center;background:var(--gold-500);color:#fff;font-size:32px">📜</div>
      <div class="module-info">
        <div class="module-title">Past Papers</div>
        <div class="module-sub">Solve real exam papers from any college</div>
      </div>
      <span style="color:var(--ink-4);font-size:18px">›</span>
    </div>`;
}



// Fetches question counts for many rows in ONE request instead of one
// .count() request per row — reused below for modules, past papers, and
// practice tests, all of which used to fire one count query per item every
// time their list rendered.
const CONTENT_COUNTS_CACHE_KEY = 'content_counts_2026_10_10';
const CONTENT_COUNTS_TTL = 30 * 60 * 1000;
let _contentCounts = null;
let _contentCountsPromise = null;
let _contentCountsUnavailable = false;
let _contentCountsFetchedAt = 0;

function _refreshContentCounts() {
  if (_contentCountsPromise) return _contentCountsPromise;
  _contentCountsPromise = (async () => {
    try {
      const { data, error } = await sb.rpc('get_content_counts');
      if (error || !Array.isArray(data)) { _contentCountsUnavailable = true; return null; }
      const grouped = {};
      for (const row of data) {
        if (!row || row.content_id === null || row.content_id === undefined) continue;
        (grouped[row.kind] ||= {})[row.content_id] = Number(row.total_count) || 0;
      }
      cacheSet(CONTENT_COUNTS_CACHE_KEY, grouped);
      _contentCounts = grouped;
      _contentCountsFetchedAt = Date.now();
      return grouped;
    } catch (e) {
      _contentCountsUnavailable = true;
      return null;
    } finally {
      _contentCountsPromise = null;
    }
  })();
  return _contentCountsPromise;
}

async function _loadContentCounts() {
  if (_contentCounts && Date.now() - _contentCountsFetchedAt < CONTENT_COUNTS_TTL) return _contentCounts;
  if (_contentCountsUnavailable) return _contentCounts;
  const cached = cacheGet(CONTENT_COUNTS_CACHE_KEY, CONTENT_COUNTS_TTL);
  if (cached !== null) {
    _contentCounts = cached;
    _contentCountsFetchedAt = Date.now();
    return cached;
  }
  if (_contentCounts) {
    _refreshContentCounts();
    return _contentCounts;
  }
  const stale = cacheGet(CONTENT_COUNTS_CACHE_KEY, CONTENT_COUNTS_TTL, true);
  if (stale !== null) {
    _contentCounts = stale;
    _contentCountsFetchedAt = Date.now();
    _refreshContentCounts();
    return stale;
  }
  return _refreshContentCounts();
}

export async function getQuestionCountsBy(column, ids) {
  const counts = {};
  for (const id of ids) counts[id] = 0;
  if (!ids.length) return counts;
  const kinds = { paper_id: 'questions_paper', practice_test_id: 'questions_test', module_id: 'questions_module', subject_id: 'questions_subject' };
  const rpcCounts = kinds[column] ? await _loadContentCounts() : null;
  if (rpcCounts) {
    const grouped = rpcCounts[kinds[column]] || {};
    ids.forEach(id => { counts[id] = grouped[id] || 0; });
    return counts;
  }
  const cacheKey = `content_counts_fallback_${column}_${ids.slice().sort().join('_')}`;
  const cached = cacheGet(cacheKey, CONTENT_COUNTS_TTL);
  if (cached !== null) return { ...counts, ...cached };
  // One exact-count-only request per id, in parallel. head:true means Postgres
  // computes just the count and returns zero rows — this is what makes it safe
  // from PostgREST's default 1000-row response cap, unlike a single combined
  // .in(...) select that fetches every matching row and counts them client-side
  // (which silently truncates, under-reporting — sometimes all the way to 0 —
  // for whichever ids' rows don't make it into that first 1000 once the table
  // has grown large enough).
  const results = await Promise.all(ids.map(id =>
    sb.from('questions').select('id', { count: 'exact', head: true }).eq(column, id)
  ));
  ids.forEach((id, i) => { counts[id] = results[i]?.count || 0; });
  cacheSet(cacheKey, counts);
  return counts;
}


// Powers the "X subjects" line shown on a not-yet-started module's card, in
// place of a bare "Not started" with no other information on it.
// Same pattern as getQuestionCountsBy above, but against practice_tests
// grouped by subject — powers the "X tests" line shown on a not-yet-started
// subject's row, in place of a bare "Not started".
async function getTestCountsBySubject(subjectIds) {
  const counts = {};
  for (const id of subjectIds) counts[id] = 0;
  if (!subjectIds.length) return counts;
  const rpcCounts = await _loadContentCounts();
  if (rpcCounts) {
    const grouped = rpcCounts.active_tests_subject || {};
    subjectIds.forEach(id => { counts[id] = grouped[id] || 0; });
    return counts;
  }
  const cacheKey = `active_test_counts_subject_${subjectIds.slice().sort().join('_')}`;
  const cached = cacheGet(cacheKey, CONTENT_COUNTS_TTL);
  if (cached !== null) return { ...counts, ...cached };
  const results = await Promise.all(subjectIds.map(id =>
    sb.from('practice_tests').select('id', { count: 'exact', head: true }).eq('subject_id', id).eq('is_active', true)
  ));
  subjectIds.forEach((id, i) => { counts[id] = results[i]?.count || 0; });
  cacheSet(cacheKey, counts);
  return counts;
}



async function getSubjectCountsForModules(moduleIds) {
  const counts = {};
  for (const id of moduleIds) counts[id] = 0;
  if (!moduleIds.length) return counts;
  const rpcCounts = await _loadContentCounts();
  if (rpcCounts) {
    const grouped = rpcCounts.subjects_module || {};
    moduleIds.forEach(id => { counts[id] = grouped[id] || 0; });
    return counts;
  }
  const cacheKey = `subject_counts_module_${moduleIds.slice().sort().join('_')}`;
  const cached = cacheGet(cacheKey, CONTENT_COUNTS_TTL);
  if (cached !== null) return { ...counts, ...cached };
  const results = await Promise.all(moduleIds.map(id =>
    sb.from('subjects').select('id', { count: 'exact', head: true }).eq('module_id', id)
  ));
  moduleIds.forEach((id, i) => { counts[id] = results[i]?.count || 0; });
  cacheSet(cacheKey, counts);
  return counts;
}



// Return cached content immediately; expired entries render first while a
// quiet refresh updates the cache for the next screen visit.
function _cachedQuery(key, ttl, makeQuery, errorText) {
  const fresh = cacheGet(key, ttl);
    if (fresh !== null) return Promise.resolve({ data: fresh });
  const stale = cacheGet(key, ttl, true);
  if (stale !== null) {
    db(makeQuery(), errorText).then(result => { if (result.data !== null) cacheSet(key, result.data); });
    return Promise.resolve({ data: stale });
  }
  return db(makeQuery(), errorText).then(result => {
    if (result.data !== null) cacheSet(key, result.data);
    return result;
  });
}

function _fetchYearsCached() {
  return _cachedQuery('years', CONTENT_COUNTS_TTL, () =>
    sb.from('years').select('id,name,is_active,display_order,coming_soon_text').order('display_order'), 'Years error');
}


// A notification/announcement lives until its own expires_at (chosen by the admin when sending). Rows without one
// (sent before that option existed) keep the original 48 hours.
function _notifAlive(n) {
  const end = n.expires_at ? new Date(n.expires_at).getTime() : new Date(n.created_at).getTime() + 48 * 3600 * 1000;
  return end > Date.now();
}

// ==================== DEDICATED MODULES TAB ====================
export async function renderModulesScreen() {
  const wrap = document.getElementById('modulesPageWrap');
  wrap.innerHTML = `
    <div class="skel-card"><div class="skeleton" style="height:24px;width:60%;margin-bottom:8px"></div><div class="skeleton" style="height:14px;width:80%"></div></div>
    ${[1,2,3].map(()=>`<div class="skel-card" style="display:flex;gap:12px;align-items:center"><div class="skeleton" style="width:52px;height:52px;border-radius:12px;flex-shrink:0"></div><div style="flex:1"><div class="skeleton" style="height:16px;margin-bottom:6px;width:60%"></div><div class="skeleton" style="height:12px;width:40%"></div></div></div>`).join('')}`;
  showLoading(false);
  try {
    const myYearName = window.currentUser?.year_of_study || null;
    const [{ data: years }, stats] = await Promise.all([
      _fetchYearsCached(),
      getUserStats()
    ]);

    // Load own year's modules fully — others are collapsible (lazy-loaded)
    const myYear = (years||[]).find(y => y.name === myYearName);
    // Cache selectedYear so other functions fast-path
    if (myYear && (!window.selectedYear || window.selectedYear.id !== myYear.id)) {
      window.selectedYear = { id: myYear.id, name: myYear.name };
      localStorage.setItem('lum_year', JSON.stringify(window.selectedYear));
    }
    let myYearHtml = '';
    if (myYear && myYear.is_active) {
      const [{ data: yearModules }] = await Promise.all([
        _cachedQuery(`year_modules_${myYear.id}`, CONTENT_COUNTS_TTL, () => sb.from('year_modules').select('module_id,display_order').eq('year_id', myYear.id).order('display_order'), 'Modules error')
      ]);
      const moduleIds = (yearModules||[]).map(ym => ym.module_id);
      if (moduleIds.length) {
        const [{ data: modules }, ...counts] = await Promise.all([
          _cachedQuery(`modules_${moduleIds.slice().sort().join('_')}`, CONTENT_COUNTS_TTL, () => sb.from('modules').select('id,name,icon_url,color').in('id', moduleIds), 'Modules error'),
          // We don't know module ids yet, fetch after
        ]);
        const ordered = (yearModules||[]).map(ym => modules?.find(m => m.id===ym.module_id)).filter(Boolean);
        const qCounts = await getSubjectCountsForModules(ordered.map(m => m.id));
        ordered.forEach((m,i) => {
          const mSt = stats.subject_stats?.[m.id] || {};
          const mAcc = mSt.total ? Math.round((mSt.correct/mSt.total)*100) : null;
          myYearHtml += buildModuleCardHtml(m, qCounts[m.id]||0, mAcc, myYear.id, myYear.name);
        });
      } else {
        myYearHtml = `<div class="card"><p>No modules for ${myYearName} yet.</p></div>`;
      }
    } else {
      myYearHtml = `<div class="card"><p>${myYearName ? `${myYearName} is not yet active.` : 'Set your year in Profile to see your modules.'}</p></div>`;
    }

    wrap.innerHTML = `
      <div class="flex-between" style="margin-bottom:4px">
        <h2 style="margin:0">📚 Modules</h2>
        <span class="text-xs text-muted" onclick="changeYear()" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted">${myYearName||'Set Year'} ✏️</span>
      </div>
      <p class="text-sm text-muted" style="margin-bottom:16px">Solve real previous exam papers below, or practice subject-by-subject with your year's modules.</p>
      <div class="list-item" style="margin-bottom:18px" onclick="openCustomTestBuilder()">
        <div class="list-item-left">
          <div class="list-item-icon" style="background:var(--gold-50);color:var(--gold-600);font-size:20px">🛠️</div>
          <div><div class="list-item-title">Build Your Own Test</div><div class="list-item-sub">Pick subjects, difficulty & question count</div></div>
        </div>
        <span style="color:var(--ink-4)">›</span>
      </div>
      <div class="section-label">${myYearName || 'My Modules'}</div>
      ${buildPastPapersCardHtml()}
      ${myYearHtml}
      <div style="height:16px"></div>`;
  } catch(e) {
    console.error('renderModulesScreen error:', e);
    wrap.innerHTML = `<div class="card"><p>Failed to load. <button class="btn btn-primary btn-sm mt-2" onclick="renderModulesScreen()">Retry</button></p></div>`;
  } finally {
    showLoading(false);
  }
}
window.renderModulesScreen = renderModulesScreen;



// Counts each home-header stat up from 0 to its real value on render — a
// small, deliberate motion moment (not decoration) since these numbers ARE
// the point of the header. Skips straight to the final value when the OS/
// browser has "reduce motion" on.
function _animateHeaderStats() {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('.lumhsian-stat-num[data-count]').forEach(el => {
    const target = parseInt(el.dataset.count) || 0;
    const suffix = el.dataset.suffix || '';
    if (reduced) { el.textContent = target + suffix; return; }
    const duration = 700, start = performance.now();
    function tick(now) {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased) + suffix;
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}
window._animateHeaderStats = _animateHeaderStats;



export async function renderHome() {
  checkExpiredAttemptOnRender();
  const wrap = document.getElementById('homePageWrap');
  wrap.innerHTML = `
    <div class="skel-card"><div class="skeleton" style="height:140px;margin-bottom:0"></div></div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">
      ${[1,2,3,4].map(()=>'<div class="skeleton" style="height:64px;border-radius:12px"></div>').join('')}
    </div>
    <div class="skel-card"><div class="skeleton" style="height:20px;margin-bottom:8px;width:40%"></div><div class="skeleton" style="height:80px"></div></div>
    <div class="skel-card"><div class="skeleton" style="height:80px"></div></div>`;
  showLoading(false);
  try {

  const myYearName = window.currentUser?.year_of_study || null;
  const [{ data: years }, stats] = await Promise.all([
    _fetchYearsCached(),
    getUserStats()
  ]);
  const cachedAnnouncements = cacheGet('announcements', CONTENT_COUNTS_TTL) || [];
  // Bug fix: target_college was saved when an announcement was created but
  // never actually checked here, so every "targeted" announcement was shown
  // to all students regardless of college. Filter it the same way the
  // notification bell already does, then keep the latest 3.
  const myYearForFilter = await _getMyYear();
  const announcements = cachedAnnouncements.filter(a =>
    (!a.target_college || a.target_college === window.currentUser.college) &&
    (!a.target_year_id || a.target_year_id === myYearForFilter?.id)
  ).slice(0, 3);

  // My year modules teaser (top 3) — parallel fetch
  const myYear = (years || []).find(y => y.name === myYearName);
  let myYearModuleHtml = '';
  if (myYear) {
    // Cache selectedYear so _getMyYear() fast-paths henceforth
    if (!window.selectedYear || window.selectedYear.id !== myYear.id) {
      window.selectedYear = { id: myYear.id, name: myYear.name };
      localStorage.setItem('lum_year', JSON.stringify(window.selectedYear));
    }
    const { data: yearModules } = await _cachedQuery(`year_modules_${myYear.id}`, CONTENT_COUNTS_TTL, () => sb.from('year_modules').select('module_id,display_order').eq('year_id', myYear.id).order('display_order'), 'Modules error');
    const moduleIds = (yearModules || []).map(ym => ym.module_id);
    if (moduleIds.length) {
      const { data: modules } = await _cachedQuery(`modules_${moduleIds.slice().sort().join('_')}`, CONTENT_COUNTS_TTL, () => sb.from('modules').select('id,name,icon_url,color').in('id', moduleIds), 'Modules error');
      const ordered = (yearModules || []).map(ym => modules?.find(m => m.id === ym.module_id)).filter(Boolean).slice(0, 3);
      const counts = await getSubjectCountsForModules(ordered.map(m => m.id));
      ordered.forEach((m,i) => {
        const mSt = stats.subject_stats?.[m.id] || {};
        const mAcc = mSt.total ? Math.round((mSt.correct/mSt.total)*100) : null;
        myYearModuleHtml += buildModuleCardHtml(m, counts[m.id]||0, mAcc, myYear.id, myYear.name);
      });
    }
  }
  if (!myYearModuleHtml) myYearModuleHtml = `<div class="card"><p>${myYearName ? `No modules for ${myYearName} yet.` : 'Set your year in Profile to see your modules here.'}</p></div>`;

  const acc = stats.total_questions ? Math.round((stats.total_correct/stats.total_questions)*100) : 0;
  const greeting = (() => { const h=new Date().getHours(); if(h<12) return '🌅 Good morning'; if(h<17) return '☀️ Good afternoon'; return '🌙 Good evening'; })();
  const avatarEmoji = window.currentUser.gender==='female' ? '👩‍⚕️' : '👨‍⚕️';
  const announceHtml = announcements.map(a=>`<div class="announce-bar">${a.image_url ? `<img src="${esc(a.image_url)}" style="width:28px;height:28px;border-radius:6px;object-fit:cover;flex-shrink:0">` : `<span style="font-size:16px">${esc(a.emoji)||'📢'}</span>`}<span><strong>${esc(a.title)||''}</strong>${a.title&&a.body?' · ':''}${esc(a.body)||''}</span></div>`).join('');

  wrap.innerHTML = `
    <style>
      @keyframes lumhsianPulseSweep { 0% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -300; } }
      .lumhsian-pulse-line { animation: lumhsianPulseSweep 3.5s linear infinite; }
      @keyframes lumhsianStatPop { 0% { transform: scale(.85); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
      .lumhsian-stat-num { display: inline-block; animation: lumhsianStatPop .45s cubic-bezier(.34,1.56,.64,1) backwards; }
      @media (prefers-reduced-motion: reduce) {
        .lumhsian-pulse-line, .lumhsian-stat-num { animation: none !important; }
      }
    </style>
    <div style="background:linear-gradient(150deg,#5e4600 0%,#c9980a 55%,#e0ac1e 100%);border-radius:var(--radius-xl);padding:11px 15px 12px;margin-bottom:10px;color:white;position:relative;overflow:hidden;box-shadow:0 10px 28px -10px rgba(122,92,0,.55)">
      <div style="position:absolute;top:-24px;right:-16px;font-size:88px;opacity:.07;line-height:1;transform:rotate(-8deg)">${ICON_STETHOSCOPE}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;position:relative">
        ${getSetting('donation_enabled','false') === 'true' ? `<div class="home-support-chip" onclick="showDonationPage()">💛 Support Us</div>` : '<span></span>'}
        <div onclick="openNotificationBell()" style="cursor:pointer;font-size:19px;width:36px;height:36px;background:rgba(255,255,255,.16);border-radius:50%;display:flex;align-items:center;justify-content:center;position:relative">
          ${ICON_BELL}<span id="notifBellBadge" style="display:none;position:absolute;top:-4px;right:-4px;background:var(--red);color:white;font-size:10px;font-weight:700;border-radius:10px;min-width:18px;height:18px;align-items:center;justify-content:center;padding:0 4px;border:2px solid #7a5c00">0</span>
        </div>
      </div>
      <div class="flex-between" style="margin-bottom:8px;position:relative">
        <div>
          <div style="font-size:11px;opacity:.75;font-weight:600;text-transform:uppercase;letter-spacing:.8px">${greeting}</div>
          <div style="font-family:var(--font-display);font-size:19px;font-weight:800;margin-top:2px;letter-spacing:-.2px">Dr. ${esc(window.currentUser.name)}</div>
          <div style="font-size:12px;opacity:.75;margin-top:2px">${esc(window.currentUser.college||'Student')}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:26px;width:44px;height:44px;background:rgba(255,255,255,.14);border-radius:14px;display:flex;align-items:center;justify-content:center;margin-left:auto">${avatarEmoji}</div>
          <div onclick="changeYear()" style="font-size:11px;opacity:.9;margin-top:6px;cursor:pointer;text-decoration:underline;text-decoration-style:dotted">${esc(myYearName||'Set Year')} ${ICON_EDIT}</div>
        </div>
      </div>
      <svg class="lumhsian-pulse-line" width="100%" height="11" viewBox="0 0 300 16" preserveAspectRatio="none" style="display:block;opacity:.32;margin-bottom:7px" stroke-dasharray="300">
        <path d="M0,8 L36,8 L42,1 L49,15 L55,8 L106,8 L112,1 L119,15 L125,8 L176,8 L182,1 L189,15 L195,8 L246,8 L252,1 L259,15 L265,8 L300,8" stroke="white" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
        <div style="background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:7px 4px 6px;text-align:center">
          <div style="font-size:11px;opacity:.85;margin-bottom:1px">🎯</div>
          <div class="lumhsian-stat-num" style="font-size:16px;font-weight:800;font-family:var(--font-display)" data-count="${acc}" data-suffix="%">0%</div>
          <div style="font-size:9.5px;opacity:.72;margin-top:1px;font-weight:500">Accuracy</div>
        </div>
        <div style="background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:7px 4px 6px;text-align:center">
          <div style="font-size:11px;opacity:.85;margin-bottom:1px">📝</div>
          <div class="lumhsian-stat-num" style="font-size:16px;font-weight:800;font-family:var(--font-display);animation-delay:.05s" data-count="${stats.total_tests||0}" data-suffix="">0</div>
          <div style="font-size:9.5px;opacity:.72;margin-top:1px;font-weight:500">Tests</div>
        </div>
        <div style="background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:7px 4px 6px;text-align:center">
          <div style="font-size:11px;opacity:.85;margin-bottom:1px">${ICON_FIRE}</div>
          <div class="lumhsian-stat-num" style="font-size:16px;font-weight:800;font-family:var(--font-display);animation-delay:.1s" data-count="${stats.streak||0}" data-suffix="">0</div>
          <div style="font-size:9.5px;opacity:.72;margin-top:1px;font-weight:500">Streak</div>
        </div>
      </div>
    </div>

    ${announceHtml}

    <div class="quick-row">
      <div class="quick-tile" onclick="navGo('modules')"><span class="quick-tile-icon">${ICON_BOOK}</span><span class="quick-tile-label">Modules</span></div>
      <div class="quick-tile" onclick="openPastPapersRoot()"><span class="quick-tile-icon">${ICON_BUILDING}</span><span class="quick-tile-label">Past Papers</span></div>
      <div class="quick-tile" onclick="openCustomTestBuilder()"><span class="quick-tile-icon">🛠️</span><span class="quick-tile-label">Own Test</span></div>
      ${isAIEnabled() ? `<div class="quick-tile" onclick="openAITutor()"><span class="quick-tile-icon">${ICON_ROBOT}</span><span class="quick-tile-label">AI Tutor</span></div>` : ''}
      <div class="quick-tile" onclick="navGo('bookmarks')"><span class="quick-tile-icon">${ICON_BOOKMARK}</span><span class="quick-tile-label">Bookmark</span></div>
      <div class="quick-tile" onclick="navGo('wrongattempts')"><span class="quick-tile-icon">${ICON_X_CIRCLE}</span><span class="quick-tile-label">Wrong Qs</span></div>
      <div class="quick-tile" onclick="openSavedTests()"><span class="quick-tile-icon">📁</span><span class="quick-tile-label">Saved Tests</span></div>
      <div class="quick-tile" onclick="navGo('planner')"><span class="quick-tile-icon">${ICON_CALENDAR}</span><span class="quick-tile-label">Planner</span></div>
    </div>

    ${(() => {
      const saved = getResumableSnapshot();
      // Only a skipped/backgrounded Attempt belongs on this prominent bar,
      // and only while time genuinely remains — Review and Practice pauses
      // are intentionally never shown here (or on Profile); they only ever
      // appear as a small note directly on their own test/paper/saved-test
      // card (see _pausedReviewNoteHtml below).
      if (!saved || saved.mode !== 'attempt') return '';
      const elapsed = Math.floor((Date.now() - saved.startTime) / 1000);
      const remaining = (saved.timeLimit || 0) - elapsed;
      if (remaining <= 0) return '';
      const name = saved.testTitle || saved.paperTitle || saved.moduleName || 'your test';
      const mins = Math.floor(remaining / 60), secs = remaining % 60;
      return `<div id="resumeTestBar" style="display:flex;gap:8px;align-items:center;margin-bottom:16px">
      <button class="btn btn-secondary btn-sm" style="flex:1;text-align:left" onclick="checkResumableTest()">▶ Resume: ${esc(name)} (${mins}m ${secs}s left)</button>
      <button class="btn-icon" title="Dismiss" onclick="dismissResumableTest()">✕</button>
    </div>`;
    })()}

    <div class="flex-between" style="margin-bottom:8px">
      <span class="section-label" style="margin:0">My Modules${myYearName ? ` · ${myYearName}` : ''}</span>
      <span class="text-xs fw-600" style="color:var(--gold-600);cursor:pointer" onclick="navGo('modules')">View All →</span>
    </div>
    ${myYearModuleHtml}

    <div class="card" style="margin:16px 0">
      <div class="flex-between mb-1"><span class="text-sm fw-600">Overall Progress</span><span class="text-sm fw-700" style="color:var(--gold-700)">${stats.total_correct||0} / ${stats.total_questions||0} correct</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${acc}%"></div></div>
      <div class="flex-between mt-2"><span class="text-xs text-muted">Best score: ${stats.best_score||0}%</span><button class="btn btn-ghost btn-sm" style="padding:4px 10px" onclick="navGo('stats')">Full stats →</button></div>
    </div>
    <div style="height:16px"></div>`;

  _animateHeaderStats();
  } catch(e) {
    console.error('renderHome error:', e);
    document.getElementById('homePageWrap').innerHTML = `<div class="card"><p>Failed to load. <button class="btn btn-primary btn-sm mt-2" onclick="renderHome()">Retry</button></p></div>`;
  } finally { showLoading(false); }
}
window.renderHome = renderHome;



// Expand/collapse a year section on Home to show its modules




// ==================== MODULE DETAIL ====================
// Shared by openModule/openModuleTestGroup/openSubjectTestGroup — a module
// belonging to a year other than the student's own year_of_study is browsable
// but Attempt/Review are locked (see blockWrongYear below). An admin inside
// "View as Student" preview (window._isAdminPreview) always sees everything
// unlocked, since admin needs to test/QA every year, not just whichever one
// they landed on.
function _isYearContentUnlocked(fromYearName) {
  return !fromYearName || fromYearName === window.currentUser?.year_of_study || !!window._isAdminPreview;
}


export async function openModule(moduleId, moduleName, iconUrl, color, fromYearId, fromYearName) {
  showLoading(true, 'Loading module...');
  const [moduleRes, subjectsRes, qCountRes, moduleTestsRes] = await Promise.all([
    db(sb.from('modules').select('name,icon_url,color').eq('id', moduleId).single(), 'Module error'),
    _cachedQuery(`subjects_module_${moduleId}`, CONTENT_COUNTS_TTL, () => sb.from('subjects').select('id,name,module_id,display_order').eq('module_id', moduleId).order('display_order'), 'Subjects error'),
    db(sb.from('questions').select('*', { count: 'exact', head: true }).eq('module_id', moduleId).is('paper_id', null), 'Question count error'),
    db(sb.from('practice_tests').select('id').eq('module_id', moduleId).is('subject_id', null).eq('is_active', true), 'Tests error')
  ]);
  // Always trust the freshly-fetched row for name/icon/color — the passed-in
  // params can be a stale snapshot from whenever this module was first opened
  // this session (backToModule() and app-resume both replay that old value),
  // so without this a rename in Admin wouldn't show up here until much later.
  const freshModule = moduleRes.data;
  moduleName = freshModule?.name || moduleName;
  iconUrl = freshModule?.icon_url || iconUrl;
  color = freshModule?.color || color;

  // Track so saveAppState can persist module screen state — stores the fresh
  // values above, so later backToModule()/resume calls stay fresh from here too.
  window._lastOpenedModule = { moduleId, moduleName, iconUrl: iconUrl || '', color: color || '', fromYearId: fromYearId || null, fromYearName: fromYearName || null };
  window._moduleScreenMode = 'module';
  window._moduleSubView = null;
  const subjects = subjectsRes.data || [];
  const totalQ = qCountRes.count || 0;
  const moduleTestCount = moduleTestsRes.data?.length || 0;
  const stats = await getUserStats();
  showLoading(false);

  // Determine if this module belongs to the student's own year (their year_of_study).
  // If not, Attempt/Review are blocked with a friendly message — browsing structure is still allowed.
  const isOwnYear = _isYearContentUnlocked(fromYearName);
  window._currentModuleYearName = fromYearName || window.currentUser?.year_of_study || null;

  // Batch fetch test counts per subject — one request total instead of one per subject
  const subTestCounts = await getTestCountsBySubject(subjects.map(s => s.id));

  let subjectHtml = '';
  for (const s of subjects) {
    const sStats = stats.subject_stats?.[`${moduleId}_${s.id}`] || {};
    const sAcc = sStats.total ? Math.round((sStats.correct / sStats.total) * 100) : null;
    const sTestCount = subTestCounts[s.id] || 0;
    subjectHtml += `
      <div class="list-item" onclick="openSubjectTestGroup(${moduleId},'${moduleName.replace(/'/g,"\\'")}',${s.id},'${s.name.replace(/'/g,"\\'")}')">
        <div class="list-item-left">
          <div class="list-item-icon">${ICON_BOOK}</div>
          <div style="min-width:0">
            <div class="list-item-title">${s.name}</div>
            <div class="list-item-sub">${sAcc !== null ? `${sAcc}% last accuracy` : `${sTestCount} test${sTestCount === 1 ? '' : 's'}`}</div>
          </div>
        </div>
        <span style="color:var(--ink-4)">›</span>
      </div>`;
  }

  // Whole-module practice tests (admin-curated, e.g. "Head & Neck Practice Test 1") —
  // tapping opens openModuleTestGroup() below, which lists them with Review/Attempt.
  // This count is specifically whole-module tests (subject_id IS NULL) — most
  // modules only have subject-scoped tests (shown per-subject below instead),
  // so showing "0 tests" here for every such module read as a broken/missing
  // count rather than what it actually is: correctly zero of this one
  // specific kind. Hidden entirely when there are none, same as the banner
  // subtitle below.
  const moduleTestsHtml = moduleTestCount > 0 ? `
    <div class="list-item" onclick="openModuleTestGroup(${moduleId},'${moduleName.replace(/'/g,"\\'")}')">
      <div class="list-item-left">
        <div class="list-item-icon">${ICON_TARGET}</div>
        <div style="min-width:0">
          <div class="list-item-title">${moduleName} Practice Tests</div>
          <div class="list-item-sub">${moduleTestCount} test${moduleTestCount === 1 ? '' : 's'}</div>
        </div>
      </div>
      <span style="color:var(--ink-4)">›</span>
    </div>` : '';

  const wrap = document.getElementById('modulePageWrap');
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back</button>

    <div class="card-teal" style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
      <img src="${iconUrl || 'https://placehold.co/72x72/ffffff/c9980a?text=📚'}" style="width:72px;height:72px;border-radius:var(--radius-lg);object-fit:cover;background:rgba(255,255,255,.15)" onerror="this.src='https://placehold.co/72x72/ffffff/c9980a?text=📚'">
      <div>
        <h2>${moduleName}</h2>
        <p>${subjects.length} subject${subjects.length === 1 ? '' : 's'}${moduleTestCount > 0 ? ` · ${moduleTestCount} practice test${moduleTestCount === 1 ? '' : 's'}` : ''}</p>
      </div>
    </div>

    ${!isOwnYear ? `
    <div class="card" style="margin-bottom:16px;background:linear-gradient(135deg,var(--amber-50,#fff7e6) 0%,var(--surface) 100%);border:1px solid var(--amber)">
      <div style="display:flex;gap:10px;align-items:flex-start">
        <span style="font-size:20px">${ICON_LOCK}</span>
        <div>
          <div style="font-weight:700;font-size:13px;margin-bottom:2px">This is ${fromYearName || 'a different year'}'s content</div>
          <div style="font-size:12px;color:var(--ink-3);line-height:1.5">You can browse the structure here, but Attempt &amp; Review are locked because your profile year is <strong>${window.currentUser?.year_of_study || 'not set'}</strong>. Change your year in Profile if this is actually your year.</div>
          <button class="btn btn-secondary btn-sm mt-2" onclick="changeYear()">⚙️ Change My Year</button>
        </div>
      </div>
    </div>` : ''}

    ${moduleTestsHtml}

    ${subjects.length ? `<div class="section-label">By Subject</div>${subjectHtml}` : ''}
  `;
  showScreen('module');
}
window.openModule = openModule;



// "Back" from any in-place module sub-view (like a past-paper group below) —
// re-renders the module's main page from the last-opened state instead of
// touching navStack, so the Back button always lands somewhere sensible.
function backToModule() {
  window._moduleSubView = null;
  const m = window._lastOpenedModule;
  if (m) openModule(m.moduleId, m.moduleName, m.iconUrl, m.color, m.fromYearId, m.fromYearName);
  else goBack();
}
window.backToModule = backToModule;



// ==================== GLOBAL PAST PAPERS (College → Papers, scoped to the student's own year) ====================
// Auto-scoped to whichever Academic Year is "mine" right now — the student's
// own year_of_study, or whatever year an admin is currently previewing as
// (see selectYear()/Home's year-switcher to change that) — so there's no
// year-picker step and no "X Year" heading; tapping Past Papers goes straight
// to a college list containing only that one year's papers. To check a
// different year, switch year first (Home), then open Past Papers again.
// Reuses the 'module' screen/modulePageWrap the same in-place way
// openModule()'s old sub-views did, so Review/Solve still hand off to the
// exact same startTest() used everywhere else — driven by paper_id alone
// (see startTest()), since a single paper can still be tagged with any
// number of modules via the past_paper_modules table (e.g. one exam paper
// covering GIT + Endocrinology + Pharmacology), purely as a display label,
// independent of which Academic Year the paper itself belongs to.
let _pastPapersData = null; // { colleges, yearId, yearName } — cached per visit so drilling down/back never re-fetches

export async function openPastPapersRoot() {
  showLoading(true, 'Loading past papers...');
  // Plain selects + separate lookups, NOT embedded joins — PostgREST can't
  // always resolve those relationships for past_papers, and this sidesteps
  // it entirely with simple, always-working queries run in parallel.
  const [{ data: allPapers }, { data: allModules }, { data: allTags }, { data: allYears }] = await Promise.all([
    _cachedQuery('active_past_papers', CONTENT_COUNTS_TTL, () => sb.from('past_papers').select('id,title,year_id,college_name,paper_year,display_order').eq('is_active', true).order('display_order'), 'Past papers error'),
    _cachedQuery('module_names', CONTENT_COUNTS_TTL, () => sb.from('modules').select('id,name'), 'Modules error'),
    _cachedQuery('past_paper_module_tags', CONTENT_COUNTS_TTL, () => sb.from('past_paper_modules').select('paper_id,module_id'), 'Paper-module tags error'),
    db(sb.from('years').select('id,name,display_order').order('display_order'), 'Years error')
  ]);
  const moduleNameById = {};
  for (const m of (allModules || [])) moduleNameById[m.id] = m.name;
  const moduleIdsByPaper = {};
  for (const t of (allTags || [])) {
    if (!moduleIdsByPaper[t.paper_id]) moduleIdsByPaper[t.paper_id] = [];
    moduleIdsByPaper[t.paper_id].push(t.module_id);
  }
  const myYear = (allYears || []).find(y => y.name === window.currentUser?.year_of_study) || null;
  window._lastOpenedPastPapers = { level: 'root' };
  window._moduleScreenMode = 'pastpapers';
  window._moduleSubView = null;

  if (!myYear) {
    showLoading(false);
    const wrap = document.getElementById('modulePageWrap');
    wrap.innerHTML = `
      <button class="back-btn" onclick="goBack()">← Back</button>
      <div class="card-teal" style="margin-bottom:16px"><h2>${ICON_BUILDING} Past Papers</h2></div>
      <div class="card"><p>Set your academic year first, then come back here.</p></div>`;
    showScreen('module');
    return;
  }

  // Only THIS year's papers with at least one question — same rule the old
  // grouping used, now scoped to one year instead of filtered out later.
  // Question count + module tag are stashed on each paper (_qCount/
  // _moduleTag) so drilling into a college never needs to re-fetch either.
  // _moduleTag joins every module this paper is tagged with via
  // past_paper_modules (any number, e.g. "GIT + Endocrinology +
  // Pharmacology") — it's purely a display label admin sets, not a real
  // relationship, and is blank if nothing is tagged.
  const papers = (allPapers || []).filter(p => p.year_id === myYear.id);
  const ppCounts = await getQuestionCountsBy('paper_id', papers.map(p => p.id));
  showLoading(false);

  const colleges = {};
  for (const p of papers) {
    const qCount = ppCounts[p.id] || 0;
    if (!qCount) continue;
    const collegeName = (p.college_name || '').trim();
    const cKey = collegeName || '__general__';
    if (!colleges[cKey]) colleges[cKey] = { collegeName, papers: [] };
    const moduleTag = (moduleIdsByPaper[p.id] || []).map(id => moduleNameById[id]).filter(Boolean).join(' + ');
    colleges[cKey].papers.push({ ...p, _qCount: qCount, _moduleTag: moduleTag });
  }
  _pastPapersData = { colleges, yearId: myYear.id, yearName: myYear.name };

  renderPastPapersCollegeList();
  showScreen('module');
}
window.openPastPapersRoot = openPastPapersRoot;



// Renders the college-list shell (header + search box + list container).
// This is now the FIRST screen Past Papers shows — no year picker, no "X
// Year" heading, since the year is already implied by whose account this is.
function renderPastPapersCollegeList() {
  window._lastOpenedPastPapers = { level: 'root' };
  window._moduleScreenMode = 'pastpapers';
  const wrap = document.getElementById('modulePageWrap');
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back</button>
    <div class="card-teal" style="margin-bottom:16px"><h2>${ICON_BUILDING} Past Papers</h2><p>Choose a college</p></div>
    <div class="mb-3"><input type="text" id="ppCollegeSearch" class="input-field" placeholder="🔍 Search college..." oninput="filterPastPaperColleges(this.value)"></div>
    <div id="ppCollegeListInner"></div>
    <div style="height:16px"></div>`;
  filterPastPaperColleges('');
}
window.renderPastPapersCollegeList = renderPastPapersCollegeList;



// Re-renders only the list below the search box, never the input itself —
// so typing doesn't lose focus/cursor position on every keystroke.
function filterPastPaperColleges(term) {
  const listWrap = document.getElementById('ppCollegeListInner');
  if (!listWrap || !_pastPapersData) return;
  const { colleges } = _pastPapersData;
  const t = (term || '').trim().toLowerCase();

  const sortedKeys = Object.keys(colleges).sort((a, b) => {
    if (a === '__general__') return 1;
    if (b === '__general__') return -1;
    return colleges[a].collegeName.localeCompare(colleges[b].collegeName);
  });

  let html = '';
  for (const key of sortedKeys) {
    const cg = colleges[key];
    const title = cg.collegeName || 'Other Colleges';
    if (t && !title.toLowerCase().includes(t)) continue;
    html += `
      <div class="list-item" onclick="openPastPaperCollege('${escJs(key)}')">
        <div class="list-item-left">
          <div class="list-item-icon">${ICON_BUILDING}</div>
          <div style="min-width:0">
            <div class="list-item-title">${esc(title)}</div>
            <div class="list-item-sub">${cg.papers.length} paper${cg.papers.length === 1 ? '' : 's'}</div>
          </div>
        </div>
        <span style="color:var(--ink-4)">›</span>
      </div>`;
  }
  listWrap.innerHTML = html || `<div class="card"><p>${t ? 'No colleges match your search.' : 'No past papers added yet for your year. Check back soon.'}</p></div>`;
}
window.filterPastPaperColleges = filterPastPaperColleges;



// Attempt only — the one time-sensitive case, so it's the only one that
// replaces the normal Review/Attempt row with a prominent Resume button, on
// whichever exact card matches the one paused session the app keeps at a
// time (see getResumableSnapshot() in quiz.js).
function _resumeRowHtml(saved, idField, idValue) {
  if (!saved || idValue == null || saved[idField] !== idValue || saved.mode !== 'attempt') return null;
  const answered = (saved.answers || []).filter(a => a !== null).length;
  const total = (saved.questions || []).length;
  return `<div style="width:100%">
    <div class="text-xs fw-700" style="color:var(--gold-700);margin-bottom:6px">⏸ Paused — ${answered}/${total} answered</div>
    <button class="btn btn-primary btn-sm" style="width:100%;background:linear-gradient(105deg,#0d7a4f,#22c55e)" onclick="checkResumableTest()">▶ Resume Test</button>
  </div>`;
}



// Review and Practice: neither is time-pressured, so neither should
// interrupt — just a small line underneath the normal Review/Attempt
// buttons on whichever exact card is paused. It is only a note (no separate
// button): tapping that card's own Review button asks "continue from Qn" vs
// "start fresh" (see startTest() in quiz.js).
function _pausedReviewNoteHtml(saved, idField, idValue) {
  if (!saved || saved.mode === 'attempt' || idValue == null || saved[idField] !== idValue) return '';
  const total = (saved.questions || []).length;
  const at = Math.min((saved.currentIndex || 0) + 1, Math.max(total, 1));
  const label = saved.mode === 'practice' ? 'Practice' : 'Review';
  return `<div class="text-xs mt-1" style="color:var(--gold-700)">⏸ ${label} paused at Q${at} of ${total}</div>`;
}



// College tapped from the list — every actual paper for that college (in the
// student's own year, always — there's no other year to accidentally land
// on anymore), flat (papers aren't tied to one module, so there's nothing to
// section by). Review/Solve wire into the exact same startTest() as
// everywhere else, which pulls this paper's questions by paper_id alone
// (module is passed as null below — it's not read in paper mode).
async function openPastPaperCollege(collegeKey) {
  const g = _pastPapersData?.colleges?.[collegeKey];
  if (!g) { openPastPapersRoot(); return; }
  window._lastOpenedPastPapers = { level: 'college', collegeKey };
  window._moduleScreenMode = 'pastpapers';
  const title = g.collegeName || 'Other Colleges';
  const papers = [...g.papers].sort((a, b) => (a.title || '').localeCompare(b.title || ''));

  showLoading(true, 'Loading papers...');
  const stats = await getUserStats();
  const saved = getResumableSnapshot();
  showLoading(false);

  let html = '';
  for (const p of papers) {
    const pStats = stats.paper_stats?.[p.id] || null;
    const metaBits = [`${p._qCount} questions`, `⏱ ~${Math.ceil(p._qCount * 1.5)} min`];
    if (p._moduleTag) metaBits.push(`📦 ${esc(p._moduleTag)}`);
    if (p.paper_year) metaBits.push(`📅 ${esc(p.paper_year)}`);
    const bestLine = attemptLineHtml(pStats);
    const resumeRow = _resumeRowHtml(saved, 'paperId', p.id);
    html += `
      <div class="list-item no-hover" style="flex-direction:column;align-items:stretch;cursor:default">
        <div class="list-item-left" style="width:100%">
          <div class="list-item-icon">📜${attemptBadgeHtml(pStats)}</div>
          <div style="min-width:0">
            <div class="list-item-title">${esc(p.title)}</div>
            <div class="list-item-sub">${metaBits.join(' · ')}</div>
            ${bestLine}
          </div>
        </div>
        <div class="btn-row mt-2">
          ${resumeRow || `
          <button class="btn btn-secondary btn-sm" onclick="startTest('browse',null,'${escJs(p.title)}',null,${p.id},'${escJs(p.title)}')">👁 Review</button>
          <button class="btn btn-primary btn-sm" onclick="startTest('attempt',null,'${escJs(p.title)}',null,${p.id},'${escJs(p.title)}')">📝 Solve</button>`}
        </div>
        ${_pausedReviewNoteHtml(saved, 'paperId', p.id)}
      </div>`;
  }

  const wrap = document.getElementById('modulePageWrap');
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back to Past Papers</button>
    <div class="card-teal" style="margin-bottom:16px"><h2>${ICON_BUILDING} ${esc(title)}</h2><p>${papers.length} paper${papers.length === 1 ? '' : 's'}</p></div>
    ${html || '<div class="card"><p>No papers with questions in this group yet.</p></div>'}
    <div style="height:16px"></div>`;
}
window.openPastPaperCollege = openPastPaperCollege;



// Drill-down shown after tapping the "[Module] Practice Tests" row on the module page —
// lists the whole-module tests admin created (e.g. "Head & Neck Practice Test 1/2/3"),
// each with the same Review/Attempt actions used everywhere else in the app.
async function openModuleTestGroup(moduleId, moduleName) {
  window._moduleSubView = 'moduleTests';
  showLoading(true, 'Loading practice tests...');
  const { data: tests } = await _cachedQuery(`module_tests_${moduleId}`, CONTENT_COUNTS_TTL, () => sb.from('practice_tests').select('id,title,display_order').eq('module_id', moduleId).is('subject_id', null).eq('is_active', true).order('display_order'), 'Tests error');
  const list = tests || [];
  const counts = await getQuestionCountsBy('practice_test_id', list.map(t => t.id));
  const stats = await getUserStats();
  const saved = getResumableSnapshot();
  showLoading(false);

  const fromYearName = window._lastOpenedModule?.fromYearName || null;
  const isOwnYear = _isYearContentUnlocked(fromYearName);
  const lockedClick = `blockWrongYear('${(fromYearName||'').replace(/'/g,"\\'")}')`;

  let html = '';
  for (const t of list) {
    const tCount = counts[t.id] || 0;
    if (!tCount) continue;
    const tStats = stats.test_stats?.[t.id] || null;
    const metaBits = [`${tCount} questions`, `⏱ ~${Math.ceil(tCount * 1.5)} min`];
    const bestLine = attemptLineHtml(tStats);
    const resumeRow = isOwnYear ? _resumeRowHtml(saved, 'testId', t.id) : null;
    html += `
      <div class="list-item no-hover" style="flex-direction:column;align-items:stretch;cursor:default">
        <div class="list-item-left" style="width:100%">
          <div class="list-item-icon">${ICON_TARGET}${attemptBadgeHtml(tStats)}</div>
          <div style="min-width:0">
            <div class="list-item-title">${t.title}</div>
            <div class="list-item-sub">${metaBits.join(' · ')}</div>
            ${bestLine}
          </div>
        </div>
        <div class="btn-row mt-2">
          ${resumeRow || `
          <button class="btn btn-secondary btn-sm" onclick="${isOwnYear ? `startTest('browse',${moduleId},'${moduleName.replace(/'/g,"\\'")}',null,null,null,${t.id},'${t.title.replace(/'/g,"\\'")}')` : lockedClick}">👁 Review</button>
          <button class="btn btn-primary btn-sm" onclick="${isOwnYear ? `startTest('attempt',${moduleId},'${moduleName.replace(/'/g,"\\'")}',null,null,null,${t.id},'${t.title.replace(/'/g,"\\'")}')` : lockedClick}">📝 Attempt</button>`}
        </div>
        ${isOwnYear ? _pausedReviewNoteHtml(saved, 'testId', t.id) : ''}
      </div>`;
  }

  const wrap = document.getElementById('modulePageWrap');
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back to ${moduleName}</button>
    <div class="card-teal" style="margin-bottom:16px"><h2>${ICON_TARGET} ${moduleName} Practice Tests</h2><p>${list.length} test${list.length === 1 ? '' : 's'}</p></div>
    ${html || '<div class="card"><p>No practice tests added yet for this module. Check back soon.</p></div>'}
    <div style="height:16px"></div>`;
}
window.openModuleTestGroup = openModuleTestGroup;



// Drill-down shown after tapping a Subject row on the module page — lists that
// subject's admin-created tests (e.g. "Gross Anatomy Practice Test 1/2/3"), each
// with the same Review/Attempt actions used everywhere else in the app.
async function openSubjectTestGroup(moduleId, moduleName, subjectId, subjectName) {
  window._moduleSubView = 'subjectTests';
  showLoading(true, 'Loading practice tests...');
  const { data: tests } = await _cachedQuery(`subject_tests_${moduleId}_${subjectId}`, CONTENT_COUNTS_TTL, () => sb.from('practice_tests').select('id,title,display_order').eq('module_id', moduleId).eq('subject_id', subjectId).eq('is_active', true).order('display_order'), 'Tests error');
  const list = tests || [];
  const counts = await getQuestionCountsBy('practice_test_id', list.map(t => t.id));
  const stats = await getUserStats();
  const saved = getResumableSnapshot();
  showLoading(false);

  const fromYearName = window._lastOpenedModule?.fromYearName || null;
  const isOwnYear = _isYearContentUnlocked(fromYearName);
  const lockedClick = `blockWrongYear('${(fromYearName||'').replace(/'/g,"\\'")}')`;

  let html = '';
  for (const t of list) {
    const tCount = counts[t.id] || 0;
    if (!tCount) continue;
    const tStats = stats.test_stats?.[t.id] || null;
    const metaBits = [`${tCount} questions`, `⏱ ~${Math.ceil(tCount * 1.5)} min`];
    const bestLine = attemptLineHtml(tStats);
    const resumeRow = isOwnYear ? _resumeRowHtml(saved, 'testId', t.id) : null;
    html += `
      <div class="list-item no-hover" style="flex-direction:column;align-items:stretch;cursor:default">
        <div class="list-item-left" style="width:100%">
          <div class="list-item-icon">${ICON_TARGET}${attemptBadgeHtml(tStats)}</div>
          <div style="min-width:0">
            <div class="list-item-title">${t.title}</div>
            <div class="list-item-sub">${metaBits.join(' · ')}</div>
            ${bestLine}
          </div>
        </div>
        <div class="btn-row mt-2">
          ${resumeRow || `
          <button class="btn btn-secondary btn-sm" onclick="${isOwnYear ? `startTest('browse',${moduleId},'${moduleName.replace(/'/g,"\\'")}',null,null,null,${t.id},'${t.title.replace(/'/g,"\\'")}')` : lockedClick}">👁 Review</button>
          <button class="btn btn-primary btn-sm" onclick="${isOwnYear ? `startTest('attempt',${moduleId},'${moduleName.replace(/'/g,"\\'")}',null,null,null,${t.id},'${t.title.replace(/'/g,"\\'")}')` : lockedClick}">📝 Attempt</button>`}
        </div>
        ${isOwnYear ? _pausedReviewNoteHtml(saved, 'testId', t.id) : ''}
      </div>`;
  }

  const wrap = document.getElementById('modulePageWrap');
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back to ${moduleName}</button>
    <div class="card-teal" style="margin-bottom:16px"><h2>📖 ${subjectName} Practice Tests</h2><p>${moduleName}</p></div>
    ${html || '<div class="card"><p>No practice tests added yet for this subject. Check back soon.</p></div>'}
    <div style="height:16px"></div>`;
}
window.openSubjectTestGroup = openSubjectTestGroup;



// Friendly block shown when a logged-in student tries to Attempt/Review a module
// that does not belong to their own profile year.
function blockWrongYear(moduleYearName) {
  showConfirm(
    `This belongs to ${moduleYearName || 'a different year'}, not your year (${window.currentUser?.year_of_study || 'not set'}). Change your year in Profile to access it, or stay in your own year's content.`,
    () => changeYear(),
    'Change My Year',
    false
  );
}



// ==================== TEST ENGINE ====================
// Modes:
//   'attempt'  = real timed graded test (Solve a past paper) → saved to history, resumable if interrupted
//   'practice' = untimed subject / mixed practice, instant right-or-wrong feedback → saved to history
//   'browse'   = "just view" review of a past paper, instant feedback, NOT timed, NOT saved as an attempt
// ==================== CUSTOM TEST BUILDER ("Make Your Own Test") ====================
// Helper: get the year row for the current user's profile year
async function _getMyYear() {
  const myYearName = window.currentUser?.year_of_study;
  if (!myYearName) return null;
  if (window.selectedYear?.name === myYearName) return window.selectedYear;
  const { data } = await db(sb.from('years').select('id,name').eq('name', myYearName).maybeSingle(), 'Year fetch error');
  if (data) { window.selectedYear = data; localStorage.setItem('lum_year', JSON.stringify(data)); }
  return data || null;
}



async function openCustomTestBuilder() {
  showLoading(true, 'Loading modules...');
  const myYear = await _getMyYear();
  if (!myYear) {
    showLoading(false);
    showToast('Please set your year in Profile first to build a custom test.');
    return;
  }
  const { data: yearModules } = await db(sb.from('year_modules').select('module_id').eq('year_id', myYear.id), 'Modules error');
  const moduleIds = (yearModules || []).map(ym => ym.module_id);
  const [{ data: modules }, { data: papers }, { data: savedTests }] = await Promise.all([
    moduleIds.length ? db(sb.from('modules').select('*').in('id', moduleIds), 'Modules fetch error') : Promise.resolve({ data: [] }),
    db(sb.from('past_papers').select('id,title').eq('is_active', true).eq('year_id', myYear.id).order('display_order'), 'Past papers error'),
    db(sb.from('custom_tests').select('*').eq('user_email', window.currentUser.email).order('created_at', { ascending: false }), 'Saved tests error')
  ]);
  const saved = getResumableSnapshot();
  showLoading(false);

  const overlay = document.createElement('div');
  overlay.id = 'ctbOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.85);z-index:10006;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:20px;width:100%;max-width:460px;max-height:88vh;overflow-y:auto">
      <div class="flex-between mb-3">
        <span class="fw-700">🛠️ Build Your Own Test</span>
        <button onclick="this.closest('[style*=fixed]').remove()" style="background:none;border:none;font-size:18px;cursor:pointer">✕</button>
      </div>
      <p class="text-xs text-muted mb-3">Mix and match — pick any combination of modules, past papers, and practice tests below. Behaves like a real Attempt: answers are locked in until you finish, review comes after. It won't count toward your personal statistics.</p>

      <div class="card" style="margin-bottom:14px;padding:12px 14px;cursor:pointer" onclick="document.getElementById('ctbOverlay')?.remove();openSavedTests()">
        <div class="flex-between"><span class="fw-700 text-sm">📁 Saved Tests${savedTests?.length ? ` (${savedTests.length})` : ''}</span><span class="text-xs fw-600" style="color:var(--gold-600)">Open →</span></div>
      </div>

      <div class="tab-bar" id="ctbSourceTabs" style="margin-bottom:14px">
        <button class="tab-btn active" onclick="ctbShowSource('modules')">📚 Modules</button>
        <button class="tab-btn" onclick="ctbShowSource('papers')">📜 Past Papers</button>
        <button class="tab-btn" onclick="ctbShowSource('tests')">🎯 Practice Tests</button>
      </div>

      <div id="ctbSrcModules">
        <div class="fw-700 mb-2 text-sm">Modules</div>
        <div id="ctbModules" style="margin-bottom:10px">
          ${(modules||[]).length ? (modules||[]).map(m => `
            <label style="display:flex;align-items:center;gap:8px;padding:6px 0">
              <input type="checkbox" class="ctb-module" value="${m.id}" data-name="${m.name.replace(/"/g,'&quot;')}" onchange="ctbModulesChanged()">
              <span class="text-sm">${esc(m.name)}</span>
            </label>`).join('') : '<p class="text-xs text-muted">No modules are set up for your year yet. Ask your admin to add some first.</p>'}
        </div>
        <div class="fw-700 mb-2 text-sm">Subject(s) <span class="text-xs text-muted fw-400">(optional, leave blank for all)</span></div>
        <div id="ctbSubjects" style="margin-bottom:6px"><p class="text-xs text-muted">Select a module first</p></div>
      </div>

      <div id="ctbSrcPapers" style="display:none">
        <div class="fw-700 mb-2 text-sm">Past Papers</div>
        <div style="margin-bottom:6px">
          ${(papers||[]).length ? (papers||[]).map(p => `
            <label style="display:flex;align-items:center;gap:8px;padding:6px 0">
              <input type="checkbox" class="ctb-paper" value="${p.id}">
              <span class="text-sm">${esc(p.title)}</span>
            </label>`).join('') : '<p class="text-xs text-muted">No past papers added for your year yet.</p>'}
        </div>
      </div>

      <div id="ctbSrcTests" style="display:none">
        <div class="fw-700 mb-2 text-sm">Practice Tests</div>
        <div id="ctbTests" style="margin-bottom:6px"><p class="text-xs text-muted">Pick a module in the Modules tab first — its practice tests will show up here.</p></div>
      </div>

      <div class="fw-700 mb-2 text-sm mt-2">Test Settings</div>
      <label class="input-label">Number of Questions</label>
      <input id="ctb_count" type="number" class="input-field" value="20" min="5" max="200">
      <label class="input-label">Timer (minutes, 0 for no timer)</label>
      <input id="ctb_timer" type="number" class="input-field" value="30" min="0" max="240">
      <label class="input-label">Save this test as (optional)</label>
      <input id="ctb_name" class="input-field" placeholder="e.g. My Anatomy + Past Paper Mix">

      <div class="btn-row mt-3">
        <button class="btn btn-secondary" onclick="buildCustomTest(false,'browse')">👁 Start as Review</button>
        <button class="btn btn-primary" onclick="buildCustomTest(false,'attempt')">📝 Start as Attempt</button>
      </div>
      <button class="btn btn-ghost btn-sm mt-2" style="width:100%" onclick="buildCustomTest(true)">💾 Save for later (don't start yet)</button>
    </div>`;
  document.body.appendChild(overlay);
}
window.openCustomTestBuilder = openCustomTestBuilder;



function ctbShowSource(which) {
  document.querySelectorAll('#ctbSourceTabs .tab-btn').forEach((b,i) => b.classList.toggle('active', ['modules','papers','tests'][i] === which));
  document.getElementById('ctbSrcModules').style.display = which === 'modules' ? '' : 'none';
  document.getElementById('ctbSrcPapers').style.display = which === 'papers' ? '' : 'none';
  document.getElementById('ctbSrcTests').style.display = which === 'tests' ? '' : 'none';
}
window.ctbShowSource = ctbShowSource;



async function ctbModulesChanged() {
  const checked = [...document.querySelectorAll('.ctb-module:checked')];
  const subWrap = document.getElementById('ctbSubjects');
  const testWrap = document.getElementById('ctbTests');
  // Re-rendering below would otherwise wipe ticks the student already made under other modules
  const keepSubs = new Set([...document.querySelectorAll('.ctb-subject:checked')].map(c => c.value));
  const keepTests = new Set([...document.querySelectorAll('.ctb-test:checked')].map(c => c.value));
  if (!checked.length) {
    subWrap.innerHTML = '<p class="text-xs text-muted">Select a module first</p>';
    testWrap.innerHTML = '<p class="text-xs text-muted">Pick a module in the Modules tab first — its practice tests will show up here.</p>';
    return;
  }
  const moduleIds = checked.map(c => c.value);
  const moduleNameMap = {};
  checked.forEach(c => moduleNameMap[c.value] = c.dataset.name);

  const [{ data: subs }, { data: tests }] = await Promise.all([
    db(sb.from('subjects').select('id,name,module_id').in('module_id', moduleIds).order('display_order'), 'Subjects error'),
    db(sb.from('practice_tests').select('id,title,module_id,subject_id').in('module_id', moduleIds).eq('is_active', true).order('display_order'), 'Tests error')
  ]);

  const subsByModule = {};
  (subs || []).forEach(s => { (subsByModule[s.module_id] = subsByModule[s.module_id] || []).push(s); });
  const testsByModule = {};
  (tests || []).forEach(t => {
    const byMod = (testsByModule[t.module_id] = testsByModule[t.module_id] || {});
    const key = t.subject_id || 0;
    (byMod[key] = byMod[key] || []).push(t);
  });
  const moduleTitle = mid => `<div class="ctb-group-title">📚 ${esc(moduleNameMap[mid] || '')}</div>`;
  const checkRow = (cls, id, label, on) => `<label class="ctb-check"><input type="checkbox" class="${cls}" value="${id}"${on ? ' checked' : ''}${cls === 'ctb-test' ? ' onchange="ctbSyncBox(this.closest(\'.ctb-box\'))"' : ''}><span class="text-sm">${esc(label)}</span></label>`;

  // Subjects: grouped under their module so two modules' subjects never run together
  subWrap.innerHTML = subs?.length ? moduleIds.map(mid => {
    const list = subsByModule[mid] || [];
    return list.length ? `<div style="margin-bottom:10px">${moduleTitle(mid)}${list.map(s => checkRow('ctb-subject', s.id, s.name, keepSubs.has(String(s.id)))).join('')}</div>` : '';
  }).join('') : '<p class="text-xs text-muted">No subjects defined. All questions in the module(s) will be used.</p>';

  // Practice tests: one box per subject (named after the subject) holding that subject's tests
  // The head holds TWO separate controls: a "select all" checkbox on the left, and the title + arrow on the right that
  // collapses/expands the box. They used to be one tap area (a tiny text button inside the clickable header), so a tap
  // that missed the button by a few pixels collapsed the list instead of selecting.
  const testBox = (name, list) => `<div class="ctb-box open">
      <div class="ctb-box-head">
        <label class="ctb-all" title="Select every test in this subject"><input type="checkbox" class="ctb-boxall" onchange="ctbBoxAll(this)"><span>All</span></label>
        <div class="ctb-box-title" onclick="ctbBoxToggle(this)">
          <div class="fw-600 text-sm">${esc(name)}</div>
          <div class="text-xs text-muted"><span class="ctb-count">0</span> of ${list.length} selected</div>
        </div>
        <div class="ctb-chev" onclick="ctbBoxToggle(this)">▾</div>
      </div>
      <div class="ctb-box-body">${list.map(t => checkRow('ctb-test', t.id, t.title, keepTests.has(String(t.id)))).join('')}</div>
    </div>`;
  testWrap.innerHTML = tests?.length ? moduleIds.map(mid => {
    const byMod = testsByModule[mid];
    if (!byMod) return '';
    const mySubs = subsByModule[mid] || [];
    const known = new Set(mySubs.map(s => String(s.id)));
    const subjectBoxes = mySubs.filter(s => byMod[s.id]).map(s => testBox(s.name, byMod[s.id])).join('');
    const loose = [...(byMod[0] || []), ...Object.keys(byMod).filter(k => k !== '0' && !known.has(k)).flatMap(k => byMod[k])];
    return `<div style="margin-bottom:12px">${moduleTitle(mid)}${subjectBoxes}${loose.length ? testBox('Whole-module tests', loose) : ''}</div>`;
  }).join('') : '<p class="text-xs text-muted">No practice tests in the selected module(s) yet.</p>';
  testWrap.querySelectorAll('.ctb-box').forEach(ctbSyncBox);   // reflect any ticks that were kept across the re-render
}

// Keeps a subject box's "All" checkbox (ticked / half-ticked / empty) and its "n of m selected" count in step with the
// individual tests, however they were ticked.
function ctbSyncBox(boxEl) {
  if (!boxEl) return;
  const inputs = [...boxEl.querySelectorAll('.ctb-test')];
  const n = inputs.filter(i => i.checked).length;
  const all = boxEl.querySelector('.ctb-boxall');
  if (all) { all.checked = n > 0 && n === inputs.length; all.indeterminate = n > 0 && n < inputs.length; }
  const c = boxEl.querySelector('.ctb-count');
  if (c) c.textContent = n;
}
window.ctbSyncBox = ctbSyncBox;

function ctbBoxAll(cb) {
  const boxEl = cb.closest('.ctb-box');
  if (!boxEl) return;
  boxEl.querySelectorAll('.ctb-test').forEach(i => { i.checked = cb.checked; });
  ctbSyncBox(boxEl);
}
window.ctbBoxAll = ctbBoxAll;

function ctbBoxToggle(el) {
  const boxEl = el.closest('.ctb-box');
  if (boxEl) boxEl.classList.toggle('open');
}
window.ctbBoxToggle = ctbBoxToggle;
window.ctbModulesChanged = ctbModulesChanged;



async function buildCustomTest(saveOnly, mode) {
  const moduleIds = [...document.querySelectorAll('.ctb-module:checked')].map(c => parseInt(c.value));
  const subjectIds = [...document.querySelectorAll('.ctb-subject:checked')].map(c => parseInt(c.value));
  const paperIds = [...document.querySelectorAll('.ctb-paper:checked')].map(c => parseInt(c.value));
  const testIds = [...document.querySelectorAll('.ctb-test:checked')].map(c => parseInt(c.value));
  const count = parseInt(document.getElementById('ctb_count').value) || 20;
  const timer = parseInt(document.getElementById('ctb_timer').value) || 0;
  const name = document.getElementById('ctb_name').value.trim() || `Custom Test ${new Date().toLocaleDateString()}`;
  if (!moduleIds.length && !paperIds.length && !testIds.length) return showToast('Pick at least one module, past paper, or practice test');

  let savedId = null;
  if (saveOnly || document.getElementById('ctb_name').value.trim()) {
    const row = { user_email: window.currentUser.email, name, module_ids: moduleIds, subject_ids: subjectIds, question_count: count, time_limit_minutes: timer };
    // Only send these when used, so a plain module/subject test still saves even if their columns aren't migrated yet
    if (paperIds.length) row.paper_ids = paperIds;
    if (testIds.length) row.test_ids = testIds;
    const res = await db(sb.from('custom_tests').insert(row).select('id').single(), 'Save failed');
    if (res.error || !res.data) return; // db() already showed the specific error (e.g. paper_ids/test_ids not migrated yet — see schema note)
    savedId = res.data.id;
    showToast('Test saved ✓');
    if (saveOnly) { document.getElementById('ctbOverlay')?.remove(); return; }
  }
  document.getElementById('ctbOverlay')?.remove();
  // savedId marks it as already saved, so the results/end-of-review "Save this test?" prompts don't ask again
  startCustomTest(moduleIds, subjectIds, count, timer, name, paperIds, testIds, mode, savedId);
}
window.buildCustomTest = buildCustomTest;



// Home → Saved Tests: every Make Your Own test the student saved, with Review / Attempt / Delete
export async function renderSavedTests() {
  const wrap = document.getElementById('savedTestsPageWrap');
  if (!wrap) return;
  wrap.innerHTML = `<button class="back-btn" onclick="goBack()">← Back</button>${skeletonList(3)}`;
  const { data: tests } = await db(sb.from('custom_tests').select('*').eq('user_email', window.currentUser.email).order('created_at', { ascending: false }), 'Saved tests error');
  const saved = getResumableSnapshot();
  const list = tests || [];
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const cards = list.map(t => {
    const bits = [];
    if ((t.module_ids || []).length) bits.push(plural(t.module_ids.length, 'module'));
    if ((t.paper_ids || []).length) bits.push(plural(t.paper_ids.length, 'past paper'));
    if ((t.test_ids || []).length) bits.push(plural(t.test_ids.length, 'practice test'));
    const resumeRow = _resumeRowHtml(saved, 'customTestId', t.id);
    return `<div class="card" style="margin-bottom:10px">
      <div class="fw-700">${esc(t.name)}</div>
      <div class="text-xs text-muted" style="margin:2px 0 10px">${plural(t.question_count || 0, 'question')} · ${t.time_limit_minutes ? t.time_limit_minutes + ' min' : 'no timer'}${bits.length ? ' · ' + bits.join(', ') : ''}</div>
      ${resumeRow || `<div class="btn-row">
        <button class="btn btn-secondary btn-sm" onclick="startSavedCustomTest(${t.id},'browse')">👁 Review</button>
        <button class="btn btn-primary btn-sm" onclick="startSavedCustomTest(${t.id},'attempt')">📝 Attempt</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteSavedCustomTest(${t.id})">🗑</button>
      </div>`}
      ${_pausedReviewNoteHtml(saved, 'customTestId', t.id)}
    </div>`;
  }).join('');
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back</button>
    <div class="card-teal" style="margin-bottom:14px">
      <h2>📁 Saved Tests</h2>
      <p>${list.length ? plural(list.length, 'saved test') : 'Your Make Your Own tests live here'}</p>
    </div>
    ${cards || `<div class="card text-center" style="padding:32px 20px"><div style="font-size:42px">📁</div><h3 style="margin-top:10px">No saved tests yet</h3><p class="mt-2 text-sm">Build a test and tick Save, or save it right after you attempt or review it.</p></div>`}
    <button class="btn btn-primary mt-2" style="width:100%" onclick="openCustomTestBuilder()">🛠️ Build a New Test</button>
    <div style="height:16px"></div>`;
}
window.renderSavedTests = renderSavedTests;

// The entry point for every "Saved Tests" button. It renders AND shows the screen itself, so it never depends on the
// navigation module's screen→renderer table (an out-of-date navigation.js that doesn't know this screen yet used to
// leave a blank page with no Back button).
async function openSavedTests() {
  showScreen('savedtests');
  await renderSavedTests();
}
window.openSavedTests = openSavedTests;



async function startSavedCustomTest(id, mode) {
  const { data: t } = await db(sb.from('custom_tests').select('*').eq('id', id).single(), 'Load failed');
  if (!t) return;
  document.getElementById('ctbOverlay')?.remove();
  startCustomTest(t.module_ids, t.subject_ids, t.question_count, t.time_limit_minutes, t.name, t.paper_ids || [], t.test_ids || [], mode, t.id);
}
window.startSavedCustomTest = startSavedCustomTest;



async function deleteSavedCustomTest(id) {
  showConfirm('Delete this saved test? This can\'t be undone.', async () => {
    await db(sb.from('custom_tests').delete().eq('id', id), 'Delete failed');
    showToast('Deleted');
    renderSavedTests();
  }, 'Delete', true);
}
window.deleteSavedCustomTest = deleteSavedCustomTest;



// Given a test's mapped question list, returns a Set of the *indices* (not ids)
// that the student already has bookmarked from any previous session. Without
// this, a freshly started test always assumed nothing was bookmarked yet, so a
// question you'd bookmarked last week would wrongly show "not bookmarked" until
// you tapped it again.
export async function loadBookmarkedIndexSet(mapped) {
  const { data } = await db(sb.from('bookmarks').select('question_id').eq('email', window.currentUser.email).in('question_id', mapped.map(q => q.id)), 'Bookmarks check failed');
  const idToIdx = {};
  mapped.forEach((q, i) => { idToIdx[q.id] = i; });
  const set = new Set();
  (data || []).forEach(b => { if (idToIdx[b.question_id] !== undefined) set.add(idToIdx[b.question_id]); });
  return set;
}




// ==================== STATS ====================
export async function getUserStats(forceRefresh = false) {
  const statsUser = window.currentUser?.email || null;
  if (!forceRefresh && window._lastStats && window._lastStatsUser === statsUser) {
    return window._lastStats;
  }
  const pending = _pendingStats().find(item => item.email === statsUser);
  if (pending?.stats) {
    window._lastStats = pending.stats;
    window._lastStatsFetchedAt = Date.now();
    window._lastStatsUser = statsUser;
    return pending.stats;
  }
  const { data } = await db(sb.from('user_stats').select('*').eq('email', window.currentUser.email).maybeSingle(), 'Stats fetch failed');
  const result = data || { total_tests: 0, total_questions: 0, total_correct: 0, best_score: 0, history: [], streak: 0, last_practice_date: null, subject_stats: {}, paper_stats: {}, test_stats: {} };
  window._lastStats = result;
  window._lastStatsFetchedAt = Date.now();
  window._lastStatsUser = statsUser;
  return result;
}



export async function saveUserStats(stats) {
  window._lastStats = stats;
  window._lastStatsFetchedAt = Date.now();
  window._lastStatsUser = window.currentUser?.email || null;
  const email = window.currentUser?.email;
  if (!email) return;
  const queuedEntry = _queuePendingStats(email, stats);
  // Columns that needed a one-time migration in Supabase (see the SQL notes at the end of this file) are saved
  // separately from the core stats. Bundled into one upsert, a single missing column made Supabase reject the ENTIRE
  // save — total_tests / total_correct / history / streak included — for every submission until the migration was run.
  const OPTIONAL_COLS = ['completed_attempt_tests', 'attempt_answered', 'attempt_questions', 'attempt_correct', 'archived_years', 'total_skipped'];
  const coreStats = {}, optional = {};
  for (const [k, v] of Object.entries(stats)) (OPTIONAL_COLS.includes(k) ? optional : coreStats)[k] = v;
  const { error } = await db(sb.from('user_stats').upsert({ email, ...coreStats }), 'Stats save failed');
  if (error) {
    console.warn('Stats save failed', error);
    return;
  }
  if (Object.keys(optional).length) {
    const { error: eo } = await db(sb.from('user_stats').update(optional).eq('email', email), 'Stats save failed');
    if (eo) {
      // One of these columns isn't in the database yet — save them one by one so only that one is skipped.
      for (const [k, v] of Object.entries(optional)) {
        const { error: e1 } = await db(sb.from('user_stats').update({ [k]: v }).eq('email', email), 'Stats save failed');
        if (e1) console.warn(k + ' not saved — run the migration in Supabase SQL Editor (see SQL reference section)', e1);
      }
    }
  }
  _clearPendingStats(queuedEntry);
}



// ==================== REALTIME HEARTBEAT SYSTEM ====================
let heartbeatInterval = null;



export function startHeartbeat() {
  if (!window.currentUser || window.currentUser.is_admin) return;
  sendHeartbeat();
  heartbeatInterval = setInterval(sendHeartbeat, 60000);
}



async function sendHeartbeat() {
  if (!window.currentUser) return;
  const screen = window.navStack[window.navStack.length - 1] || 'home';
  await db(
    sb.from('users').update({
      last_heartbeat: new Date().toISOString(),
      last_active: Date.now(),
      current_screen: screen
    }).eq('email', window.currentUser.email),
    'Heartbeat failed'
  );
}



export function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}



// ==================== GLOBAL SYSTEM BOOT ====================
// Settings cache - populated on boot, used sync throughout app
window._settingsCache = {};



export async function loadAppSettings() {
  const applySettings = (settings) => {
    window._settingsCache = {};
    for (const s of settings) window._settingsCache[s.key] = s.value;
    const S = key => window._settingsCache[key] || '';
    window.maintenanceMode = S('maintenance_mode') === 'true';
    announcementText = S('announcement') || '';
    window._privacyMsg = S('privacy_message') || 'Your data is safe with us and is never shared with third parties.';

    // Apply dynamic branding
    if (S('primary_color')) document.documentElement.style.setProperty('--gold-600', S('primary_color'));
    if (S('accent_color')) document.documentElement.style.setProperty('--gold-400', S('accent_color'));
    if (S('app_name')) { const el = document.getElementById('splashAppName'); if (el) el.textContent = S('app_name'); }
    if (S('app_tagline')) { const el = document.getElementById('appTagline'); if (el) el.textContent = S('app_tagline'); }
    if (S('app_for')) { const el = document.getElementById('splashAppForPill'); if (el) { el.textContent = '🎓 ' + S('app_for'); el.style.display = 'inline-block'; } }
    if (S('welcome_message')) { const el = document.getElementById('splashWelcomeMessage'); if (el) { el.textContent = S('welcome_message'); el.style.display = 'block'; } }
  };

  // Settings rarely change but used to be re-fetched from scratch on every
  // single app launch. A 5-minute local cache means most launches apply
  // branding/maintenance-mode instantly from disk with zero network calls.
  const cached = cacheGet('settings', 300000);
  if (cached) { applySettings(cached); return; }

  const { data: settings } = await db(
    sb.from('system_settings').select('*'),
    'App settings load failed'
  );
  if (!settings) return;
  applySettings(settings);
  cacheSet('settings', settings);
}



// Sync getSetting using cache (no DB call needed after boot)
export function getSetting(key, fallback = '') {
  if (window._settingsCache && key in window._settingsCache) return window._settingsCache[key];
  return fallback;
}



// Single source of truth for "is AI on right now". There used to be two
// separate switches that looked like they both turned AI off (the AI Tutor
// Settings checkbox, and the Feature Flags "AI Tutor" toggle) but only one of
// them actually did anything. toggleFeatureFlag() and saveAISettings() now
// keep both in sync, and every AI entry point in the app checks this
// function, so flipping either switch off truly removes AI everywhere.
export function isAIEnabled() {
  return getSetting('ai_enabled', 'true') !== 'false' && isFeatureEnabled('ai_tutor');
}



// ==================== PWA / SERVICE WORKER ====================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  });
}



const NOTIFICATION_FETCH_TTL = 30 * 60 * 1000;
const NOTIFICATION_BASELINE_VERSION = '2026-10-10-v1';
let _notificationFetchAt = 0;
let _notificationFetchPromise = null;
let _notificationFetchUser = null;
let _pendingNotificationOpen = new URLSearchParams(location.search).get('open') === 'notifications';

function _notificationStorageKey(kind) {
  const userKey = window.currentUser?.auth_uid || window.currentUser?.email || 'anonymous';
  return `lum_${kind}_${encodeURIComponent(userKey)}`;
}

function _shownNotificationIds() {
  try { return new Set(JSON.parse(localStorage.getItem(_notificationStorageKey('shown_notifications')) || '[]')); }
  catch { return new Set(); }
}

function _saveShownNotificationIds(ids) {
  try { localStorage.setItem(_notificationStorageKey('shown_notifications'), JSON.stringify([...ids].slice(-200))); }
  catch (e) { console.warn('Could not save notification history', e); }
}

async function _showServiceWorkerNotification(item) {
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(item.title || 'LUMHSian', {
      body: item.body || '',
      tag: String(item.id),
      data: { url: location.origin }
    });
  } catch (e) {
    console.warn('Notification display failed', e);
  }
}



// ==================== IN-APP NOTIFICATION BELL ====================
function checkWhatsNew() {
  const version = getSetting('whats_new_version', '');
  const text = getSetting('whats_new_text', '');
  if (!version || !text) return;
  if (localStorage.getItem('seen_whats_new') === version) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.85);z-index:10006;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:400px;text-align:center">
      <div style="font-size:44px;margin-bottom:8px">✨</div>
      <div class="fw-700 mb-2" style="font-size:18px">What's New</div>
      <p class="text-sm" style="white-space:pre-wrap;line-height:1.6">${text}</p>
      <button class="btn btn-primary mt-3" style="width:100%" onclick="localStorage.setItem('seen_whats_new','${version}');this.closest('[style*=fixed]').remove()">Got it 👍</button>
    </div>`;
  document.body.appendChild(overlay);
}



// Students can delete a notification/announcement from their own bell
// without it disappearing for anyone else — both are shared broadcast rows,
// so "delete" here just means "never show me this one again," tracked
// locally the same lightweight way last-seen already is, rather than
// needing a new per-user table. Keyed by source+id since app_notifications
// and announcements each have their own independent id sequence.
function _getDismissedNotifIds() {
  try { return new Set(JSON.parse(localStorage.getItem('dismissed_notif_ids') || '[]')); }
  catch { return new Set(); }
}
function dismissNotification(source, id) {
  const ids = _getDismissedNotifIds();
  const key = `${source}:${id}`;
  ids.add(key);
  // Cap at the most recent 200 so this can never grow unbounded.
  localStorage.setItem('dismissed_notif_ids', JSON.stringify([...ids].slice(-200)));
  window._appNotifs = (window._appNotifs || []).filter(n => `${n._source}:${n.id}` !== key);
  if (_notificationFetchUser) cacheSet(`notifications_${_notificationFetchUser}`, window._appNotifs);
  _refreshNotificationBadge();
  openNotificationBell(true);
}
window.dismissNotification = dismissNotification;



// Admin messages the student hasn't opened yet. "Seen" is tracked on this device as the highest message id they have
// opened, so no database write is needed just to mark something read.
function _inboxSeenId() { return parseInt(localStorage.getItem('lum_inbox_seen_id') || '0'); }
window._inboxSeenId = _inboxSeenId;
window.checkNewNotifications = checkNewNotifications;   // (function declaration, so it is available from here)

function _refreshNotificationBadge(notifs = window._appNotifs || []) {
  const lastSeen = parseInt(localStorage.getItem(_notificationStorageKey('last_seen_notif_time')) || '0', 10);
  const unread = notifs.filter(n => new Date(n.created_at).getTime() > lastSeen).length;
  const badge = document.getElementById('notifBellBadge');
  if (badge) {
    badge.style.display = unread > 0 ? 'flex' : 'none';
    badge.textContent = unread > 9 ? '9+' : unread;
  }
}
window._refreshNotificationBadge = _refreshNotificationBadge;

async function checkNewNotifications(force = false) {
  if (!window.currentUser || localStorage.getItem('notif_enabled') === 'false') return;
  const currentFetchUser = window.currentUser.auth_uid || window.currentUser.email;
  if (_notificationFetchUser !== currentFetchUser) {
    _notificationFetchUser = currentFetchUser;
    _notificationFetchAt = 0;
    window._appNotifs = null;
  }
  if (!force && window._appNotifs && Date.now() - _notificationFetchAt < NOTIFICATION_FETCH_TTL) return;
  if (_notificationFetchPromise) return _notificationFetchPromise;
  const notificationCacheKey = `notifications_${currentFetchUser}`;
  const cachedNotifs = cacheGet(notificationCacheKey, NOTIFICATION_FETCH_TTL);
  if (cachedNotifs !== null) {
    const seenInboxId = _inboxSeenId();
    window._appNotifs = cachedNotifs.filter(n => n._source !== 'inbox' || Number(n.id) > seenInboxId);
    window._inboxUnread = window._appNotifs.filter(n => n._source === 'inbox').length;
    _notificationFetchAt = Date.now();
    _refreshNotificationBadge();
    return;
  }
  _notificationFetchPromise = (async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const [notifRes, announceRes, inboxRes] = await Promise.all([
      db(sb.from('app_notifications').select('id,title,body,created_at,expires_at,target_college,target_year_id').gte('created_at', cutoff).order('created_at', { ascending: false }).limit(40), 'Notif load failed'),
      db(sb.from('announcements').select('id,title,body,emoji,image_url,created_at,expires_at,target_college,target_year_id,is_active').eq('is_active', true).gte('created_at', cutoff).order('created_at', { ascending: false }).limit(40), 'Announce load failed'),
      db(sb.from('inbox_messages').select('id,kind,body,image_url,created_at').eq('user_email', window.currentUser.email).eq('sender', 'admin').gt('id', _inboxSeenId()).order('id', { ascending: false }).limit(20), 'Inbox notification load failed')
    ]);
    const notifs = (notifRes.data || []).filter(_notifAlive);
    const announces = (announceRes.data || []).filter(_notifAlive);
    const inboxOk = !inboxRes.error;
    const inboxItems = inboxOk ? (inboxRes.data || []) : [];
    window._inboxUnread = inboxItems.length;
    const dismissed = _getDismissedNotifIds();
    const myYearForFilter = await _getMyYear();
    const merged = [
      ...notifs.map(n => ({ ...n, _source: 'notif' })),
      ...announces.map(a => ({ ...a, _source: 'announce' })),
      ...inboxItems.map(m => ({
        id: m.id, _source: 'inbox', created_at: m.created_at,
        title: m.kind === 'reply' ? '📬 Reply to your report' : '✉️ New message from admin',
        body: m.body ? (m.body.substring(0, 140) + (m.body.length > 140 ? '…' : '')) : (m.image_url ? '📷 Photo' : '')
      }))
    ].filter(n =>
      (!n.target_college || n.target_college === window.currentUser.college) &&
      (!n.target_year_id || n.target_year_id === myYearForFilter?.id) &&
      !dismissed.has(`${n._source}:${n.id}`)
    ).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    window._appNotifs = merged;
    if (!notifRes.error && !announceRes.error && inboxOk) {
      cacheSet(notificationCacheKey, merged);
      cacheSet('announcements', announces);
    }

    const baselineKey = _notificationStorageKey('notification_baseline');
    const shownIds = _shownNotificationIds();
    let baselineVersion = null;
    try { baselineVersion = localStorage.getItem(baselineKey); } catch (e) {}
    const isFirstLoad = baselineVersion !== NOTIFICATION_BASELINE_VERSION;
    if (isFirstLoad) {
      merged.forEach(n => shownIds.add(`${n._source}:${n.id}`));
      try { localStorage.setItem(baselineKey, NOTIFICATION_BASELINE_VERSION); } catch (e) {}
    } else {
      for (const item of merged) {
        const idKey = `${item._source}:${item.id}`;
        if (shownIds.has(idKey)) continue;
        shownIds.add(idKey);
        _saveShownNotificationIds(shownIds);
        await _showServiceWorkerNotification(item);
      }
    }
    _saveShownNotificationIds(shownIds);
    _notificationFetchAt = Date.now();

    _refreshNotificationBadge(merged);
  })();
  try { await _notificationFetchPromise; }
  finally { _notificationFetchPromise = null; }
}



async function openNotificationBell(isRerender, filter) {
  filter = filter || 'all';
  if (!isRerender) {
    document.getElementById('notifBellOverlay')?.remove();
    const loading = document.createElement('div');
    loading.id = 'notifBellOverlay';
    loading.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10005;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
    loading.innerHTML = '<div style="background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:var(--radius-xl);width:100%;max-width:420px;padding:28px;text-align:center"><div class="spinner" style="margin:0 auto 12px"></div><p class="text-sm text-muted">Loading notifications...</p></div>';
    document.body.appendChild(loading);
    await checkNewNotifications(true);
    loading.remove();
  }
  const notifs = window._appNotifs || [];
  let lastSeen = parseInt(localStorage.getItem(_notificationStorageKey('last_seen_notif_time')) || '0');
  if (!isRerender) {
    const newest = notifs.length ? Math.max(...notifs.map(n => new Date(n.created_at).getTime())) : Date.now();
    localStorage.setItem(_notificationStorageKey('last_seen_notif_time'), String(newest));
    lastSeen = newest;
    const latestInboxId = Math.max(0, ...notifs.filter(n => n._source === 'inbox' && typeof n.id === 'number').map(n => n.id));
    if (latestInboxId > _inboxSeenId()) localStorage.setItem('lum_inbox_seen_id', String(latestInboxId));
    document.getElementById('notifBellBadge')?.style && (document.getElementById('notifBellBadge').style.display = 'none');
  } else {
    document.getElementById('notifBellOverlay')?.remove();
  }

  const unreadCount = notifs.filter(n => new Date(n.created_at).getTime() > lastSeen).length;
  const visible = filter === 'unread' ? notifs.filter(n => new Date(n.created_at).getTime() > lastSeen) : notifs;

  // A per-type accent (left border + icon chip color) instead of every card
  // looking identical regardless of what kind of notification it is.
  const typeMeta = {
    announce: { color: 'var(--gold-700)', bg: 'var(--gold-50)' },
    report_reply: { color: 'var(--green)', bg: 'var(--green-light)' },
    inbox: { color: 'var(--green)', bg: 'var(--green-light)' },
    notif: { color: 'var(--gold-700)', bg: 'var(--gold-50)' }
  };

  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const today = visible.filter(n => new Date(n.created_at).getTime() >= todayStart.getTime());
  const earlier = visible.filter(n => new Date(n.created_at).getTime() < todayStart.getTime());

  const cardHtml = (n) => {
    const isUnread = new Date(n.created_at).getTime() > lastSeen;
    const meta = typeMeta[n._source] || typeMeta.notif;
    const icon = n._source === 'announce' ? (n.emoji || '📢') : (n._source === 'inbox' ? '✉️' : (n._source === 'report_reply' ? '📬' : '🔔'));
    const isReportReply = n._source === 'report_reply' || n._source === 'inbox';
    return `
      <div style="display:flex;gap:10px;padding:12px;margin-bottom:8px;border-radius:var(--radius-lg);background:${isUnread ? meta.bg : 'var(--surface)'};color:var(--ink);border:1px solid ${isUnread ? meta.color : 'var(--border)'};${isReportReply ? 'cursor:pointer' : ''}" ${isReportReply ? `onclick="this.closest('[style*=fixed]').remove();openInbox()"` : ''}>
        <div style="width:34px;height:34px;border-radius:50%;background:${meta.bg};display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;border:1px solid var(--border)">${icon}</div>
        <div style="min-width:0;flex:1">
          <div class="flex-between" style="align-items:flex-start;gap:6px">
            <div class="fw-700 text-sm" style="min-width:0">${esc(n.title)}</div>
            <button onclick="event.stopPropagation();dismissNotification('${n._source}',${n.id})" title="Remove" style="background:none;border:none;font-size:14px;cursor:pointer;color:var(--ink-4);flex-shrink:0;padding:0">🗑</button>
          </div>
          ${n.body ? `<div class="text-sm" style="margin-top:2px;color:var(--ink-3)">${esc(n.body)}</div>` : ''}
          ${isReportReply ? `<div class="text-xs fw-600" style="color:${meta.color};margin-top:5px">Tap to open your Inbox →</div>` : ''}
          ${n.image_url ? `<img src="${esc(n.image_url)}" style="max-width:100%;border-radius:var(--radius-md);margin-top:6px">` : ''}
          <div class="text-xs text-muted mt-1">${timeAgo(new Date(n.created_at).getTime())}${isUnread ? ' · <span style="color:'+meta.color+';font-weight:700">NEW</span>' : ''}</div>
        </div>
      </div>`;
  };

  const overlay = document.createElement('div');
  overlay.id = 'notifBellOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10005;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:var(--radius-xl);width:100%;max-width:420px;max-height:82vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="padding:16px 18px 12px;border-bottom:1px solid var(--border)">
        <div class="flex-between mb-2">
          <span class="fw-700" style="font-size:16px;font-family:var(--font-display)">🔔 Notifications</span>
          <button onclick="this.closest('[style*=fixed]').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--ink-4)">✕</button>
        </div>
        <div class="flex-between">
          <div class="tab-bar" style="margin:0;flex:1">
            <button class="tab-btn ${filter==='all'?'active':''}" onclick="openNotificationBell(true,'all')">All (${notifs.length})</button>
            <button class="tab-btn ${filter==='unread'?'active':''}" onclick="openNotificationBell(true,'unread')">Unread (${unreadCount})</button>
          </div>
        </div>
      </div>
      <div style="padding:14px 18px 18px;overflow-y:auto">
        ${visible.length ? `
          ${today.length ? `<div class="text-xs fw-700 text-muted mb-2" style="text-transform:uppercase;letter-spacing:.5px">Today</div>${today.map(cardHtml).join('')}` : ''}
          ${earlier.length ? `<div class="text-xs fw-700 text-muted mb-2" style="text-transform:uppercase;letter-spacing:.5px;margin-top:${today.length?'12px':'0'}">Earlier</div>${earlier.map(cardHtml).join('')}` : ''}
        ` : `
          <div style="text-align:center;padding:32px 0">
            <div style="font-size:36px;margin-bottom:8px">🔕</div>
            <p class="text-sm text-muted">${filter==='unread' ? "You're all caught up." : 'No notifications yet.'}</p>
          </div>`}
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.openNotificationBell = openNotificationBell;

async function _flushPendingNotificationOpen() {
  if (!_pendingNotificationOpen || !window.currentUser || !window._notificationAuthReady) return;
  _pendingNotificationOpen = false;
  const url = new URL(location.href);
  url.searchParams.delete('open');
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  await openNotificationBell();
}
window._flushPendingNotificationOpen = _flushPendingNotificationOpen;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type !== 'open-notifications') return;
    _pendingNotificationOpen = true;
    _flushPendingNotificationOpen().catch(e => console.warn('Could not open notifications', e));
  });
}



// Check dark mode on load — only ever respect an explicit in-app choice.
// The OS-level "system dark mode" setting is intentionally ignored here so the
// app always starts in light mode for every student, even if their phone is
// set to dark mode system-wide. Dark mode only turns on if they flip the
// Dark Mode switch in Profile themselves.
if (localStorage.getItem('dark_mode') === 'true') {
  applyDarkMode(true);
}



// ==================== OFFLINE DETECTION ====================
window.addEventListener('online', () => showToast('🌐 Back online'));


window.addEventListener('offline', () => showToast('⚠️ You are offline. Some features may not work.', 5000));



// Save test state whenever app goes to background
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    persistActiveTest(); saveAppState();
  } else if (document.visibilityState === 'visible') {
    _onAppForeground();
  }
});


// Also save on page hide (iOS Safari)
window.addEventListener('pagehide', () => { persistActiveTest(); saveAppState(); });



// Re-render the current screen when app comes back to foreground.
// Fixes: admin tab button says "Media" but content shows Overview.
function _onAppForeground() {
  try {
    if (!window.currentUser) return;
    const activeEl = document.querySelector('.screen.active');
    if (!activeEl) return;
    const screenId = activeEl.id.replace('screen-', '');
    if (['splash','createaccount','test'].includes(screenId)) return;

    if (screenId === 'admin') {
      if (!window.currentUser.is_admin) return;
      // Re-render the active tab using adminShowTab (handles button highlight + content).
      // adminShowTab(..., true) preserves _currentContentTab/_currentQSubTab in memory, and
      // adminContent()/adminCourses()/adminQuestions() now automatically re-open whichever
      // nested sub-tab those hold — no need to manually re-navigate here (doing so used to
      // wipe the sub-tab right after it was correctly restored).
      adminShowTab(window._currentAdminTab || 'overview', true);
      // After render settles, just refill whatever was typed
      setTimeout(() => {
        _refillFormData();
      }, 400);
      return;
    }

    // All other screens — re-render in place
    const renders = {
      home: renderHome, modules: renderModulesScreen, search: renderSearch,
      stats: renderStats, profile: renderProfile,
      bookmarks: renderBookmarks, planner: renderPlanner,
      module: () => {
        if (window._moduleScreenMode === 'pastpapers') {
          // Deliberately always resume to the college list (root), never deep
          // into a specific college — replaying an old saved collegeKey here
          // could show a stale list if the admin/student's effective year
          // changed since the last visit. openPastPapersRoot() re-resolves
          // "my year" fresh every time, so this is always correct.
          openPastPapersRoot();
        } else if (window._lastOpenedModule) {
          const m = window._lastOpenedModule;
          openModule(m.moduleId, m.moduleName, m.iconUrl||'', m.color||'', m.fromYearId||null, m.fromYearName||null);
        }
      },
      results: () => { if (window.activeTest) renderResults(); },
      review: () => {
        if (window._qvState) { renderQuickView(); showScreen('review', false); }
        else if (window.reviewState) { renderReview(); showScreen('review', false); }
      }
    };
    if (renders[screenId]) renders[screenId]();
  } catch(e) { console.error('_onAppForeground:', e); }
}



// Apply saved form field values to the DOM. Handles cascading dropdowns (e.g. picking a
// Module repopulates Subject/Past-Paper/Test options via its onchange, and picking a
// Subject further repopulates Test options via its own onchange) by calling each restored
// select's onchange handler directly and AWAITING it before moving to the next one, in DOM
// order — so a 2-level chain (module -> subject -> test) restores correctly instead of a
// later field's value getting set before its options actually exist.
async function _applyFormData(formData) {
  if (!formData) return;
  const cascadeIds = [];
  // First pass: every plain field (no onchange) can be set immediately.
  Object.entries(formData).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.tagName === 'SELECT' && el.getAttribute('onchange')) { cascadeIds.push(id); return; }
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = val;
    else el.value = val;
  });
  // Second pass: cascading selects, IN ORDER — set this one's value, run its onchange
  // handler and wait for it, THEN move to the next (which may depend on what this one
  // just repopulated, e.g. Subject's test list depending on Module having loaded first).
  for (const id of cascadeIds) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (formData[id]) el.value = formData[id];
    const fnName = el.getAttribute('onchange')?.match(/^(\w+)\(\)$/)?.[1];
    if (fnName && typeof window[fnName] === 'function') {
      try { await window[fnName](); } catch (e) {}
    }
  }
  // Final pass: non-cascading selects whose options may only exist now that the
  // cascades above have finished populating them (e.g. Past Paper, Practice Test).
  Object.entries(formData).forEach(([id, val]) => {
    if (cascadeIds.includes(id)) return;
    const el = document.getElementById(id);
    if (!el || el.tagName !== 'SELECT') return;
    el.value = val;
  });
}



// Refill saved form field values after a tab re-render
function _refillFormData() {
  try {
    const raw = localStorage.getItem(APP_STATE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    if (!state || Date.now() - state.ts > APP_STATE_MAX_AGE) return;
    _applyFormData(state.formData);
  } catch(e) {}
}



// Returns true if a newer render has started — stale renders should bail out
export function _renderStale(token) { return window._adminRenderToken !== token; }



// ==================== APP STATE PERSISTENCE (background resume) ====================
// Goal: if Android/iOS kills the page in the background (low memory, OEM battery
// managers like MIUI/ColorOS, or just a long time away) and it reloads from scratch,
// the user should NOT land back on the home screen / lose whatever they were typing
// (admin forms especially). We continuously snapshot "where the user is" and "what
// they've typed" and silently restore it on the next load, instead of the resume
// dialog used for timed tests.
const APP_STATE_KEY = 'lum_app_state';


const APP_STATE_MAX_AGE = 24 * 3600 * 1000;

 // treat anything older than this as a fresh session
const APP_STATE_RESTORABLE_SCREENS = ['home','modules','search','stats','profile','bookmarks','wrongattempts','planner','savedtests','admin','module','results','review'];



export function saveAppState() {
  try {
    const activeScreen = document.querySelector('.screen.active');
    const screenId = activeScreen ? activeScreen.id.replace('screen-', '') : null;
    if (!screenId || !APP_STATE_RESTORABLE_SCREENS.includes(screenId)) return;

    const formData = {};
    document.querySelectorAll('input[id], textarea[id], select[id]').forEach(el => {
      if (el.type === 'password' || el.type === 'file') return;
      formData[el.id] = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value;
    });

    // Extra state for screens that need data to re-render themselves on restore
    let moduleState = null, savedActiveTest = null, savedReviewState = null, pastPapersState = null;
    if (screenId === 'module' && window._moduleScreenMode === 'pastpapers' && window._lastOpenedPastPapers) {
      pastPapersState = window._lastOpenedPastPapers;
    } else if (screenId === 'module' && window._lastOpenedModule) {
      moduleState = window._lastOpenedModule;
    }
    if (screenId === 'results' && window.activeTest) {
      try { savedActiveTest = JSON.parse(JSON.stringify(window.activeTest)); } catch(e) {}
    }
    if (screenId === 'review' && window.reviewState) {
      try { savedReviewState = JSON.parse(JSON.stringify({ ...window.reviewState, bookmarked: Array.from(window.reviewState.bookmarked || []) })); } catch(e) {}
    }
    localStorage.setItem(APP_STATE_KEY, JSON.stringify({
      screenId,
      navStack: Array.isArray(window.navStack) ? window.navStack.slice() : [],
      adminTab: screenId === 'admin' ? (window._currentAdminTab || 'overview') : null,
      contentTab: screenId === 'admin' ? (window._currentContentTab || null) : null,
      qSubTab: screenId === 'admin' ? (window._currentQSubTab || null) : null,
      scrollY: window.scrollY,
      formData,
      moduleState,
      pastPapersState,
      savedActiveTest,
      savedReviewState,
      ts: Date.now()
    }));
  } catch (e) { /* storage unavailable — fail silently, not critical */ }
}



export function clearAppState() { try { localStorage.removeItem(APP_STATE_KEY); } catch (e) {} }



export const saveAppStateDebounced = _debounce(saveAppState, 800);


// Catch typing in any form field across the whole app (admin forms especially)
document.addEventListener('input', saveAppStateDebounced);


// Catch dropdown / checkbox changes
document.addEventListener('change', saveAppStateDebounced);



// Called once at boot, after login/session is confirmed. Returns true if it restored
// something, so the normal "go to home / go to admin overview" logic can be skipped.
export async function restoreAppState() {
  try {
    const raw = localStorage.getItem(APP_STATE_KEY);
    if (!raw) return false;
    const state = JSON.parse(raw);
    if (!state || !state.screenId) return false;
    if (Date.now() - state.ts > APP_STATE_MAX_AGE) { clearAppState(); return false; }
    if (!APP_STATE_RESTORABLE_SCREENS.includes(state.screenId)) return false;
    // Admin state should only ever be restored into an actual admin session, and vice versa
    if (state.screenId === 'admin' && !window.currentUser?.is_admin) return false;
    if (state.screenId !== 'admin' && window.currentUser?.is_admin) return false;

    // ---- module screen: re-run openModule, or re-open Past Papers, with saved params ----
    if (state.screenId === 'module') {
      if (state.pastPapersState) {
        // Deliberately resume to the college list (root) only, not deep into
        // a saved college — openPastPapersRoot() re-resolves "my year" fresh
        // each time, so this can never show a stale/wrong year's papers.
        await openPastPapersRoot();
        restoreNavigationStack(state.navStack, state.screenId);
        setTimeout(() => window.scrollTo(0, state.scrollY || 0), 300);
        return true;
      }
      if (!state.moduleState) return false; // can't restore without saved module params
      const m = state.moduleState;
      await openModule(m.moduleId, m.moduleName, m.iconUrl || '', m.color || '');
      restoreNavigationStack(state.navStack, state.screenId);
      // openModule already calls showScreen('module') internally, so skip generic render below
      setTimeout(() => window.scrollTo(0, state.scrollY || 0), 300);
      return true;
    }

    // ---- results screen: restore activeTest then re-render ----
    if (state.screenId === 'results') {
      if (!state.savedActiveTest) return false;
      window.activeTest = state.savedActiveTest;
      renderResults(); // re-renders resultsPageWrap and calls showScreen('results')
      restoreNavigationStack(state.navStack, state.screenId);
      setTimeout(() => window.scrollTo(0, state.scrollY || 0), 300);
      return true;
    }

    // ---- review screen: restore reviewState then re-render ----
    if (state.screenId === 'review') {
      if (!state.savedReviewState) return false;
      // Also restore activeTest so "Back to results" works if user presses it
      if (state.savedActiveTest) window.activeTest = state.savedActiveTest;
      window.reviewState = { ...state.savedReviewState, bookmarked: new Set(state.savedReviewState.bookmarked || []) };
      renderReview();
      showScreen('review', false);
      restoreNavigationStack(state.navStack, state.screenId);
      setTimeout(() => window.scrollTo(0, state.scrollY || 0), 300);
      return true;
    }

    const renders = {
      home: renderHome, modules: renderModulesScreen, search: renderSearch, stats: renderStats,
      profile: renderProfile, bookmarks: renderBookmarks, wrongattempts: renderWrongAttempts, planner: renderPlanner, savedtests: renderSavedTests,
      admin: () => renderAdminPanel(state.adminTab || 'overview')
    };
    if (renders[state.screenId]) await renders[state.screenId]();
    showScreen(state.screenId, false);
    restoreNavigationStack(state.navStack, state.screenId);
    // Restore inner content sub-tab (and its own Add/Browse/Bulk sub-tab) if saved
    if (state.screenId === 'admin' && state.contentTab) {
      setTimeout(() => {
        window._currentQSubTab = state.qSubTab || null;
        const btn = [...document.querySelectorAll('.tab-bar .tab-btn')]
          .find(b => b.getAttribute('onclick')?.includes(`'${state.contentTab}'`));
        adminContentTab(state.contentTab, btn || null, true);
      }, 200);
    }

    // Give the just-rendered HTML a moment to settle, then refill whatever was typed
    setTimeout(() => {
      _applyFormData(state.formData);
      window.scrollTo(0, state.scrollY || 0);
    }, 400);
    return true;
  } catch (e) { console.error('Restore app state failed:', e); return false; }
}



// ==================== KEYBOARD SHORTCUTS (Admin) ====================
document.addEventListener('keydown', e => {
  if (!window.currentUser?.is_admin) return;
  if (e.ctrlKey && e.key === 'k') { e.preventDefault(); adminShowTab('students'); }
  if (e.ctrlKey && e.key === 'l') { e.preventDefault(); adminShowTab('analytics'); }
});

// A real, static, network-fetchable manifest.json (see the file delivered
// alongside this one) — NOT built as a Blob. A blob: URL only exists inside
// this one browser tab's memory, so while it's good enough for the browser
// to read in-page (which is why the install prompt/banner below still shows
// up), Chrome's actual Android install flow needs to hand the manifest +
// icons to Google's own WebAPK-signing service to build a real standalone
// app — and that service can't fetch a blob: URL at all, since it isn't a
// real network resource. The install silently fell back to a plain
// bookmark shortcut instead, which is exactly why it opened in ordinary
// Chrome instead of launching standalone. manifest.json must be uploaded to
// the site's root (same folder as index.html/sw.js) for this to resolve.
const manifestLink = document.createElement('link');
manifestLink.rel = 'manifest';
manifestLink.href = '/manifest.json';
document.head.appendChild(manifestLink);



// Theme color meta
const metaTheme = document.createElement('meta');


metaTheme.name = 'theme-color';


metaTheme.content = localStorage.getItem('dark_mode') === 'true' ? '#000000' : '#c9980a';


document.head.appendChild(metaTheme);



// Apple PWA tags
const appleCapable = document.createElement('meta');


appleCapable.name = 'apple-mobile-web-app-capable';


appleCapable.content = 'yes';


document.head.appendChild(appleCapable);


const appleStatus = document.createElement('meta');


appleStatus.name = 'apple-mobile-web-app-status-bar-style';


appleStatus.content = 'black-translucent';


document.head.appendChild(appleStatus);



// ==================== FEATURE FLAG CHECK ====================
// Flags are cached on boot via loadAppSettings - no per-call DB query
window._featureFlags = {};



async function loadFeatureFlags() {
  const cached = cacheGet('feature_flags', 300000);
  if (cached) { window._featureFlags = cached; return; }
  const { data } = await db(sb.from('feature_flags').select('name,is_enabled'), 'Flags load failed');
  if (data) {
    window._featureFlags = {};
    for (const f of data) window._featureFlags[f.name] = f.is_enabled;
    cacheSet('feature_flags', window._featureFlags);
  }
}



export function isFeatureEnabled(featureName) {
  if (featureName in window._featureFlags) return window._featureFlags[featureName];
  return true; // default: enabled
}



// ==================== SEARCH (category tabs + module filter) ====================
// Remembers the last search (term/module/category) at module scope, purely so
// that returning to Search after Quick View — or any other re-render of this
// screen — restores what was there instead of showing a blank box.
let _lastSearchTerm = '';
let _lastSearchModuleId = '';
let _lastSearchType = 'all';

function _searchTypeTabsHtml() {
  const types = [['all', 'All'], ['modules', '📚 Modules'], ['questions', '❓ Questions'], ['tests', '🎯 Tests']];
  return types.map(([id, label]) => `<button class="tab-btn ${id === _lastSearchType ? 'active' : ''}" onclick="setSearchType('${id}')">${label}</button>`).join('');
}


function setSearchType(type) {
  _lastSearchType = type;
  const bar = document.getElementById('searchTypeTabs');
  if (bar) bar.innerHTML = _searchTypeTabsHtml();
  executeSearch();
}
window.setSearchType = setSearchType;


export async function renderSearch(term = '') {
  const wrap = document.getElementById('searchPageWrap');
  // Scoped to the student's own year — same rule as everywhere else now
  // (Past Papers, Home's "My Modules"): search should only ever surface
  // this year's content, not every year mixed together.
  const myYear = await _getMyYear();
  let modules = [];
  if (myYear) {
    const { data: yearModules } = await db(sb.from('year_modules').select('module_id').eq('year_id', myYear.id), 'Modules error');
    const moduleIds = (yearModules || []).map(ym => ym.module_id);
    if (moduleIds.length) {
      const { data } = await db(sb.from('modules').select('id,name').in('id', moduleIds), 'Modules error');
      modules = data || [];
    }
  }

  // No explicit term (e.g. re-rendered by back-navigation, not a fresh open) —
  // restore whatever was last searched instead of showing a blank box.
  if (!term && _lastSearchTerm) term = _lastSearchTerm;

  wrap.innerHTML = `
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2" style="font-family:var(--font-display)">🔍 Search</div>
      ${!myYear ? '<p class="text-xs text-muted mb-2">Set your academic year in Profile to search your modules.</p>' : ''}
      <div class="input-group mb-2">
        <input type="text" id="searchInput" class="input-field" placeholder="Search questions, modules, tests..." value="${esc(term)}" oninput="executeSearchDebounced()" onkeydown="if(event.key==='Enter')executeSearch()" style="margin:0;flex:1">
        <button class="btn btn-primary" style="width:auto;flex-shrink:0" onclick="executeSearch()">Search</button>
      </div>
      <div class="tab-bar" id="searchTypeTabs">${_searchTypeTabsHtml()}</div>
      <select id="searchModule" class="input-field" title="Filter by module" aria-label="Filter by module" onchange="executeSearch()">
        <option value="">All Modules</option>
        ${(modules||[]).map(m => `<option value="${m.id}" ${String(m.id)===String(_lastSearchModuleId)?'selected':''}>${esc(m.name)}</option>`).join('')}
      </select>
    </div>
    <div id="searchResults"></div>`;

  if (term || _lastSearchModuleId) executeSearch();
}



async function executeSearch() {
  const term = document.getElementById('searchInput')?.value.trim() || '';
  const moduleId = document.getElementById('searchModule')?.value || '';
  const type = _lastSearchType || 'all';
  _lastSearchTerm = term;
  _lastSearchModuleId = moduleId;
  const resWrap = document.getElementById('searchResults');
  if (!resWrap) return;
  if (!term && !moduleId) { resWrap.innerHTML = ''; return; }

  resWrap.innerHTML = skeletonList(2, false);

  // Same year-scoping as renderSearch above — every query below stays
  // within the student's own year's modules, never searching other years'
  // content mixed in.
  const myYear = await _getMyYear();
  let myModuleIds = [];
  if (myYear) {
    const { data: yearModules } = await db(sb.from('year_modules').select('module_id').eq('year_id', myYear.id), 'Modules error');
    myModuleIds = (yearModules || []).map(ym => ym.module_id);
  }
  if (!myModuleIds.length) { resWrap.innerHTML = '<p class="text-sm text-muted text-center">Set your academic year in Profile to search.</p>'; return; }

  const wantModules = type === 'all' || type === 'modules';
  const wantQuestions = type === 'all' || type === 'questions';
  const wantTests = type === 'all' || type === 'tests';

  let moduleMatchHtml = '', subjectMatchHtml = '', testsMatchHtml = '', questionsHtml = '';
  let anyResult = false;

  // Modules + Subjects — only meaningful as a text search within "my" modules,
  // and skipped once a specific module is already selected (searching for
  // modules matching a name while also filtered to one specific module isn't
  // a useful combination).
  if (wantModules && term && !moduleId) {
    const [modsRes, subRes] = await Promise.all([
      db(sb.from('modules').select('id,name,icon_url').in('id', myModuleIds).ilike('name', `%${term}%`).limit(8), 'Modules search failed'),
      db(sb.from('subjects').select('id,name,module_id,modules(name)').in('module_id', myModuleIds).ilike('name', `%${term}%`).limit(8), 'Subjects search failed')
    ]);
    if (modsRes.data?.length) {
      anyResult = true;
      moduleMatchHtml = `<div class="section-label">Modules</div>` +
        modsRes.data.map(m => `
          <div class="list-item" onclick="openModule(${m.id},'${escJs(m.name)}','${escJs(m.icon_url||'')}','',null,null)">
            <div class="list-item-left">
              <img src="${m.icon_url||'https://placehold.co/36x36/fdf3c0/c9980a?text=📚'}" style="width:36px;height:36px;border-radius:8px;object-fit:cover" onerror="this.src='https://placehold.co/36x36/fdf3c0/c9980a?text=📚'">
              <div><div class="list-item-title">${esc(m.name)}</div><div class="list-item-sub">Tap to open module</div></div>
            </div>
            <span style="color:var(--ink-4)">›</span>
          </div>`).join('');
    }
    if (subRes.data?.length) {
      anyResult = true;
      subjectMatchHtml = `<div class="section-label">Subjects</div>` +
        subRes.data.map(s => `
          <div class="list-item no-hover" style="flex-direction:column;align-items:stretch;cursor:default">
            <div class="list-item-left" style="width:100%">
              <div class="list-item-icon">${ICON_BOOK}</div>
              <div><div class="list-item-title">${esc(s.name)}</div><div class="list-item-sub">in ${esc(s.modules?.name || 'Unknown Module')}</div></div>
            </div>
          </div>`).join('');
    }
  }

  // Practice Tests — new category, wasn't searchable at all before. Reuses the
  // exact same startTest() Review/Attempt actions as everywhere else in the app.
  if (wantTests) {
    let tq = sb.from('practice_tests').select('id,title,module_id,subject_id,modules(name)').in('module_id', myModuleIds).eq('is_active', true).limit(20);
    if (term) tq = tq.ilike('title', `%${term}%`);
    if (moduleId) tq = tq.eq('module_id', moduleId);
    const { data: testRows } = await db(tq, 'Practice test search failed');
    const rows = testRows || [];
    if (rows.length) {
      const counts = await getQuestionCountsBy('practice_test_id', rows.map(t => t.id));
      const withQs = rows.filter(t => counts[t.id]);
      if (withQs.length) {
        anyResult = true;
        testsMatchHtml = `<div class="section-label">🎯 Practice Tests</div>` +
          withQs.map(t => `
            <div class="list-item no-hover" style="flex-direction:column;align-items:stretch;cursor:default">
              <div class="list-item-left" style="width:100%">
                <div class="list-item-icon">${ICON_TARGET}</div>
                <div style="min-width:0"><div class="list-item-title">${esc(t.title)}</div><div class="list-item-sub">${esc(t.modules?.name||'')} · ${counts[t.id]||0} questions</div></div>
              </div>
              <div class="btn-row mt-2">
                <button class="btn btn-secondary btn-sm" onclick="startTest('browse',${t.module_id},'${escJs(t.modules?.name||'')}',null,null,null,${t.id},'${escJs(t.title)}')">👁 Review</button>
                <button class="btn btn-primary btn-sm" onclick="startTest('attempt',${t.module_id},'${escJs(t.modules?.name||'')}',null,null,null,${t.id},'${escJs(t.title)}')">📝 Attempt</button>
              </div>
            </div>`).join('');
      }
    }
  }

  // Questions
  if (wantQuestions) {
    let query = sb.from('questions').select('id,text,explanation,difficulty,options,correct_answer,module_id,modules(name)').in('module_id', myModuleIds).order('id', { ascending: false }).limit(40);
    if (term) query = query.ilike('text', `%${term}%`);
    if (moduleId) query = query.eq('module_id', moduleId);
    const { data: results } = await db(query, 'Search failed');

    if (results?.length) {
      anyResult = true;
      questionsHtml = `<div class="section-label">❓ Questions</div>
         <div class="text-xs text-muted mb-2" style="padding-left:4px">${results.length} result${results.length !== 1 ? 's' : ''}</div>` +
        results.map(q => `
          <div class="card" style="margin-bottom:8px">
            <div class="flex-between mb-1">
              <span class="text-xs text-muted">${esc(q.modules?.name || 'Unknown')}</span>
              <span class="badge badge-${q.difficulty==='easy'?'green':q.difficulty==='hard'?'red':'teal'} text-xs">${esc(q.difficulty)||'medium'}</span>
            </div>
            <div style="font-size:14px;font-weight:500;line-height:1.5;margin-bottom:10px">${esc(q.text?.substring(0,150))}${q.text?.length>150?'...':''}</div>
            <div class="btn-row">
              ${isAIEnabled() ? `<button class="btn btn-secondary btn-xs" onclick="openAITutor('${escJs(q.text||'')}','${escJs(q.explanation||'')}')">🤖 AI Explain</button>` : ''}
              <button class="btn btn-ghost btn-xs" onclick="quickViewQuestion(${q.id})">👁 Quick View</button>
            </div>
          </div>`).join('');
    }
  }

  if (!anyResult) {
    const label = type === 'modules' ? 'modules or subjects' : type === 'questions' ? 'questions' : type === 'tests' ? 'practice tests' : 'results';
    resWrap.innerHTML = `<div class="card text-center"><p>No ${label} found${term ? ` for "${esc(term)}"` : ''}.</p></div>`;
    return;
  }

  resWrap.innerHTML = moduleMatchHtml + subjectMatchHtml + testsMatchHtml + questionsHtml;
}
window.executeSearch = executeSearch;


// 350ms after the last keystroke — used by the live oninput handler above so
// typing doesn't fire a Supabase query on every character.
const executeSearchDebounced = _debounce(executeSearch, 350);
window.executeSearchDebounced = executeSearchDebounced;



// ==================== ACTIVITY LOGGING ====================
export async function logActivity(action, data = {}) {
  if (!window.currentUser) return;
  await db(sb.from('activity_logs').insert({
    user_email: window.currentUser.email,
    action,
    data: JSON.stringify(data),
    screen: window.navStack[window.navStack.length - 1] || 'unknown',
    created_at: new Date().toISOString()
  }), 'Log failed');
}

// ==================== COMPLETE SUPABASE SQL SCHEMA ====================
/*
====================================================
  PASTE THIS ENTIRE BLOCK IN SUPABASE SQL EDITOR
  (Dashboard → SQL Editor → New Query → Paste → Run)
====================================================

-- ENABLE UUID EXTENSION
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============ CORE TABLES ============

CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  auth_uid UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  password_hash TEXT, -- legacy only; unused now that login is via Google
  gender TEXT DEFAULT 'male',
  college TEXT,
  city TEXT,
  dob DATE DEFAULT '2005-01-01',
  profile_completed BOOLEAN DEFAULT FALSE,
  joined BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  last_active BIGINT,
  last_heartbeat TIMESTAMPTZ,
  current_screen TEXT,
  is_admin BOOLEAN DEFAULT FALSE,
  is_banned BOOLEAN DEFAULT FALSE,
  profile_image TEXT,
  phone TEXT,
  year_of_study TEXT,
  enrollment_number TEXT
);

CREATE TABLE IF NOT EXISTS user_stats (
  email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  total_tests INTEGER DEFAULT 0,
  total_questions INTEGER DEFAULT 0,
  total_correct INTEGER DEFAULT 0,
  best_score INTEGER DEFAULT 0,
  streak INTEGER DEFAULT 0,
  last_practice_date TEXT,
  history JSONB DEFAULT '[]',
  subject_stats JSONB DEFAULT '{}',
  paper_stats JSONB DEFAULT '{}',
  test_stats JSONB DEFAULT '{}',
  completed_attempt_tests INTEGER DEFAULT 0
);

-- MIGRATION (safe to re-run): submitTest() in the app writes paper_stats/test_stats
-- on every Past Paper or named Practice Test submission. Those two columns were
-- missing from this table, so Supabase rejected the ENTIRE upsert (not just those
-- two fields) with an unknown-column error every time — which silently wiped out
-- total_tests/history/streak/etc. for that submission too. This is why stats
-- weren't saving and admin never saw the attempt. Run this once against the real
-- database (SQL Editor in Supabase) — editing this file alone does not patch a
-- database that already exists:
ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS paper_stats JSONB DEFAULT '{}';
ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS test_stats JSONB DEFAULT '{}';

-- MIGRATION (safe to re-run): switching years now resets a student's visible
-- stats to zero (see selectYear() in this file) rather than just locking the
-- old year's content by name-mismatch. The old numbers are archived into this
-- column first rather than being dropped outright. Written in a separate call
-- from the reset itself, so a missing column here only loses the archive, not
-- the reset the student is actually waiting on — but run this once against
-- the real database for the archive to actually work:
ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS archived_years JSONB DEFAULT '{}';

-- MIGRATION (safe to re-run): Build Your Own Test can now also pull from past
-- papers and specific practice tests, not just whole modules/subjects (see
-- startCustomTest() in quiz.js and openCustomTestBuilder() in this file).
-- Saving a custom test with either of those selected needs these two columns:
ALTER TABLE custom_tests ADD COLUMN IF NOT EXISTS paper_ids INTEGER[] DEFAULT '{}';
ALTER TABLE custom_tests ADD COLUMN IF NOT EXISTS test_ids INTEGER[] DEFAULT '{}';

ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS attempt_questions INTEGER DEFAULT 0;
ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS attempt_correct INTEGER DEFAULT 0;

-- MIGRATION (safe to re-run): Inbox (admin <-> student chat), per-notification duration, lifetime skipped count.
CREATE TABLE IF NOT EXISTS inbox_messages (
  id BIGSERIAL PRIMARY KEY,
  user_email TEXT NOT NULL,            -- the student this conversation belongs to
  sender TEXT NOT NULL DEFAULT 'admin',  -- 'admin' | 'student'
  kind TEXT NOT NULL DEFAULT 'message',  -- 'message' | 'reply' | 'report'
  body TEXT,
  image_url TEXT,
  ref_id BIGINT,                       -- reports_feedback.id this message belongs to (reports / replies)
  quote TEXT,                          -- the student's original text, shown above an admin reply
  created_at TIMESTAMPTZ DEFAULT NOW(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_user ON inbox_messages(user_email, created_at DESC);
ALTER TABLE inbox_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inbox_select_own_or_admin" ON inbox_messages;
DROP POLICY IF EXISTS "inbox_insert_admin_or_own" ON inbox_messages;
DROP POLICY IF EXISTS "inbox_update_admin_only" ON inbox_messages;
DROP POLICY IF EXISTS "inbox_delete_own_or_admin" ON inbox_messages;
CREATE POLICY "inbox_select_own_or_admin" ON inbox_messages FOR SELECT
  USING (user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin());
CREATE POLICY "inbox_insert_admin_or_own" ON inbox_messages FOR INSERT
  WITH CHECK (is_current_user_admin() OR (sender = 'student' AND user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid())));
CREATE POLICY "inbox_update_admin_only" ON inbox_messages FOR UPDATE USING (is_current_user_admin());
CREATE POLICY "inbox_delete_own_or_admin" ON inbox_messages FOR DELETE
  USING (user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin());
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE inbox_messages; EXCEPTION WHEN OTHERS THEN NULL; END $$;  -- instant delivery (optional)
ALTER TABLE app_notifications ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS total_skipped INTEGER DEFAULT 0;
UPDATE user_stats SET total_skipped = COALESCE((SELECT SUM(COALESCE((h->>'skipped')::int, 0)) FROM jsonb_array_elements(history) h WHERE COALESCE(h->>'mode','') <> 'browse'), 0)
  WHERE COALESCE(total_skipped, 0) = 0 AND history IS NOT NULL AND jsonb_typeof(history) = 'array';

ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS attempt_answered INTEGER DEFAULT 0;
UPDATE user_stats SET attempt_answered = attempt_questions WHERE COALESCE(attempt_answered, 0) = 0 AND COALESCE(attempt_questions, 0) > 0;

ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS completed_attempt_tests INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS institutes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  abbreviation TEXT,
  city TEXT,
  province TEXT,
  logo_url TEXT,
  website TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Alias: colleges table (same as institutes, keep both for compatibility)
CREATE TABLE IF NOT EXISTS colleges (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  abbreviation TEXT,
  city TEXT,
  province TEXT,
  logo_url TEXT,
  website TEXT,
  university TEXT DEFAULT 'LUMHS', -- parent university (future multi-uni support)
  type TEXT DEFAULT 'medical',      -- medical | dental | other (future BDS/other support)
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS years (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  display_order INTEGER DEFAULT 1,
  is_active BOOLEAN DEFAULT TRUE,
  coming_soon_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS modules (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  icon_url TEXT,
  color TEXT DEFAULT '#c9980a',
  display_order INTEGER DEFAULT 1,
  category TEXT DEFAULT 'mbbs', -- mbbs | bds | mdcat | other (future multi-dept support)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS year_modules (
  id SERIAL PRIMARY KEY,
  year_id INTEGER REFERENCES years(id) ON DELETE CASCADE,
  module_id INTEGER REFERENCES modules(id) ON DELETE CASCADE,
  display_order INTEGER DEFAULT 1,
  UNIQUE(year_id, module_id)
);

CREATE TABLE IF NOT EXISTS subjects (
  id SERIAL PRIMARY KEY,
  module_id INTEGER REFERENCES modules(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_order INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS questions (
  id SERIAL PRIMARY KEY,
  module_id INTEGER REFERENCES modules(id) ON DELETE CASCADE,
  subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
  year_id INTEGER REFERENCES years(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '[]',
  correct_answer INTEGER NOT NULL DEFAULT 0,
  explanation TEXT,
  image_url TEXT,
  explanation_image_url TEXT,
  difficulty TEXT DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  tags JSONB DEFAULT '[]',
  is_published BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id SERIAL PRIMARY KEY,
  email TEXT REFERENCES users(email) ON DELETE CASCADE,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  added_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  was_correct BOOLEAN,
  UNIQUE(email, question_id)
);

-- NEW (2026-07): questions a student got wrong during a real Attempt/Practice
-- session, auto-saved so they can revisit and clear them from Profile → Wrong
-- Attempts. Same shape as bookmarks on purpose — same access pattern (own rows
-- only), same UNIQUE-per-question upsert behavior.
CREATE TABLE IF NOT EXISTS wrong_attempts (
  id SERIAL PRIMARY KEY,
  email TEXT REFERENCES users(email) ON DELETE CASCADE,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  last_wrong_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  wrong_count INTEGER DEFAULT 1,
  UNIQUE(email, question_id)
);

CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  title TEXT,
  body TEXT,
  emoji TEXT DEFAULT '📢',
  image_url TEXT,
  target_college TEXT,
  type TEXT DEFAULT 'general',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS about_cards (
  id SERIAL PRIMARY KEY,
  image_url TEXT,
  title TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feature_flags (
  name TEXT PRIMARY KEY,
  label TEXT,
  description TEXT,
  is_enabled BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC DEFAULT 0,
  billing_cycle TEXT DEFAULT 'month',
  duration_days INTEGER DEFAULT 30,
  features JSONB DEFAULT '[]',
  is_active BOOLEAN DEFAULT FALSE,
  is_featured BOOLEAN DEFAULT FALSE,
  is_free BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_email TEXT REFERENCES users(email) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES subscription_plans(id),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','active','expired','cancelled')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  details TEXT,
  admin_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id SERIAL PRIMARY KEY,
  user_email TEXT,
  action TEXT,
  data JSONB,
  screen TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS media_library (
  id SERIAL PRIMARY KEY,
  name TEXT,
  url TEXT NOT NULL,
  type TEXT,
  tag TEXT DEFAULT 'general',
  size INTEGER,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  uploaded_by TEXT
);

-- ============ DEFAULT DATA ============

INSERT INTO system_settings (key, value) VALUES
  ('app_name', 'LUMHSian'),
  ('app_tagline', 'AI-powered MBBS QBank · Past Papers'),
  ('maintenance_mode', 'false'),
  ('signup_enabled', 'true'),
  ('otp_required', 'true'),
  ('payment_enabled', 'false'),
  ('currency', 'PKR'),
  ('free_trial_days', '7'),
  ('payment_gateway', 'manual'),
  ('ai_enabled', 'true'),
  ('ai_provider', 'deepseek'),
  ('primary_color', '#c9980a'),
  ('accent_color', '#e8a820'),
  ('privacy_message', 'Your data is safe with us and is never shared with third parties.'),
  ('contact_email', 'lumhsianpro@gmail.com')
ON CONFLICT (key) DO NOTHING;

INSERT INTO feature_flags (name, label, description, is_enabled) VALUES
  ('ai_tutor', '🤖 AI Tutor', 'AI-powered explanation for MCQs', TRUE),
  ('bookmarks', '📖 Bookmarks', 'Save MCQs for later review', TRUE),
  ('past_papers', '📜 Past Papers', 'Timed past paper exams', TRUE),
  ('planner', '📅 Study Planner', 'Daily goal and streak system', TRUE),
  ('dark_mode', '🌙 Dark Mode', 'Dark theme for students', TRUE),
  ('notifications', '🔔 Notifications', 'Browser push notifications', FALSE),
  ('adaptive_quiz', '🧠 Adaptive Quiz', 'Difficulty adapts to performance', FALSE),
  ('negative_marking', '➖ Negative Marking', 'Deduct marks for wrong answers', FALSE),
  ('video_explanations', '🎥 Video Explanations', 'Video support in explanations', FALSE),
  ('subscriptions', '💎 Subscriptions', 'Paid subscription system', FALSE)
ON CONFLICT (name) DO NOTHING;

INSERT INTO colleges (name, abbreviation, city, province, is_active) VALUES
  ('LUMHS Jamshoro', 'LUMHS', 'Jamshoro', 'Sindh', TRUE),
  ('Indus Medical College', 'IMC', 'Tando Muhammad Khan', 'Sindh', TRUE),
  ('Bilawal Medical College', 'BMC', 'Jamshoro', 'Sindh', TRUE),
  ('Mirpurkhas Medical College', 'MMC', 'Mirpurkhas', 'Sindh', TRUE),
  ('LUMHS Thatta', 'LUMHS-T', 'Thatta', 'Sindh', TRUE),
  ('PUMHS Nawabshah', 'PUMHS', 'Nawabshah', 'Sindh', TRUE)
ON CONFLICT (name) DO NOTHING;

INSERT INTO years (name, display_order, is_active) VALUES
  ('1st Year MBBS', 1, FALSE),
  ('2nd Year MBBS', 2, TRUE),
  ('3rd Year MBBS', 3, FALSE),
  ('4th Year MBBS', 4, FALSE),
  ('Final Year MBBS', 5, FALSE)
ON CONFLICT DO NOTHING;

-- ============ ROW LEVEL SECURITY ============

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE wrong_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE years ENABLE ROW LEVEL SECURITY;
ALTER TABLE modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE year_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE colleges ENABLE ROW LEVEL SECURITY;
ALTER TABLE institutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE about_cards ENABLE ROW LEVEL SECURITY;

-- Allow all anon access (ORIGINAL, now superseded — see "SECURITY PATCH:
-- real per-row access control" further down, which drops and replaces most
-- of the policies this loop creates).
-- HISTORICAL NOTE: this comment used to say the app had no way to identify a
-- real admin server-side because it used a custom email+password table. That's
-- no longer true — the app now signs everyone in through real Supabase Auth
-- (Google OAuth via sb.auth.signInWithOAuth), so auth.uid() reliably identifies
-- who is actually signed in, and RLS policies below use it accordingly.
DO $$ DECLARE t TEXT;
BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
  EXECUTE format('DROP POLICY IF EXISTS "allow_all_%s" ON %I', t, t);
  EXECUTE format('CREATE POLICY "allow_all_%s" ON %I FOR ALL USING (true) WITH CHECK (true)', t, t);
END LOOP; END $$;

-- ============ SECURITY PATCH: hide secret keys from system_settings ============
-- Without this, ANY visitor (no login needed) could call the Supabase REST API
-- directly and read your ai_api_key / stripe_sk / razorpay_secret straight out of
-- the database — the "allow_all" policy above has no concept of which rows are secret.
-- This narrows SELECT only (writes/admin saving still work exactly as before).
DROP POLICY IF EXISTS "allow_all_system_settings" ON system_settings;
CREATE POLICY "system_settings_select_public" ON system_settings
  FOR SELECT USING (key NOT IN ('ai_api_key', 'stripe_sk', 'razorpay_secret'));
CREATE POLICY "system_settings_write" ON system_settings
  FOR INSERT WITH CHECK (true);
CREATE POLICY "system_settings_update" ON system_settings
  FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "system_settings_delete" ON system_settings
  FOR DELETE USING (true);

-- ============ SECURITY PATCH (2026-07): real per-row access control ============
-- THIS IS THE SINGLE MOST IMPORTANT FIX IN THIS FILE — read this before anything else.
--
-- Every table above got a blanket "allow_all" policy (USING true, WITH CHECK
-- true). That means ANY visitor — no login, no admin account, nothing — can
-- open this page, copy the public anon key straight out of the page source
-- (it's meant to be public, that part's fine), and then call the Supabase REST
-- API directly to insert/update/delete rows in almost every table. The
-- is_admin flag on currentUser is only ever checked in JavaScript, and anyone
-- can skip the JavaScript entirely and talk to the API directly. Concretely,
-- until this patch is applied, anyone can:
--   • grant themselves admin with one fetch() call that PATCHes their own
--     users row to set is_admin = true;
--   • insert a fake question/announcement/college whose text is designed to
--     run JavaScript in every other viewer's browser — the esc()/escNl() fixes
--     elsewhere in this file stop that text from executing once it's in the
--     database, but only this patch stops it from getting written in the
--     first place by someone who was never supposed to have write access;
--   • overwrite any other student's stats, ban status, or subscription.
--
-- Now that the app signs everyone in through real Supabase Auth (Google
-- OAuth), auth.uid() reliably identifies who's actually signed in, so we can
-- finally write real rules instead of "allow everything":
--   • Reference/content tables (questions, colleges, modules, announcements,
--     years, subjects, feature flags, plans, media library): anyone can read,
--     only an admin account can write.
--   • users: anyone can read basic profile rows and you can update
--     your own row, but never your own is_admin / is_banned / email / auth_uid
--     — those four can only change when the request is already coming from an
--     admin account. (Note: this does NOT yet hide one student's phone number
--     /enrollment number from another student reading the users table — that
--     needs column-level filtering via a view, which is a separate change happy
--     to help with next; ask if you want that too.)
--   • Personal tables (user_stats, bookmarks, activity_logs, subscriptions):
--     you can only read/write your own rows; admins can see/manage everyone's.
--
-- ⚠️ TEST BEFORE TRUSTING: run this in the Supabase SQL editor, then sign in as
-- an ordinary (non-admin) student account and confirm (1) your profile still
-- saves, (2) personal stats and bookmarks still load, and (3) trying to set
-- your own is_admin/is_banned from the browser console now fails. I can't run
-- this against your live database from here, so please verify it actually
-- behaves as described before considering the admin panel "secured" rather
-- than "hidden".
--
-- UPDATE (2026-07, this pass): the five tables flagged below now have policies,
-- added further down in this file: past_papers and practice_tests were folded
-- into the reference-table loop (public read, admin write, same as questions/
-- modules). reports_feedback got its own personal+admin policy (own rows to
-- read/submit, admin-only to update/delete). question_comments and
-- comment_likes are DROPPED outright, not just locked down — Abid confirmed
-- the comments/likes feature is gone for good and he wants the old data gone
-- with it, so there's no "admin-only" policy for these two anymore, just a
-- DROP TABLE. I also found a SIXTH table the original audit missed — custom_tests
-- (saved "Build Your Own Test" configs) — and locked that down too (own rows
-- only, same as bookmarks). Then Abid ran the table/column list himself and
-- that turned up a SEVENTH — error_logs (auto-captured crash reports, predates
-- this file — see error_logs_setup.sql) — now admin-only to read, open to
-- insert (client-side error capture must work even for a signed-out visitor).
-- None of these seven had a real policy before this patch, so — same as the
-- rest of this file — please run the SQL editor test below and confirm
-- nothing broke for a normal student account.
--
-- ORIGINAL NOTE for reference: question_comments, comment_likes, reports_feedback,
-- past_papers, and practice_tests are all used throughout this app but weren't
-- defined anywhere in this schema file, which means they were created or
-- altered directly in Supabase after this file was last kept in sync. If any
-- OTHER tables exist beyond these seven that aren't in this file, this compact
-- version of the check is easier to read through than the column-by-column one —
-- it lists every table once with a true/false for whether RLS is even turned on,
-- which is really the question that matters:
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' order by tablename;
-- Any row showing "false" is a table with no lock on it at all, regardless of
-- what policies may or may not exist for it. Send me that result and I'll write
-- policies for anything still missing.

CREATE OR REPLACE FUNCTION is_current_user_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE auth_uid = auth.uid() AND is_admin = true);
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ---------- users ----------
DROP POLICY IF EXISTS "allow_all_users" ON users;
CREATE POLICY "users_select_all" ON users FOR SELECT USING (true);
CREATE POLICY "users_insert_own" ON users FOR INSERT
  WITH CHECK (auth.uid() = auth_uid OR is_current_user_admin());
CREATE POLICY "users_update_own_or_admin" ON users FOR UPDATE
  USING (auth.uid() = auth_uid OR is_current_user_admin())
  WITH CHECK (
    is_current_user_admin()
    OR (
      auth.uid() = auth_uid
      AND email     IS NOT DISTINCT FROM (SELECT u.email     FROM users u WHERE u.auth_uid = auth.uid())
      AND auth_uid  IS NOT DISTINCT FROM (SELECT u.auth_uid  FROM users u WHERE u.auth_uid = auth.uid())
      AND is_admin  IS NOT DISTINCT FROM (SELECT u.is_admin  FROM users u WHERE u.auth_uid = auth.uid())
      AND is_banned IS NOT DISTINCT FROM (SELECT u.is_banned FROM users u WHERE u.auth_uid = auth.uid())
    )
  );
CREATE POLICY "users_delete_admin_only" ON users FOR DELETE USING (is_current_user_admin());

-- ---------- user_stats ----------
DROP POLICY IF EXISTS "allow_all_user_stats" ON user_stats;
CREATE POLICY "user_stats_select_all" ON user_stats FOR SELECT USING (true);
CREATE POLICY "user_stats_insert_own_or_admin" ON user_stats FOR INSERT
  WITH CHECK (email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin());
CREATE POLICY "user_stats_update_own_or_admin" ON user_stats FOR UPDATE
  USING (email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin());
CREATE POLICY "user_stats_delete_admin_only" ON user_stats FOR DELETE USING (is_current_user_admin());

-- ---------- bookmarks (personal — no one else has a reason to read these) ----------
DROP POLICY IF EXISTS "allow_all_bookmarks" ON bookmarks;
CREATE POLICY "bookmarks_all_own_or_admin" ON bookmarks FOR ALL
  USING (email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin())
  WITH CHECK (email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin());

-- ---------- wrong_attempts (personal, same pattern as bookmarks) ----------
DROP POLICY IF EXISTS "allow_all_wrong_attempts" ON wrong_attempts;
CREATE POLICY "wrong_attempts_all_own_or_admin" ON wrong_attempts FOR ALL
  USING (email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin())
  WITH CHECK (email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin());

-- ---------- activity_logs ----------
DROP POLICY IF EXISTS "allow_all_activity_logs" ON activity_logs;
CREATE POLICY "activity_logs_select_own_or_admin" ON activity_logs FOR SELECT
  USING (user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin());
CREATE POLICY "activity_logs_insert_own" ON activity_logs FOR INSERT
  WITH CHECK (user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin());
CREATE POLICY "activity_logs_update_admin_only" ON activity_logs FOR UPDATE USING (is_current_user_admin());
CREATE POLICY "activity_logs_delete_admin_only" ON activity_logs FOR DELETE USING (is_current_user_admin());

-- ---------- error_logs (auto-captured client crash reports) ----------
-- Found via the table/column list Abid pulled from Supabase (2026-07) — this
-- table predates this schema file (see error_logs_setup.sql) so it was never
-- covered by any patch. INSERT has to stay open to everyone, including a
-- visitor who isn't signed in yet, because the whole point is catching errors
-- that happen before/during login too — there's a client-side cap of 20 log
-- lines per page load so this can't be used to flood the table. Reading,
-- editing, and deleting stays admin-only; a student never needs to read
-- error logs (their own or anyone else's).
ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_error_logs" ON error_logs;
CREATE POLICY "error_logs_insert_anyone" ON error_logs FOR INSERT WITH CHECK (true);
CREATE POLICY "error_logs_select_admin_only" ON error_logs FOR SELECT USING (is_current_user_admin());
CREATE POLICY "error_logs_update_admin_only" ON error_logs FOR UPDATE USING (is_current_user_admin());
CREATE POLICY "error_logs_delete_admin_only" ON error_logs FOR DELETE USING (is_current_user_admin());

-- ---------- app_notifications (broadcast notifications — same shape as announcements) ----------
-- Found via the full table list Abid pulled (2026-07). rowsecurity showed true
-- already, but that only means RLS was switched on somewhere along the way —
-- it says nothing about whether a real policy backs it, so this sets one
-- explicitly rather than trust the flag alone. Admin sends these, every
-- student reads the same list, same as announcements.
ALTER TABLE app_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_app_notifications" ON app_notifications;
CREATE POLICY "app_notifications_select_all" ON app_notifications FOR SELECT USING (true);
CREATE POLICY "app_notifications_insert_admin_only" ON app_notifications FOR INSERT WITH CHECK (is_current_user_admin());
CREATE POLICY "app_notifications_update_admin_only" ON app_notifications FOR UPDATE USING (is_current_user_admin());
CREATE POLICY "app_notifications_delete_admin_only" ON app_notifications FOR DELETE USING (is_current_user_admin());

-- ---------- subscriptions (never let a user approve their own) ----------
DROP POLICY IF EXISTS "allow_all_subscriptions" ON subscriptions;
CREATE POLICY "subscriptions_select_own_or_admin" ON subscriptions FOR SELECT
  USING (user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin());
CREATE POLICY "subscriptions_insert_own" ON subscriptions FOR INSERT
  WITH CHECK (user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()));
CREATE POLICY "subscriptions_update_admin_only" ON subscriptions FOR UPDATE USING (is_current_user_admin());
CREATE POLICY "subscriptions_delete_admin_only" ON subscriptions FOR DELETE USING (is_current_user_admin());

-- ---------- reports_feedback (student submits their own; only admin manages) ----------
ALTER TABLE reports_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_reports_feedback" ON reports_feedback;
CREATE POLICY "reports_feedback_select_own_or_admin" ON reports_feedback FOR SELECT
  USING (user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin());
CREATE POLICY "reports_feedback_insert_own" ON reports_feedback FOR INSERT
  WITH CHECK (user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()));
CREATE POLICY "reports_feedback_update_admin_only" ON reports_feedback FOR UPDATE USING (is_current_user_admin());
CREATE POLICY "reports_feedback_delete_admin_only" ON reports_feedback FOR DELETE USING (is_current_user_admin());

-- ---------- custom_tests (a student's saved "Build Your Own Test" configs — personal) ----------
-- Found during this pass: not in the original audit list, but it stores per-student
-- data the same way bookmarks does, so it gets the same own-rows-only treatment.
ALTER TABLE custom_tests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_custom_tests" ON custom_tests;
CREATE POLICY "custom_tests_all_own_or_admin" ON custom_tests FOR ALL
  USING (user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin())
  WITH CHECK (user_email = (SELECT u.email FROM users u WHERE u.auth_uid = auth.uid()) OR is_current_user_admin());

-- ---------- question_comments / comment_likes ----------
-- Confirmed by Abid (2026-07): the comments/likes feature is gone for good, so
-- these two tables — and every comment/like a student ever posted — are
-- dropped outright rather than just locked down. CASCADE handles comment_likes'
-- foreign key into question_comments automatically. This step is NOT reversible.
DROP TABLE IF EXISTS comment_likes CASCADE;
DROP TABLE IF EXISTS question_comments CASCADE;

-- ---------- audit_logs (admin activity trail) ----------
DROP POLICY IF EXISTS "allow_all_audit_logs" ON audit_logs;
CREATE POLICY "audit_logs_admin_only" ON audit_logs FOR ALL
  USING (is_current_user_admin()) WITH CHECK (is_current_user_admin());

-- ---------- reference/content tables: public read, admin-only write ----------
-- (the EXECUTE ENABLE ROW LEVEL SECURITY line below is a safe no-op for tables
-- that already had it enabled above — it's only load-bearing for past_papers
-- and practice_tests, which are new to this loop and never had RLS turned on
-- at all, meaning their policies would otherwise silently do nothing)
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['announcements','years','modules','year_modules','subjects',
                                'questions','institutes','colleges','feature_flags',
                                'subscription_plans','media_library','past_papers','practice_tests',
                                'about_cards'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "allow_all_%s" ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_select_all" ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_insert_admin_only" ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_update_admin_only" ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_delete_admin_only" ON %I', t, t);
    EXECUTE format('CREATE POLICY "%s_select_all" ON %I FOR SELECT USING (true)', t, t);
    EXECUTE format('CREATE POLICY "%s_insert_admin_only" ON %I FOR INSERT WITH CHECK (is_current_user_admin())', t, t);
    EXECUTE format('CREATE POLICY "%s_update_admin_only" ON %I FOR UPDATE USING (is_current_user_admin())', t, t);
    EXECUTE format('CREATE POLICY "%s_delete_admin_only" ON %I FOR DELETE USING (is_current_user_admin())', t, t);
  END LOOP;
END $$;

-- ---------- system_settings: SELECT already restricted above; lock down writes too ----------
DROP POLICY IF EXISTS "system_settings_write" ON system_settings;
DROP POLICY IF EXISTS "system_settings_update" ON system_settings;
DROP POLICY IF EXISTS "system_settings_delete" ON system_settings;
CREATE POLICY "system_settings_insert_admin_only" ON system_settings FOR INSERT WITH CHECK (is_current_user_admin());
CREATE POLICY "system_settings_update_admin_only" ON system_settings FOR UPDATE USING (is_current_user_admin());
CREATE POLICY "system_settings_delete_admin_only" ON system_settings FOR DELETE USING (is_current_user_admin());

-- ============ STORAGE BUCKETS ============
-- Run these in Supabase Storage UI or SQL:
-- CREATE BUCKET "module-images" (public: true)
-- CREATE BUCKET "question-images" (public: true)

-- ============ INDEXES ============
CREATE INDEX IF NOT EXISTS idx_questions_module ON questions(module_id);
CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions(subject_id);
CREATE INDEX IF NOT EXISTS idx_questions_year ON questions(year_id);
-- Added: past papers and practice tests now fetch their question counts in a
-- single batched query (.in('paper_id', [...]) / .in('practice_test_id', [...]))
-- instead of one request per row — these indexes are what make that single
-- query fast server-side too, not just fewer round trips client-side.
CREATE INDEX IF NOT EXISTS idx_questions_paper ON questions(paper_id);
CREATE INDEX IF NOT EXISTS idx_questions_practice_test ON questions(practice_test_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_email ON bookmarks(email);
CREATE INDEX IF NOT EXISTS idx_wrong_attempts_email ON wrong_attempts(email);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_email);
CREATE INDEX IF NOT EXISTS idx_reports_feedback_user ON reports_feedback(user_email);
CREATE INDEX IF NOT EXISTS idx_reports_feedback_status ON reports_feedback(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_email);

-- ============ FURTHER DB-SIDE PERFORMANCE (optional, do outside this file) ============
-- 1. RLS policies that call auth.uid() directly re-evaluate it per row scanned.
--    Wrapping it as (select auth.uid()) instead lets Postgres compute it once
--    per query — a well-documented Supabase perf tip. Worth an audit pass over
--    the RLS policies above if any list screen still feels slow at scale.
-- 2. For data that's public and near-static (colleges, years, subscription
--    plans — already localStorage-cached client-side in this file), an Edge
--    Function with a Cache-Control header in front of it adds a CDN-level
--    cache too, so even a first-ever visit on a fresh device doesn't hit
--    Postgres directly. Not necessary at current scale, but the natural next
--    step if traffic grows.
*/



window.onload = async function() {
  try {
  const hadStoredSession = _hasStoredSupabaseSession();
  const [session] = await Promise.all([
    getSessionWithRetry(hadStoredSession ? 5 : 1, 1200),
    loadAppSettings().catch(e => console.warn('loadAppSettings failed', e)),
    loadFeatureFlags().catch(e => console.warn('loadFeatureFlags failed', e))
  ]);
  if (session) {
    try {
      await handleAuthedSession(session);
    } catch (e) {
      // We had a valid session — a failure applying it is far more likely to
      // be the same slow/dropped connection than an actual auth problem, so
      // keep trying quietly instead of dropping to the login screen.
      console.warn('handleAuthedSession failed at boot, will keep retrying', e);
      _showReconnecting();
    }
  } else if (hadStoredSession) {
    // We know this device has signed in before — a missing session right
    // now almost certainly means the network isn't back yet, not that the
    // person needs to log in again.
    _showReconnecting();
  } else {
    showScreen('splash', false);
  }
  // Notification data is fetched only when the student opens the bell.
  if (window.currentUser && !window.currentUser.is_admin && window.currentUser.profile_completed) {
    checkWhatsNew();
    window._notificationAuthReady = true;
    await _flushPendingNotificationOpen();
  }
  applyWallpaper();
  } catch(e) {
    console.error('Startup error:', e);
    showLoading(false);
    // Make sure splash is visible if startup fails
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-splash').classList.add('active');
  }
};



// ==================== PWA INSTALL BANNER ====================
let _pwaPrompt = null;


export const _isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;


const _isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);


const _isIOSChrome = _isIOS && /CriOS/i.test(navigator.userAgent);


const _isIOSSafari = _isIOS && !_isIOSChrome;


const _isMac = /macintosh/i.test(navigator.userAgent) && !_isIOS;


const _isMacSafari = _isMac && /Safari/i.test(navigator.userAgent) && !/Chrome/i.test(navigator.userAgent);


const _isEdge = /Edg/i.test(navigator.userAgent);


const _isSamsung = /SamsungBrowser/i.test(navigator.userAgent);


const _isFirefox = /Firefox|FxiOS/i.test(navigator.userAgent);


const PWA_SNOOZE_KEY = 'pwa_snooze_until';



window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _pwaPrompt = e;
});



function _isPwaSnoozed() {
  const until = parseInt(localStorage.getItem(PWA_SNOOZE_KEY) || '0', 10);
  return until && Date.now() < until;
}



window.addEventListener('load', () => {
  if (_isStandalone || _isPwaSnoozed()) return;
  setTimeout(() => {
    if (localStorage.getItem('pwa_mini')) showPWAMini();
    else showPWAFull();
  }, 500);
});



function showPWAFull() {
  if (_isStandalone || _isPwaSnoozed()) return;
  if (document.getElementById('_pwaBanner')) return;
  const banner = document.createElement('div');
  banner.id = '_pwaBanner';
  banner.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;background:rgba(26,18,0,.95);border:1px solid rgba(201,152,10,.5);color:white;border-radius:16px;padding:10px 12px 6px;z-index:9998;box-shadow:0 8px 32px rgba(0,0,0,.5);backdrop-filter:blur(16px);animation:fadeInUp .35s cubic-bezier(.4,0,.2,1);touch-action:none;will-change:transform';
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <img src="icon.png" style="width:36px;height:36px;border-radius:10px;flex-shrink:0">
      <div style="flex:1;min-width:0">
        <div style="font-weight:800;font-size:13px;margin-bottom:1px">Install LUMHSian App 📲</div>
        <div style="font-size:11px;color:rgba(255,255,255,.6)">For better & smooth experience</div>
      </div>
      <button onclick="_triggerInstall()" style="background:linear-gradient(105deg,#7a5c00,#e8a820);color:white;border:none;border-radius:10px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">📥 Install</button>
      <button onclick="_collapseBanner()" title="Minimize" style="background:rgba(255,255,255,.1);color:rgba(255,255,255,.6);border:none;font-size:16px;cursor:pointer;padding:4px 6px;line-height:1;font-family:inherit;border-radius:8px;flex-shrink:0">×</button>
    </div>
    <div style="display:flex;justify-content:center">
      <button onclick="_snoozePwaBanner()" style="background:none;border:none;color:rgba(255,255,255,.5);font-size:11px;cursor:pointer;font-family:inherit;padding:7px 10px;display:flex;align-items:center;gap:4px">✕ Not now, hide for 24 hours</button>
    </div>`;
  document.body.appendChild(banner);
  _makeDraggable(banner, () => _snoozePwaBanner());
}
window.showPWAFull = showPWAFull;



function showPWAMini() {
  if (_isStandalone || _isPwaSnoozed()) return;
  if (document.getElementById('_pwaMini')) return;
  const mini = document.createElement('div');
  mini.id = '_pwaMini';
  mini.style.cssText = 'position:fixed;bottom:82px;right:12px;background:rgba(26,18,0,.92);border:1px solid rgba(201,152,10,.5);color:white;border-radius:14px;padding:8px 8px 8px 12px;z-index:9998;font-size:12px;font-weight:700;display:flex;align-items:center;gap:6px;box-shadow:0 4px 16px rgba(0,0,0,.4);backdrop-filter:blur(10px);font-family:inherit;touch-action:none;will-change:transform';
  mini.innerHTML = `
    <span onclick="document.getElementById('_pwaMini').remove();localStorage.removeItem('pwa_mini');showPWAFull()" style="cursor:pointer;display:flex;align-items:center;gap:6px">
      <img src="icon.png" style="width:20px;height:20px;border-radius:5px"> 📲 Install
    </span>
    <button onclick="_snoozePwaBanner()" title="Hide for 24 hours" style="background:rgba(255,255,255,.12);border:none;color:rgba(255,255,255,.7);font-size:13px;cursor:pointer;padding:3px 6px;line-height:1;font-family:inherit;border-radius:6px;flex-shrink:0">✕</button>`;
  document.body.appendChild(mini);
  _makeDraggable(mini, () => _snoozePwaBanner());
}



function _collapseBanner() {
  const b = document.getElementById('_pwaBanner');
  if (b) b.remove();
  localStorage.setItem('pwa_mini', '1');
  showPWAMini();
}
window._collapseBanner = _collapseBanner;



// Sets a 24-hour snooze so the floating banner/pill stays out of the way, while
// "Install App" in Profile → Settings still works any time — the snooze only
// affects this floating prompt, never the manual option.
function _snoozePwaBanner() {
  localStorage.setItem(PWA_SNOOZE_KEY, String(Date.now() + 24 * 60 * 60 * 1000));
  document.getElementById('_pwaBanner')?.remove();
  document.getElementById('_pwaMini')?.remove();
  showToast('Install reminder snoozed for 24 hours. You can still install anytime from Profile → Settings.');
}
window._snoozePwaBanner = _snoozePwaBanner;



// Press-and-drag gesture, free in any direction: as soon as a drag starts, a
// "✕" drop zone appears at the bottom of the screen — drag the banner/pill
// onto it and let go to snooze for 24h; let go anywhere else and it springs
// back to where it started. Taps on the real buttons inside (Install / × /
// Not now) are left alone so this never swallows a normal tap. touch-action:none
// on the element (set where it's created) hands full control of the gesture
// to this code instead of the browser's own scroll/pan handling, which is
// what let the element only ever seem to move sideways before.
function _makeDraggable(el, onDismiss) {
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false, dropZone = null;
  const THRESHOLD = 8;

  function start(x, y) { startX = x; startY = y; dx = 0; dy = 0; dragging = false; }

  function move(x, y) {
    dx = x - startX; dy = y - startY;
    if (!dragging && Math.hypot(dx, dy) < THRESHOLD) return;
    dragging = true;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    if (!dropZone) dropZone = _showPwaDropZone();
    const z = dropZone.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const dist = Math.hypot((z.left + z.width / 2) - (r.left + r.width / 2), (z.top + z.height / 2) - (r.top + r.height / 2));
    dropZone.classList.toggle('_dz-active', dist < 75);
  }

  function end() {
    if (!dragging) return;
    const hit = dropZone?.classList.contains('_dz-active');
    if (hit) {
      el.style.transition = 'opacity .2s ease-in, transform .2s ease-in';
      el.style.opacity = '0';
      el.style.transform = `translate(${dx}px, ${dy}px) scale(.85)`;
      setTimeout(onDismiss, 180);
    } else {
      el.style.transition = 'transform .3s cubic-bezier(.34,1.56,.64,1)';
      el.style.transform = 'translate(0,0)';
    }
    _removePwaDropZone();
    dragging = false;
  }

  el.addEventListener('touchstart', (e) => {
    if (e.target.closest('button')) return;
    start(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (e.target.closest('button') && !dragging) return;
    move(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  el.addEventListener('touchend', end);

  // Mouse support too, for PWAs opened on desktop
  el.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    start(e.clientX, e.clientY);
    const onMouseMove = (ev) => move(ev.clientX, ev.clientY);
    const onMouseUp = () => { end(); document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}



function _showPwaDropZone() {
  let dz = document.getElementById('_pwaDropZone');
  if (dz) return dz;
  dz = document.createElement('div');
  dz.id = '_pwaDropZone';
  dz.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);width:64px;height:64px;border-radius:50%;background:rgba(220,38,38,.15);border:2px solid var(--red);display:flex;align-items:center;justify-content:center;font-size:26px;z-index:9997;color:var(--red);opacity:0;transition:opacity .15s,background .15s,transform .15s;pointer-events:none';
  dz.textContent = '✕';
  document.body.appendChild(dz);
  requestAnimationFrame(() => { dz.style.opacity = '1'; });
  return dz;
}



function _removePwaDropZone() {
  const dz = document.getElementById('_pwaDropZone');
  if (!dz) return;
  dz.style.opacity = '0';
  setTimeout(() => dz.remove(), 150);
}



async function _triggerInstall() {
  // Native prompt available (Android Chrome, Windows Chrome/Edge, Mac Chrome) — direct install
  if (_pwaPrompt) {
    _pwaPrompt.prompt();
    const { outcome } = await _pwaPrompt.userChoice;
    _pwaPrompt = null;
    if (outcome === 'accepted') {
      document.getElementById('_pwaBanner')?.remove();
      document.getElementById('_pwaMini')?.remove();
      localStorage.removeItem('pwa_mini');
      showToast('✅ LUMHSian App installed!');
    }
    return;
  }
  // Manual guide for devices that don't support native prompt
  if (_isIOSSafari) {
    _showGuide('iPhone / iPad (Safari)', [
      { icon: '1️⃣', text: 'Tap the <strong>Share</strong> icon in the bar at the bottom of the screen', hint: 'It looks like a square with an arrow pointing up: ⬆️' },
      { icon: '2️⃣', text: 'A list of options will pop up, scroll down and tap <strong>"Add to Home Screen"</strong>', hint: 'If you don\u2019t see it, scroll down further. It\u2019s further down the list' },
      { icon: '3️⃣', text: 'Tap <strong>"Add"</strong> at the top right corner of the screen', hint: 'Done! The app icon will now be on your Home Screen, like any other app 🎉' }
    ]);
  } else if (_isIOSChrome) {
    _showGuide('iPhone / iPad (Chrome)', [
      { icon: '1️⃣', text: 'Tap the <strong>three dots (⋮)</strong> at the bottom right of the screen', hint: '' },
      { icon: '2️⃣', text: 'Tap <strong>"Add to Home Screen"</strong> from the menu', hint: '' },
      { icon: '3️⃣', text: 'Tap <strong>"Add"</strong> to confirm', hint: 'Done! The app icon will now be on your Home Screen 🎉' }
    ]);
  } else if (_isMacSafari) {
    _showGuide('Mac (Safari)', [
      { icon: '1️⃣', text: 'Click <strong>File</strong> in the menu bar at the very top of the screen', hint: '' },
      { icon: '2️⃣', text: 'Click <strong>"Add to Dock"</strong>', hint: '' },
      { icon: '3️⃣', text: 'Click <strong>"Add"</strong> to confirm', hint: 'Done! The app icon will now be in your Dock 🎉' }
    ]);
  } else if (_isEdge) {
    _showGuide('Microsoft Edge', [
      { icon: '1️⃣', text: 'Click the <strong>three dots (···)</strong> at the top right of the window', hint: '' },
      { icon: '2️⃣', text: 'Hover over or click <strong>"Apps"</strong>', hint: '' },
      { icon: '3️⃣', text: 'Click <strong>"Install this site as an app"</strong>', hint: 'Done! The app will open in its own window from now on 🎉' }
    ]);
  } else if (_isSamsung) {
    _showGuide('Samsung Internet', [
      { icon: '1️⃣', text: 'Tap the <strong>menu icon</strong> at the bottom right', hint: 'Looks like three lines stacked on top of each other: ☰' },
      { icon: '2️⃣', text: 'Tap <strong>"Add page to"</strong>, then choose <strong>"Home screen"</strong>', hint: '' },
      { icon: '3️⃣', text: 'Tap <strong>"Add"</strong> to confirm', hint: 'Done! The app icon will now be on your Home Screen 🎉' }
    ]);
  } else if (_isFirefox) {
    _showGuide('Firefox', [
      { icon: '1️⃣', text: 'Tap the <strong>three dots (⋮)</strong> menu (or the address bar options)', hint: '' },
      { icon: '2️⃣', text: 'Look for <strong>"Install"</strong> or <strong>"Add to Home Screen"</strong>', hint: 'Firefox doesn\u2019t offer this on every version. If you don\u2019t see it, Chrome or your phone\u2019s default browser will work' },
      { icon: '3️⃣', text: 'Confirm by tapping <strong>"Add"</strong> or <strong>"Install"</strong>', hint: 'Done 🎉' }
    ]);
  } else {
    _showGuide('Android', [
      { icon: '1️⃣', text: 'Look for a <strong>menu button</strong> in your browser, usually three dots (⋮) or three lines (☰), normally at the top right or bottom right', hint: '' },
      { icon: '2️⃣', text: 'In that menu, find <strong>"Add to Home Screen"</strong> or <strong>"Install App"</strong>', hint: 'The exact wording depends on which browser you\u2019re using' },
      { icon: '3️⃣', text: 'Confirm by tapping <strong>"Add"</strong> or <strong>"Install"</strong>', hint: 'Done! The app icon will now be on your Home Screen 🎉' }
    ]);
  }
}
window._triggerInstall = _triggerInstall;



function _showGuide(device, steps) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10010;display:flex;align-items:flex-end;justify-content:center;padding:16px;backdrop-filter:blur(8px)';
  const stepsHTML = steps.map(s => `
    <div style="display:flex;align-items:flex-start;gap:12px;padding:12px;background:var(--surface-3);border-radius:14px;margin-bottom:8px;border:1px solid var(--border)">
      <span style="font-size:20px;flex-shrink:0;margin-top:1px">${s.icon}</span>
      <div>
        <div style="font-size:14px;color:var(--ink-2);line-height:1.5">${s.text}</div>
        ${s.hint ? `<div style="font-size:12px;color:var(--ink-4);margin-top:4px;line-height:1.4">💡 ${s.hint}</div>` : ''}
      </div>
    </div>`).join('');
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:28px 28px 20px 20px;padding:24px;width:100%;max-width:440px;max-height:85vh;overflow-y:auto">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
        <img src="icon.png" style="width:48px;height:48px;border-radius:14px;box-shadow:0 2px 10px rgba(0,0,0,.15)">
        <div>
          <div style="font-weight:800;font-size:17px;color:var(--ink)">Install LUMHSian</div>
          <div style="font-size:12px;color:var(--ink-4);margin-top:2px">${device}</div>
        </div>
      </div>
      <p style="font-size:13px;color:var(--ink-3);margin-bottom:16px">Your browser doesn't let us install the app automatically, so here's how to do it in a few taps:</p>
      <div style="margin-bottom:20px">${stepsHTML}</div>
      <button class="btn btn-primary" onclick="this.closest('[style*=inset]').remove()">Got it, thanks!</button>
      <button onclick="this.closest('[style*=inset]').remove()" style="display:block;width:100%;margin-top:8px;background:none;border:none;color:var(--ink-4);font-size:13px;cursor:pointer;padding:8px;font-family:inherit">Maybe later</button>
    </div>`;
  document.body.appendChild(overlay);
}


// ==================== HALF-UPDATED DEPLOYMENT CHECK ====================
// Reaching this line means app.js itself loaded. If one of the other files is still an older cached copy, some of the
// functions below won't exist — show the "App updated · Refresh" prompt from index.html instead of leaving broken buttons.
window.__lumBooted = true;
setTimeout(() => {
  const needed = ['leaveFinishedTest', 'waOpen', 'showDonationPage', '_closeLegalPage', 'adminGoBack', 'openSavedTests', 'openInbox', 'adminOpenMessages'];
  if ((needed.some(n => typeof window[n] !== 'function') || !window.__lumNavReady) && typeof window.__lumShowUpdate === 'function') window.__lumShowUpdate();
}, 5000);
