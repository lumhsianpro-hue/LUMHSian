import { adminContentTab, adminShowTab, applyWallpaper, renderAdminPanel, timeAgo } from './admin.js';
import { handleAuthedSession } from './auth.js';
import { renderRanking } from './leaderboard.js';
import { goBack, showScreen } from './navigation.js';
import { applyDarkMode, renderBookmarks, renderPlanner, renderProfile, renderStats, renderWrongAttempts } from './profile.js';
import { RESUME_KEY, persistActiveTest, renderResults, renderReview, startCustomTest } from './quiz.js';
import { _hasStoredSupabaseSession, _showReconnecting, db, getSessionWithRetry, sb } from './supabase.js';
import { ICON_BELL, ICON_BOOK, ICON_BOOKMARK, ICON_BUILDING, ICON_CALENDAR, ICON_EDIT, ICON_FIRE, ICON_LOCK, ICON_ROBOT, ICON_STETHOSCOPE, ICON_TARGET, ICON_X_CIRCLE, _debounce, attemptBadgeHtml, attemptLineHtml, cacheGet, cacheSet, esc, escJs, showConfirm, showLoading, showToast, skeletonList } from './utils.js';



// Bump this string on every deploy where you want every logged-in user to be
// forced back to the login screen once (e.g. after a meaningful update).
// They do NOT need to sign up again — their account stays, this only clears
// the saved auto-login session so they re-enter their password once.
export const APP_VERSION = '2026-07-06.1';



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
    if (_errorLogCount >= 20) return;
    const sig = source + ':' + String(message || '').slice(0, 150);
    if (_loggedErrorSignatures.has(sig)) return;
    _loggedErrorSignatures.add(sig);
    _errorLogCount++;
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


window.activeTest = null;


window.navStack = [];


window.maintenanceMode = false;


let announcementText = '';


window.aiConversation = [];


window.currentAIContext = null;





// ==================== YEAR SELECTION ====================
export async function loadYearScreen() {
  showLoading(true, 'Loading years...');
  try {
  const { data: years } = await db(sb.from('years').select('*').order('display_order'), 'Failed to load years');
  const wrap = document.getElementById('yearPageWrap');
  if (!years?.length) { wrap.innerHTML = `<div class="card"><p>No years configured yet. Contact admin.</p></div>`; showScreen('year'); return; }
  let html = `<div class="card-teal" style="margin-bottom:20px"><h2>Select Your Year</h2><p>MBBS Program</p></div>`;
  if (window.selectedYear) {
    html = `<button class="btn btn-secondary btn-sm mb-3" onclick="renderHome();showScreen('home')">← Back</button>` + html;
  }
  for (const y of years) {
    const active = y.is_active;
    html += `<div class="module-card ${!active ? 'locked' : ''}" onclick="${active ? `selectYear(${y.id},'${y.name.replace(/'/g,"\\'")}')` : `showToast('${y.coming_soon_text || 'Coming soon'}') `}">
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
    showToast('Failed to load. Please refresh.');
  } finally {
    showLoading(false);
  }
}



function selectYear(id, name) {
  const isChange = !!window.selectedYear && window.selectedYear.id !== id;
  window.selectedYear = { id, name };
  localStorage.setItem('lum_year', JSON.stringify(window.selectedYear));
  if (window.currentUser) {
    window.currentUser = { ...window.currentUser, year_of_study: name };
    db(sb.from('users').update({ year_of_study: name }).eq('email', window.currentUser.email), 'Year update failed');
  }
  // Invalidate stats cache so home shows fresh data
  window._lastStatsFetchedAt = 0;
  renderHome();
  showScreen('home');
  if (isChange) showToast(`✅ Year changed to ${name}`);
}
window.selectYear = selectYear;



// Lets a logged-in student switch to a different year at any time
// (e.g. Profile → Change Year, or tapping the year badge on Home).
function changeYear() {
  const current = window.currentUser?.year_of_study;
  if (current) {
    showConfirm(`You're currently set to <strong>${current}</strong>. Change your year? Your stats and history will stay, only your active year changes.`, () => loadYearScreen(), 'Change Year', false);
  } else {
    loadYearScreen();
  }
}
window.changeYear = changeYear;

// ==================== RANK HELPER ====================
export async function getRankInfo() {
  // Cache for 60s — called on every home render
  if (window._rankInfoCache && window._rankInfoFetchedAt && (Date.now() - window._rankInfoFetchedAt < 60000)) {
    return window._rankInfoCache;
  }
  try {
    const myYear = window.currentUser?.year_of_study;
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Rank info timed out')), 8000));
    const work = (async () => {
      let emailsInYear = null;
      if (myYear) {
        const { data: peers } = await sb.from('users').select('email').eq('year_of_study', myYear);
        emailsInYear = (peers || []).map(p => p.email);
      }
      let query = sb.from('user_stats').select('email,total_correct,total_questions,completed_attempt_tests');
      if (emailsInYear) query = query.in('email', emailsInYear);
      const { data } = await query;
      return data;
    })();
    const allStats = await Promise.race([work, timeout]);
    if (!allStats) return { rank: null, total: 0 };
    const ranked = allStats.filter(s => (s.completed_attempt_tests || 0) > 0 && s.email !== 'lumhsianpro@gmail.com').map(s => ({
      email: s.email,
      acc: s.total_questions ? Math.round((s.total_correct / s.total_questions) * 100) : 0
    })).sort((a, b) => b.acc - a.acc);
    const rank = ranked.findIndex(r => r.email === window.currentUser.email) + 1;
    const result = { rank: rank || null, total: ranked.length };
    window._rankInfoCache = result;
    window._rankInfoFetchedAt = Date.now();
    return result;
  } catch { return { rank: null, total: 0 }; }
}



// ==================== HOME / DASHBOARD ====================
// Shared module-card HTML builder — used by both the Home teaser and the
// dedicated Modules tab so they always render identically.
function buildModuleCardHtml(m, qCount, mAcc, yearId, yearName) {
  const safeYearName = escJs(yearName||'');
  return `
    <div class="module-card" onclick="openModule(${m.id},'${escJs(m.name)}','${escJs(m.icon_url||'')}','${escJs(m.color||'')}',${yearId||'null'},'${safeYearName}')">
      <img class="module-thumb" src="${esc(m.icon_url) || 'https://placehold.co/72x72/fdf3c0/c9980a?text=📚'}" onerror="this.src='https://placehold.co/72x72/fdf3c0/c9980a?text=📚'">
      <div class="module-info">
        <div class="module-title">${esc(m.name)}</div>
        <div class="module-sub">${qCount || 0} questions${mAcc !== null && mAcc !== undefined ? ` · ${mAcc}% accuracy` : ''}</div>
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
export async function getQuestionCountsBy(column, ids) {
  const counts = {};
  for (const id of ids) counts[id] = 0;
  if (!ids.length) return counts;
  const { data } = await db(sb.from('questions').select(column).in(column, ids), 'Question counts error');
  if (data) for (const row of data) counts[row[column]] = (counts[row[column]] || 0) + 1;
  return counts;
}


async function getQuestionCountsForModules(moduleIds) {
  const counts = {};
  for (const id of moduleIds) counts[id] = 0;
  if (!moduleIds.length) return counts;
  const { data } = await db(sb.from('questions').select('module_id').in('module_id', moduleIds).is('paper_id', null), 'Question counts error');
  if (data) for (const row of data) counts[row.module_id] = (counts[row.module_id] || 0) + 1;
  return counts;
}



// Years and active announcements are fetched on both Home and the Modules
// tab. Years change extremely rarely (30 min cache); announcements are
// admin-authored and time-sensitive so they get a shorter window (3 min) —
// both now persist in localStorage so a fresh page load can skip the network
// call entirely too, not just repeat calls within one session.
function _fetchYearsCached() {
  const cached = cacheGet('years', 1800000);
  if (cached) return Promise.resolve({ data: cached });
  return db(sb.from('years').select('*').order('display_order'), 'Years error').then(r => {
    if (r.data) cacheSet('years', r.data);
    return r;
  });
}


function _fetchAnnouncementsCached() {
  const cached = cacheGet('announcements', 180000);
  if (cached) return Promise.resolve({ data: cached });
  return db(sb.from('announcements').select('*').eq('is_active', true).order('created_at', { ascending: false }).limit(20), 'Announce error').then(r => {
    if (r.data) cacheSet('announcements', r.data);
    return r;
  });
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
        db(sb.from('year_modules').select('module_id,display_order').eq('year_id', myYear.id).order('display_order'), 'Modules error')
      ]);
      const moduleIds = (yearModules||[]).map(ym => ym.module_id);
      if (moduleIds.length) {
        const [{ data: modules }, ...counts] = await Promise.all([
          db(sb.from('modules').select('*').in('id', moduleIds), 'Modules error'),
          // We don't know module ids yet, fetch after
        ]);
        const ordered = (yearModules||[]).map(ym => modules?.find(m => m.id===ym.module_id)).filter(Boolean);
        const qCounts = await getQuestionCountsForModules(ordered.map(m => m.id));
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



export async function renderHome() {
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
  const [{ data: years }, stats, annoRes] = await Promise.all([
    _fetchYearsCached(),
    getUserStats(),
    _fetchAnnouncementsCached()
  ]);
  // Bug fix: target_college was saved when an announcement was created but
  // never actually checked here, so every "targeted" announcement was shown
  // to all students regardless of college. Filter it the same way the
  // notification bell already does, then keep the latest 3.
  const announcements = (annoRes.data || []).filter(a => !a.target_college || a.target_college === window.currentUser.college).slice(0, 3);

  // My year modules teaser (top 3) — parallel fetch
  const myYear = (years || []).find(y => y.name === myYearName);
  let myYearModuleHtml = '';
  if (myYear) {
    // Cache selectedYear so _getMyYear() fast-paths henceforth
    if (!window.selectedYear || window.selectedYear.id !== myYear.id) {
      window.selectedYear = { id: myYear.id, name: myYear.name };
      localStorage.setItem('lum_year', JSON.stringify(window.selectedYear));
    }
    const { data: yearModules } = await db(sb.from('year_modules').select('module_id,display_order').eq('year_id', myYear.id).order('display_order'), 'Modules error');
    const moduleIds = (yearModules || []).map(ym => ym.module_id);
    if (moduleIds.length) {
      const { data: modules } = await db(sb.from('modules').select('*').in('id', moduleIds), 'Modules error');
      const ordered = (yearModules || []).map(ym => modules?.find(m => m.id === ym.module_id)).filter(Boolean).slice(0, 3);
      const counts = await getQuestionCountsForModules(ordered.map(m => m.id));
      ordered.forEach((m,i) => {
        const mSt = stats.subject_stats?.[m.id] || {};
        const mAcc = mSt.total ? Math.round((mSt.correct/mSt.total)*100) : null;
        myYearModuleHtml += buildModuleCardHtml(m, counts[m.id]||0, mAcc, myYear.id, myYear.name);
      });
    }
  }
  if (!myYearModuleHtml) myYearModuleHtml = `<div class="card"><p>${myYearName ? `No modules for ${myYearName} yet.` : 'Set your year in Profile to see your modules here.'}</p></div>`;

  // Other years collapsible
  let allYearsHtml = '';
  for (const y of (years||[])) {
    if (y.name === myYearName) continue;
    const active = y.is_active;
    allYearsHtml += `
      <div class="card" style="margin-bottom:8px;padding:0;overflow:hidden">
        <div style="padding:14px 16px;display:flex;align-items:center;gap:10px;cursor:pointer" onclick="${active ? `toggleYearSection(${y.id})` : `showToast('${(y.coming_soon_text||'Coming soon').replace(/'/g,"\\'")}')` }">
          <span style="font-size:20px">${active ? ICON_BOOK : ICON_LOCK}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px">${y.name}</div>
            <div style="font-size:11px;color:var(--ink-4)">${active ? 'Tap to browse modules' : (y.coming_soon_text||'Coming soon')}</div>
          </div>
          ${active ? `<span id="yearChevron${y.id}" style="color:var(--ink-4)">▾</span>` : ''}
        </div>
        <div id="yearSection${y.id}" style="display:none;padding:0 12px 12px"></div>
      </div>`;
  }

  const acc = stats.total_questions ? Math.round((stats.total_correct/stats.total_questions)*100) : 0;
  const greeting = (() => { const h=new Date().getHours(); if(h<12) return '🌅 Good morning'; if(h<17) return '☀️ Good afternoon'; return '🌙 Good evening'; })();
  const avatarEmoji = window.currentUser.gender==='female' ? '👩‍⚕️' : '👨‍⚕️';
  const rankData = await getRankInfo();
  const announceHtml = announcements.map(a=>`<div class="announce-bar"><span style="font-size:16px">${esc(a.emoji)||'📢'}</span><span><strong>${esc(a.title)||''}</strong>${a.title&&a.body?' · ':''}${esc(a.body)||''}</span></div>`).join('');

  wrap.innerHTML = `
    <div style="background:linear-gradient(135deg,#7a5c00 0%,#c9980a 100%);border-radius:var(--radius-xl);padding:20px;margin-bottom:12px;color:white;position:relative;overflow:hidden">
      <div style="position:absolute;top:-20px;right:-20px;font-size:80px;opacity:.08;line-height:1">${ICON_STETHOSCOPE}</div>
      <div onclick="openNotificationBell()" style="position:absolute;top:14px;right:14px;cursor:pointer;font-size:20px">
        ${ICON_BELL}<span id="notifBellBadge" style="display:none;position:absolute;top:-6px;right:-8px;background:var(--red);color:white;font-size:10px;font-weight:700;border-radius:10px;min-width:16px;height:16px;align-items:center;justify-content:center;padding:0 3px">0</span>
      </div>
      <div class="flex-between" style="margin-bottom:12px">
        <div>
          <div style="font-size:12px;opacity:.7;font-weight:500;text-transform:uppercase;letter-spacing:.5px">${greeting}</div>
          <div style="font-family:var(--font-display);font-size:20px;font-weight:800;margin-top:2px">Dr. ${window.currentUser.name}</div>
          <div style="font-size:12px;opacity:.7;margin-top:2px">${window.currentUser.college||'Student'}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:36px">${avatarEmoji}</div>
          <div onclick="changeYear()" style="font-size:11px;opacity:.85;margin-top:2px;cursor:pointer;text-decoration:underline;text-decoration-style:dotted">${myYearName||'Set Year'} ${ICON_EDIT}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
        <div style="background:rgba(255,255,255,.12);border-radius:12px;padding:10px 6px;text-align:center">
          <div style="font-size:18px;font-weight:800;font-family:var(--font-display)">${acc}%</div>
          <div style="font-size:10px;opacity:.7;margin-top:2px">Accuracy</div>
        </div>
        <div style="background:rgba(255,255,255,.12);border-radius:12px;padding:10px 6px;text-align:center">
          <div style="font-size:18px;font-weight:800;font-family:var(--font-display)">${stats.total_tests||0}</div>
          <div style="font-size:10px;opacity:.7;margin-top:2px">Tests</div>
        </div>
        <div style="background:rgba(255,255,255,.12);border-radius:12px;padding:10px 6px;text-align:center">
          <div style="font-size:18px;font-weight:800;font-family:var(--font-display)">${stats.streak||0} ${ICON_FIRE}</div>
          <div style="font-size:10px;opacity:.7;margin-top:2px">Streak</div>
        </div>
        <div style="background:rgba(255,255,255,.12);border-radius:12px;padding:10px 6px;text-align:center">
          <div style="font-size:18px;font-weight:800;font-family:var(--font-display)">#${rankData.rank||'—'}</div>
          <div style="font-size:10px;opacity:.7;margin-top:2px">Rank</div>
        </div>
      </div>
    </div>

    ${announceHtml}

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(64px,1fr));gap:8px;margin-bottom:16px">
      <div class="quick-tile" onclick="navGo('modules')"><span class="quick-tile-icon">${ICON_BOOK}</span><span class="quick-tile-label">Modules</span></div>
      <div class="quick-tile" onclick="openPastPapersRoot()"><span class="quick-tile-icon">${ICON_BUILDING}</span><span class="quick-tile-label">Past Papers</span></div>
      ${isAIEnabled() ? `<div class="quick-tile" onclick="openAITutor()"><span class="quick-tile-icon">${ICON_ROBOT}</span><span class="quick-tile-label">AI Tutor</span></div>` : ''}
      <div class="quick-tile" onclick="navGo('bookmarks')"><span class="quick-tile-icon">${ICON_BOOKMARK}</span><span class="quick-tile-label">Saved</span></div>
      <div class="quick-tile" onclick="navGo('wrongattempts')"><span class="quick-tile-icon">${ICON_X_CIRCLE}</span><span class="quick-tile-label">Wrong</span></div>
      <div class="quick-tile" onclick="navGo('planner')"><span class="quick-tile-icon">${ICON_CALENDAR}</span><span class="quick-tile-label">Planner</span></div>
    </div>

    ${localStorage.getItem(RESUME_KEY) ? `<div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;margin-bottom:16px">
      <button class="btn btn-secondary btn-sm" style="flex-shrink:0" onclick="checkResumableTest()">▶ Resume Test</button>
    </div>` : ''}

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

    <div class="section-label">Browse Other Years</div>
    <div style="font-size:11px;color:var(--ink-4);margin:-4px 0 10px">You can explore any year's content. To attempt or review, your profile year must match.</div>
    ${allYearsHtml || '<div class="card"><p>No other years configured yet.</p></div>'}
    <div style="height:16px"></div>`;

  checkNewNotifications();
  } catch(e) {
    console.error('renderHome error:', e);
    document.getElementById('homePageWrap').innerHTML = `<div class="card"><p>Failed to load. <button class="btn btn-primary btn-sm mt-2" onclick="renderHome()">Retry</button></p></div>`;
  } finally { showLoading(false); }
}
window.renderHome = renderHome;



// Expand/collapse a year section on Home to show its modules
async function toggleYearSection(yearId) {
  const section = document.getElementById('yearSection'+yearId);
  const chevron = document.getElementById('yearChevron'+yearId);
  if (!section) return;
  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'block';
  if (chevron) chevron.textContent = isOpen ? '▾' : '▴';
  if (isOpen || section.dataset.loaded === 'true') return;

  section.innerHTML = '<div class="spinner" style="margin:16px auto"></div>';
  const { data: yearRow } = await db(sb.from('years').select('name').eq('id', yearId).maybeSingle(), 'Year error');
  const { data: yearModules } = await db(sb.from('year_modules').select('module_id,display_order').eq('year_id', yearId).order('display_order'), 'YM error');
  const moduleIds = (yearModules||[]).map(ym => ym.module_id);
  if (!moduleIds.length) { section.innerHTML = '<div style="font-size:12px;color:var(--ink-4);padding:8px 0">No modules added yet.</div>'; section.dataset.loaded='true'; return; }
  const { data: modules } = await db(sb.from('modules').select('*').in('id', moduleIds), 'Modules error');
  const ordered = (yearModules||[]).map(ym => modules?.find(m => m.id===ym.module_id)).filter(Boolean);
  const counts = await getQuestionCountsForModules(ordered.map(m => m.id));
  section.innerHTML = ordered.map(m => buildModuleCardHtml(m, counts[m.id]||0, null, yearId, yearRow?.name||'')).join('');
  section.dataset.loaded = 'true';
}
window.toggleYearSection = toggleYearSection;




// ==================== MODULE DETAIL ====================
async function openModule(moduleId, moduleName, iconUrl, color, fromYearId, fromYearName) {
  showLoading(true, 'Loading module...');
  const [moduleRes, subjectsRes, qCountRes, moduleTestsRes] = await Promise.all([
    db(sb.from('modules').select('name,icon_url,color').eq('id', moduleId).single(), 'Module error'),
    db(sb.from('subjects').select('*').eq('module_id', moduleId).order('display_order'), 'Subjects error'),
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
  const subjects = subjectsRes.data || [];
  const totalQ = qCountRes.count || 0;
  const moduleTestCount = moduleTestsRes.data?.length || 0;
  const stats = await getUserStats();
  showLoading(false);

  // Determine if this module belongs to the student's own year (their year_of_study).
  // If not, Attempt/Review are blocked with a friendly message — browsing structure is still allowed.
  const isOwnYear = !fromYearName || fromYearName === window.currentUser?.year_of_study;
  window._currentModuleYearName = fromYearName || window.currentUser?.year_of_study || null;

  // Batch fetch subject counts — one request total instead of one per subject
  const subCounts = await getQuestionCountsBy('subject_id', subjects.map(s => s.id));

  let subjectHtml = '';
  for (const s of subjects) {
    const sCount = subCounts[s.id];
    const sStats = stats.subject_stats?.[`${moduleId}_${s.id}`] || {};
    const sAcc = sStats.total ? Math.round((sStats.correct / sStats.total) * 100) : null;
    subjectHtml += `
      <div class="list-item" onclick="openSubjectTestGroup(${moduleId},'${moduleName.replace(/'/g,"\\'")}',${s.id},'${s.name.replace(/'/g,"\\'")}')">
        <div class="list-item-left">
          <div class="list-item-icon">${ICON_BOOK}</div>
          <div style="min-width:0">
            <div class="list-item-title">${s.name}</div>
            <div class="list-item-sub">${sCount || 0} questions${sAcc !== null ? ` · ${sAcc}% last accuracy` : ' · Not started'}</div>
          </div>
        </div>
        <span style="color:var(--ink-4)">›</span>
      </div>`;
  }

  // Whole-module practice tests (admin-curated, e.g. "Head & Neck Practice Test 1") —
  // tapping opens openModuleTestGroup() below, which lists them with Review/Attempt.
  const moduleTestsHtml = `
    <div class="list-item" onclick="openModuleTestGroup(${moduleId},'${moduleName.replace(/'/g,"\\'")}')">
      <div class="list-item-left">
        <div class="list-item-icon">${ICON_TARGET}</div>
        <div style="min-width:0">
          <div class="list-item-title">${moduleName} Practice Tests</div>
          <div class="list-item-sub">${moduleTestCount} test${moduleTestCount === 1 ? '' : 's'}</div>
        </div>
      </div>
      <span style="color:var(--ink-4)">›</span>
    </div>`;

  const wrap = document.getElementById('modulePageWrap');
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back</button>

    <div class="card-teal" style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
      <img src="${iconUrl || 'https://placehold.co/72x72/ffffff/c9980a?text=📚'}" style="width:72px;height:72px;border-radius:var(--radius-lg);object-fit:cover;background:rgba(255,255,255,.15)" onerror="this.src='https://placehold.co/72x72/ffffff/c9980a?text=📚'">
      <div>
        <h2>${moduleName}</h2>
        <p>${totalQ} total questions</p>
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
  const m = window._lastOpenedModule;
  if (m) openModule(m.moduleId, m.moduleName, m.iconUrl, m.color, m.fromYearId, m.fromYearName);
  else goBack();
}
window.backToModule = backToModule;



// ==================== GLOBAL PAST PAPERS (College → Year → Papers) ====================
// Past Papers lives outside the module structure entirely now — one shared
// library spanning every module, browsed as College → Year → Papers. Reuses
// the 'module' screen/modulePageWrap the same in-place way openModule()'s
// old sub-views did, so Review/Solve still hand off to the exact same
// startTest() used everywhere else — driven by paper_id alone (see
// startTest()), since a single paper can be tagged with any number of
// modules via the past_paper_modules table (e.g. one exam paper covering
// GIT + Endocrinology + Pharmacology), not just one.
let _pastPapersData = null;

 // { collegeGroups } — cached per visit so drilling down/back never re-fetches

async function openPastPapersRoot() {
  showLoading(true, 'Loading past papers...');
  // Plain selects + separate lookups, NOT embedded joins — PostgREST can't
  // always resolve those relationships for past_papers, and this sidesteps
  // it entirely with simple, always-working queries run in parallel.
  const [{ data: allPapers }, { data: allModules }, { data: allTags }] = await Promise.all([
    db(sb.from('past_papers').select('*').eq('is_active', true).order('display_order'), 'Past papers error'),
    db(sb.from('modules').select('id,name'), 'Modules error'),
    db(sb.from('past_paper_modules').select('paper_id,module_id'), 'Paper-module tags error')
  ]);
  const moduleNameById = {};
  for (const m of (allModules || [])) moduleNameById[m.id] = m.name;
  const moduleIdsByPaper = {};
  for (const t of (allTags || [])) {
    if (!moduleIdsByPaper[t.paper_id]) moduleIdsByPaper[t.paper_id] = [];
    moduleIdsByPaper[t.paper_id].push(t.module_id);
  }
  const papers = allPapers || [];
  const ppCounts = await getQuestionCountsBy('paper_id', papers.map(p => p.id));
  showLoading(false);

  // Group by college, keeping only papers that actually have questions —
  // same rule the old per-module grouping used. Question count + module tag
  // are stashed on each paper (_qCount/_moduleTag) so drilling into a year
  // never needs to re-fetch either. _moduleTag joins every module this paper
  // is tagged with via past_paper_modules (any number, e.g. "GIT +
  // Endocrinology + Pharmacology") — it's purely a display label admin sets,
  // not a real relationship, and is blank if nothing is tagged.
  const collegeGroups = {};
  for (const p of papers) {
    const qCount = ppCounts[p.id] || 0;
    if (!qCount) continue;
    const collegeName = (p.college_name || '').trim();
    const key = collegeName || '__general__';
    if (!collegeGroups[key]) collegeGroups[key] = { collegeName, papers: [] };
    const moduleTag = (moduleIdsByPaper[p.id] || []).map(id => moduleNameById[id]).filter(Boolean).join(' + ');
    collegeGroups[key].papers.push({ ...p, _qCount: qCount, _moduleTag: moduleTag });
  }
  _pastPapersData = { collegeGroups };

  renderPastPapersRootShell();
  showScreen('module');
}
window.openPastPapersRoot = openPastPapersRoot;



// Renders the college-list shell (header + search box + list container) and
// fills the list from cache. Also used to go "back" from a college's year
// list without re-fetching anything.
function renderPastPapersRootShell() {
  window._lastOpenedPastPapers = { level: 'root' };
  window._moduleScreenMode = 'pastpapers';
  const wrap = document.getElementById('modulePageWrap');
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back</button>
    <div class="card-teal" style="margin-bottom:16px"><h2>${ICON_BUILDING} Past Papers</h2><p>Choose your college to find its papers</p></div>
    <div class="mb-3"><input type="text" id="ppCollegeSearch" class="input-field" placeholder="🔍 Search college..." oninput="filterPastPaperColleges(this.value)"></div>
    <div id="ppCollegeListInner"></div>
    <div style="height:16px"></div>`;
  filterPastPaperColleges('');
}
window.renderPastPapersRootShell = renderPastPapersRootShell;



// Re-renders only the list below the search box, never the input itself —
// so typing doesn't lose focus/cursor position on every keystroke.
function filterPastPaperColleges(term) {
  const listWrap = document.getElementById('ppCollegeListInner');
  if (!listWrap || !_pastPapersData) return;
  const { collegeGroups } = _pastPapersData;
  const t = (term || '').trim().toLowerCase();

  const sortedKeys = Object.keys(collegeGroups).sort((a, b) => {
    if (a === '__general__') return 1;
    if (b === '__general__') return -1;
    return collegeGroups[a].collegeName.localeCompare(collegeGroups[b].collegeName);
  });

  let html = '';
  for (const key of sortedKeys) {
    const g = collegeGroups[key];
    const title = g.collegeName || 'Other Colleges';
    if (t && !title.toLowerCase().includes(t)) continue;
    const years = [...new Set(g.papers.map(p => (p.paper_year || '').trim()).filter(Boolean))]
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    html += `
      <div class="list-item" onclick="openPastPaperCollege('${escJs(key)}')">
        <div class="list-item-left">
          <div class="list-item-icon">${ICON_BUILDING}</div>
          <div style="min-width:0">
            <div class="list-item-title">${esc(title)} Past Papers</div>
            <div class="list-item-sub">${g.papers.length} paper${g.papers.length === 1 ? '' : 's'}${years.length ? ' · ' + esc(years.join(', ')) : ''}</div>
          </div>
        </div>
        <span style="color:var(--ink-4)">›</span>
      </div>`;
  }
  listWrap.innerHTML = html || `<div class="card"><p>${t ? 'No colleges match your search.' : 'No past papers added yet. Check back soon.'}</p></div>`;
}
window.filterPastPaperColleges = filterPastPaperColleges;



// College tapped from the root list — groups that college's papers by exam
// year (most recent first) so the student picks a year next.
function openPastPaperCollege(collegeKey) {
  const g = _pastPapersData?.collegeGroups?.[collegeKey];
  if (!g) { openPastPapersRoot(); return; }
  window._lastOpenedPastPapers = { level: 'college', collegeKey };
  window._moduleScreenMode = 'pastpapers';
  const title = g.collegeName || 'Other Colleges';

  const yearGroups = {};
  for (const p of g.papers) {
    const y = (p.paper_year || '').trim();
    const yKey = y || '__noyear__';
    if (!yearGroups[yKey]) yearGroups[yKey] = { year: y, papers: [] };
    yearGroups[yKey].papers.push(p);
  }
  const sortedYearKeys = Object.keys(yearGroups).sort((a, b) => {
    if (a === '__noyear__') return 1;
    if (b === '__noyear__') return -1;
    return b.localeCompare(a, undefined, { numeric: true });
  });

  let html = '';
  for (const yKey of sortedYearKeys) {
    const yg = yearGroups[yKey];
    const yearLabel = yg.year || 'Other';
    html += `
      <div class="list-item" onclick="openPastPaperYear('${escJs(collegeKey)}','${escJs(yKey)}')">
        <div class="list-item-left">
          <div class="list-item-icon">${ICON_CALENDAR}</div>
          <div style="min-width:0">
            <div class="list-item-title">${esc(title)} ${esc(yearLabel)}</div>
            <div class="list-item-sub">${yg.papers.length} paper${yg.papers.length === 1 ? '' : 's'}</div>
          </div>
        </div>
        <span style="color:var(--ink-4)">›</span>
      </div>`;
  }

  const wrap = document.getElementById('modulePageWrap');
  wrap.innerHTML = `
    <button class="back-btn" onclick="renderPastPapersRootShell()">← Back to Past Papers</button>
    <div class="card-teal" style="margin-bottom:16px"><h2>${ICON_BUILDING} ${esc(title)}</h2><p>Choose a year</p></div>
    ${html || '<div class="card"><p>No papers in this group.</p></div>'}
    <div style="height:16px"></div>`;
}
window.openPastPaperCollege = openPastPaperCollege;



// Year tapped from a college's year list — every paper for that college+year,
// flat (papers aren't tied to one module, so there's nothing to section by).
// Review/Solve wire into the exact same startTest() as everywhere else, which
// pulls this paper's questions by paper_id alone (module is passed as null
// below — it's not read in paper mode). Each paper can carry any number of
// module tags via past_paper_modules (_moduleTag), purely as a display label
// admin sets — not a real relationship.
async function openPastPaperYear(collegeKey, yearKey) {
  const g = _pastPapersData?.collegeGroups?.[collegeKey];
  if (!g) { openPastPapersRoot(); return; }
  window._lastOpenedPastPapers = { level: 'year', collegeKey, yearKey };
  window._moduleScreenMode = 'pastpapers';
  const title = g.collegeName || 'Other Colleges';
  const papers = g.papers.filter(p => ((p.paper_year || '').trim() || '__noyear__') === yearKey)
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const yearLabel = yearKey === '__noyear__' ? 'Other' : yearKey;

  showLoading(true, 'Loading papers...');
  const stats = await getUserStats();
  showLoading(false);

  // Flat list — a paper isn't tied to one module anymore (a real past paper
  // spans several subjects), so there's no single module left to group these
  // by. Older papers that still have a module on record show it as a small
  // optional tag instead.
  let html = '';
  for (const p of papers) {
    const pStats = stats.paper_stats?.[p.id] || null;
    const metaBits = [`${p._qCount} questions`, `⏱ ~${Math.ceil(p._qCount * 1.5)} min`];
    if (p._moduleTag) metaBits.push(`📦 ${esc(p._moduleTag)}`);
    const bestLine = attemptLineHtml(pStats);
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
          <button class="btn btn-secondary btn-sm" onclick="startTest('browse',null,'${escJs(p.title)}',null,${p.id},'${escJs(p.title)}')">👁 Review</button>
          <button class="btn btn-primary btn-sm" onclick="startTest('attempt',null,'${escJs(p.title)}',null,${p.id},'${escJs(p.title)}')">📝 Solve</button>
        </div>
      </div>`;
  }

  const wrap = document.getElementById('modulePageWrap');
  wrap.innerHTML = `
    <button class="back-btn" onclick="openPastPaperCollege('${escJs(collegeKey)}')">← Back to ${esc(title)}</button>
    <div class="card-teal" style="margin-bottom:16px"><h2>${ICON_CALENDAR} ${esc(title)} ${esc(yearLabel)}</h2><p>${papers.length} paper${papers.length === 1 ? '' : 's'}</p></div>
    ${html || '<div class="card"><p>No papers with questions in this group yet.</p></div>'}
    <div style="height:16px"></div>`;
}
window.openPastPaperYear = openPastPaperYear;



// Drill-down shown after tapping the "[Module] Practice Tests" row on the module page —
// lists the whole-module tests admin created (e.g. "Head & Neck Practice Test 1/2/3"),
// each with the same Review/Attempt actions used everywhere else in the app.
async function openModuleTestGroup(moduleId, moduleName) {
  showLoading(true, 'Loading practice tests...');
  const { data: tests } = await db(sb.from('practice_tests').select('*').eq('module_id', moduleId).is('subject_id', null).eq('is_active', true).order('display_order'), 'Tests error');
  const list = tests || [];
  const counts = await getQuestionCountsBy('practice_test_id', list.map(t => t.id));
  const stats = await getUserStats();
  showLoading(false);

  const fromYearName = window._lastOpenedModule?.fromYearName || null;
  const isOwnYear = !fromYearName || fromYearName === window.currentUser?.year_of_study;
  const lockedClick = `blockWrongYear('${(fromYearName||'').replace(/'/g,"\\'")}')`;

  let html = '';
  for (const t of list) {
    const tCount = counts[t.id] || 0;
    if (!tCount) continue;
    const tStats = stats.test_stats?.[t.id] || null;
    const metaBits = [`${tCount} questions`, `⏱ ~${Math.ceil(tCount * 1.5)} min`];
    const bestLine = attemptLineHtml(tStats);
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
          <button class="btn btn-secondary btn-sm" onclick="${isOwnYear ? `startTest('browse',${moduleId},'${moduleName.replace(/'/g,"\\'")}',null,null,null,${t.id},'${t.title.replace(/'/g,"\\'")}')` : lockedClick}">👁 Review</button>
          <button class="btn btn-primary btn-sm" onclick="${isOwnYear ? `startTest('attempt',${moduleId},'${moduleName.replace(/'/g,"\\'")}',null,null,null,${t.id},'${t.title.replace(/'/g,"\\'")}')` : lockedClick}">📝 Attempt</button>
        </div>
      </div>`;
  }

  const wrap = document.getElementById('modulePageWrap');
  wrap.innerHTML = `
    <button class="back-btn" onclick="backToModule()">← Back to ${moduleName}</button>
    <div class="card-teal" style="margin-bottom:16px"><h2>${ICON_TARGET} ${moduleName} Practice Tests</h2><p>${list.length} test${list.length === 1 ? '' : 's'}</p></div>
    ${html || '<div class="card"><p>No practice tests added yet for this module. Check back soon.</p></div>'}
    <div style="height:16px"></div>`;
}
window.openModuleTestGroup = openModuleTestGroup;



// Drill-down shown after tapping a Subject row on the module page — lists that
// subject's admin-created tests (e.g. "Gross Anatomy Practice Test 1/2/3"), each
// with the same Review/Attempt actions used everywhere else in the app.
async function openSubjectTestGroup(moduleId, moduleName, subjectId, subjectName) {
  showLoading(true, 'Loading practice tests...');
  const { data: tests } = await db(sb.from('practice_tests').select('*').eq('module_id', moduleId).eq('subject_id', subjectId).eq('is_active', true).order('display_order'), 'Tests error');
  const list = tests || [];
  const counts = await getQuestionCountsBy('practice_test_id', list.map(t => t.id));
  const stats = await getUserStats();
  showLoading(false);

  const fromYearName = window._lastOpenedModule?.fromYearName || null;
  const isOwnYear = !fromYearName || fromYearName === window.currentUser?.year_of_study;
  const lockedClick = `blockWrongYear('${(fromYearName||'').replace(/'/g,"\\'")}')`;

  let html = '';
  for (const t of list) {
    const tCount = counts[t.id] || 0;
    if (!tCount) continue;
    const tStats = stats.test_stats?.[t.id] || null;
    const metaBits = [`${tCount} questions`, `⏱ ~${Math.ceil(tCount * 1.5)} min`];
    const bestLine = attemptLineHtml(tStats);
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
          <button class="btn btn-secondary btn-sm" onclick="${isOwnYear ? `startTest('browse',${moduleId},'${moduleName.replace(/'/g,"\\'")}',null,null,null,${t.id},'${t.title.replace(/'/g,"\\'")}')` : lockedClick}">👁 Review</button>
          <button class="btn btn-primary btn-sm" onclick="${isOwnYear ? `startTest('attempt',${moduleId},'${moduleName.replace(/'/g,"\\'")}',null,null,null,${t.id},'${t.title.replace(/'/g,"\\'")}')` : lockedClick}">📝 Attempt</button>
        </div>
      </div>`;
  }

  const wrap = document.getElementById('modulePageWrap');
  wrap.innerHTML = `
    <button class="back-btn" onclick="backToModule()">← Back to ${moduleName}</button>
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
  const { data: modules } = moduleIds.length
    ? await db(sb.from('modules').select('*').in('id', moduleIds), 'Modules fetch error')
    : { data: [] };
  const { data: savedTests } = await db(sb.from('custom_tests').select('*').eq('user_email', window.currentUser.email).order('created_at', { ascending: false }), 'Saved tests error');
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
      <p class="text-xs text-muted mb-3">Behaves like a real Attempt: answers are locked in until you finish, review comes after. It won't count toward your stats or the leaderboard.</p>

      ${savedTests?.length ? `
      <div class="card" style="margin-bottom:14px">
        <div class="fw-700 mb-2 text-sm">📁 My Saved Tests</div>
        ${savedTests.map(t => `
          <div class="flex-between" style="padding:6px 0">
            <div class="text-sm">${t.name} <span class="text-xs text-muted">(${t.question_count}q, ${t.time_limit_minutes||0}min)</span></div>
            <div style="display:flex;gap:4px">
              <button class="btn btn-secondary btn-xs" onclick="startSavedCustomTest(${t.id})">▶ Start</button>
              <button class="btn btn-ghost btn-xs" onclick="deleteSavedCustomTest(${t.id})">🗑</button>
            </div>
          </div>`).join('')}
      </div>` : ''}

      <div class="fw-700 mb-2 text-sm">1. Pick Module(s)</div>
      <div id="ctbModules" style="margin-bottom:14px">
        ${(modules||[]).length ? (modules||[]).map(m => `
          <label style="display:flex;align-items:center;gap:8px;padding:6px 0">
            <input type="checkbox" class="ctb-module" value="${m.id}" data-name="${m.name.replace(/"/g,'&quot;')}" onchange="ctbModulesChanged()">
            <span class="text-sm">${m.name}</span>
          </label>`).join('') : '<p class="text-xs text-muted">No modules are set up for your year yet. Ask your admin to add some first.</p>'}
      </div>

      <div class="fw-700 mb-2 text-sm">2. Pick Subject(s) <span class="text-xs text-muted">(optional, leave blank for all)</span></div>
      <div id="ctbSubjects" style="margin-bottom:14px"><p class="text-xs text-muted">Select a module first</p></div>

      <div class="fw-700 mb-2 text-sm">3. Test Settings</div>
      <label class="input-label">Number of Questions</label>
      <input id="ctb_count" type="number" class="input-field" value="20" min="5" max="200">
      <label class="input-label">Timer (minutes, 0 for no timer)</label>
      <input id="ctb_timer" type="number" class="input-field" value="30" min="0" max="240">
      <label class="input-label">Save this test as (optional)</label>
      <input id="ctb_name" class="input-field" placeholder="e.g. My Anatomy + Physio Mix">

      <div class="btn-row mt-3">
        <button class="btn btn-secondary" onclick="buildCustomTest(true)">💾 Save Only</button>
        <button class="btn btn-primary" onclick="buildCustomTest(false)">Start Test</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.openCustomTestBuilder = openCustomTestBuilder;



async function ctbModulesChanged() {
  const checked = [...document.querySelectorAll('.ctb-module:checked')];
  const subWrap = document.getElementById('ctbSubjects');
  if (!checked.length) { subWrap.innerHTML = '<p class="text-xs text-muted">Select a module first</p>'; return; }
  const moduleIds = checked.map(c => c.value);
  const { data: subs } = await db(sb.from('subjects').select('id,name,module_id').in('module_id', moduleIds).order('display_order'), 'Subjects error');
  if (!subs?.length) { subWrap.innerHTML = '<p class="text-xs text-muted">No subjects defined. All questions in the module(s) will be used.</p>'; return; }
  const moduleNameMap = {};
  checked.forEach(c => moduleNameMap[c.value] = c.dataset.name);
  subWrap.innerHTML = subs.map(s => `
    <label style="display:flex;align-items:center;gap:8px;padding:5px 0">
      <input type="checkbox" class="ctb-subject" value="${s.id}">
      <span class="text-sm">${s.name} <span class="text-xs text-muted">(${moduleNameMap[s.module_id]||''})</span></span>
    </label>`).join('');
}
window.ctbModulesChanged = ctbModulesChanged;



async function buildCustomTest(saveOnly) {
  const moduleIds = [...document.querySelectorAll('.ctb-module:checked')].map(c => parseInt(c.value));
  const subjectIds = [...document.querySelectorAll('.ctb-subject:checked')].map(c => parseInt(c.value));
  const count = parseInt(document.getElementById('ctb_count').value) || 20;
  const timer = parseInt(document.getElementById('ctb_timer').value) || 0;
  const name = document.getElementById('ctb_name').value.trim() || `Custom Test ${new Date().toLocaleDateString()}`;
  if (!moduleIds.length) return showToast('Please select at least one module');

  if (saveOnly || document.getElementById('ctb_name').value.trim()) {
    await db(sb.from('custom_tests').insert({
      user_email: window.currentUser.email, name, module_ids: moduleIds, subject_ids: subjectIds,
      question_count: count, time_limit_minutes: timer
    }), 'Save failed');
    showToast('Test saved ✓');
    if (saveOnly) { document.getElementById('ctbOverlay')?.remove(); return; }
  }
  document.getElementById('ctbOverlay')?.remove();
  startCustomTest(moduleIds, subjectIds, count, timer, name);
}
window.buildCustomTest = buildCustomTest;



async function startSavedCustomTest(id) {
  const { data: t } = await db(sb.from('custom_tests').select('*').eq('id', id).single(), 'Load failed');
  if (!t) return;
  document.getElementById('ctbOverlay')?.remove();
  startCustomTest(t.module_ids, t.subject_ids, t.question_count, t.time_limit_minutes, t.name);
}
window.startSavedCustomTest = startSavedCustomTest;



async function deleteSavedCustomTest(id) {
  await db(sb.from('custom_tests').delete().eq('id', id), 'Delete failed');
  showToast('Deleted');
  document.getElementById('ctbOverlay')?.remove();
  openCustomTestBuilder();
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
  if (!forceRefresh && window._lastStats && window._lastStatsFetchedAt && (Date.now() - window._lastStatsFetchedAt < 30000)) {
    return window._lastStats;
  }
  const { data } = await db(sb.from('user_stats').select('*').eq('email', window.currentUser.email).maybeSingle(), 'Stats fetch failed');
  const result = data || { total_tests: 0, total_questions: 0, total_correct: 0, best_score: 0, history: [], streak: 0, last_practice_date: null, subject_stats: {}, paper_stats: {}, test_stats: {} };
  window._lastStats = result;
  window._lastStatsFetchedAt = Date.now();
  return result;
}



export async function saveUserStats(stats) {
  window._lastStats = stats;
  window._lastStatsFetchedAt = Date.now();
  // completed_attempt_tests is saved as its own separate call, not mixed into
  // this upsert. That column needs a one-time migration in Supabase (see the
  // note in the SQL reference near the end of this file) — bundling it in
  // meant that until the migration was run, Supabase rejected the ENTIRE
  // upsert over that one unrecognized column, silently failing to save
  // total_tests/total_correct/history/streak too, for every single
  // submission. Splitting it out means core stats always save regardless of
  // whether that migration has been run yet.
  const { completed_attempt_tests, ...coreStats } = stats;
  const { error } = await sb.from('user_stats').upsert({ email: window.currentUser.email, ...coreStats });
  if (error) {
    console.warn('Stats save failed', error);
    showToast('⚠️ Could not save your stats. Check your connection', 4000);
    return;
  }
  if (typeof completed_attempt_tests === 'number') {
    const { error: e2 } = await sb.from('user_stats').update({ completed_attempt_tests }).eq('email', window.currentUser.email);
    if (e2) console.warn('completed_attempt_tests not saved — run the migration in Supabase SQL Editor (see SQL reference section)', e2);
  }
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
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}



function showLocalNotification(title, body) {
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && localStorage.getItem('notif_enabled') !== 'false') {
    new Notification(title, { body });
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



async function checkNewNotifications() {
  if (!window.currentUser || localStorage.getItem('notif_enabled') === 'false') return;
  const { data } = await db(sb.from('app_notifications').select('*').order('created_at', { ascending: false }).limit(20), 'Notif load failed');
  const relevant = (data || []).filter(n => !n.target_college || n.target_college === window.currentUser.college);
  window._appNotifs = relevant;
  const lastSeen = parseInt(localStorage.getItem('last_seen_notif_id') || '0');
  const unread = relevant.filter(n => n.id > lastSeen).length;
  const badge = document.getElementById('notifBellBadge');
  if (badge) badge.style.display = unread > 0 ? 'flex' : 'none';
  if (badge) badge.textContent = unread > 9 ? '9+' : unread;
  // Fire a native OS notification for the newest one if we have permission (nice-to-have, doesn't work if app/browser is fully closed)
  if (unread > 0 && relevant[0]) showLocalNotification(relevant[0].title, relevant[0].body || '');
}



function openNotificationBell() {
  const notifs = window._appNotifs || [];
  const maxId = notifs.length ? Math.max(...notifs.map(n => n.id)) : 0;
  localStorage.setItem('last_seen_notif_id', maxId);
  document.getElementById('notifBellBadge')?.style && (document.getElementById('notifBellBadge').style.display = 'none');
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10005;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:20px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto">
      <div class="flex-between mb-3">
        <span class="fw-700">🔔 Notifications</span>
        <button onclick="this.closest('[style*=fixed]').remove()" style="background:none;border:none;font-size:18px;cursor:pointer">✕</button>
      </div>
      ${notifs.length ? notifs.map(n => `
        <div class="card" style="margin-bottom:8px">
          <div class="fw-700 text-sm">${n.title}</div>
          ${n.body ? `<div class="text-sm" style="margin-top:2px">${n.body}</div>` : ''}
          <div class="text-xs text-muted mt-1">${timeAgo(new Date(n.created_at).getTime())}</div>
        </div>`).join('') : '<p class="text-sm text-muted text-center">No notifications yet.</p>'}
    </div>`;
  document.body.appendChild(overlay);
}
window.openNotificationBell = openNotificationBell;



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
      stats: renderStats, ranking: renderRanking, profile: renderProfile,
      bookmarks: renderBookmarks, planner: renderPlanner,
      module: () => {
        if (window._moduleScreenMode === 'pastpapers' && window._lastOpenedPastPapers) {
          const pp = window._lastOpenedPastPapers;
          openPastPapersRoot().then(() => {
            if (pp.level === 'college' && pp.collegeKey) openPastPaperCollege(pp.collegeKey);
            else if (pp.level === 'year' && pp.collegeKey && pp.yearKey) { openPastPaperCollege(pp.collegeKey); openPastPaperYear(pp.collegeKey, pp.yearKey); }
          });
        } else if (window._lastOpenedModule) {
          const m = window._lastOpenedModule;
          openModule(m.moduleId, m.moduleName, m.iconUrl||'', m.color||'', m.fromYearId||null, m.fromYearName||null);
        }
      },
      results: () => { if (window.activeTest) renderResults(); },
      review: () => { if (window.reviewState) { renderReview(); showScreen('review', false); } }
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
const APP_STATE_RESTORABLE_SCREENS = ['home','modules','search','stats','ranking','profile','bookmarks','wrongattempts','planner','admin','module','results','review'];



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
        const pp = state.pastPapersState;
        await openPastPapersRoot();
        if (pp.level === 'college' && pp.collegeKey) openPastPaperCollege(pp.collegeKey);
        else if (pp.level === 'year' && pp.collegeKey && pp.yearKey) { openPastPaperCollege(pp.collegeKey); await openPastPaperYear(pp.collegeKey, pp.yearKey); }
        setTimeout(() => window.scrollTo(0, state.scrollY || 0), 300);
        return true;
      }
      if (!state.moduleState) return false; // can't restore without saved module params
      const m = state.moduleState;
      await openModule(m.moduleId, m.moduleName, m.iconUrl || '', m.color || '');
      // openModule already calls showScreen('module') internally, so skip generic render below
      setTimeout(() => window.scrollTo(0, state.scrollY || 0), 300);
      return true;
    }

    // ---- results screen: restore activeTest then re-render ----
    if (state.screenId === 'results') {
      if (!state.savedActiveTest) return false;
      window.activeTest = state.savedActiveTest;
      renderResults(); // re-renders resultsPageWrap and calls showScreen('results')
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
      setTimeout(() => window.scrollTo(0, state.scrollY || 0), 300);
      return true;
    }

    const renders = {
      home: renderHome, modules: renderModulesScreen, search: renderSearch, stats: renderStats,
      ranking: renderRanking, profile: renderProfile, bookmarks: renderBookmarks, wrongattempts: renderWrongAttempts, planner: renderPlanner,
      admin: () => renderAdminPanel(state.adminTab || 'overview')
    };
    if (renders[state.screenId]) await renders[state.screenId]();
    showScreen(state.screenId, false);
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

const manifestData = {
  name: "LUMHSian",
  short_name: "LUMHSian",
  description: "AI-powered MBBS QBank for medical students",
  start_url: "/",
  display: "standalone",
  background_color: "#c9980a",
  theme_color: "#ffffff",
  icons: [
    { src: "https://placehold.co/192x192/c9980a/ffffff?text=L", sizes: "192x192", type: "image/png" },
    { src: "https://placehold.co/512x512/c9980a/ffffff?text=L", sizes: "512x512", type: "image/png" }
  ]
};


const manifestBlob = new Blob([JSON.stringify(manifestData)], { type: 'application/json' });


const manifestUrl = URL.createObjectURL(manifestBlob);


const manifestLink = document.createElement('link');


manifestLink.rel = 'manifest';


manifestLink.href = manifestUrl;


document.head.appendChild(manifestLink);



// Theme color meta
const metaTheme = document.createElement('meta');


metaTheme.name = 'theme-color';


metaTheme.content = localStorage.getItem('dark_mode') === 'true' ? '#000000' : '#ffffff';


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



// ==================== SEARCH (with module + difficulty filters) ====================
export async function renderSearch(term = '') {
  const wrap = document.getElementById('searchPageWrap');
  const { data: modules } = await db(sb.from('modules').select('id,name'), 'Modules error');

  wrap.innerHTML = `
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2" style="font-family:var(--font-display)">🔍 Search</div>
      <div class="input-group mb-2">
        <input type="text" id="searchInput" class="input-field" placeholder="Search questions, modules, subjects..." value="${term}" oninput="executeSearchDebounced()" onkeydown="if(event.key==='Enter')executeSearch()" style="margin:0;flex:1">
        <button class="btn btn-primary" style="width:auto;flex-shrink:0" onclick="executeSearch()">Search</button>
      </div>
      <select id="searchModule" class="input-field" title="Filter by module" aria-label="Filter by module" onchange="executeSearch()">
        <option value="">All Modules</option>
        ${(modules||[]).map(m => `<option value="${m.id}">${m.name}</option>`).join('')}
      </select>
      <select id="searchDiff" class="input-field" title="Filter by difficulty" aria-label="Filter by difficulty" onchange="executeSearch()">
        <option value="">All Difficulties</option>
        <option value="easy">🟢 Easy</option>
        <option value="medium">🟡 Medium</option>
        <option value="hard">🔴 Hard</option>
      </select>
    </div>
    <div id="searchResults"></div>`;

  if (term) executeSearch();
}



async function executeSearch() {
  const term = document.getElementById('searchInput')?.value.trim() || '';
  const moduleId = document.getElementById('searchModule')?.value || '';
  const diff = document.getElementById('searchDiff')?.value || '';
  const resWrap = document.getElementById('searchResults');
  if (!resWrap) return;
  if (!term && !moduleId && !diff) { resWrap.innerHTML = ''; return; }

  resWrap.innerHTML = skeletonList(2, false);

  // Search modules and subjects if there's a text term and no module filter
  let moduleMatchHtml = '';
  let subjectMatchHtml = '';
  if (term && !moduleId) {
    const [modsRes, subRes] = await Promise.all([
      db(sb.from('modules').select('id,name,icon_url').ilike('name', `%${term}%`).limit(5), 'Modules search failed'),
      db(sb.from('subjects').select('id,name,module_id,modules(name)').ilike('name', `%${term}%`).limit(5), 'Subjects search failed')
    ]);
    if (modsRes.data?.length) {
      moduleMatchHtml = `<div class="section-label">Modules</div>` +
        modsRes.data.map(m => `
          <div class="list-item" onclick="openModule(${m.id},'${m.name.replace(/'/g,"\\'")}','${(m.icon_url||'').replace(/'/g,"\\'")}','',null,null)">
            <div class="list-item-left">
              <img src="${m.icon_url||'https://placehold.co/36x36/fdf3c0/c9980a?text=📚'}" style="width:36px;height:36px;border-radius:8px;object-fit:cover" onerror="this.src='https://placehold.co/36x36/fdf3c0/c9980a?text=📚'">
              <div><div class="list-item-title">${m.name}</div><div class="list-item-sub">Tap to open module</div></div>
            </div>
            <span style="color:var(--ink-4)">›</span>
          </div>`).join('');
    }
    if (subRes.data?.length) {
      subjectMatchHtml = `<div class="section-label">Subjects</div>` +
        subRes.data.map(s => `
          <div class="list-item no-hover" style="flex-direction:column;align-items:stretch;cursor:default">
            <div class="list-item-left" style="width:100%">
              <div class="list-item-icon">${ICON_BOOK}</div>
              <div><div class="list-item-title">${s.name}</div><div class="list-item-sub">in ${s.modules?.name || 'Unknown Module'}</div></div>
            </div>
          </div>`).join('');
    }
  }

  // Always search questions
  let query = sb.from('questions').select('id,text,explanation,difficulty,options,correct_answer,module_id,modules(name)').order('id', { ascending: false }).limit(40);
  if (term) query = query.ilike('text', `%${term}%`);
  if (moduleId) query = query.eq('module_id', moduleId);
  if (diff) query = query.eq('difficulty', diff);

  const { data: results } = await db(query, 'Search failed');

  const questionsHtml = results?.length
    ? `<div class="section-label">❓ Questions</div>
       <div class="text-xs text-muted mb-2" style="padding-left:4px">${results.length} result${results.length !== 1 ? 's' : ''}</div>` +
      results.map(q => `
        <div class="card" style="margin-bottom:8px">
          <div class="flex-between mb-1">
            <span class="text-xs text-muted">${q.modules?.name || 'Unknown'}</span>
            <span class="badge badge-${q.difficulty==='easy'?'green':q.difficulty==='hard'?'red':'teal'} text-xs">${q.difficulty||'medium'}</span>
          </div>
          <div style="font-size:14px;font-weight:500;line-height:1.5;margin-bottom:10px">${q.text?.substring(0,150)}${q.text?.length>150?'...':''}</div>
          <div class="btn-row">
            ${isAIEnabled() ? `<button class="btn btn-secondary btn-xs" onclick="openAITutor('${q.text?.replace(/'/g,"\\'").replace(/\n/g,' ')||''}','${(q.explanation||'').replace(/'/g,"\\'").replace(/\n/g,' ')}')">🤖 AI Explain</button>` : ''}
            <button class="btn btn-ghost btn-xs" onclick="quickViewQuestion(${q.id})">👁 Quick View</button>
          </div>
        </div>`).join('')
    : `<div class="card text-center"><p>No questions found${moduleMatchHtml || subjectMatchHtml ? '. Try the modules above' : ''}.</p></div>`;

  if (!moduleMatchHtml && !subjectMatchHtml && !results?.length) {
    resWrap.innerHTML = `<div class="card text-center"><p>No results found for "${term}".</p></div>`;
    return;
  }

  resWrap.innerHTML = moduleMatchHtml + subjectMatchHtml + questionsHtml;
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
  show_on_leaderboard BOOLEAN DEFAULT FALSE,
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

-- MIGRATION (safe to re-run, run once in Supabase SQL Editor): leaderboard
-- eligibility now requires fully completing at least one timed Attempt test
-- (every question answered, none skipped) — this counter tracks that. The app
-- code already tolerates this column being missing (it just retries the stats
-- save without it), but until this is run nobody can qualify for the
-- leaderboard, since the eligibility check reads this column.
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
  ('leaderboard_public', 'true'),
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
  ('leaderboard', '🏆 Leaderboard', 'Show student rankings', TRUE),
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
--   • users: anyone can read (the leaderboard needs this) and you can update
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
-- saves, (2) the leaderboard and bookmarks still load, and (3) trying to set
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
-- 2. Leaderboard/ranking is already cached client-side for 60s (getRankInfo);
--    if the student body grows into the thousands, moving that computation
--    into a materialized view refreshed on a schedule (pg_cron) would take it
--    off the request path entirely.
-- 3. For data that's public and near-static (colleges, years, subscription
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
  // 3. Start notification polling if logged in as a (non-admin) student with a completed profile
  if (window.currentUser && !window.currentUser.is_admin && window.currentUser.profile_completed) {
    checkNewNotifications();
    checkWhatsNew();
    setInterval(checkNewNotifications, 120000);
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
