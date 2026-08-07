import { _renderStale, getQuestionCountsBy, getSetting, loadAppSettings, loadYearScreen, renderHome, saveAppState } from './app.js';
import { showScreen } from './navigation.js';
import { callAIRaw } from './quiz.js';
import { ADMIN_EMAIL, USERS_SAFE_COLS, adminRPC, db, sb } from './supabase.js';
import { _debounce, cacheClear, esc, escJs, renderMd, showConfirm, showLoading, showToast } from './utils.js';

// ==================== ADMIN PANEL MAIN ====================
export async function renderAdminPanel(initialTab = 'overview') {
  const wrap = document.getElementById('adminPageWrap');
  wrap.innerHTML = `
    <div class="admin-header" style="margin:-16px -14px 20px;padding:20px 16px 16px">
      <div class="flex-between" style="margin-bottom:18px">
        <div>
          <div style="font-family:var(--font-display);font-size:22px;font-weight:800;letter-spacing:-0.5px">LUMHSian <span style="color:var(--gold-300)">Admin</span></div>
          <div style="font-size:12px;color:rgba(255,255,255,.5);margin-top:2px">Full Control Dashboard · ${new Date().toLocaleDateString('en-PK',{weekday:'short',day:'numeric',month:'short'})}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-sm" style="background:rgba(255,255,255,.12);color:var(--gold-200);border:1px solid rgba(255,255,255,.15)" onclick="adminViewAsStudent()">👁 Preview</button>
          <button class="btn btn-sm" style="background:rgba(220,38,38,.2);color:#fca5a5;border:1px solid rgba(220,38,38,.3)" onclick="logout()">Logout</button>
        </div>
      </div>
      <!-- Live Stats Bar -->
      <div id="adminLiveBar" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px"></div>
    </div>

    <!-- Admin Tab Navigation -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:20px">
      ${[
        ['📊','Overview','adminTab_overview'],
        ['👥','Students','adminTab_students'],
        ['🎓','Courses','adminTab_courses'],
        ['📚','Content','adminTab_content'],
        ['🚩','Reports','adminTab_reports'],
        ['🐞','Errors','adminTab_errorlogs'],
        ['📢','Announce','adminTab_announce'],
        ['🏫','Colleges','adminTab_colleges'],
        ['💰','Monetize','adminTab_money'],
        ['⚙️','Settings','adminTab_settings'],
        ['📈','Analytics','adminTab_analytics'],
        ['🖼️','Media','adminTab_media']
      ].map(([icon,label,id]) => `
        <button id="${id}" class="btn btn-secondary btn-sm" onclick="adminShowTab('${id.replace('adminTab_','')}')" style="position:relative;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:8px 4px">
          ${icon} ${label}
          ${id === 'adminTab_reports' ? '<span id="_reportsTabBadge" class="admin-tab-badge" style="display:none"></span>' : ''}
        </button>`).join('')}
    </div>

    <div id="adminContent"></div>`;

  await loadAdminLiveBar();
  getPendingReportsCount().then(updateReportsBadge);
  adminShowTab(initialTab);
}



// Small helper so the Reports tab button always shows how many reports/feedback
// are still pending, visible right from the admin panel menu without opening the tab.
async function getPendingReportsCount() {
  try {
    const { count } = await sb.from('reports_feedback').select('*', { count: 'exact', head: true }).eq('status', 'pending');
    return count || 0;
  } catch (e) {
    console.warn('getPendingReportsCount failed', e);
    return 0;
  }
}



function updateReportsBadge(count) {
  const badge = document.getElementById('_reportsTabBadge');
  if (!badge) return;
  if (count > 0) { badge.textContent = count > 99 ? '99+' : String(count); badge.style.display = 'flex'; }
  else badge.style.display = 'none';
}



async function loadAdminLiveBar() {
  const [usersRes, qRes, testsRes] = await Promise.all([
    db(sb.from('users').select('*', { count: 'exact', head: true }), 'Count error'),
    db(sb.from('questions').select('*', { count: 'exact', head: true }), 'Count error'),
    db(sb.from('user_stats').select('total_tests'), 'Stats error')
  ]);
  const totalTests = (testsRes.data || []).reduce((a, b) => a + (b.total_tests || 0), 0);
  const now = Date.now();
  const { data: recentUsers } = await db(sb.from('users').select('last_active').gt('last_active', now - 3600000), 'Active error');

  document.getElementById('adminLiveBar').innerHTML = [
    ['👥', usersRes.count || 0, 'Students'],
    ['❓', qRes.count || 0, 'Questions'],
    ['📝', totalTests, 'Tests Done'],
    ['🟢', recentUsers?.length || 0, 'Online Now']
  ].map(([icon, val, label]) => `
    <div class="admin-stat-pill">
      <div style="font-size:18px">${icon}</div>
      <div style="font-family:var(--font-display);font-size:22px;font-weight:800;line-height:1;margin:4px 0">${val}</div>
      <div style="font-size:10px;color:rgba(255,255,255,.7);font-weight:600;text-transform:uppercase;letter-spacing:.3px">${label}</div>
    </div>`).join('');
}



export function adminShowTab(tab, _preserveContentTab = false) {
  window._currentAdminTab = tab;
  if (!_preserveContentTab) { window._currentContentTab = null; window._currentQSubTab = null; }
  saveAppState();
  document.querySelectorAll('[id^="adminTab_"]').forEach(b => {
    b.style.background = 'var(--surface)';
    b.style.borderColor = 'var(--border-2)';
    b.style.color = 'var(--gold-700)';
  });
  const activeBtn = document.getElementById('adminTab_' + tab);
  if (activeBtn) {
    activeBtn.style.background = '#7a5c00';
    activeBtn.style.color = 'white';
    activeBtn.style.borderColor = 'var(--gold-700)';
  }
  const tabs = {
    overview: adminOverview, students: adminStudents, courses: adminCourses,
    content: adminContent, reports: adminReports, errorlogs: adminErrorLogs, announce: adminAnnouncements,
    colleges: adminColleges, money: adminMonetization, settings: adminAppSettings,
    analytics: adminAnalytics, media: adminMediaLibrary
  };
  if (tabs[tab]) {
    const token = Date.now();
    window._adminRenderToken = token;
    // adminReports takes (filter, token) — every other tab fn takes just (token) — so it
    // needs to be called explicitly here, otherwise the token lands in the filter slot
    // and every "if (filter === ...)" check in adminReports silently fails to match.
    if (tab === 'reports') adminReports('all', token);
    else tabs[tab](token);
  }
}
window.adminShowTab = adminShowTab;



// ==================== OVERVIEW TAB ====================
async function adminOverview(token = window._adminRenderToken) {
  const [usersRes, statsRes, qRes, subRes, modRes] = await Promise.all([
    db(sb.from('users').select('joined,gender,college,last_active,is_banned'), 'Users error'),
    db(sb.from('user_stats').select('total_tests,total_questions,total_correct,streak,history'), 'Stats error'),
    db(sb.from('questions').select('module_id,subject_id'), 'Q error'),
    db(sb.from('subjects').select('id,name'), 'Subjects error'),
    db(sb.from('modules').select('id,name'), 'Modules error')
  ]);

  if (_renderStale(token)) return;
  const users = usersRes.data || [];
  const stats = statsRes.data || [];
  const questions = qRes.data || [];
  const modules = modRes.data || [];

  const now = Date.now();
  const activeToday = users.filter(u => u.last_active > now - 86400000).length;
  const activeWeek = users.filter(u => u.last_active > now - 604800000).length;
  const banned = users.filter(u => u.is_banned).length;
  const newThisWeek = users.filter(u => u.joined > now - 604800000).length;
  const totalTests = stats.reduce((a, b) => a + (b.total_tests || 0), 0);
  const totalQ_attempted = stats.reduce((a, b) => a + (b.total_questions || 0), 0);
  const totalCorrect = stats.reduce((a, b) => a + (b.total_correct || 0), 0);
  const avgAcc = totalQ_attempted ? Math.round((totalCorrect / totalQ_attempted) * 100) : 0;

  // College breakdown
  const collegeMap = {};
  for (const u of users) {
    const c = u.college || 'Unknown';
    collegeMap[c] = (collegeMap[c] || 0) + 1;
  }
  const collegeRows = Object.entries(collegeMap).sort((a, b) => b[1] - a[1]).map(([c, n]) =>
    `<div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
      <span class="text-sm fw-600">${c}</span>
      <div style="display:flex;align-items:center;gap:8px">
        <div class="progress-track" style="width:80px;margin:0"><div class="progress-fill" style="width:${Math.round(n/users.length*100)}%"></div></div>
        <span class="badge badge-teal">${n}</span>
      </div>
    </div>`).join('');

  // Gender breakdown
  const male = users.filter(u => u.gender === 'male').length;
  const female = users.filter(u => u.gender === 'female').length;

  // Module usage
  const moduleUsage = {};
  for (const q of questions) {
    const m = modules.find(mod => mod.id === q.module_id);
    const name = m?.name || 'Unknown';
    moduleUsage[name] = (moduleUsage[name] || 0) + 1;
  }

  // Signups per day (last 7 days)
  const signupChart = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(now - (6 - i) * 86400000);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const end = start + 86400000;
    return { label: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()], count: users.filter(u => u.joined >= start && u.joined < end).length };
  });

  document.getElementById('adminContent').innerHTML = `
    <!-- Quick Start Guide -->
    <div class="card-teal" style="margin-bottom:16px">
      <div class="fw-700 mb-2" style="font-size:16px">🚀 How to add content (in order)</div>
      <div style="font-size:13px;line-height:1.7;opacity:.95">
        1️⃣ <strong>Courses → Years</strong>: add/activate a year (e.g. 2nd Year MBBS)<br>
        2️⃣ <strong>Courses → Modules</strong>: add a module (e.g. Anatomy)<br>
        3️⃣ <strong>Courses → Year↔Module</strong>: link that module to the year<br>
        4️⃣ <strong>Content → Subjects</strong>: add subjects inside the module (optional)<br>
        5️⃣ <strong>Content → Past Papers</strong>: name a paper (college + year)<br>
        6️⃣ <strong>Content → Questions</strong>: add MCQs, pick the module/subject/paper<br>
      </div>
      <div class="text-xs mt-2" style="opacity:.85">💡 You can add modules/subjects/questions to a "Coming Soon" year too. Students just won't see it until you switch it to Active in Years.</div>
      <div class="btn-row mt-3">
        <button class="btn btn-sm" style="background:rgba(255,255,255,.15);color:white" onclick="adminShowTab('courses')">🎓 Go to Courses</button>
        <button class="btn btn-sm" style="background:rgba(255,255,255,.15);color:white" onclick="adminShowTab('content')">📚 Go to Content</button>
        <button class="btn btn-sm" style="background:rgba(255,255,255,.15);color:white" onclick="adminShowTab('settings')">⚙️ AI / Settings</button>
      </div>
    </div>

    <!-- Key Metrics -->
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:16px">
      ${[
        ['👥 Total Students', users.length, ''],
        ['🟢 Active Today', activeToday, 'badge-green'],
        ['📅 Active This Week', activeWeek, 'badge-teal'],
        ['🆕 New This Week', newThisWeek, 'badge-teal'],
        ['🚫 Banned', banned, 'badge-red'],
        ['📝 Tests Taken', totalTests, ''],
        ['❓ Q Attempted', totalQ_attempted, ''],
        ['🎯 Avg Accuracy', avgAcc + '%', '']
      ].map(([label, val, badge]) => `
        <div class="stat-box">
          <div class="stat-val" style="font-size:20px">${val}</div>
          <div class="stat-key">${label}</div>
        </div>`).join('')}
    </div>

    <!-- Gender -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">👫 Gender Distribution</div>
      <div class="flex-between mb-1"><span class="text-sm">👨‍⚕️ Male</span><strong>${male}</strong></div>
      <div class="progress-track"><div class="progress-fill" style="width:${users.length ? Math.round(male/users.length*100) : 0}%"></div></div>
      <div class="flex-between mb-1 mt-2"><span class="text-sm">👩‍⚕️ Female</span><strong>${female}</strong></div>
      <div class="progress-track"><div class="progress-fill" style="width:${users.length ? Math.round(female/users.length*100) : 0}%"></div></div>
    </div>

    <!-- College Breakdown -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">🏫 Students by College</div>
      ${collegeRows || '<p class="text-muted">No data</p>'}
    </div>

    <!-- Signups Chart -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">📈 Signups (Last 7 Days)</div>
      <canvas id="signupCanvas" height="120" style="width:100%"></canvas>
    </div>

    <!-- Module Questions -->
    <div class="card">
      <div class="fw-700 mb-2">📚 Questions by Module</div>
      ${Object.entries(moduleUsage).map(([name, count]) => `
        <div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
          <span class="text-sm fw-600">${name}</span>
          <span class="badge badge-teal">${count} Q</span>
        </div>`).join('') || '<p class="text-muted">No questions yet</p>'}
    </div>`;

  // Draw signup chart
  requestAnimationFrame(() => {
    const canvas = document.getElementById('signupCanvas');
    if (!canvas) return;
    canvas.width = canvas.parentElement.offsetWidth - 40;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = 120;
    const max = Math.max(...signupChart.map(d => d.count), 1);
    const barW = Math.floor((W - 20) / signupChart.length) - 6;
    ctx.clearRect(0, 0, W, H);
    signupChart.forEach((d, i) => {
      const barH = max > 0 ? Math.round((d.count / max) * 80) : 0;
      const x = 10 + i * ((W - 20) / signupChart.length);
      const y = 90 - barH;
      const grad = ctx.createLinearGradient(0, y, 0, 90);
      grad.addColorStop(0, '#c9980a'); grad.addColorStop(1, '#e8a820');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH || 2, [4, 4, 0, 0]);
      ctx.fill();
      ctx.fillStyle = '#404040'; ctx.font = '10px Inter'; ctx.textAlign = 'center';
      ctx.fillText(d.label, x + barW / 2, 110);
      if (d.count > 0) { ctx.fillStyle = '#171717'; ctx.font = 'bold 10px Inter'; ctx.fillText(d.count, x + barW / 2, y - 4); }
    });
  });
}



// ==================== STUDENTS TAB ====================
async function adminStudents(token = window._adminRenderToken) {
  document.getElementById('adminContent').innerHTML = `
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">🔍 Filter & Search Students</div>
      <input type="text" id="studentSearch" class="input-field" placeholder="Search name or email..." oninput="filterStudents()">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <select id="filterCollege" class="input-field" title="Filter by college" aria-label="Filter by college" style="flex:1;margin:0" onchange="filterStudents()">
          <option value="">All Colleges</option>
          <option value="Others">🌐 Others</option>
        </select>
        <select id="filterGender" class="input-field" title="Filter by gender" aria-label="Filter by gender" style="flex:1;margin:0" onchange="filterStudents()">
          <option value="">All Genders</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
        </select>
        <select id="filterStatus" class="input-field" title="Filter by status" aria-label="Filter by status" style="flex:1;margin:0" onchange="filterStudents()">
          <option value="">All Status</option>
          <option value="online">🟢 Online Now</option>
          <option value="active">Active (7d)</option>
          <option value="inactive">Inactive</option>
          <option value="banned">Banned</option>
        </select>
      </div>
      <div class="flex-between mt-2">
        <span id="studentCount" class="text-xs text-muted"></span>
        <button class="btn btn-secondary btn-xs" onclick="exportStudentsCSV()">📥 Export CSV</button>
      </div>
    </div>
    <div id="studentsLiveStrip" style="margin-bottom:12px"></div>
    <div id="studentsList"></div>`;

  await loadStudentsData();
  if (_renderStale(token)) return;
}



// Quick horizontal strip of who's online right now — tap any avatar to open full profile
function renderStudentsLiveStrip() {
  const el = document.getElementById('studentsLiveStrip');
  if (!el) return;
  const now = Date.now();
  const online = allStudentsData.filter(u => isUserOnline(u, now));
  if (!online.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="card" style="padding:12px">
      <div class="flex-between mb-2">
        <div class="fw-700 text-sm">🟢 Online Now (${online.length})</div>
      </div>
      <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:4px">
        ${online.map(u => `
          <div onclick="adminViewStudentDetail('${u.email}')" style="cursor:pointer;text-align:center;flex-shrink:0;width:64px">
            <div style="width:44px;height:44px;border-radius:50%;background:var(--gold-100);display:flex;align-items:center;justify-content:center;font-size:20px;margin:0 auto;position:relative;border:2px solid var(--green)">
              ${u.gender === 'female' ? '👩‍⚕️' : '👨‍⚕️'}
              <span style="position:absolute;bottom:-2px;right:-2px;width:11px;height:11px;background:var(--green);border:2px solid var(--surface);border-radius:50%"></span>
            </div>
            <div class="text-xs" style="margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc((u.name||'').split(' ')[0])||esc(u.email.split('@')[0])}</div>
          </div>`).join('')}
      </div>
    </div>`;
}



// Single source of truth for "is this user online right now" — heartbeat within last 2 minutes
function isUserOnline(u, now = Date.now()) {
  return !!(u.last_heartbeat && (now - new Date(u.last_heartbeat).getTime()) < 120000);
}



let allStudentsData = [];


async function loadStudentsData() {
  showLoading(true, 'Loading students...');
  const { data: users } = await db(sb.from('users').select(USERS_SAFE_COLS).order('joined', { ascending: false }), 'Users error');
  const { data: stats } = await db(sb.from('user_stats').select('*'), 'Stats error');
  const { data: colleges } = await db(sb.from('colleges').select('name').order('name'), 'Colleges error');

  allStudentsData = (users || []).map(u => {
    const s = stats?.find(ss => ss.email === u.email) || {};
    const acc = s.total_questions ? Math.round((s.total_correct / s.total_questions) * 100) : 0;
    return { ...u, stats: s, acc };
  });

  // Populate college filter
  const collegeFilter = document.getElementById('filterCollege');
  if (colleges) {
    for (const c of colleges) {
      const opt = document.createElement('option');
      opt.value = c.name; opt.textContent = c.name;
      collegeFilter?.appendChild(opt);
    }
  }
  showLoading(false);
  filterStudents();
}



function filterStudents() {
  const search = document.getElementById('studentSearch')?.value.toLowerCase() || '';
  const college = document.getElementById('filterCollege')?.value || '';
  const gender = document.getElementById('filterGender')?.value || '';
  const status = document.getElementById('filterStatus')?.value || '';
  const now = Date.now();

  renderStudentsLiveStrip();

  let filtered = allStudentsData.filter(u => {
    if (search && !u.name?.toLowerCase().includes(search) && !u.email?.toLowerCase().includes(search)) return false;
    if (college && u.college !== college) return false;
    if (gender && u.gender !== gender) return false;
    if (status === 'online' && !isUserOnline(u, now)) return false;
    if (status === 'active' && (u.last_active < now - 604800000)) return false;
    if (status === 'inactive' && (u.last_active > now - 604800000)) return false;
    if (status === 'banned' && !u.is_banned) return false;
    return true;
  });

  document.getElementById('studentCount').textContent = `${filtered.length} students`;
  const list = document.getElementById('studentsList');
  if (!list) return;

  if (!filtered.length) { list.innerHTML = `<div class="card text-center"><p>No students match filters.</p></div>`; return; }

  list.innerHTML = filtered.map(u => {
    const lastActive = u.last_active ? timeAgo(u.last_active) : 'Never';
    const joinedDate = u.joined ? new Date(u.joined).toLocaleDateString() : '?';
    const isOnline = isUserOnline(u, now);
    const isActiveToday = u.last_active > now - 86400000;
    return `
      <div class="admin-row" id="student_${u.email.replace(/[^a-zA-Z0-9]/g,'_')}" onclick="adminViewStudentDetail('${u.email}')" style="cursor:pointer">
        <div class="admin-row-left">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
            <div style="width:36px;height:36px;border-radius:50%;background:var(--gold-100);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">${u.gender === 'female' ? '👩‍⚕️' : '👨‍⚕️'}</div>
            <div>
              <div class="fw-700">${esc(u.name) || 'Unknown'}</div>
              <div class="text-xs text-muted">${esc(u.email)}</div>
            </div>
            ${isOnline ? '<span class="badge badge-green" style="font-size:10px">🟢 Online</span>' : isActiveToday ? '<span class="badge badge-teal" style="font-size:10px">Today</span>' : ''}
            ${u.is_banned ? '<span class="badge badge-red">Banned</span>' : ''}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            <span class="chip" style="font-size:11px">🏫 ${esc(u.college) || 'No college'}</span>
            <span class="chip" style="font-size:11px">📅 Joined ${joinedDate}</span>
            <span class="chip" style="font-size:11px">⏰ Active ${lastActive}</span>
            <span class="chip" style="font-size:11px">📝 ${u.stats?.total_tests || 0} tests</span>
            <span class="chip" style="font-size:11px">🎯 ${u.acc}% acc</span>
            <span class="chip" style="font-size:11px">🔥 ${u.stats?.streak || 0} streak</span>
          </div>
        </div>
        <div class="admin-row-actions" onclick="event.stopPropagation()">
          <button class="btn btn-secondary btn-xs" onclick="adminViewStudentDetail('${u.email}')">📊 Full Profile</button>
          <button class="btn ${u.is_banned ? 'btn-secondary' : 'btn-danger'} btn-xs" onclick="adminToggleBan('${u.email}',${u.is_banned})">${u.is_banned ? '✅ Unban' : '🚫 Ban'}</button>
          <button class="btn btn-danger btn-xs" onclick="adminDeleteUser('${u.email}')">🗑 Delete</button>
        </div>
      </div>`;
  }).join('');
}
window.filterStudents = filterStudents;



export function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return new Date(ts).toLocaleDateString();
}



async function adminViewStudentDetail(email) {
  // Robust: works whether called from the cached list, the live strip, or
  // the Analytics > Realtime tab — fetches fresh if not already in cache.
  let u = allStudentsData.find(s => s.email === email);
  let s = u?.stats;
  if (!u) {
    showLoading(true, 'Loading profile...');
    const { data: userRow } = await db(sb.from('users').select(USERS_SAFE_COLS).eq('email', email).maybeSingle(), 'User fetch failed');
    const { data: statRow } = await db(sb.from('user_stats').select('*').eq('email', email).maybeSingle(), 'Stats fetch failed');
    showLoading(false);
    if (!userRow) return showToast('Student not found');
    s = statRow || {};
    const acc = s.total_questions ? Math.round((s.total_correct / s.total_questions) * 100) : 0;
    u = { ...userRow, stats: s, acc };
  }
  s = s || u.stats || {};
  const history = (s.history || []).slice(0, 10);
  const avatar = u.gender === 'female' ? '👩‍⚕️' : '👨‍⚕️';
  const online = isUserOnline(u);

  // Recent activity (best-effort — table may be empty, that's fine)
  const { data: activity } = await db(
    sb.from('activity_logs').select('action,screen,created_at').eq('user_email', email).order('created_at', { ascending: false }).limit(8),
    'Activity fetch failed'
  );

  const overlay = document.createElement('div');
  overlay.id = 'studentDetailOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.65);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:0;width:100%;max-width:440px;max-height:90vh;overflow-y:auto">
      <!-- Header -->
      <div style="background:linear-gradient(135deg,#7a5c00,#c9980a);border-radius:var(--radius-xl) var(--radius-xl) 0 0;padding:24px;text-align:center;color:white;position:relative">
        <button onclick="this.closest('[style*=fixed]').remove()" style="position:absolute;top:12px;right:12px;background:rgba(255,255,255,.2);border:none;color:white;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:16px">✕</button>
        <div style="font-size:52px;margin-bottom:8px;position:relative;display:inline-block">
          ${u.profile_image ? `<img src="${esc(u.profile_image)}" style="width:56px;height:56px;border-radius:50%;object-fit:cover" onerror="this.style.display='none'">` : avatar}
          <span style="position:absolute;bottom:-2px;right:-6px;width:14px;height:14px;border-radius:50%;border:2px solid var(--gold-700);background:${online ? 'var(--green)' : '#9ca3af'}"></span>
        </div>
        <div style="font-size:18px;font-weight:800;font-family:var(--font-display)">${esc(u.name) || 'Unknown'}</div>
        <div style="font-size:12px;opacity:.7;margin-top:2px">${esc(u.email)}</div>
        <div style="font-size:11px;margin-top:4px;font-weight:700;color:${online ? '#86efac' : 'rgba(255,255,255,.6)'}">${online ? '🟢 Online now' : '⚪ Offline · last seen ' + (u.last_active ? timeAgo(u.last_active) : 'never')}</div>
        <div style="margin-top:8px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap">
          <span style="background:rgba(255,255,255,.2);border-radius:999px;padding:3px 12px;font-size:11px;font-weight:600">🏫 ${esc(u.college)||'Unknown'}</span>
          <span style="background:rgba(255,255,255,.2);border-radius:999px;padding:3px 12px;font-size:11px;font-weight:600">${u.gender==='female'?'👩‍⚕️ Female':'👨‍⚕️ Male'}</span>
          ${u.is_banned ? '<span style="background:rgba(220,38,38,.4);border-radius:999px;padding:3px 12px;font-size:11px;font-weight:600">🚫 Banned</span>' : '<span style="background:rgba(5,150,105,.3);border-radius:999px;padding:3px 12px;font-size:11px;font-weight:600">✅ Active</span>'}
          ${u.is_admin ? '<span style="background:rgba(245,158,11,.4);border-radius:999px;padding:3px 12px;font-size:11px;font-weight:600">⭐ Admin</span>' : ''}
        </div>
      </div>
      <!-- Body -->
      <div style="padding:20px">
        <!-- Stats -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px">
          <div class="stat-box"><div class="stat-val">${u.acc}%</div><div class="stat-key">Accuracy</div></div>
          <div class="stat-box"><div class="stat-val">${s?.total_tests||0}</div><div class="stat-key">Tests</div></div>
          <div class="stat-box"><div class="stat-val">${s?.best_score||0}%</div><div class="stat-key">Best</div></div>
          <div class="stat-box"><div class="stat-val">${s?.total_questions||0}</div><div class="stat-key">Questions</div></div>
          <div class="stat-box"><div class="stat-val">${s?.total_correct||0}</div><div class="stat-key">Correct</div></div>
          <div class="stat-box"><div class="stat-val">${s?.streak||0}🔥</div><div class="stat-key">Streak</div></div>
        </div>
        <!-- Full Profile Info -->
        <div class="card" style="margin-bottom:20px;padding:14px">
          <div class="flex-between mb-2"><span class="fw-700 text-sm">👤 Profile Details</span>
            <button class="btn btn-ghost btn-xs" onclick="adminEditStudentInfo('${u.email}')">✏️ Edit</button>
          </div>
          <div class="text-xs text-muted mb-1">📧 Email: <strong>${esc(u.email)}</strong></div>
          <div class="text-xs text-muted mb-1">📱 Phone: <strong>${u.phone ? esc(u.phone) : '<span style="color:var(--amber)">Not set</span>'}</strong></div>
          <div class="text-xs text-muted mb-1">🆔 Enrollment No: <strong>${u.enrollment_number ? esc(u.enrollment_number) : '<span style="color:var(--amber)">Not set</span>'}</strong></div>
          <div class="text-xs text-muted mb-1">📚 Year of Study: <strong>${u.year_of_study ? esc(u.year_of_study) : '<span style="color:var(--amber)">Not set</span>'}</strong></div>
          <div class="text-xs text-muted mb-1">🏫 College: <strong>${esc(u.college) || 'N/A'}</strong></div>
          <div class="text-xs text-muted mb-1">📅 Joined: <strong>${u.joined ? new Date(u.joined).toLocaleDateString() : 'N/A'}</strong></div>
          <div class="text-xs text-muted">📺 Current/Last screen: <strong>${esc(u.current_screen) || 'N/A'}</strong></div>
        </div>
        ${activity?.length ? `<div class="card" style="padding:14px;margin-bottom:20px">
          <div class="fw-600 mb-2">🕓 Recent Activity</div>
          ${activity.map(a=>`<div class="flex-between mb-1"><span class="text-xs">${esc(a.action)||''}${a.screen?' · '+esc(a.screen):''}</span><span class="text-xs text-muted">${timeAgo(new Date(a.created_at).getTime())}</span></div>`).join('')}
        </div>` : ''}
        ${history.length ? `<div class="card" style="padding:14px;margin-bottom:20px">
          <div class="fw-600 mb-2">📜 Recent Tests</div>
          ${history.map(h=>`<div class="flex-between mb-1"><span class="text-xs">${esc(h.module)||''}</span><span class="text-xs text-muted">${h.date} · <strong>${h.percent}%</strong></span></div>`).join('')}
        </div>` : ''}
        <!-- Actions -->
        <div class="btn-row">
          <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard?.writeText('${u.email}');showToast('Email copied')">📋 Copy Email</button>
          <button class="btn ${u.is_banned?'btn-secondary':'btn-danger'} btn-sm" onclick="adminToggleBan('${u.email}',${u.is_banned})">${u.is_banned?'✅ Unban':'🚫 Ban'}</button>
          <button class="btn btn-ghost btn-sm" onclick="this.closest('[style*=fixed]').remove()">Close</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.adminViewStudentDetail = adminViewStudentDetail;



// Lets admin fill in/edit fields the student themselves can't set yet from the app UI
// (phone, enrollment number, year, college, name, gender) — fully controllable from one place.
async function adminEditStudentInfo(email) {
  let u = allStudentsData.find(s => s.email === email);
  if (!u) {
    const { data } = await db(sb.from('users').select(USERS_SAFE_COLS).eq('email', email).maybeSingle(), 'User fetch failed');
    u = data;
  }
  if (!u) return showToast('Student not found');
  const { data: years } = await db(sb.from('years').select('name').order('display_order'), 'Years error');
  const { data: colleges } = await db(sb.from('colleges').select('name').order('name'), 'Colleges error');
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.85);z-index:10003;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:420px;max-height:90vh;overflow-y:auto">
      <div class="fw-700 mb-1">✏️ Edit Student Info</div>
      <div class="text-xs text-muted mb-3">${esc(email)}</div>
      <label class="text-xs text-muted">Full Name</label>
      <input id="_ei_name" class="input-field mt-1" value="${esc(u.name)}">
      <label class="text-xs text-muted mt-2" style="display:block">Phone</label>
      <input id="_ei_phone" class="input-field mt-1" placeholder="03XX-XXXXXXX" value="${esc(u.phone)}">
      <label class="text-xs text-muted mt-2" style="display:block">Enrollment Number</label>
      <input id="_ei_enroll" class="input-field mt-1" placeholder="e.g. 2023-LUMHS-123" value="${esc(u.enrollment_number)}">
      <label class="text-xs text-muted mt-2" style="display:block">Year of Study</label>
      <select id="_ei_year" class="input-field mt-1">
        <option value="">Not set</option>
        ${(years||[]).map(y => `<option value="${y.name}" ${u.year_of_study===y.name?'selected':''}>${y.name}</option>`).join('')}
      </select>
      <label class="text-xs text-muted mt-2" style="display:block">College</label>
      <select id="_ei_college" class="input-field mt-1">
        <option value="">Not set</option>
        ${(colleges||[]).map(c => `<option value="${c.name}" ${u.college===c.name?'selected':''}>${c.name}</option>`).join('')}
        <option value="Others" ${u.college==='Others'?'selected':''}>🌐 Others</option>
        ${(u.college && u.college!=='Others' && !(colleges||[]).some(c=>c.name===u.college)) ? `<option value="${u.college.replace(/"/g,'&quot;')}" selected>${u.college}</option>` : ''}
      </select>
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="adminSaveStudentInfo('${email}')">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.adminEditStudentInfo = adminEditStudentInfo;



async function adminSaveStudentInfo(email) {
  const name = document.getElementById('_ei_name').value.trim();
  const phone = document.getElementById('_ei_phone').value.trim();
  const enrollment_number = document.getElementById('_ei_enroll').value.trim();
  const year_of_study = document.getElementById('_ei_year').value;
  const college = document.getElementById('_ei_college').value;
  if (!name) return showToast('Name cannot be empty');
  await db(sb.from('users').update({ name, phone, enrollment_number, year_of_study, college }).eq('email', email), 'Update failed');
  showToast('Student info updated ✓');
  document.querySelector('[style*="z-index:10003"]')?.remove();
  document.getElementById('studentDetailOverlay')?.remove();
  await loadStudentsData();
  adminViewStudentDetail(email);
}
window.adminSaveStudentInfo = adminSaveStudentInfo;



async function adminToggleBan(email, isBanned) {
  showConfirm(isBanned ? `Unban ${email}?` : `Ban ${email}?<br><small>They won't be able to login.</small>`, async () => {
    const { error } = await adminRPC('admin_set_flag', { p_target_email: email, p_field: 'is_banned', p_value: !isBanned });
    if (error) return showToast('Ban toggle failed: ' + error.message);
    showToast(isBanned ? 'User unbanned' : 'User banned');
    await loadStudentsData();
  }, isBanned ? 'Unban' : 'Ban', !isBanned);
}
window.adminToggleBan = adminToggleBan;



async function adminDeleteUser(email) {
  showConfirm(`PERMANENTLY delete ${email}?<br><small>All data deleted forever. Cannot be undone.</small>`, async () => {
    await db(sb.from('user_stats').delete().eq('email', email), 'Delete stats failed');
    await db(sb.from('bookmarks').delete().eq('email', email), 'Delete bookmarks failed');
    await db(sb.from('users').delete().eq('email', email), 'Delete user failed');
    showToast('User deleted permanently');
    await loadStudentsData();
  }, 'Delete Forever');
}
window.adminDeleteUser = adminDeleteUser;



// SECURITY FIX: a student's name/college/etc. is free text they control. Without
// this, a name like =HYPERLINK("http://evil.com","click") becomes a live formula
// the moment an admin opens the exported CSV in Excel/Sheets (CSV/formula
// injection). Prefixing a leading =/+/-/@/tab with a quote neutralizes that
// while leaving the visible text unchanged; doubling internal quotes keeps the
// CSV itself well-formed.
function csvCell(v) {
  let s = (v === null || v === undefined) ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}



function exportStudentsCSV() {
  const rows = [['Name', 'Email', 'Phone', 'Enrollment No', 'College', 'Year', 'Gender', 'Joined', 'Last Active', 'Tests', 'Accuracy%', 'Streak', 'Banned']];
  for (const u of allStudentsData) {
    rows.push([
      u.name, u.email, u.phone || '', u.enrollment_number || '', u.college || '', u.year_of_study || '', u.gender,
      u.joined ? new Date(u.joined).toLocaleDateString() : '',
      u.last_active ? new Date(u.last_active).toLocaleDateString() : '',
      u.stats?.total_tests || 0, u.acc, u.stats?.streak || 0, u.is_banned ? 'Yes' : 'No'
    ]);
  }
  const csv = rows.map(r => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `LUMHSian_Students_${new Date().toLocaleDateString()}.csv`;
  a.click();
}
window.exportStudentsCSV = exportStudentsCSV;



// ==================== CONTENT TAB ====================
async function adminCourses(token = window._adminRenderToken) {
  if (_renderStale(token)) return;
  document.getElementById('adminContent').innerHTML = `
    <div class="tab-bar">
      <button class="tab-btn" onclick="adminContentTab('years',this)">📅 Years</button>
      <button class="tab-btn" onclick="adminContentTab('modules',this)">📦 Modules</button>
      <button class="tab-btn" onclick="adminContentTab('mapping',this)">🔗 Year↔Module</button>
    </div>
    <div id="contentTabBody"></div>`;
  // Resume onto whatever sub-tab was open before (background kill / reload), else default
  const isResume = !!window._currentContentTab;
  const tabToOpen = window._currentContentTab || 'years';
  const btn = [...document.querySelectorAll('#adminContent .tab-bar .tab-btn')]
    .find(b => b.getAttribute('onclick')?.includes(`'${tabToOpen}'`)) || document.querySelector('#adminContent .tab-bar .tab-btn');
  adminContentTab(tabToOpen, btn, isResume);
}



async function adminContent(token = window._adminRenderToken) {
  if (_renderStale(token)) return;
  document.getElementById('adminContent').innerHTML = `
    <div class="tab-bar">
      <button class="tab-btn" onclick="adminContentTab('subjects',this)">📖 Subjects</button>
      <button class="tab-btn" onclick="adminContentTab('papers',this)">📜 Past Papers</button>
      <button class="tab-btn" onclick="adminContentTab('tests',this)">🎯 Practice Tests</button>
      <button class="tab-btn" onclick="adminContentTab('questions',this)">❓ Questions</button>
    </div>
    <div id="contentTabBody"></div>`;
  // Resume onto whatever sub-tab was open before (background kill / reload), else default
  const isResume = !!window._currentContentTab;
  const tabToOpen = window._currentContentTab || 'subjects';
  const btn = [...document.querySelectorAll('#adminContent .tab-bar .tab-btn')]
    .find(b => b.getAttribute('onclick')?.includes(`'${tabToOpen}'`)) || document.querySelector('#adminContent .tab-bar .tab-btn');
  adminContentTab(tabToOpen, btn, isResume);
}



// _preserveQSubTab: true when this is a resume (background/reload restore), so the
// deeper Add/Browse/Bulk sub-tab inside Questions isn't wiped out. False (default) means
// a fresh user click, which should reset back to the first inner sub-tab as expected.
export function adminContentTab(tab, btn, _preserveQSubTab = false) {
  window._currentContentTab = tab;
  if (!_preserveQSubTab) window._currentQSubTab = null;
  document.querySelectorAll('.tab-bar .tab-btn').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  const fns = { years: adminYears, modules: adminModules, mapping: adminYearModules, subjects: adminSubjects, papers: adminPastPapers, tests: adminPracticeTests, questions: adminQuestions };
  if (fns[tab]) fns[tab]();
}
window.adminContentTab = adminContentTab;



// --- YEARS CRUD ---
async function adminYears() {
  const { data: years } = await db(sb.from('years').select('*').order('display_order'), 'Years error');
  const yearList = (years || []).map(y => `
    <div class="admin-row">
      <div class="admin-row-left">
        <div class="fw-700">${y.name}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
          <span class="chip" style="font-size:11px">Order: ${y.display_order}</span>
          <span class="badge ${y.is_active ? 'badge-green' : 'badge-amber'}">${y.is_active ? '✅ Active' : '🔒 Coming Soon'}</span>
          ${y.coming_soon_text ? `<span class="chip" style="font-size:11px">${y.coming_soon_text}</span>` : ''}
        </div>
      </div>
      <div class="admin-row-actions">
        <button class="btn btn-secondary btn-xs" onclick="adminEditYear(${y.id})">✏️ Edit</button>
        <button class="btn btn-danger btn-xs" onclick="adminDeleteYear(${y.id})">🗑</button>
      </div>
    </div>`).join('');

  document.getElementById('contentTabBody').innerHTML = `
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">➕ Add New Year / Batch</div>
      <label class="input-label">Year Name</label>
      <input id="y_name" class="input-field" placeholder="e.g., 2nd Year MBBS 2024">
      <label class="input-label">Display Order</label>
      <input id="y_order" type="number" class="input-field" placeholder="1, 2, 3...">
      <label class="input-label">Status</label>
      <select id="y_active" class="input-field" title="Year status" aria-label="Year status">
        <option value="true">✅ Active (visible to students)</option>
        <option value="false">🔒 Coming Soon</option>
      </select>
      <label class="input-label">Coming Soon Message (shown if locked)</label>
      <input id="y_coming" class="input-field" placeholder="e.g., Opening in January 2025">
      <button class="btn btn-primary" onclick="adminAddYear()">Add Year</button>
    </div>
    <div class="fw-700 mb-2">📋 Existing Years</div>
    ${yearList || '<div class="card"><p class="text-muted">No years added yet.</p></div>'}`;
}
window.adminYears = adminYears;



async function adminAddYear() {
  const name = document.getElementById('y_name').value.trim();
  const order = parseInt(document.getElementById('y_order').value);
  const active = document.getElementById('y_active').value === 'true';
  const coming = document.getElementById('y_coming').value.trim() || null;
  if (!name || isNaN(order)) return showToast('Name and display order required');
  await db(sb.from('years').insert({ name, display_order: order, is_active: active, coming_soon_text: coming }), 'Add failed');
  cacheClear('years');
  showToast('Year added ✓'); adminYears();
}
window.adminAddYear = adminAddYear;



async function adminEditYear(id) {
  const { data: y } = await db(sb.from('years').select('*').eq('id', id).single(), 'Load error');
  if (!y) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:420px">
      <div class="fw-700 mb-3">✏️ Edit Year</div>
      <label class="input-label">Year Name</label>
      <input id="_ey_name" class="input-field" value="${esc(y.name)}">
      <label class="input-label">Display Order</label>
      <input id="_ey_order" type="number" class="input-field" title="Display order" aria-label="Display order" placeholder="1" value="${y.display_order||1}">
      <label class="input-label">Status</label>
      <select id="_ey_active" class="input-field" title="Year status" aria-label="Year status">
        <option value="true" ${y.is_active?'selected':''}>✅ Active</option>
        <option value="false" ${!y.is_active?'selected':''}>⏳ Coming Soon</option>
      </select>
      <label class="input-label">Coming Soon Message (optional)</label>
      <input id="_ey_coming" class="input-field" placeholder="e.g., Available soon!" value="${esc(y.coming_soon_text||'')}">
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="saveEditedYear(${y.id}, this)">Save Changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.adminEditYear = adminEditYear;


// Handles the Save button for adminEditYear above. Deliberately a real, named,
// module-scoped function (not an inline onclick IIFE) — inline handler strings
// run outside this module's scope, so imports like sb/db are invisible to them
// and would throw "sb is not defined" the instant they tried to save anything.
async function saveEditedYear(id, btnEl) {
  try {
    const n = document.getElementById('_ey_name').value.trim();
    const o = parseInt(document.getElementById('_ey_order').value) || 1;
    const a = document.getElementById('_ey_active').value === 'true';
    const c = document.getElementById('_ey_coming').value.trim() || null;
    if (!n) { showToast('Name required'); return; }
    const { error } = await db(sb.from('years').update({ name: n, display_order: o, is_active: a, coming_soon_text: c }).eq('id', id), 'Edit failed');
    if (error) return;
    cacheClear('years');
    showToast('Year updated ✓');
    btnEl.closest('[style*=fixed]').remove();
    adminYears();
  } catch (err) {
    console.error('Edit year failed:', err);
    showToast('Unexpected error: ' + err.message, 9000);
  }
}
window.saveEditedYear = saveEditedYear;



async function adminDeleteYear(id) {
  showConfirm('Delete this year?<br><small>Students will lose access to linked modules.</small>', async () => {
    await db(sb.from('year_modules').delete().eq('year_id', id), 'Unlink failed');
    await db(sb.from('years').delete().eq('id', id), 'Delete failed');
    cacheClear('years');
    showToast('Year deleted'); adminYears();
  }, 'Delete');
}
window.adminDeleteYear = adminDeleteYear;



// --- MODULES CRUD ---
async function adminModules() {
  const { data: modules } = await db(sb.from('modules').select('*').order('name'), 'Modules error');
  const list = (modules || []).map(m => `
    <div class="admin-row">
      <div class="admin-row-left" style="display:flex;align-items:center;gap:10px">
        <img src="${m.icon_url || 'https://placehold.co/44x44/fdf3c0/c9980a?text=📚'}" style="width:44px;height:44px;border-radius:var(--radius-md);object-fit:cover;flex-shrink:0" onerror="this.src='https://placehold.co/44x44/fdf3c0/c9980a?text=📚'">
        <div>
          <div class="fw-700">${m.name}</div>
          <div class="text-xs text-muted">${m.description || 'No description'}</div>
          ${m.color ? `<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${m.color};margin-top:4px"></span>` : ''}
        </div>
      </div>
      <div class="admin-row-actions">
        <button class="btn btn-secondary btn-xs" onclick="adminEditModule(${m.id})">✏️ Edit</button>
        <button class="btn btn-danger btn-xs" onclick="adminDeleteModule(${m.id})">🗑</button>
      </div>
    </div>`).join('');

  document.getElementById('contentTabBody').innerHTML = `
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">➕ Add Module</div>
      <label class="input-label">Module Name</label>
      <input id="m_name" class="input-field" placeholder="e.g., Anatomy">
      <label class="input-label">Description</label>
      <input id="m_desc" class="input-field" placeholder="Brief description">
      <label class="input-label">Category <span class="text-xs text-muted">(for future multi-department support)</span></label>
      <select id="m_category" class="input-field" title="Module category" aria-label="Module category">
        <option value="mbbs">🩺 MBBS</option>
        <option value="bds">🦷 BDS (Future)</option>
        <option value="mdcat">📝 MDCAT (Future)</option>
        <option value="other">📚 Other</option>
      </select>
      <label class="input-label">Accent Color (for UI)</label>
      <input id="m_color" type="color" class="input-field" title="Module accent color" aria-label="Module accent color" style="height:44px;padding:4px 12px" value="#c9980a">
      <label class="input-label">Module Image</label>
      <div class="upload-area" onclick="document.getElementById('m_img_file').click()">
        <div style="font-size:32px">📸</div>
        <div class="text-sm mt-1">Click to upload image</div>
        <div class="text-xs text-muted">PNG, JPG, WebP</div>
      </div>
      <input type="file" id="m_img_file" accept="image/*" style="display:none" onchange="previewAndUpload('m_img_file','m_img_url','m_preview')">
      <img id="m_preview" style="display:none;max-width:100%;border-radius:var(--radius-lg);margin-top:8px">
      <input id="m_img_url" class="input-field" placeholder="Image URL (auto-filled after upload)" style="margin-top:8px">
      <button class="btn btn-primary" onclick="adminAddModule()">Add Module</button>
    </div>
    <div class="card" style="margin-bottom:20px;border:1.5px solid var(--gold-400)">
      <div class="fw-700 mb-2">📥 Bulk Upload Modules</div>
      <p class="text-xs text-muted mb-3">Add many modules at once from an Excel/CSV file. The "Years" column is optional — list any of your existing Academic Year names, comma-separated (e.g. "First Year, Second Year"), to link the module to those years immediately instead of doing it separately in Courses → Year↔Module Mapping.</p>
      <input type="file" id="modBulkFile" accept=".xlsx,.xls,.csv" class="input-field" title="Choose Excel/CSV file" aria-label="Choose Excel or CSV file" onchange="previewModuleBulk()">
      <div id="modBulkPreview" style="margin-top:12px"></div>
      <button class="btn btn-primary mt-3" id="modBulkUploadBtn" style="display:none" onclick="executeModuleBulkUpload()">Upload All Modules</button>
      <hr class="divider">
      <div class="fw-700 mb-2">📥 Download Template</div>
      <button class="btn btn-secondary" onclick="downloadModuleTemplate()">Download Excel Template</button>
    </div>
    <div class="fw-700 mb-2">📦 Existing Modules</div>
    ${list || '<div class="card"><p class="text-muted">No modules yet.</p></div>'}`;
}
window.adminModules = adminModules;



let modBulkData = [];

function downloadModuleTemplate() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([
    { Name: 'Anatomy', Description: 'Human structure and body systems', Color: '#c9980a', Category: 'mbbs', Years: 'First Year' },
    { Name: 'Biochemistry', Description: 'Chemical processes in the body', Color: '#2e7d32', Category: 'mbbs', Years: 'First Year, Second Year' }
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Modules');
  XLSX.writeFile(wb, 'module_bulk_template.xlsx');
}
window.downloadModuleTemplate = downloadModuleTemplate;


function previewModuleBulk() {
  const file = document.getElementById('modBulkFile')?.files[0];
  if (!file) return;
  const MAX_FILE_BYTES = 10 * 1024 * 1024, MAX_ROWS = 500;
  if (file.size > MAX_FILE_BYTES) {
    showToast('File is too large (max 10 MB). Please split it into smaller batches.');
    document.getElementById('modBulkFile').value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (rows.length > MAX_ROWS) throw new Error(`Too many rows (${rows.length}). Please upload at most ${MAX_ROWS} modules at a time.`);
      const norm = (row, ...keys) => {
        for (const k of keys) {
          for (const rk of Object.keys(row)) {
            if (rk.replace(/[\s_]/g, '').toLowerCase() === k.replace(/[\s_]/g, '').toLowerCase()) return row[rk];
          }
        }
        return '';
      };
      modBulkData = rows.map(row => ({
        name: String(norm(row, 'Name', 'ModuleName')).trim(),
        description: String(norm(row, 'Description')).trim(),
        color: String(norm(row, 'Color')).trim() || '#c9980a',
        category: String(norm(row, 'Category')).trim().toLowerCase() || 'mbbs',
        years: String(norm(row, 'Years', 'Year')).split(',').map(y => y.trim()).filter(Boolean)
      })).filter(m => m.name);

      if (!modBulkData.length) throw new Error('No valid rows found — check that a "Name" column exists and has values.');

      document.getElementById('modBulkPreview').innerHTML = `
        <div class="badge badge-green" style="margin-bottom:8px">${modBulkData.length} module${modBulkData.length===1?'':'s'} found</div>
        ${modBulkData.slice(0, 5).map(m => `<div class="card" style="margin-bottom:6px;font-size:13px"><strong>${esc(m.name)}</strong>${m.years.length ? ` · ${esc(m.years.join(', '))}` : ''}</div>`).join('')}
        ${modBulkData.length > 5 ? `<div class="text-xs text-muted">...and ${modBulkData.length - 5} more</div>` : ''}`;
      document.getElementById('modBulkUploadBtn').style.display = 'block';
    } catch (err) {
      document.getElementById('modBulkPreview').innerHTML = `<div class="badge badge-red">❌ ${esc(err.message)}</div>`;
      modBulkData = [];
    }
  };
  reader.readAsArrayBuffer(file);
}
window.previewModuleBulk = previewModuleBulk;


async function executeModuleBulkUpload() {
  if (!modBulkData.length) return;
  const { data: existingYears } = await db(sb.from('years').select('id,name'), 'Years error');
  const yearByName = {};
  for (const y of (existingYears || [])) yearByName[y.name.trim().toLowerCase()] = y.id;

  showLoading(true, `Uploading ${modBulkData.length} modules...`);
  let success = 0, failed = 0, yearsLinked = 0, yearsSkipped = 0, firstErr = '';
  for (const m of modBulkData) {
    const { data: inserted, error } = await sb.from('modules').insert({
      name: m.name, description: m.description, color: m.color, category: m.category
    }).select('id').single();
    if (error) {
      failed++;
      console.error('Bulk module insert failed:', error);
      if (!firstErr) firstErr = error.message;
      continue;
    }
    success++;
    for (const yName of m.years) {
      const yId = yearByName[yName.toLowerCase()];
      if (!yId) { yearsSkipped++; continue; }
      const { error: mapErr } = await sb.from('year_modules').insert({ year_id: yId, module_id: inserted.id, display_order: 1 });
      if (!mapErr) yearsLinked++;
    }
  }
  showLoading(false);
  let msg = `✅ ${success} module${success === 1 ? '' : 's'} added`;
  if (failed) msg += `, ❌ ${failed} failed: ${firstErr}`;
  if (yearsLinked) msg += `. Linked to ${yearsLinked} year${yearsLinked === 1 ? '' : 's'}`;
  if (yearsSkipped) msg += `. ${yearsSkipped} year name${yearsSkipped === 1 ? '' : 's'} in the file didn't match any existing Academic Year — link ${yearsSkipped === 1 ? 'it' : 'those'} manually in Courses → Year↔Module Mapping`;
  showToast(msg, (failed || yearsSkipped) ? 11000 : 4000);
  logAdminAction(`Bulk uploaded ${success} modules`);
  modBulkData = [];
  document.getElementById('modBulkFile').value = '';
  document.getElementById('modBulkUploadBtn').style.display = 'none';
  document.getElementById('modBulkPreview').innerHTML = '';
  adminModules();
}
window.executeModuleBulkUpload = executeModuleBulkUpload;



// ==================== IMAGE CROPPER (WhatsApp-style pan & zoom) ====================
// Opens a fixed-frame crop modal for `file`. Drag to pan, slider to zoom.
// Calls onDone(blob) with the final cropped JPEG, or nothing if cancelled.
function openImageCropper(file, aspect, onDone) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => buildCropperUI(img, aspect, onDone);
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}



function buildCropperUI(img, aspect, onDone) {
  const frameW = Math.min(320, window.innerWidth - 64);
  const frameH = frameW / aspect;
  const baseScale = Math.max(frameW / img.naturalWidth, frameH / img.naturalHeight);
  let zoom = 1; // multiplier on top of baseScale, 1x to 3x
  let offX = 0, offY = 0; // top-left of image relative to frame top-left, in CSS px
  let dragging = false, startX = 0, startY = 0, startOffX = 0, startOffY = 0;

  function scale() { return baseScale * zoom; }
  function dispW() { return img.naturalWidth * scale(); }
  function dispH() { return img.naturalHeight * scale(); }
  function clamp() {
    const w = dispW(), h = dispH();
    const minX = frameW - w, minY = frameH - h; // both <= 0
    offX = Math.min(0, Math.max(minX, offX));
    offY = Math.min(0, Math.max(minY, offY));
  }
  function center() { offX = (frameW - dispW()) / 2; offY = (frameH - dispH()) / 2; clamp(); }
  function render() {
    imgEl.style.width = dispW() + 'px';
    imgEl.style.height = dispH() + 'px';
    imgEl.style.left = offX + 'px';
    imgEl.style.top = offY + 'px';
  }

  center();

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:10010;display:flex;align-items:center;justify-content:center;padding:16px;flex-direction:column';
  overlay.innerHTML = `
    <div style="color:white;font-weight:700;margin-bottom:14px;text-align:center">📷 Move &amp; zoom to frame your photo</div>
    <div id="_cropFrame" style="position:relative;width:${frameW}px;height:${frameH}px;overflow:hidden;border-radius:14px;border:2px solid white;touch-action:none;background:#111;cursor:grab"></div>
    <input id="_cropZoom" type="range" min="1" max="3" step="0.01" value="1" style="width:${frameW}px;margin-top:18px">
    <div class="btn-row" style="margin-top:18px;width:${frameW}px">
      <button class="btn btn-ghost" style="flex:1;color:white;border-color:rgba(255,255,255,.3)" id="_cropCancel">Cancel</button>
      <button class="btn btn-primary" style="flex:1" id="_cropDone">✓ Use Photo</button>
    </div>`;
  document.body.appendChild(overlay);

  const cropFrame = overlay.querySelector('#_cropFrame');
  const imgEl = document.createElement('img');
  imgEl.src = img.src;
  imgEl.style.position = 'absolute';
  imgEl.style.userSelect = 'none';
  imgEl.draggable = false;
  cropFrame.appendChild(imgEl);
  render();

  const zoomSlider = overlay.querySelector('#_cropZoom');
  zoomSlider.addEventListener('input', () => {
    const cx = offX - frameW / 2, cy = offY - frameH / 2; // anchor roughly to current center
    const oldScale = scale();
    zoom = parseFloat(zoomSlider.value);
    const ratio = scale() / oldScale;
    offX = offX * ratio + (frameW / 2) * (1 - ratio);
    offY = offY * ratio + (frameH / 2) * (1 - ratio);
    clamp(); render();
  });

  function pointerDown(x, y) { dragging = true; startX = x; startY = y; startOffX = offX; startOffY = offY; cropFrame.style.cursor = 'grabbing'; }
  function pointerMove(x, y) { if (!dragging) return; offX = startOffX + (x - startX); offY = startOffY + (y - startY); clamp(); render(); }
  function pointerUp() { dragging = false; cropFrame.style.cursor = 'grab'; }

  cropFrame.addEventListener('pointerdown', (e) => { cropFrame.setPointerCapture(e.pointerId); pointerDown(e.clientX, e.clientY); });
  cropFrame.addEventListener('pointermove', (e) => pointerMove(e.clientX, e.clientY));
  cropFrame.addEventListener('pointerup', pointerUp);
  cropFrame.addEventListener('pointercancel', pointerUp);

  function cleanup() { overlay.remove(); }

  overlay.querySelector('#_cropCancel').onclick = cleanup;
  overlay.querySelector('#_cropDone').onclick = () => {
    const outW = aspect >= 1 ? 800 : Math.round(800 * aspect);
    const outH = aspect >= 1 ? Math.round(800 / aspect) : 800;
    const canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext('2d');
    const sx = -offX / scale(), sy = -offY / scale();
    const sw = frameW / scale(), sh = frameH / scale();
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
    canvas.toBlob((blob) => { cleanup(); if (blob) onDone(blob); }, 'image/jpeg', 0.9);
  };
}



async function previewAndUpload(fileInputId, urlFieldId, previewId) {
  const file = document.getElementById(fileInputId)?.files[0];
  if (!file) return;
  // Square frame for icons/logos, wide frame for content/explanation images
  const aspect = ['q_img_file','q_exp_img_file','an_img_file','ntf_img_file','dn_img_file','_eq_img_file','_eq_exp_img_file'].includes(fileInputId) ? 1.6 : 1;
  openImageCropper(file, aspect, async (blob) => {
    const preview = document.getElementById(previewId);
    if (preview) { preview.src = URL.createObjectURL(blob); preview.style.display = 'block'; }
    showLoading(true, 'Uploading image...');
    const path = `uploads/${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
    const bucket = fileInputId.includes('q_') ? 'question-images' : 'module-images';
    const { error } = await sb.storage.from(bucket).upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
    if (error) { showLoading(false); showToast('Upload failed: ' + error.message); return; }
    const { data: urlData } = sb.storage.from(bucket).getPublicUrl(path);
    const urlField = document.getElementById(urlFieldId);
    if (urlField) urlField.value = urlData.publicUrl;
    showLoading(false); showToast('Image uploaded ✓');
  });
}
window.previewAndUpload = previewAndUpload;



async function adminAddModule() {
  const name = document.getElementById('m_name').value.trim();
  const desc = document.getElementById('m_desc').value.trim();
  const color = document.getElementById('m_color').value;
  const icon_url = document.getElementById('m_img_url').value.trim() || null;
  const category = document.getElementById('m_category').value || 'mbbs';
  if (!name) return showToast('Module name required');
  await db(sb.from('modules').insert({ name, description: desc, icon_url, color, category }), 'Add failed');
  showToast('Module added ✓'); adminModules();
}
window.adminAddModule = adminAddModule;



async function adminEditModule(id) {
  const { data: m } = await db(sb.from('modules').select('*').eq('id', id).single(), 'Load failed');
  if (!m) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:420px;max-height:90vh;overflow-y:auto">
      <div class="fw-700 mb-3">✏️ Edit Module</div>
      <label class="input-label">Module Name</label>
      <input id="_em_name" class="input-field" value="${esc(m.name)}">
      <label class="input-label">Description</label>
      <textarea id="_em_desc" class="input-field" rows="2" placeholder="Brief description" style="resize:vertical">${esc(m.description||'')}</textarea>
      <label class="input-label">Image URL</label>
      <input id="_em_img" class="input-field" placeholder="Image URL" value="${esc(m.icon_url||'')}">
      <label class="input-label">Accent Color</label>
      <input id="_em_color" type="color" class="input-field" title="Accent color" aria-label="Accent color" value="${m.color||'#c9980a'}" style="height:44px;padding:4px 12px">
      <label class="input-label">Category</label>
      <select id="_em_cat" class="input-field" title="Module category" aria-label="Module category">
        <option value="mbbs" ${m.category==='mbbs'||!m.category?'selected':''}>🩺 MBBS</option>
        <option value="bds" ${m.category==='bds'?'selected':''}>🦷 BDS (Future)</option>
        <option value="mdcat" ${m.category==='mdcat'?'selected':''}>📝 MDCAT (Future)</option>
        <option value="other" ${m.category==='other'?'selected':''}>📚 Other</option>
      </select>
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="saveEditedModule(${m.id}, this)">Save Changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.adminEditModule = adminEditModule;


// See saveEditedYear above for why this can't be an inline onclick IIFE.
async function saveEditedModule(id, btnEl) {
  try {
    const n = document.getElementById('_em_name').value.trim();
    const d = document.getElementById('_em_desc').value.trim();
    const img = document.getElementById('_em_img').value.trim() || null;
    const c = document.getElementById('_em_color').value;
    const cat = document.getElementById('_em_cat').value;
    if (!n) { showToast('Name required'); return; }
    const { error } = await db(sb.from('modules').update({ name: n, description: d, icon_url: img, color: c, category: cat }).eq('id', id), 'Edit failed');
    if (error) return;
    showToast('Module updated ✓');
    btnEl.closest('[style*=fixed]').remove();
    adminModules();
  } catch (err) {
    console.error('Edit module failed:', err);
    showToast('Unexpected error: ' + err.message, 9000);
  }
}
window.saveEditedModule = saveEditedModule;



async function adminDeleteModule(id) {
  showConfirm('Delete this module?<br><small>All subjects, past papers, practice tests and questions inside will also be permanently deleted.</small>', async () => {
    await db(sb.from('questions').delete().eq('module_id', id), 'Q delete failed');
    await db(sb.from('subjects').delete().eq('module_id', id), 'Sub delete failed');
    // Past papers are many-to-many with modules now (past_paper_modules), not owned by
    // one module — deleting this module should only remove ITS tag from any papers,
    // never the papers themselves (they may still be validly tagged with other modules,
    // or with none at all).
    await db(sb.from('past_paper_modules').delete().eq('module_id', id), 'Paper tag cleanup failed');
    await db(sb.from('practice_tests').delete().eq('module_id', id), 'Tests delete failed');
    await db(sb.from('year_modules').delete().eq('module_id', id), 'Mapping delete failed');
    await db(sb.from('modules').delete().eq('id', id), 'Module delete failed');
    showToast('Module deleted'); adminModules();
  }, 'Delete');
}
window.adminDeleteModule = adminDeleteModule;



// --- YEAR ↔ MODULE MAPPING ---
async function adminYearModules() {
  const [yearsRes, modulesRes, mappingsRes] = await Promise.all([
    db(sb.from('years').select('id,name').order('display_order'), 'Years error'),
    db(sb.from('modules').select('id,name').order('name'), 'Modules error'),
    db(sb.from('year_modules').select('*'), 'Mappings error')
  ]);
  const years = yearsRes.data || [], modules = modulesRes.data || [], mappings = mappingsRes.data || [];

  const mapTable = years.map(y => {
    const yMaps = mappings.filter(m => m.year_id === y.id);
    return `<div class="card" style="margin-bottom:10px">
      <div class="fw-700 mb-2">📅 ${y.name}</div>
      ${yMaps.length ? yMaps.map(map => {
        const mod = modules.find(m => m.id === map.module_id);
        return `<div class="flex-between" style="padding:6px 0;border-bottom:1px solid var(--border)">
          <span class="text-sm fw-600">📦 ${mod?.name || 'Unknown'} <span class="text-xs text-muted">(order ${map.display_order})</span></span>
          <button class="btn btn-danger btn-xs" onclick="adminRemoveMapping(${map.id})">Remove</button>
        </div>`;
      }).join('') : '<p class="text-xs text-muted">No modules assigned</p>'}
    </div>`;
  }).join('');

  document.getElementById('contentTabBody').innerHTML = `
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">🔗 Assign Module to Year</div>
      <label class="input-label">Year</label>
      <select id="map_year" class="input-field" title="Select year" aria-label="Select year">
        ${years.map(y => `<option value="${y.id}">${y.name}</option>`).join('')}
      </select>
      <label class="input-label">Module</label>
      <select id="map_module" class="input-field" title="Select module" aria-label="Select module">
        ${modules.map(m => `<option value="${m.id}">${m.name}</option>`).join('')}
      </select>
      <label class="input-label">Display Order</label>
      <input id="map_order" type="number" class="input-field" placeholder="1, 2, 3..." value="1">
      <button class="btn btn-primary" onclick="adminAddMapping()">Assign</button>
    </div>
    <div class="fw-700 mb-2">📋 Current Assignments</div>
    ${mapTable}`;
}



async function adminAddMapping() {
  const year_id = document.getElementById('map_year').value;
  const module_id = document.getElementById('map_module').value;
  const order = parseInt(document.getElementById('map_order').value) || 1;
  const { data: existing } = await db(sb.from('year_modules').select('id').eq('year_id', year_id).eq('module_id', module_id).maybeSingle(), 'Check failed');
  if (existing) return showToast('Already assigned');
  await db(sb.from('year_modules').insert({ year_id, module_id, display_order: order }), 'Assign failed');
  showToast('Module assigned ✓'); adminYearModules();
}
window.adminAddMapping = adminAddMapping;



async function adminRemoveMapping(id) {
  await db(sb.from('year_modules').delete().eq('id', id), 'Remove failed');
  showToast('Assignment removed'); adminYearModules();
}
window.adminRemoveMapping = adminRemoveMapping;



// --- SUBJECTS CRUD ---
async function adminSubjects() {
  const { data: modules } = await db(sb.from('modules').select('id,name').order('name'), 'Modules error');
  const mList = modules || [];
  const moduleIds = mList.map(m => m.id);
  // Subjects and question counts for every module used to be fetched with 2
  // separate queries PER module (sequentially, in a loop). Now it's 2 queries
  // total, grouped client-side — this screen used to get slower the more
  // modules the app had.
  const [{ data: allSubs }, qCounts] = await Promise.all([
    moduleIds.length ? db(sb.from('subjects').select('*').in('module_id', moduleIds).order('display_order'), 'Subs error') : Promise.resolve({ data: [] }),
    getQuestionCountsBy('module_id', moduleIds)
  ]);
  const subsByModule = {};
  for (const s of (allSubs || [])) {
    if (!subsByModule[s.module_id]) subsByModule[s.module_id] = [];
    subsByModule[s.module_id].push(s);
  }

  let subHtml = '';
  for (const m of mList) {
    const subs = subsByModule[m.id] || [];
    const qCount = qCounts[m.id] || 0;
    subHtml += `<div class="card" style="margin-bottom:10px">
      <div class="flex-between mb-2">
        <div class="fw-700">📦 ${m.name}</div>
        <span class="badge badge-teal">${qCount} questions</span>
      </div>
      ${subs.map(s => `
        <div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
          <span class="text-sm fw-600">${s.name} <span class="text-xs text-muted">(order ${s.display_order || '?'})</span></span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary btn-xs" onclick="adminEditSubject(${s.id},'${s.name.replace(/'/g,"\\'")}',${s.display_order||1})">✏️</button>
            <button class="btn btn-danger btn-xs" onclick="adminDeleteSubject(${s.id})">🗑</button>
          </div>
        </div>`).join('')}
    </div>`;
  }

  document.getElementById('contentTabBody').innerHTML = `
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">➕ Add Subject</div>
      <label class="input-label">Module</label>
      <select id="sub_module" class="input-field" title="Select module for subject" aria-label="Select module for subject">
        ${mList.map(m => `<option value="${m.id}">${m.name}</option>`).join('')}
      </select>
      <label class="input-label">Subject Name</label>
      <input id="sub_name" class="input-field" placeholder="e.g., Upper Limb">
      <label class="input-label">Display Order</label>
      <input id="sub_order" type="number" class="input-field" title="Display order" aria-label="Display order" placeholder="1" value="1">
      <button class="btn btn-primary" onclick="adminAddSubject()">Add Subject</button>
    </div>
    <div class="fw-700 mb-2">📖 Subjects by Module</div>
    ${subHtml || '<div class="card"><p class="text-muted">Add modules first.</p></div>'}`;
}
window.adminSubjects = adminSubjects;



async function adminAddSubject() {
  const module_id = document.getElementById('sub_module').value;
  const name = document.getElementById('sub_name').value.trim();
  const display_order = parseInt(document.getElementById('sub_order').value) || 1;
  if (!name) return showToast('Subject name required');
  await db(sb.from('subjects').insert({ module_id, name, display_order }), 'Add failed');
  showToast('Subject added ✓'); adminSubjects();
}
window.adminAddSubject = adminAddSubject;



async function adminEditSubject(id, oldName, oldOrder) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:400px">
      <div class="fw-700 mb-3">✏️ Edit Subject</div>
      <label class="input-label">Subject Name</label>
      <input id="_es_name" class="input-field" value="${esc(oldName)}">
      <label class="input-label">Display Order</label>
      <input id="_es_order" type="number" class="input-field" title="Display order" aria-label="Display order" placeholder="1" value="${oldOrder||1}">
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="saveEditedSubject(${id}, this)">Save Changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.adminEditSubject = adminEditSubject;


// See saveEditedYear above for why this can't be an inline onclick IIFE.
async function saveEditedSubject(id, btnEl) {
  try {
    const n = document.getElementById('_es_name').value.trim();
    const o = parseInt(document.getElementById('_es_order').value) || 1;
    if (!n) { showToast('Name required'); return; }
    const { error } = await db(sb.from('subjects').update({ name: n, display_order: o }).eq('id', id), 'Edit failed');
    if (error) return;
    showToast('Subject updated ✓');
    btnEl.closest('[style*=fixed]').remove();
    adminSubjects();
  } catch (err) {
    console.error('Edit subject failed:', err);
    showToast('Unexpected error: ' + err.message, 9000);
  }
}
window.saveEditedSubject = saveEditedSubject;



async function adminDeleteSubject(id) {
  showConfirm('Delete this subject?<br><small>Questions in it will become uncategorized (not deleted).</small>', async () => {
    await db(sb.from('questions').update({ subject_id: null }).eq('subject_id', id), 'Unlink failed');
    await db(sb.from('subjects').delete().eq('id', id), 'Delete failed');
    showToast('Subject deleted'); adminSubjects();
  }, 'Delete');
}
window.adminDeleteSubject = adminDeleteSubject;



// --- PAST PAPERS CRUD ---
// Past papers are admin-named (e.g. "LUMHS Annual Exam 2023") and fully independent
// of the student's academic Year (1st/2nd/3rd/4th/Final) — they belong to a Module only.
async function adminPastPapers() {
  const { data: modules } = await db(sb.from('modules').select('id,name').order('name'), 'Modules error');
  const mList = modules || [];
  const moduleNameById = {};
  for (const m of mList) moduleNameById[m.id] = m.name;
  const { data: collegeRows } = await db(sb.from('colleges').select('name').eq('is_active', true).order('name'), 'Colleges error');
  const pp_college_options = `<option value="" disabled selected>Select college...</option>` +
    (collegeRows || []).map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  const { data: yearRows } = await db(sb.from('years').select('id,name').order('display_order'), 'Years error');
  const yList = yearRows || [];
  const yearNameById = {};
  for (const y of yList) yearNameById[y.id] = y.name;
  const pp_year_options = `<option value="" disabled selected>Select academic year...</option>` +
    yList.map(y => `<option value="${y.id}">${esc(y.name)}</option>`).join('');

  // Every paper, every paper's question count, and every paper↔module tag —
  // in 3 requests total, no matter how many papers or modules exist.
  const { data: allPapers } = await db(sb.from('past_papers').select('*').order('display_order'), 'Papers error');
  const papers = allPapers || [];
  const qCounts = await getQuestionCountsBy('paper_id', papers.map(p => p.id));
  const { data: allTags } = await db(sb.from('past_paper_modules').select('paper_id,module_id'), 'Paper-module tags error');
  const moduleIdsByPaper = {};
  for (const t of (allTags || [])) {
    if (!moduleIdsByPaper[t.paper_id]) moduleIdsByPaper[t.paper_id] = [];
    moduleIdsByPaper[t.paper_id].push(t.module_id);
  }

  // Grouped by Academic Year → College, same as students now see it. Papers
  // with no year_id yet (from before this field existed) get their own group
  // so they're easy to find and fix — they won't show to any student until
  // they're assigned one via Edit. Stashed on window so drilling down through
  // Year → College (or typing in the search box) never needs to re-fetch.
  const yearGroups = {};
  const NO_YEAR = '__noyear__';
  for (const p of papers) {
    const yKey = p.year_id || NO_YEAR;
    if (!yearGroups[yKey]) yearGroups[yKey] = { yearName: p.year_id ? (yearNameById[p.year_id] || 'Unknown Year') : null, colleges: {} };
    const collegeName = (p.college_name || '').trim();
    const cKey = collegeName || '__general__';
    if (!yearGroups[yKey].colleges[cKey]) yearGroups[yKey].colleges[cKey] = { collegeName, papers: [] };
    const moduleTag = (moduleIdsByPaper[p.id] || []).map(id => moduleNameById[id]).filter(Boolean).join(' + ');
    yearGroups[yKey].colleges[cKey].papers.push({ ...p, _qCount: qCounts[p.id] || 0, _moduleTag: moduleTag });
  }
  window._adminPapersData = { yearGroups, yList, NO_YEAR };

  const pp_module_checkboxes = mList.map(m => `
    <label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer">
      <input type="checkbox" class="pp-module-check" value="${m.id}" style="width:18px;height:18px;accent-color:var(--gold-600);flex-shrink:0">
      <span class="text-sm">${esc(m.name)}</span>
    </label>`).join('');

  document.getElementById('contentTabBody').innerHTML = `
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">➕ Add Past Paper</div>
      <label class="input-label">Paper Title <span class="text-xs text-muted">(shown to students)</span></label>
      <input id="pp_title" class="input-field" placeholder="e.g., Annual Exam 2023">
      <label class="input-label">Academic Year <span class="text-xs text-muted">(required — this is what keeps 1st/2nd/3rd year papers from mixing together)</span></label>
      <select id="pp_year_id" class="input-field" title="Select academic year" aria-label="Select academic year">
        ${pp_year_options}
      </select>
      ${!yList.length ? '<div class="text-xs text-muted mt-1">No academic years added yet. Add one in Courses → Academic Years first.</div>' : ''}
      <label class="input-label">Modules covered <span class="text-xs text-muted">(optional tags — check any that apply, doesn't restrict which questions go in this paper)</span></label>
      <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-md);padding:4px 12px;margin-bottom:12px">
        ${pp_module_checkboxes || '<p class="text-xs text-muted" style="padding:8px 0">No modules yet.</p>'}
      </div>
      <label class="input-label">College / University <span class="text-xs text-muted">(this is what students browse by next — Past Papers → Year → College)</span></label>
      <select id="pp_college" class="input-field" title="Select college" aria-label="Select college">
        ${pp_college_options}
      </select>
      ${!collegeRows?.length ? '<div class="text-xs text-muted mt-1">No colleges added yet. Add one in Content → Colleges first.</div>' : ''}
      <label class="input-label">Paper Year / Session <span class="text-xs text-muted">(optional label, e.g. exam sitting — NOT the academic year above)</span></label>
      <input id="pp_year" class="input-field" placeholder="e.g., 2023 or 2022 Supplementary">
      <label class="input-label">Display Order</label>
      <input id="pp_order" type="number" class="input-field" title="Display order" aria-label="Display order" placeholder="1" value="1">
      <label class="input-label">Status</label>
      <select id="pp_active" class="input-field" title="Paper status" aria-label="Paper status">
        <option value="true">✅ Visible to students</option>
        <option value="false">🔒 Hidden (draft)</option>
      </select>
      <button class="btn btn-primary" onclick="adminAddPastPaper()">Add Past Paper</button>
    </div>
    <div class="card" style="margin-bottom:20px;border:1.5px solid var(--gold-400)">
      <div class="fw-700 mb-2">📥 Bulk Upload Past Papers</div>
      <p class="text-xs text-muted mb-3">Create many paper entries at once from an Excel/CSV file — this only creates the papers themselves (title, academic year, college, exam year, module tags). Add each paper's questions afterward from Content → Questions → Bulk Upload, picking the paper there.</p>
      <input type="file" id="ppBulkFile" accept=".xlsx,.xls,.csv" class="input-field" title="Choose Excel/CSV file" aria-label="Choose Excel or CSV file" onchange="previewPaperBulk()">
      <div id="ppBulkPreview" style="margin-top:12px"></div>
      <button class="btn btn-primary mt-3" id="ppBulkUploadBtn" style="display:none" onclick="executePaperBulkUpload()">Upload All Papers</button>
      <hr class="divider">
      <div class="fw-700 mb-2">📥 Download Template</div>
      <button class="btn btn-secondary" onclick="downloadPaperTemplate()">Download Excel Template</button>
    </div>
    <div class="card" style="margin-bottom:16px">
      <label class="input-label">🔍 Search Past Papers</label>
      <input id="ppSearchBox" class="input-field" placeholder="Search by paper title..." oninput="filterAdminPapers(this.value)">
    </div>
    <div id="adminPapersListArea"></div>
    <div style="height:16px"></div>`;

  renderAdminPapersYearList();
}
window.adminPastPapers = adminPastPapers;


// One paper's row — title, meta (id/exam-year/modules/count), and its action
// buttons. Shared by the College drill-down view and the search-results view
// so the two never drift out of sync with each other.
function _adminPaperRowHtml(p, contextLabel) {
  return `
    <div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
      <div>
        <div class="text-sm fw-600">${esc(p.title)} <span class="text-xs text-muted" style="font-weight:500">#${p.id}</span> ${p.is_active ? '' : '<span class="badge badge-amber" style="font-size:9px">Hidden</span>'}</div>
        <div class="text-xs text-muted">${contextLabel ? `${esc(contextLabel)} · ` : ''}${p.paper_year ? `📅 ${esc(p.paper_year)} · ` : ''}${p._moduleTag ? `📦 ${esc(p._moduleTag)} · ` : ''}${p._qCount} questions</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
        ${p._qCount ? `<button class="btn btn-secondary btn-xs" onclick="downloadPaperQuestions(${p.id},'${escJs(p.title)}')">⬇️ Download</button>` : ''}
        <button class="btn btn-secondary btn-xs" onclick="startReplaceAllQuestions('paper',${p.id},'${escJs(p.title)}',${p._qCount})">🔁 Replace Qs</button>
        <button class="btn btn-secondary btn-xs" onclick="adminEditPastPaper(${p.id})">✏️</button>
        <button class="btn btn-danger btn-xs" onclick="adminDeletePastPaper(${p.id})">🗑</button>
      </div>
    </div>`;
}


// Level 1 (default view): every Academic Year as its own tappable card.
function renderAdminPapersYearList() {
  const area = document.getElementById('adminPapersListArea');
  if (!area || !window._adminPapersData) return;
  const searchBox = document.getElementById('ppSearchBox');
  if (searchBox) searchBox.value = '';
  const { yearGroups, yList, NO_YEAR } = window._adminPapersData;

  let html = '<div class="fw-700 mb-2">📜 Past Papers by Academic Year</div>';
  if (yearGroups[NO_YEAR]) {
    const g = yearGroups[NO_YEAR];
    const paperCount = Object.values(g.colleges).reduce((s, c) => s + c.papers.length, 0);
    html += `
      <div class="card" style="margin-bottom:10px;border:1.5px solid var(--amber);cursor:pointer" onclick="openAdminPapersYear('${NO_YEAR}')">
        <div class="flex-between"><div class="fw-700">⚠️ No Academic Year Assigned</div><span style="color:var(--ink-4)">›</span></div>
        <div class="text-xs text-muted mt-1">${paperCount} paper${paperCount === 1 ? '' : 's'} — students won't see these yet</div>
      </div>`;
  }
  for (const y of yList) {
    const g = yearGroups[y.id];
    if (!g) continue;
    const collegeCount = Object.keys(g.colleges).length;
    const paperCount = Object.values(g.colleges).reduce((s, c) => s + c.papers.length, 0);
    html += `
      <div class="card" style="margin-bottom:10px;cursor:pointer" onclick="openAdminPapersYear(${y.id})">
        <div class="flex-between"><div class="fw-700">🎓 ${esc(y.name)}</div><span style="color:var(--ink-4)">›</span></div>
        <div class="text-xs text-muted mt-1">${collegeCount} college${collegeCount === 1 ? '' : 's'} · ${paperCount} paper${paperCount === 1 ? '' : 's'}</div>
      </div>`;
  }
  area.innerHTML = html + (Object.keys(yearGroups).length ? '' : '<div class="card"><p class="text-muted">No past papers added yet. Give one a name and an academic year above.</p></div>');
}
window.renderAdminPapersYearList = renderAdminPapersYearList;


// Level 2: every College that has papers for the tapped Year.
function openAdminPapersYear(yearKey) {
  const area = document.getElementById('adminPapersListArea');
  const { yearGroups, yList, NO_YEAR } = window._adminPapersData || {};
  const g = yearGroups?.[yearKey];
  if (!area || !g) { renderAdminPapersYearList(); return; }
  const yearLabel = yearKey === NO_YEAR ? '⚠️ No Academic Year Assigned' : (yList.find(y => y.id == yearKey)?.name || 'Unknown Year');

  const sortedCollegeKeys = Object.keys(g.colleges).sort((a, b) => {
    if (a === '__general__') return 1;
    if (b === '__general__') return -1;
    return g.colleges[a].collegeName.localeCompare(g.colleges[b].collegeName);
  });
  let html = `
    <button class="btn btn-secondary btn-xs mb-2" onclick="renderAdminPapersYearList()">← All Years</button>
    <div class="fw-700 mb-2">🎓 ${esc(yearLabel)}</div>`;
  for (const cKey of sortedCollegeKeys) {
    const cg = g.colleges[cKey];
    const title = cg.collegeName || 'No College Set';
    html += `
      <div class="card" style="margin-bottom:10px;cursor:pointer" onclick="openAdminPapersCollege('${escJs(String(yearKey))}','${escJs(cKey)}')">
        <div class="flex-between"><div class="fw-700">🏫 ${esc(title)}</div><span style="color:var(--ink-4)">›</span></div>
        <div class="text-xs text-muted mt-1">${cg.papers.length} paper${cg.papers.length === 1 ? '' : 's'}</div>
      </div>`;
  }
  area.innerHTML = html;
}
window.openAdminPapersYear = openAdminPapersYear;


// Level 3: every actual paper for that Year+College, with full row actions
// (Download / Replace Qs / Edit / Delete) — same as the old flat list had,
// just reached by drilling down instead of scrolling past every other group.
function openAdminPapersCollege(yearKey, collegeKey) {
  const area = document.getElementById('adminPapersListArea');
  const { yearGroups, yList, NO_YEAR } = window._adminPapersData || {};
  const g = yearGroups?.[yearKey]?.colleges?.[collegeKey];
  if (!area || !g) { renderAdminPapersYearList(); return; }
  const yearLabel = yearKey === NO_YEAR ? '⚠️ No Academic Year Assigned' : (yList.find(y => y.id == yearKey)?.name || 'Unknown Year');
  const title = g.collegeName || 'No College Set';

  let html = `
    <button class="btn btn-secondary btn-xs mb-2" onclick="openAdminPapersYear('${escJs(String(yearKey))}')">← ${esc(yearLabel)}</button>
    <div class="fw-700 mb-2">🏫 ${esc(title)}</div>
    <div class="card">${g.papers.map(p => _adminPaperRowHtml(p)).join('')}</div>`;
  area.innerHTML = html;
}
window.openAdminPapersCollege = openAdminPapersCollege;


// Search bypasses the drill-down entirely — typing shows every matching
// paper flat, each labeled with its own Year · College, regardless of where
// it lives in the hierarchy. Clearing the box goes back to the Year list.
function filterAdminPapers(term) {
  const area = document.getElementById('adminPapersListArea');
  const { yearGroups, yList, NO_YEAR } = window._adminPapersData || {};
  if (!area || !yearGroups) return;
  const t = (term || '').trim().toLowerCase();
  if (!t) { renderAdminPapersYearList(); return; }

  const yearNameByKey = { [NO_YEAR]: '⚠️ No Academic Year' };
  for (const y of yList) yearNameByKey[y.id] = y.name;

  const matches = [];
  for (const yKey of Object.keys(yearGroups)) {
    for (const cKey of Object.keys(yearGroups[yKey].colleges)) {
      const cg = yearGroups[yKey].colleges[cKey];
      for (const p of cg.papers) {
        if (p.title.toLowerCase().includes(t)) {
          matches.push({ p, label: `${yearNameByKey[yKey] || 'Unknown Year'} · ${cg.collegeName || 'No College Set'}` });
        }
      }
    }
  }
  const html = `<div class="fw-700 mb-2">🔍 ${matches.length} result${matches.length === 1 ? '' : 's'}</div>` +
    (matches.length ? `<div class="card">${matches.map(m => _adminPaperRowHtml(m.p, m.label)).join('')}</div>` : '<div class="card"><p class="text-muted">No papers match that search.</p></div>');
  area.innerHTML = html;
}
window.filterAdminPapers = filterAdminPapers;



let ppBulkData = [];

function downloadPaperTemplate() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([
    { Title: 'Annual Exam 2023', AcademicYear: 'First Year', CollegeName: 'LUMHS Jamshoro', PaperYear: '2023', Modules: 'Anatomy, Physiology', DisplayOrder: 1, IsActive: 'TRUE' },
    { Title: 'Supplementary 2022', AcademicYear: 'First Year', CollegeName: 'LUMHS Jamshoro', PaperYear: '2022 Supplementary', Modules: 'Biochemistry', DisplayOrder: 2, IsActive: 'TRUE' }
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'PastPapers');
  XLSX.writeFile(wb, 'past_paper_bulk_template.xlsx');
}
window.downloadPaperTemplate = downloadPaperTemplate;


// Exports every question already in a given past paper to a readable PDF —
// numbered questions, options lettered with the correct one marked, the
// explanation underneath, and any question/explanation images embedded right
// where they belong — so it reads like the actual paper, not a data table.
// Loads jsPDF from a CDN the first time it's needed (no index.html changes
// required); if that fails (e.g. no internet), it says so instead of
// silently doing nothing. A single broken image link doesn't stop the rest
// of the download — it's noted inline and skipped.
async function downloadPaperQuestions(paperId, paperTitle) {
  showLoading(true, 'Preparing download...');
  const { data: questions } = await db(sb.from('questions').select('*').eq('paper_id', paperId).order('id'), 'Load failed');
  if (!questions || !questions.length) { showLoading(false); return showToast('No questions to download yet'); }

  if (!window.jspdf) {
    showLoading(true, 'Loading PDF tools...');
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('script load failed'));
        document.head.appendChild(s);
      });
    } catch {
      showLoading(false);
      showToast('Could not load the PDF tool — check your internet connection and try again', 8000);
      return;
    }
  }
  if (!window.jspdf) { showLoading(false); showToast('PDF tool did not load — try again'); return; }

  // Phase 1: fetch every distinct image ONCE and convert it to a data URL +
  // its natural pixel size, so the render pass below never has to await
  // anything mid-page — that's what keeps the page-break math reliable. A
  // failed fetch (broken link, offline, CORS, etc.) just leaves that URL out
  // of the cache; placeImage() below notices and prints a note instead.
  const urls = new Set();
  for (const q of questions) {
    if (q.image_url) urls.add(q.image_url);
    if (q.explanation_image_url) urls.add(q.explanation_image_url);
  }
  const imgCache = {};
  if (urls.size) {
    showLoading(true, `Downloading ${urls.size} image${urls.size === 1 ? '' : 's'}...`);
    await Promise.all([...urls].map(async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const blob = await res.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        const dims = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => resolve(null);
          img.src = dataUrl;
        });
        if (dims && dims.width) imgCache[url] = { dataUrl, ...dims };
      } catch { /* left out of imgCache on purpose — treated as failed below */ }
    }));
  }

  showLoading(true, 'Building PDF...');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const marginX = 15, maxWidth = 180, pageBottom = 280;
  const maxImgW = 90, maxImgH = 90;
  let y = 20;
  const ensureSpace = (needed) => { if (y + needed > pageBottom) { doc.addPage(); y = 20; } };

  const placeImage = (url, label) => {
    const cached = imgCache[url];
    doc.setFont('helvetica', 'normal');
    if (!cached) {
      ensureSpace(5);
      doc.setFontSize(8);
      doc.setTextColor(180, 60, 60);
      doc.text(`(${label} image could not be downloaded — check it in the app)`, marginX + 4, y);
      doc.setTextColor(0);
      y += 6;
      return;
    }
    let w = maxImgW, h = (cached.height / cached.width) * w;
    if (h > maxImgH) { h = maxImgH; w = (cached.width / cached.height) * h; }
    ensureSpace(h + 4);
    const fmtMatch = cached.dataUrl.match(/^data:image\/(\w+);/i);
    const fmt = (fmtMatch ? fmtMatch[1] : 'jpeg').toUpperCase().replace('JPG', 'JPEG');
    try {
      doc.addImage(cached.dataUrl, fmt, marginX + 4, y, w, h);
      y += h + 4;
    } catch (err) {
      console.error('addImage failed:', err);
      doc.setFontSize(8);
      doc.setTextColor(180, 60, 60);
      doc.text(`(${label} image could not be embedded — check it in the app)`, marginX + 4, y);
      doc.setTextColor(0);
      y += 6;
    }
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  const titleLines = doc.splitTextToSize(paperTitle || 'Past Paper', maxWidth);
  doc.text(titleLines, marginX, y);
  y += titleLines.length * 7 + 3;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`${questions.length} question${questions.length === 1 ? '' : 's'}`, marginX, y);
  doc.setTextColor(0);
  y += 10;

  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  questions.forEach((q, i) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    const qLines = doc.splitTextToSize(`Q${i + 1}. ${q.text || ''}`, maxWidth);
    ensureSpace(qLines.length * 5.5 + 4);
    doc.text(qLines, marginX, y);
    y += qLines.length * 5.5 + 2;

    if (q.image_url) placeImage(q.image_url, 'Question');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    (q.options || []).forEach((opt, oi) => {
      const isCorrect = oi === q.correct_answer;
      const optLines = doc.splitTextToSize(`${letters[oi] || oi + 1}) ${opt}${isCorrect ? '   ✓ Correct' : ''}`, maxWidth - 6);
      ensureSpace(optLines.length * 5 + 1);
      doc.setTextColor(isCorrect ? 0 : 30, isCorrect ? 130 : 30, isCorrect ? 60 : 30);
      doc.text(optLines, marginX + 4, y);
      y += optLines.length * 5 + 1;
    });
    doc.setTextColor(0);

    if (q.explanation) {
      y += 1;
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(90);
      const expLines = doc.splitTextToSize(`Explanation: ${q.explanation}`, maxWidth - 6);
      ensureSpace(expLines.length * 4.5 + 2);
      doc.text(expLines, marginX + 4, y);
      y += expLines.length * 4.5;
      doc.setTextColor(0);
    }

    if (q.explanation_image_url) placeImage(q.explanation_image_url, 'Explanation');

    y += 5;
    ensureSpace(0.1); // moves to a fresh page cleanly if the next question has no room at all
  });

  showLoading(false);
  const safeName = (paperTitle || 'paper').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'paper';
  doc.save(`${safeName}_questions.pdf`);
}
window.downloadPaperQuestions = downloadPaperQuestions;


function previewPaperBulk() {
  const file = document.getElementById('ppBulkFile')?.files[0];
  if (!file) return;
  const MAX_FILE_BYTES = 10 * 1024 * 1024, MAX_ROWS = 500;
  if (file.size > MAX_FILE_BYTES) {
    showToast('File is too large (max 10 MB). Please split it into smaller batches.');
    document.getElementById('ppBulkFile').value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (rows.length > MAX_ROWS) throw new Error(`Too many rows (${rows.length}). Please upload at most ${MAX_ROWS} papers at a time.`);
      const norm = (row, ...keys) => {
        for (const k of keys) {
          for (const rk of Object.keys(row)) {
            if (rk.replace(/[\s_]/g, '').toLowerCase() === k.replace(/[\s_]/g, '').toLowerCase()) return row[rk];
          }
        }
        return '';
      };
      ppBulkData = rows.map(row => ({
        title: String(norm(row, 'Title')).trim(),
        academicYearName: String(norm(row, 'AcademicYear', 'Year')).trim(),
        college_name: String(norm(row, 'CollegeName', 'College')).trim(),
        paper_year: String(norm(row, 'PaperYear', 'Session')).trim() || null,
        display_order: parseInt(norm(row, 'DisplayOrder', 'Order')) || 1,
        is_active: String(norm(row, 'IsActive', 'Active')).trim().toLowerCase() !== 'false',
        moduleNames: String(norm(row, 'Modules', 'Module')).split(',').map(x => x.trim()).filter(Boolean)
      })).filter(p => p.title && p.college_name);

      if (!ppBulkData.length) throw new Error('No valid rows found — check that "Title" and "CollegeName" columns exist and have values.');

      document.getElementById('ppBulkPreview').innerHTML = `
        <div class="badge badge-green" style="margin-bottom:8px">${ppBulkData.length} paper${ppBulkData.length===1?'':'s'} found</div>
        ${ppBulkData.slice(0, 5).map(p => `<div class="card" style="margin-bottom:6px;font-size:13px"><strong>${esc(p.title)}</strong> · ${esc(p.academicYearName || '⚠️ no year')} · ${esc(p.college_name)}${p.paper_year ? ` · ${esc(p.paper_year)}` : ''}</div>`).join('')}
        ${ppBulkData.length > 5 ? `<div class="text-xs text-muted">...and ${ppBulkData.length - 5} more</div>` : ''}`;
      document.getElementById('ppBulkUploadBtn').style.display = 'block';
    } catch (err) {
      document.getElementById('ppBulkPreview').innerHTML = `<div class="badge badge-red">❌ ${esc(err.message)}</div>`;
      ppBulkData = [];
    }
  };
  reader.readAsArrayBuffer(file);
}
window.previewPaperBulk = previewPaperBulk;


async function executePaperBulkUpload() {
  if (!ppBulkData.length) return;
  const [{ data: existingColleges }, { data: existingModules }, { data: existingYears }] = await Promise.all([
    db(sb.from('colleges').select('name').eq('is_active', true), 'Colleges error'),
    db(sb.from('modules').select('id,name'), 'Modules error'),
    db(sb.from('years').select('id,name'), 'Years error')
  ]);
  const collegeNames = new Set((existingColleges || []).map(c => c.name.trim().toLowerCase()));
  const moduleIdByName = {};
  for (const m of (existingModules || [])) moduleIdByName[m.name.trim().toLowerCase()] = m.id;
  const yearIdByName = {};
  for (const y of (existingYears || [])) yearIdByName[y.name.trim().toLowerCase()] = y.id;

  showLoading(true, `Uploading ${ppBulkData.length} papers...`);
  let success = 0, failed = 0, tagsLinked = 0, tagsSkipped = 0, collegeSkipped = 0, yearSkipped = 0, firstErr = '';
  for (const p of ppBulkData) {
    // Same rule as the single Add Past Paper form: college AND academic year must
    // already exist (Content → Colleges, Courses → Academic Years) so students'
    // Year → College browse tree stays consistent instead of fragmenting into
    // near-duplicate spellings, or worse, papers that never show to anyone.
    if (!collegeNames.has(p.college_name.toLowerCase())) {
      collegeSkipped++;
      continue;
    }
    const yearId = yearIdByName[p.academicYearName.toLowerCase()];
    if (!yearId) {
      yearSkipped++;
      continue;
    }
    const { data: inserted, error } = await sb.from('past_papers').insert({
      title: p.title, year_id: yearId, college_name: p.college_name, paper_year: p.paper_year,
      display_order: p.display_order, is_active: p.is_active
    }).select('id').single();
    if (error) {
      failed++;
      console.error('Bulk paper insert failed:', error);
      if (!firstErr) firstErr = error.message;
      continue;
    }
    success++;
    for (const mName of p.moduleNames) {
      const mId = moduleIdByName[mName.toLowerCase()];
      if (!mId) { tagsSkipped++; continue; }
      const { error: tagErr } = await sb.from('past_paper_modules').insert({ paper_id: inserted.id, module_id: mId });
      if (!tagErr) tagsLinked++;
    }
  }
  showLoading(false);
  let msg = `✅ ${success} paper${success === 1 ? '' : 's'} added`;
  if (yearSkipped) msg += `, ⛔ ${yearSkipped} skipped (academic year name didn't match — check Courses → Academic Years for the exact spelling)`;
  if (collegeSkipped) msg += `, ⛔ ${collegeSkipped} skipped (college name didn't match any existing active college — check Content → Colleges for the exact spelling)`;
  if (failed) msg += `, ❌ ${failed} failed: ${firstErr}`;
  if (tagsLinked) msg += `. Tagged ${tagsLinked} module link${tagsLinked === 1 ? '' : 's'}`;
  if (tagsSkipped) msg += `. ${tagsSkipped} module name${tagsSkipped === 1 ? '' : 's'} didn't match an existing module, so ${tagsSkipped === 1 ? 'that tag was' : 'those tags were'} skipped (the paper itself was still created)`;
  showToast(msg, (failed || tagsSkipped || collegeSkipped || yearSkipped) ? 14000 : 4000);
  logAdminAction(`Bulk uploaded ${success} past papers`);
  ppBulkData = [];
  document.getElementById('ppBulkFile').value = '';
  document.getElementById('ppBulkUploadBtn').style.display = 'none';
  document.getElementById('ppBulkPreview').innerHTML = '';
  adminPastPapers();
}
window.executePaperBulkUpload = executePaperBulkUpload;



async function adminAddPastPaper() {
  const title = document.getElementById('pp_title').value.trim();
  const year_id = parseInt(document.getElementById('pp_year_id').value) || null;
  const college_name = document.getElementById('pp_college').value.trim() || null;
  const paper_year = document.getElementById('pp_year').value.trim() || null;
  const display_order = parseInt(document.getElementById('pp_order').value) || 1;
  const is_active = document.getElementById('pp_active').value === 'true';
  const moduleIds = Array.from(document.querySelectorAll('.pp-module-check:checked')).map(cb => parseInt(cb.value));
  if (!title) return showToast('Paper title required');
  if (!year_id) return showToast('Please select an academic year');
  if (!college_name) return showToast('Please select a college');
  const { data: inserted } = await db(sb.from('past_papers').insert({ title, year_id, college_name, paper_year, display_order, is_active }).select('id').single(), 'Add failed');
  if (inserted && moduleIds.length) {
    await db(sb.from('past_paper_modules').insert(moduleIds.map(module_id => ({ paper_id: inserted.id, module_id }))), 'Module tag save failed');
  }
  showToast('Past paper added ✓. Now add its questions from the Questions tab — pick this paper there, whatever module each question belongs to');
  adminPastPapers();
}
window.adminAddPastPaper = adminAddPastPaper;



async function adminEditPastPaper(id) {
  const [{ data: p }, { data: collegeRows }, { data: modules }, { data: existingTags }, { data: yearRows }] = await Promise.all([
    db(sb.from('past_papers').select('*').eq('id', id).single(), 'Load failed'),
    db(sb.from('colleges').select('name').eq('is_active', true).order('name'), 'Colleges error'),
    db(sb.from('modules').select('id,name').order('name'), 'Modules error'),
    db(sb.from('past_paper_modules').select('module_id').eq('paper_id', id), 'Tags load failed'),
    db(sb.from('years').select('id,name').order('display_order'), 'Years error')
  ]);
  if (!p) return;
  const taggedIds = new Set((existingTags || []).map(t => t.module_id));
  const currentCollege = p.college_name || '';
  let matched = false;
  let ep_college_options = `<option value="" ${!currentCollege ? 'selected' : ''}>None</option>`;
  for (const c of (collegeRows || [])) {
    if (c.name === currentCollege) matched = true;
    ep_college_options += `<option value="${esc(c.name)}" ${c.name === currentCollege ? 'selected' : ''}>${esc(c.name)}</option>`;
  }
  if (currentCollege && !matched) {
    ep_college_options += `<option value="${esc(currentCollege)}" selected>${esc(currentCollege)} (not in list)</option>`;
  }
  const ep_year_options = `<option value="" ${!p.year_id?'selected':''}>⚠️ None (won't show to students)</option>` +
    (yearRows || []).map(y => `<option value="${y.id}" ${y.id===p.year_id?'selected':''}>${esc(y.name)}</option>`).join('');
  const ep_module_checkboxes = (modules || []).map(m => `
    <label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer">
      <input type="checkbox" class="ep-module-check" value="${m.id}" ${taggedIds.has(m.id) ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--gold-600);flex-shrink:0">
      <span class="text-sm">${esc(m.name)}</span>
    </label>`).join('');
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:420px;max-height:90vh;overflow-y:auto">
      <div class="fw-700 mb-3">✏️ Edit Past Paper</div>
      <label class="input-label">Paper Title</label>
      <input id="_ep_title" class="input-field" value="${esc(p.title||'')}">
      <label class="input-label">Academic Year <span class="text-xs text-muted">(keeps this out of other years' lists)</span></label>
      <select id="_ep_year_id" class="input-field" title="Select academic year" aria-label="Select academic year">${ep_year_options}</select>
      <label class="input-label">Modules covered <span class="text-xs text-muted">(optional tags — check any that apply)</span></label>
      <div style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-md);padding:4px 12px;margin-bottom:12px">
        ${ep_module_checkboxes || '<p class="text-xs text-muted" style="padding:8px 0">No modules yet.</p>'}
      </div>
      <label class="input-label">College / University</label>
      <select id="_ep_college" class="input-field" title="Select college" aria-label="Select college">${ep_college_options}</select>
      <label class="input-label">Paper Year / Session</label>
      <input id="_ep_year" class="input-field" value="${esc(p.paper_year||'')}">
      <label class="input-label">Display Order</label>
      <input id="_ep_order" type="number" class="input-field" title="Display order" aria-label="Display order" value="${p.display_order||1}">
      <label class="input-label">Status</label>
      <select id="_ep_active" class="input-field" title="Paper status" aria-label="Paper status">
        <option value="true" ${p.is_active?'selected':''}>✅ Visible to students</option>
        <option value="false" ${!p.is_active?'selected':''}>🔒 Hidden (draft)</option>
      </select>
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="saveEditedPastPaper(${p.id}, this)">Save Changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.adminEditPastPaper = adminEditPastPaper;


// See saveEditedYear (near adminEditYear) for why this can't be an inline onclick
// IIFE — it silently (or, since the last fix, visibly as "sb is not defined")
// crashed before ever reaching the network call, because sb/db/etc. are imports
// local to this module and aren't visible inside a string re-parsed as inline
// event-handler code.
async function saveEditedPastPaper(id, btnEl) {
  try {
    const t = document.getElementById('_ep_title').value.trim();
    const yid = parseInt(document.getElementById('_ep_year_id').value) || null;
    const c = document.getElementById('_ep_college').value.trim() || null;
    const y = document.getElementById('_ep_year').value.trim() || null;
    const o = parseInt(document.getElementById('_ep_order').value) || 1;
    const a = document.getElementById('_ep_active').value === 'true';
    const moduleIds = Array.from(document.querySelectorAll('.ep-module-check:checked')).map(cb => parseInt(cb.value));
    if (!t) { showToast('Title required'); return; }
    const r1 = await db(sb.from('past_papers').update({ title: t, year_id: yid, college_name: c, paper_year: y, display_order: o, is_active: a }).eq('id', id), 'Edit failed — title/college/year not saved');
    if (r1.error) return;
    const r2 = await db(sb.from('past_paper_modules').delete().eq('paper_id', id), 'Tag update failed — module tags not saved');
    if (r2.error) return;
    if (moduleIds.length) {
      const r3 = await db(sb.from('past_paper_modules').insert(moduleIds.map(module_id => ({ paper_id: id, module_id }))), 'Tag save failed — module tags not saved');
      if (r3.error) return;
    }
    showToast(yid ? 'Past paper updated ✓' : '⚠️ Saved, but no Academic Year is set — this paper is still invisible to students', yid ? 3000 : 8000);
    btnEl.closest('[style*=fixed]').remove();
    adminPastPapers();
  } catch (err) {
    console.error('Edit past paper failed:', err);
    showToast('Unexpected error: ' + err.message, 9000);
  }
}
window.saveEditedPastPaper = saveEditedPastPaper;



async function adminDeletePastPaper(id) {
  showConfirm('Delete this past paper?<br><small>All questions inside it will also be permanently deleted.</small>', async () => {
    await db(sb.from('questions').delete().eq('paper_id', id), 'Q delete failed');
    await db(sb.from('past_papers').delete().eq('id', id), 'Delete failed');
    showToast('Past paper deleted'); adminPastPapers();
  }, 'Delete');
}
window.adminDeletePastPaper = adminDeletePastPaper;



// --- PRACTICE TESTS CRUD ---
// Practice Tests are admin-named question sets (e.g. "Head & Neck Practice Test 1")
// that live under a Module. Leaving Subject blank makes it a whole-module test shown
// in the "[Module] Practice Tests" folder on the module page; picking a Subject scopes
// it to that subject's own practice-test list instead. Mirrors Past Papers above —
// same shape, just grouped by Module+Subject instead of Module+College.
async function adminPracticeTests() {
  const { data: modules } = await db(sb.from('modules').select('id,name').order('name'), 'Modules error');
  const mList = modules || [];

  // Every module's tests, and every test's question count, in 2 requests
  // total instead of 1 query per module for its tests, then 1 more per test
  // for its count.
  const { data: allTests } = await db(sb.from('practice_tests').select('*, subjects(name)').order('display_order'), 'Tests error');
  const testsByModule = {};
  for (const t of (allTests || [])) {
    if (!testsByModule[t.module_id]) testsByModule[t.module_id] = [];
    testsByModule[t.module_id].push(t);
  }
  const qCounts = await getQuestionCountsBy('practice_test_id', (allTests || []).map(t => t.id));

  let testHtml = '';
  for (const m of mList) {
    const tests = testsByModule[m.id];
    if (!tests?.length) continue;
    testHtml += `<div class="card" style="margin-bottom:10px">
      <div class="fw-700 mb-2">📦 ${m.name}</div>
      ${tests.map((t) => `
        <div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
          <div>
            <div class="text-sm fw-600">${t.title} ${t.is_active ? '' : '<span class="badge badge-amber" style="font-size:9px">Hidden</span>'}</div>
            <div class="text-xs text-muted">${t.subjects?.name ? `📖 ${t.subjects.name}` : '🎯 Whole Module'} · ${qCounts[t.id] || 0} questions</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn btn-secondary btn-xs" onclick="startReplaceAllQuestions('test',${t.id},'${escJs(t.title)}',${qCounts[t.id] || 0})">🔁 Replace Qs</button>
            <button class="btn btn-secondary btn-xs" onclick="adminEditPracticeTest(${t.id})">✏️</button>
            <button class="btn btn-danger btn-xs" onclick="adminDeletePracticeTest(${t.id})">🗑</button>
          </div>
        </div>`).join('')}
    </div>`;
  }

  document.getElementById('contentTabBody').innerHTML = `
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">➕ Add Practice Test</div>
      <label class="input-label">Module</label>
      <select id="pt_module" class="input-field" title="Select module" aria-label="Select module" onchange="loadSubjectsForPT()">
        <option value="">Select module</option>
        ${mList.map(m => `<option value="${m.id}">${m.name}</option>`).join('')}
      </select>
      <label class="input-label">Subject <span class="text-xs text-muted">(leave blank for a whole-module test spanning all subjects)</span></label>
      <select id="pt_subject" class="input-field" title="Select subject" aria-label="Select subject">
        <option value="">Whole Module Test</option>
      </select>
      <label class="input-label">Test Title <span class="text-xs text-muted">(shown to students, e.g. "Practice Test 1")</span></label>
      <input id="pt_title" class="input-field" placeholder="e.g., Head &amp; Neck Practice Test 1">
      <label class="input-label">Display Order</label>
      <input id="pt_order" type="number" class="input-field" title="Display order" aria-label="Display order" placeholder="1" value="1">
      <label class="input-label">Status</label>
      <select id="pt_active" class="input-field" title="Test status" aria-label="Test status">
        <option value="true">✅ Visible to students</option>
        <option value="false">🔒 Hidden (draft)</option>
      </select>
      <button class="btn btn-primary" onclick="adminAddPracticeTest()">Add Practice Test</button>
    </div>
    <div class="fw-700 mb-2">🎯 Practice Tests by Module</div>
    ${testHtml || '<div class="card"><p class="text-muted">No practice tests added yet. Pick a module above, give the test a name (e.g. "Practice Test 1"), then add its questions from the Questions tab.</p></div>'}`;
}
window.adminPracticeTests = adminPracticeTests;



async function loadSubjectsForPT() {
  const moduleId = document.getElementById('pt_module')?.value;
  const subSel = document.getElementById('pt_subject');
  if (subSel) subSel.innerHTML = '<option value="">Whole Module Test</option>';
  if (!moduleId) return;
  const { data: subs } = await db(sb.from('subjects').select('id,name').eq('module_id', moduleId).order('display_order'), 'Subs error');
  for (const s of subs || []) {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name;
    subSel?.appendChild(opt);
  }
}
window.loadSubjectsForPT = loadSubjectsForPT;



async function adminAddPracticeTest() {
  const module_id = document.getElementById('pt_module').value;
  const subject_id = document.getElementById('pt_subject').value || null;
  const title = document.getElementById('pt_title').value.trim();
  const display_order = parseInt(document.getElementById('pt_order').value) || 1;
  const is_active = document.getElementById('pt_active').value === 'true';
  if (!module_id || !title) return showToast('Module and test title required');
  await db(sb.from('practice_tests').insert({ module_id, subject_id, title, display_order, is_active }), 'Add failed');
  showToast('Practice test added ✓. Now add its questions from the Questions tab');
  adminPracticeTests();
}
window.adminAddPracticeTest = adminAddPracticeTest;



async function adminEditPracticeTest(id) {
  const { data: t } = await db(sb.from('practice_tests').select('*').eq('id', id).single(), 'Load failed');
  if (!t) return;
  const { data: subs } = await db(sb.from('subjects').select('id,name').eq('module_id', t.module_id).order('display_order'), 'Subs error');
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:420px;max-height:90vh;overflow-y:auto">
      <div class="fw-700 mb-3">✏️ Edit Practice Test</div>
      <label class="input-label">Test Title</label>
      <input id="_ept_title" class="input-field" value="${esc(t.title||'')}">
      <label class="input-label">Subject <span class="text-xs text-muted">(blank = whole-module test)</span></label>
      <select id="_ept_subject" class="input-field" title="Subject" aria-label="Subject">
        <option value="" ${!t.subject_id?'selected':''}>Whole Module Test</option>
        ${(subs||[]).map(s=>`<option value="${s.id}" ${s.id===t.subject_id?'selected':''}>${esc(s.name)}</option>`).join('')}
      </select>
      <label class="input-label">Display Order</label>
      <input id="_ept_order" type="number" class="input-field" title="Display order" aria-label="Display order" value="${t.display_order||1}">
      <label class="input-label">Status</label>
      <select id="_ept_active" class="input-field" title="Test status" aria-label="Test status">
        <option value="true" ${t.is_active?'selected':''}>✅ Visible to students</option>
        <option value="false" ${!t.is_active?'selected':''}>🔒 Hidden (draft)</option>
      </select>
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="saveEditedPracticeTest(${t.id}, this)">Save Changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.adminEditPracticeTest = adminEditPracticeTest;


// See saveEditedYear (near adminEditYear) for why this can't be an inline onclick IIFE.
async function saveEditedPracticeTest(id, btnEl) {
  try {
    const ti = document.getElementById('_ept_title').value.trim();
    const s = document.getElementById('_ept_subject').value || null;
    const o = parseInt(document.getElementById('_ept_order').value) || 1;
    const a = document.getElementById('_ept_active').value === 'true';
    if (!ti) { showToast('Title required'); return; }
    const { error } = await db(sb.from('practice_tests').update({ title: ti, subject_id: s, display_order: o, is_active: a }).eq('id', id), 'Edit failed');
    if (error) return;
    showToast('Practice test updated ✓');
    btnEl.closest('[style*=fixed]').remove();
    adminPracticeTests();
  } catch (err) {
    console.error('Edit practice test failed:', err);
    showToast('Unexpected error: ' + err.message, 9000);
  }
}
window.saveEditedPracticeTest = saveEditedPracticeTest;



async function adminDeletePracticeTest(id) {
  showConfirm('Delete this practice test?<br><small>All questions inside it will also be permanently deleted.</small>', async () => {
    await db(sb.from('questions').delete().eq('practice_test_id', id), 'Q delete failed');
    await db(sb.from('practice_tests').delete().eq('id', id), 'Delete failed');
    showToast('Practice test deleted'); adminPracticeTests();
  }, 'Delete');
}
window.adminDeletePracticeTest = adminDeletePracticeTest;



// --- QUESTIONS: "what is this for" mode toggle (Module/Subject/Test vs Past Paper) ---
// A question either belongs to a Module (optionally + Subject + Practice Test) OR to a
// Past Paper — never sensibly both. Older versions of this screen showed all 4 dropdowns
// at once, which made it easy to leave a stale Module selected while uploading to a Paper
// (or vice versa) — the question would silently save against the wrong parent and then
// look "missing" wherever you expected to find it. This toggle makes the two modes
// mutually exclusive in the UI itself so that mistake can't happen anymore.
window._qMode = window._qMode || 'module';   // Add Question tab
window._qxMode = window._qxMode || 'module'; // Bulk Upload tab


function setQMode(prefix, mode) {
  window['_' + prefix + 'Mode'] = mode;
  document.getElementById(prefix + '_modeModuleBtn')?.classList.toggle('active', mode === 'module');
  document.getElementById(prefix + '_modePaperBtn')?.classList.toggle('active', mode === 'paper');
  const modFields = document.getElementById(prefix + '_moduleFields');
  const papFields = document.getElementById(prefix + '_paperFields');
  if (modFields) modFields.style.display = mode === 'module' ? 'block' : 'none';
  if (papFields) papFields.style.display = mode === 'paper' ? 'block' : 'none';
}
window.setQMode = setQMode;


function qModePaperToggleHtml(prefix) {
  const mode = window['_' + prefix + 'Mode'] === 'paper' ? 'paper' : 'module';
  return `
    <div class="fw-700 mb-2">🎯 Step 1: What is ${prefix === 'q' ? 'this question' : 'this batch'} for?</div>
    <div class="tab-bar" style="margin-bottom:14px">
      <button type="button" id="${prefix}_modeModuleBtn" class="tab-btn ${mode==='module'?'active':''}" onclick="setQMode('${prefix}','module')">📦 Module / Subject / Test</button>
      <button type="button" id="${prefix}_modePaperBtn" class="tab-btn ${mode==='paper'?'active':''}" onclick="setQMode('${prefix}','paper')">📜 Past Paper</button>
    </div>`;
}


// --- REPLACE ALL QUESTIONS (locked-target bulk upload) ---
// Set by the "🔁 Replace All Questions" button on a Past Paper / Practice Test row.
// While this is set, the Bulk Upload tab's Step 1 shows a locked banner instead of the
// mode toggle above, and every upload method (AI text / Excel / JSON) attaches straight
// to this one target — with an optional delete-existing-first step.
window._bulkLockedTarget = null;


function startReplaceAllQuestions(type, id, title, currentCount) {
  window._bulkLockedTarget = { type, id, title, currentCount };
  window._currentContentTab = 'questions';
  window._currentQSubTab = 'bulk';
  adminShowTab('content', true);
}
window.startReplaceAllQuestions = startReplaceAllQuestions;


function clearBulkLockedTarget() {
  window._bulkLockedTarget = null;
  const btn = [...document.querySelectorAll('#contentTabBody .tab-bar .tab-btn')].find(b => b.getAttribute('onclick')?.includes(`'bulk'`));
  qSubTab('bulk', btn);
}
window.clearBulkLockedTarget = clearBulkLockedTarget;


function bulkStep1Html() {
  const lock = window._bulkLockedTarget;
  if (lock) {
    return `
      <div class="card" style="margin-bottom:20px;border:1.5px solid var(--gold-500)">
        <div class="fw-700 mb-2">🎯 Step 1: Target locked</div>
        <div class="flex-between" style="align-items:flex-start">
          <div>
            <div class="text-sm fw-600">${lock.type === 'paper' ? '📜' : '🎯'} ${esc(lock.title)}</div>
            <div class="text-xs text-muted mt-1">${lock.currentCount} existing question${lock.currentCount===1?'':'s'} right now</div>
          </div>
          <button class="btn btn-ghost btn-xs" onclick="clearBulkLockedTarget()">✕ Change target</button>
        </div>
        <label style="display:flex;align-items:flex-start;gap:8px;margin-top:14px;padding:10px 12px;background:var(--red-light,#fde8e8);border-radius:var(--radius-md);cursor:pointer">
          <input type="checkbox" id="qx_replaceMode" checked style="width:18px;height:18px;accent-color:var(--red);flex-shrink:0;margin-top:1px">
          <span class="text-xs" style="color:var(--red);font-weight:600;line-height:1.5">Replace mode: delete all ${lock.currentCount} existing question${lock.currentCount===1?'':'s'} in "${esc(lock.title)}" right before uploading the batch below. Uncheck to just ADD more questions on top instead.</span>
        </label>
      </div>`;
  }
  const mOpts = (window._adminModules || []).map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  const mode = window._qxMode === 'paper' ? 'paper' : 'module';
  return `
    <div class="card" style="margin-bottom:20px">
      ${qModePaperToggleHtml('qx')}
      <p class="text-xs text-muted mb-3">This selection is shared by all three upload methods below (AI Text, Excel, JSON).</p>
      <div id="qx_moduleFields" style="display:${mode==='paper'?'none':'block'}">
        <label class="input-label">Module <span class="text-xs text-muted">(required)</span></label>
        <select id="qx_module" class="input-field" title="Select module" aria-label="Select module" onchange="loadSubjectsForQX()">
          <option value="">Select module</option>${mOpts}
        </select>
        <label class="input-label">Subject (optional)</label>
        <select id="qx_subject" class="input-field" title="Select subject" aria-label="Select subject" onchange="loadTestsForQX()">
          <option value="">Any / Mixed</option>
        </select>
        <label class="input-label">Practice Test (optional, pick this if every question belongs to one named practice test)</label>
        <select id="qx_test" class="input-field" title="Select practice test" aria-label="Select practice test">
          <option value="">Not part of a practice test</option>
        </select>
      </div>
      <div id="qx_paperFields" style="display:${mode==='paper'?'block':'none'}">
        <label class="input-label">Academic Year</label>
        <select id="qx_paper_year" class="input-field" title="Select academic year" aria-label="Select academic year" onchange="loadCollegesForPaperPicker('qx')">
          <option value="" disabled selected>Select year...</option>
        </select>
        <label class="input-label">College</label>
        <select id="qx_paper_college" class="input-field" title="Select college" aria-label="Select college" onchange="loadPapersForPaperPicker('qx')">
          <option value="" disabled selected>Select year first</option>
        </select>
        <label class="input-label">Past Paper <span class="text-xs text-muted">(shows how many questions it already has)</span></label>
        <select id="qx_paper" class="input-field" title="Select past paper" aria-label="Select past paper">
          <option value="" disabled selected>Select college first</option>
        </select>
      </div>
    </div>`;
}


// Resolves where a batch of bulk-uploaded questions should attach — either the locked
// Replace-All target, or whatever Step 1 above has set, respecting the Module/Past-Paper
// mode toggle so the two can never both apply at once. Shared by the preview + execute
// step of all three bulk methods (AI text, Excel, JSON) below.
// Human-readable label for wherever THIS bulk upload is headed — captured at the
// start of an upload (while the Step 1 dropdowns still exist) and shown in the
// final success toast, so it's immediately obvious if the wrong mode/target was
// picked instead of discovering it later as "total questions went up but this
// paper is still empty."
function resolveBulkTargetLabel() {
  const lock = window._bulkLockedTarget;
  if (lock) return `${lock.type === 'paper' ? 'Past Paper' : 'Practice Test'} "${lock.title}"`;
  const mode = window._qxMode === 'paper' ? 'paper' : 'module';
  const sel = document.getElementById(mode === 'paper' ? 'qx_paper' : 'qx_module');
  const optText = sel?.selectedOptions?.[0]?.textContent?.replace(/\s*\(\d+\s*questions?(\s+so\s+far)?\)\s*$/i, '').trim();
  return optText ? `${mode === 'paper' ? 'Past Paper' : 'Module'} "${optText}"` : (mode === 'paper' ? 'the selected Past Paper' : 'the selected Module');
}


function resolveBulkTarget() {
  const lock = window._bulkLockedTarget;
  if (lock) {
    return lock.type === 'paper'
      ? { module_id: null, subject_id: null, paper_id: lock.id, practice_test_id: null, ok: true }
      : { module_id: null, subject_id: null, paper_id: null, practice_test_id: lock.id, ok: true };
  }
  const mode = window._qxMode === 'paper' ? 'paper' : 'module';
  if (mode === 'paper') {
    const paper_id = document.getElementById('qx_paper')?.value || null;
    if (!paper_id) return { ok: false, errMsg: 'Select a Past Paper in Step 1 first' };
    return { module_id: null, subject_id: null, paper_id, practice_test_id: null, ok: true };
  }
  const module_id = document.getElementById('qx_module')?.value || null;
  if (!module_id) return { ok: false, errMsg: 'Select a Module in Step 1 first' };
  const subject_id = document.getElementById('qx_subject')?.value || null;
  const practice_test_id = document.getElementById('qx_test')?.value || null;
  return { module_id, subject_id, paper_id: null, practice_test_id, ok: true };
}


// Only relevant when a Replace-All target is locked and its checkbox is ticked — deletes
// every existing question under that paper/test right before the fresh batch is inserted.
// Returns false (and leaves the existing questions untouched) if the delete itself failed,
// so the caller can bail out instead of adding a duplicate batch on top of the old one.
async function _maybeReplaceExisting() {
  const lock = window._bulkLockedTarget;
  if (!lock) return true;
  if (!document.getElementById('qx_replaceMode')?.checked) return true;
  const col = lock.type === 'paper' ? 'paper_id' : 'practice_test_id';
  const { error } = await db(sb.from('questions').delete().eq(col, lock.id), 'Delete existing questions failed');
  return !error;
}


// After a locked (Replace-All) bulk upload finishes, clears the lock and returns straight
// to that paper's/test's list — the fresh question count right there confirms it worked.
// Returns false when nothing was locked, so normal (non-replace) uploads are unaffected.
function _afterLockedBulkUpload() {
  if (!window._bulkLockedTarget) return false;
  const wasType = window._bulkLockedTarget.type;
  window._bulkLockedTarget = null;
  window._currentQSubTab = null;
  if (wasType === 'paper') adminPastPapers(); else adminPracticeTests();
  return true;
}



// --- QUESTIONS CRUD ---
async function adminQuestions() {
  const { data: modules } = await db(sb.from('modules').select('id,name').order('name'), 'Modules error');

  document.getElementById('contentTabBody').innerHTML = `
    <div class="tab-bar" style="margin-bottom:12px">
      <button class="tab-btn" onclick="qSubTab('add',this)">➕ Add Question</button>
      <button class="tab-btn" onclick="qSubTab('browse',this)">🔎 Browse & Edit</button>
      <button class="tab-btn" onclick="qSubTab('bulk',this)">📂 Bulk Upload</button>
    </div>
    <div id="qTabBody"></div>`;

  window._adminModules = modules || [];
  // Resume onto whatever inner sub-tab (Add/Browse/Bulk) was open before, else default to Add
  const subTabToOpen = window._currentQSubTab || 'add';
  const subBtn = [...document.querySelectorAll('#contentTabBody .tab-bar .tab-btn')]
    .find(b => b.getAttribute('onclick')?.includes(`'${subTabToOpen}'`)) || document.querySelector('#contentTabBody .tab-bar .tab-btn');
  qSubTab(subTabToOpen, subBtn);
}



function qSubTab(tab, btn) {
  window._currentQSubTab = tab;
  if (tab !== 'bulk') window._bulkLockedTarget = null;
  document.querySelectorAll('#contentTabBody .tab-bar .tab-btn').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  const mOpts = (window._adminModules || []).map(m => `<option value="${m.id}">${m.name}</option>`).join('');

  if (tab === 'add') {
    document.getElementById('qTabBody').innerHTML = `
      <div class="card">
        ${qModePaperToggleHtml('q')}
        <div id="q_moduleFields" style="display:${window._qMode==='paper'?'none':'block'}">
          <label class="input-label">Module <span class="text-xs text-muted">(required)</span></label>
          <select id="q_module" class="input-field" title="Select module" aria-label="Select module" onchange="onQModuleChange()">
            <option value="">Select module...</option>${mOpts}
          </select>
          <label class="input-label">Subject (optional, organizes this question under a subject)</label>
          <select id="q_subject" class="input-field" title="Select subject" aria-label="Select subject" onchange="loadTestsForQ()">
            <option value="">Any / Mixed</option>
          </select>
          <label class="input-label">Practice Test (optional, assigns this question to one of your named practice tests)</label>
          <select id="q_test" class="input-field" title="Select practice test" aria-label="Select practice test">
            <option value="">Not part of a practice test</option>
          </select>
        </div>
        <div id="q_paperFields" style="display:${window._qMode==='paper'?'block':'none'}">
          <label class="input-label">Academic Year</label>
          <select id="q_paper_year" class="input-field" title="Select academic year" aria-label="Select academic year" onchange="loadCollegesForPaperPicker('q')">
            <option value="" disabled selected>Select year...</option>
          </select>
          <label class="input-label">College</label>
          <select id="q_paper_college" class="input-field" title="Select college" aria-label="Select college" onchange="loadPapersForPaperPicker('q')">
            <option value="" disabled selected>Select year first</option>
          </select>
          <label class="input-label">Past Paper <span class="text-xs text-muted">(shows how many questions it already has)</span></label>
          <select id="q_paper" class="input-field" title="Select past paper" aria-label="Select past paper">
            <option value="" disabled selected>Select college first</option>
          </select>
        </div>
        <label class="input-label">Question Text</label>
        <textarea id="q_text" class="input-field" rows="3" placeholder="Type the MCQ question here..."></textarea>
        <label class="input-label">Question Image (optional)</label>
        <div class="upload-area" onclick="document.getElementById('q_img_file').click()">📸 Upload question image</div>
        <input type="file" id="q_img_file" accept="image/*" style="display:none" onchange="previewAndUpload('q_img_file','q_img_url','q_img_preview')">
        <img id="q_img_preview" style="display:none;max-width:100%;border-radius:var(--radius-lg);margin:8px 0">
        <input id="q_img_url" class="input-field" placeholder="Image URL" readonly>
        <label class="input-label">Options (fill all 4, add 5th/6th if needed)</label>
        <div id="q_opts_container">
          ${['A','B','C','D'].map((l,i) => `
            <div class="input-group" style="margin-bottom:8px">
              <span style="width:28px;text-align:center;font-weight:700;flex-shrink:0;padding-top:14px">${l}</span>
              <input id="q_opt_${i}" class="input-field" placeholder="Option ${l}" style="margin:0">
            </div>`).join('')}
        </div>
        <button class="btn btn-ghost btn-sm" onclick="addExtraOption()" style="margin-bottom:10px">+ Add option E/F</button>
        <label class="input-label">Correct Answer</label>
        <select id="q_correct" class="input-field" title="Select correct answer" aria-label="Select correct answer">
          <option value="0">A</option><option value="1">B</option><option value="2">C</option><option value="3">D</option>
        </select>
        <label class="input-label">Explanation</label>
        <textarea id="q_exp" class="input-field" rows="3" placeholder="Explain why the correct answer is correct..."></textarea>
        <label class="input-label">Explanation Image (optional)</label>
        <div class="upload-area" onclick="document.getElementById('q_exp_img_file').click()">📸 Upload explanation image</div>
        <input type="file" id="q_exp_img_file" accept="image/*" style="display:none" onchange="previewAndUpload('q_exp_img_file','q_exp_img_url','q_exp_img_preview')">
        <img id="q_exp_img_preview" style="display:none;max-width:100%;border-radius:var(--radius-lg);margin:8px 0">
        <input id="q_exp_img_url" class="input-field" placeholder="Explanation image URL" readonly>
        <label class="input-label">Tags (comma separated, e.g. anatomy, upper limb)</label>
        <input id="q_tags" class="input-field" placeholder="tag1, tag2, tag3">
        <button class="btn btn-primary mt-3" onclick="adminAddQuestion()">💾 Save Question</button>
      </div>`;
    loadYearsForPaperPicker('q'); // populates the Academic Year dropdown right away — it no longer depends on a module being picked first
  } else if (tab === 'browse') {
    document.getElementById('qTabBody').innerHTML = `
      <div class="card" style="margin-bottom:20px">
        <label class="input-label">Filter by Module</label>
        <select id="qb_module" class="input-field" title="Filter by module" aria-label="Filter by module" onchange="browseQuestions()">
          <option value="">All Modules</option>${mOpts}
        </select>
        <label class="input-label">Filter by Past Paper</label>
        <select id="qb_paper" class="input-field" title="Filter by past paper" aria-label="Filter by past paper" onchange="browseQuestions()">
          <option value="">All Past Papers</option>
        </select>
        <label class="input-label">Filter by Practice Test</label>
        <select id="qb_test" class="input-field" title="Filter by practice test" aria-label="Filter by practice test" onchange="browseQuestions()">
          <option value="">All Practice Tests</option>
        </select>
        <label class="input-label">Search</label>
        <input id="qb_search" class="input-field" placeholder="Search question text..." oninput="browseQuestionsDebounced()">
      </div>
      <div id="qBrowseList"></div>`;
    loadBrowseFilterOptions();
    browseQuestions();
  } else if (tab === 'bulk') {
    document.getElementById('qTabBody').innerHTML = `
      ${bulkStep1Html()}

      <div class="card" style="margin-bottom:20px;border:1.5px solid var(--gold-400)">
        <div class="fw-700 mb-2">🤖 Bulk Upload via AI-Generated Text (Claude / ChatGPT, Recommended)</div>
        <p class="text-sm mb-3">Copy the full Q&amp;A text from your Claude or ChatGPT chat and paste it below, or upload a <code>.md</code>/<code>.txt</code> file directly. No need to convert it to Excel first. The app will automatically pull out the question, options, correct answer, and explanation, and <b>the explanation's line-breaks/list formatting will stay exactly as it was in the original text</b>, nothing gets squeezed onto one line. The format is flexible: numbered questions, "Q1:", or "## Question 1" headings all work, and options can be "a)", "A.", "(A)", or bolded. No need to match one exact template.</p>
        <div class="text-xs text-muted mb-3">Typical format: a heading before each question (e.g. <code>## Q1: ...</code>), optionally <code>**Question:**</code>, then <code>a) ... b) ... c) ...</code> options, optionally <code>**Subject:**</code>, then <code>**Correct Answer: (x) ...**</code>, followed by the explanation.</div>
        <label class="input-label">Step A: Paste the text, or upload a .md/.txt file</label>
        <div class="upload-area" onclick="document.getElementById('qaiFile').click()">
          <div style="font-size:32px">📄</div>
          <div class="text-sm mt-1">Click to select a .md or .txt file</div>
        </div>
        <input type="file" id="qaiFile" accept=".md,.txt,text/markdown,text/plain" style="display:none" onchange="onAIQuestionFilePicked()">
        <div id="qaiFileSummary" class="text-xs text-muted mt-1 mb-2"></div>
        <textarea id="qai_text" class="input-field" rows="8" style="font-family:monospace;font-size:12px;white-space:pre" placeholder="...or paste the full Claude/ChatGPT text directly here"></textarea>
        <button class="btn btn-primary mt-3" onclick="previewAIQuestions()">🔍 Parse &amp; Preview</button>
        <div id="qaiPreview" style="margin-top:12px"></div>
        <button class="btn btn-primary mt-3" id="qaiUploadBtn" style="display:none" onclick="executeAIQuestionUpload()">Upload All Questions</button>
      </div>

      <div class="card" style="margin-bottom:20px;background:var(--surface-2,#f8f9fa);border:1px solid var(--border)">
        <div class="fw-700 mb-2">📖 How to do it, step by step (for the Excel method)</div>
        <ol style="padding-left:18px;font-size:13px;line-height:1.9;margin:0">
          <li><b>Download the template</b> (button below) and open it in Excel.</li>
          <li>Each row = one question. Add as many rows as you need.</li>
          <li>If a question <b>has a photo</b>, put just the image's <b>filename</b> in its <code>ImageURL</code> column, e.g. <code>q5.jpg</code> (no full link needed).</li>
          <li>If a question's <b>explanation has a photo</b>, put its filename in the <code>ExplanationImageURL</code> column, e.g. <code>q5_exp.jpg</code>.</li>
          <li>If a row has no photo, <b>leave that column blank</b>.</li>
          <li>Use the "🖼 select multiple images" button below to <b>select all the photos at once</b>, whichever row/column they belong to, all together.</li>
          <li>Upload the filled Excel file → a preview will appear → tap <b>"Upload All Questions"</b>. Done.</li>
        </ol>
        <div class="text-xs text-muted mt-2">⚠️ The filename must match exactly (whatever's written in Excel must match the photo you select). A spelling difference will cause that photo to be missed.</div>
      </div>
      <div class="card" style="margin-bottom:20px">
        <div class="fw-700 mb-2">📊 Bulk Upload via Excel / CSV</div>
        <p class="text-sm mb-3">Select Module/Subject/Paper/Test in Step 1 above. Best for uploading one subject/paper's worth of MCQs at once.</p>
        <label class="input-label mt-2">Step A: Select all image files (question + explanation photos, all together)</label>
        <div class="upload-area" onclick="document.getElementById('bulkImageFiles').click()">
          <div style="font-size:32px">🖼</div>
          <div class="text-sm mt-1">Click to select multiple images</div>
        </div>
        <input type="file" id="bulkImageFiles" accept="image/*" multiple style="display:none" onchange="onBulkImageFilesPicked()">
        <div id="bulkImageFilesSummary" class="text-xs text-muted mt-1"></div>
        <label class="input-label mt-2">Step B: Select the filled Excel/CSV file</label>
        <div class="upload-area" onclick="document.getElementById('bulkExcelFile').click()">
          <div style="font-size:32px">📊</div>
          <div class="text-sm mt-1">Click to select Excel (.xlsx) or CSV file</div>
        </div>
        <input type="file" id="bulkExcelFile" accept=".xlsx,.xls,.csv" style="display:none" onchange="previewBulkExcel()">
        <div id="bulkExcelPreview" style="margin-top:12px"></div>
        <button class="btn btn-primary mt-3" id="bulkExcelUploadBtn" style="display:none" onclick="executeBulkExcelUpload()">Upload All Questions</button>
        <hr class="divider">
        <div class="fw-700 mb-2">📥 Download Template</div>
        <p class="text-xs text-muted mb-2">The template already includes 3 example rows (one with an image, one with an explanation-image, one with no image); just look through them and it'll make sense. Columns: Question, OptionA-D (OptionE/F optional), CorrectAnswer (A/B/C/D), Explanation, ImageURL (filename only), ExplanationImageURL (filename only), Tags (comma-separated).</p>
        <button class="btn btn-secondary" onclick="downloadExcelTemplate()">Download CSV Template</button>
      </div>

      <div class="card">
        <div class="fw-700 mb-2">📂 Bulk Upload via JSON (advanced)</div>
        <p class="text-sm mb-3">Upload a JSON file with an array of questions. Each must have: <code>module_id, text, options (array), correct_answer (0-3), explanation</code></p>
        <div class="upload-area" onclick="document.getElementById('bulkFile').click()">
          <div style="font-size:32px">📄</div>
          <div class="text-sm mt-1">Click to select JSON file</div>
        </div>
        <input type="file" id="bulkFile" accept=".json" style="display:none" onchange="previewBulkJSON()">
        <div id="bulkPreview" style="margin-top:12px"></div>
        <button class="btn btn-primary mt-3" id="bulkUploadBtn" style="display:none" onclick="executeBulkUpload()">Upload All Questions</button>
        <hr class="divider">
        <div class="fw-700 mb-2">📥 Download Template</div>
        <button class="btn btn-secondary" onclick="downloadJSONTemplate()">Download JSON Template</button>
      </div>`;
    // populates the Past Paper dropdown right away — it no longer depends on a module
    // being picked first. Skipped while a Replace-All target is locked, since those
    // dropdowns aren't even rendered in that mode.
    if (!window._bulkLockedTarget) loadSubjectsForQX();
  }
}
window.qSubTab = qSubTab;



let bulkXData = [];


let bulkImageFileList = [];

 // raw File objects picked for this batch, matched to CSV rows by filename
function onBulkImageFilesPicked() {
  const files = document.getElementById('bulkImageFiles')?.files;
  bulkImageFileList = files ? Array.from(files) : [];
  const summary = document.getElementById('bulkImageFilesSummary');
  if (summary) summary.textContent = bulkImageFileList.length ? `${bulkImageFileList.length} image(s) selected` : '';
}
window.onBulkImageFilesPicked = onBulkImageFilesPicked;


async function loadSubjectsForQX() {
  const moduleId = document.getElementById('qx_module')?.value;
  const subSel = document.getElementById('qx_subject');
  const testSel = document.getElementById('qx_test');
  if (subSel) subSel.innerHTML = '<option value="">Any / Mixed</option>';
  if (testSel) testSel.innerHTML = '<option value="">Not part of a practice test</option>';

  // Past papers aren't tied to one module anymore (a real paper spans several
  // subjects) — the cascading Year → College → Paper picker loads independently
  // of whichever module is selected above.
  loadYearsForPaperPicker('qx');

  if (!moduleId) return;
  const { data: subs } = await db(sb.from('subjects').select('id,name').eq('module_id', moduleId).order('display_order'), 'Subs error');
  for (const s of subs || []) {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name;
    subSel?.appendChild(opt);
  }
  await loadTestsForQX();
}
window.loadSubjectsForQX = loadSubjectsForQX;



// Practice-test options for Bulk Upload depend on BOTH module and subject, same rule
// as loadTestsForQ() above: whole-module tests always show, this subject's own tests
// are added once a subject is picked.
async function loadTestsForQX() {
  const moduleId = document.getElementById('qx_module')?.value;
  const subjectId = document.getElementById('qx_subject')?.value || null;
  const testSel = document.getElementById('qx_test');
  if (!testSel) return;
  testSel.innerHTML = '<option value="">Not part of a practice test</option>';
  if (!moduleId) return;
  const { data: tests } = await db(sb.from('practice_tests').select('id,title,subject_id').eq('module_id', moduleId).order('display_order'), 'Tests error');
  for (const t of tests || []) {
    if (t.subject_id && (!subjectId || t.subject_id.toString() !== subjectId.toString())) continue;
    const opt = document.createElement('option');
    opt.value = t.id; opt.textContent = t.title + (t.subject_id ? '' : ' (Whole Module)');
    testSel.appendChild(opt);
  }
}
window.loadTestsForQX = loadTestsForQX;



function previewBulkExcel() {
  const file = document.getElementById('bulkExcelFile')?.files[0];
  if (!file) return;
  if (!resolveBulkTarget().ok) {
    showToast(resolveBulkTarget().errMsg);
    document.getElementById('bulkExcelFile').value = '';
    return;
  }
  // SECURITY FIX: reject oversized files/rows/cells before we ever parse or
  // upload them — an unbounded file can freeze the admin's tab while parsing,
  // and unbounded cell text would later get rendered on every student's screen.
  const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
  const MAX_ROWS = 2000;
  const MAX_TEXT_LEN = 5000;
  const MAX_OPTION_LEN = 1000;
  if (file.size > MAX_FILE_BYTES) {
    showToast('File is too large (max 10 MB). Please split it into smaller batches.');
    document.getElementById('bulkExcelFile').value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (rows.length > MAX_ROWS) throw new Error(`Too many rows (${rows.length}). Please upload at most ${MAX_ROWS} questions at a time.`);
      const letterToIdx = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };
      // Normalize header names (case/space-insensitive) so "Option A" or "optiona" both work
      const norm = (row, ...keys) => {
        for (const k of keys) {
          for (const rk of Object.keys(row)) {
            if (rk.replace(/[\s_]/g, '').toLowerCase() === k.replace(/[\s_]/g, '').toLowerCase()) return row[rk];
          }
        }
        return '';
      };
      bulkXData = rows.map(row => {
        const options = ['A','B','C','D','E','F']
          .map(L => String(norm(row, `Option${L}`)).trim().slice(0, MAX_OPTION_LEN))
          .filter(v => v !== '');
        const correctLetter = String(norm(row, 'CorrectAnswer', 'Answer')).trim().toUpperCase().charAt(0);
        return {
          text: String(norm(row, 'Question')).trim().slice(0, MAX_TEXT_LEN),
          options,
          correct_answer: letterToIdx[correctLetter] ?? 0,
          explanation: String(norm(row, 'Explanation')).trim().slice(0, MAX_TEXT_LEN),
          image_url: String(norm(row, 'ImageURL', 'Image')).trim() || null,
          explanation_image_url: String(norm(row, 'ExplanationImageURL', 'ExplanationImage')).trim() || null,
          tags: String(norm(row, 'Tags')).split(',').map(t => t.trim()).filter(Boolean)
        };
      }).filter(q => q.text && q.options.length >= 2);

      if (!bulkXData.length) throw new Error('No valid rows found. Check your column headers match the template');

      document.getElementById('bulkExcelPreview').innerHTML = `
        <div class="badge badge-green" style="margin-bottom:8px">${bulkXData.length} questions found</div>
        ${bulkXData.slice(0, 3).map((q, i) => `<div class="card" style="margin-bottom:6px;font-size:13px"><strong>Q${i+1}:</strong> ${esc(q.text.substring(0, 80))}${q.text.length > 80 ? '...' : ''}</div>`).join('')}
        ${bulkXData.length > 3 ? `<div class="text-xs text-muted">...and ${bulkXData.length - 3} more</div>` : ''}`;
      document.getElementById('bulkExcelUploadBtn').style.display = 'block';
    } catch (err) {
      document.getElementById('bulkExcelPreview').innerHTML = `<div class="badge badge-red">❌ ${esc(err.message)}</div>`;
      bulkXData = [];
    }
  };
  reader.readAsArrayBuffer(file);
}
window.previewBulkExcel = previewBulkExcel;



async function executeBulkExcelUpload() {
  if (!bulkXData.length) return;
  const target = resolveBulkTarget();
  if (!target.ok) return showToast(target.errMsg);
  const targetLabel = resolveBulkTargetLabel();
  showConfirm(`Add these <b>${bulkXData.length}</b> questions to:<br><b>${targetLabel}</b>?<br><small>Double-check this is right before continuing — it's the #1 way questions end up somewhere unexpected.</small>`, async () => {
    await _doExecuteBulkExcelUpload(target, targetLabel);
  }, 'Yes, Upload');
}
window.executeBulkExcelUpload = executeBulkExcelUpload;


async function _doExecuteBulkExcelUpload(target, targetLabel) {
  const { module_id: moduleId, subject_id: subjectId, paper_id: paperId, practice_test_id: testId } = target;

  // Step 1: upload every picked image file once, keyed by its exact filename
  // (case-insensitive) so multiple rows/columns can point at the same file.
  const fileUrlMap = {};
  if (bulkImageFileList.length) {
    showLoading(true, `Uploading ${bulkImageFileList.length} image(s)...`);
    for (let i = 0; i < bulkImageFileList.length; i++) {
      const file = bulkImageFileList[i];
      showLoading(true, `Uploading image ${i + 1} of ${bulkImageFileList.length}...`);
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `bulk/${Date.now()}_${i}_${safeName}`;
      const { error } = await sb.storage.from('question-images').upload(path, file, { upsert: true, contentType: file.type || 'image/jpeg' });
      if (!error) {
        const { data: urlData } = sb.storage.from('question-images').getPublicUrl(path);
        fileUrlMap[file.name.trim().toLowerCase()] = urlData.publicUrl;
      }
    }
  }
  const resolveImage = (ref) => {
    if (!ref) return null;
    if (/^https?:\/\//i.test(ref)) return ref; // already a full link
    return fileUrlMap[ref.trim().toLowerCase()] || null;
  };

  if (!(await _maybeReplaceExisting())) return;

  showLoading(true, `Uploading ${bulkXData.length} questions...`);
  let success = 0, failed = 0, imagesMissing = 0, firstErr = '';
  for (const q of bulkXData) {
    const image_url = resolveImage(q.image_url);
    const explanation_image_url = resolveImage(q.explanation_image_url);
    if ((q.image_url && !image_url) || (q.explanation_image_url && !explanation_image_url)) imagesMissing++;
    const { error } = await sb.from('questions').insert({
      module_id: moduleId, subject_id: subjectId, paper_id: paperId, practice_test_id: testId,
      text: q.text, options: q.options, correct_answer: q.correct_answer,
      explanation: q.explanation || '', image_url,
      explanation_image_url, tags: q.tags || []
    });
    if (error) {
      failed++;
      console.error('Bulk question insert failed:', error);
      if (!firstErr) firstErr = [error.message, error.hint, error.details].filter(Boolean).join(' · ');
    } else success++;
  }
  showLoading(false);
  showToast(`✅ ${success} added to ${targetLabel}${failed ? `, ❌ ${failed} failed: ${firstErr}` : ''}${imagesMissing ? `, ⚠️ ${imagesMissing} image(s) not matched` : ''}`, failed ? 12000 : 3000);
  logAdminAction(`Bulk uploaded ${success} questions via Excel/CSV`);
  bulkXData = [];
  bulkImageFileList = [];
  if (_afterLockedBulkUpload()) return;
  const imgInput = document.getElementById('bulkImageFiles'); if (imgInput) imgInput.value = '';
  const imgSummary = document.getElementById('bulkImageFilesSummary'); if (imgSummary) imgSummary.textContent = '';
  document.getElementById('bulkExcelUploadBtn').style.display = 'none';
  document.getElementById('bulkExcelPreview').innerHTML = '';
}



function downloadExcelTemplate() {
  const headers = ['Question','OptionA','OptionB','OptionC','OptionD','OptionE','CorrectAnswer','Explanation','ImageURL','ExplanationImageURL','Tags'];
  const example1 = ['Which nerve innervates the deltoid muscle?','Radial nerve','Axillary nerve','Musculocutaneous nerve','Ulnar nerve','','B','The axillary nerve (C5,C6) innervates the deltoid and teres minor.','','','anatomy, upper limb'];
  const example2 = ['Identify the structure labeled X in the image','Median nerve','Ulnar nerve','Radial nerve','Axillary nerve','','A','See how ImageURL below has a FILE NAME, not a link. Select that same file when uploading.','q2_question.jpg','','anatomy, upper limb'];
  const example3 = ['A patient presents with wrist drop. Which nerve is most likely injured?','Median nerve','Ulnar nerve','Radial nerve','Musculocutaneous nerve','','C','See how ExplanationImageURL below has a FILE NAME. This image will show under the explanation, not the question.','','q3_explanation.jpg','neurology'];
  const csv = [headers, example1, example2, example3].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lumhsian_questions_template.csv';
  a.click();
}
window.downloadExcelTemplate = downloadExcelTemplate;



// ==================== BULK UPLOAD VIA AI-GENERATED TEXT (Claude/ChatGPT) ====================
// Lets the admin paste or upload the raw Q&A text an AI chat produces — no Excel step in
// between — and parses question/options/correct-answer/explanation straight out of it.
// The one thing this MUST get right (this is the whole point of this feature): explanation
// text keeps every line break exactly as written — paragraphs, "- " bullets, "1) 2)" lists,
// **bold** terms — nothing gets flattened onto one line or shown as literal asterisks.
// renderMd() (see near the top of this file) turns real \n's into <br> AND actually renders
// the markdown AI chats reply in (bold, bullets, numbered lists, code) into real formatting,
// so as long as this parser keeps the raw text intact, the rest of the app renders it properly
// with zero further changes.
let aiQuestionData = [];



function onAIQuestionFilePicked() {
  const file = document.getElementById('qaiFile')?.files[0];
  const summary = document.getElementById('qaiFileSummary');
  if (!file) return;
  const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB — same cap as the Excel/CSV path
  if (file.size > MAX_FILE_BYTES) {
    showToast('File is too large (max 10 MB). Please split it into smaller batches.');
    document.getElementById('qaiFile').value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const ta = document.getElementById('qai_text');
    if (ta) ta.value = e.target.result;
    if (summary) summary.textContent = `Loaded "${file.name}" (${(file.size / 1024).toFixed(1)} KB)`;
    previewAIQuestions(); // auto-preview immediately, same as picking an Excel/CSV file does
  };
  reader.onerror = () => showToast('Could not read that file');
  reader.readAsText(file);
}
window.onAIQuestionFilePicked = onAIQuestionFilePicked;



// Accepted shape is intentionally loose, because different AI chats (and the same chat on
// different days) format MCQs slightly differently. All of these are accepted:
//   ## Q1: <title, may be the full question itself>   <- 1-6 #'s, optional, "Q"/"Question" + digits
//   **Question:** <stem>                               <- optional; if missing, everything up to
//                                                          the first option line is used as the stem
//   a) option   A) option   A. option   (A) option   - A) option   **A)** option   <- any of these
//   ...
//   **Subject:** <free text>                <- optional
//   Correct Answer: (b) ...   /   Correct Option: B   /   Answer: b   /   Ans: B   <- any of these
//   <explanation — kept 100% verbatim (a leading "Explanation:" label is stripped if present),
//    this is the part that must never get flattened>
//   ---                                     <- optional separator before the next question
// Block boundaries are found by trying, in order: markdown headings ("## Q1"), inline numbering
// ("Q1)", "Question 2:"), then bare numbered lists ("1.", "2)"). If none of those appear anywhere,
// it falls back to splitting on "**Question:**" markers, and if even that's absent but the text
// still looks like a single MCQ (has option lines), the whole paste is treated as one question.
function findAIQuestionStarts(text) {
  const candidates = [
    /^[ \t]{0,3}#{1,6}[ \t]*Q(?:uestion)?\.?[ \t]*(\d+)\b[ \t:.\-]*/gim,
    /^[ \t]{0,3}\*{0,2}Q(?:uestion)?\.?[ \t]*(\d+)[.):]\*{0,2}[ \t:.\-]*/gim,
    /^[ \t]{0,3}\*{0,2}(\d+)[.)]\*{0,2}[ \t]+/gm,
  ];
  for (const re of candidates) {
    const matches = [...text.matchAll(re)];
    if (matches.length) return matches;
  }
  return [];
}



function parseAIQuestionFile(rawText) {
  const MAX_TEXT_LEN = 5000, MAX_OPTION_LEN = 1000, MAX_ROWS = 2000;
  let text = String(rawText || '').replace(/\r\n?/g, '\n');

  let matches = findAIQuestionStarts(text);
  let blocks = [];
  if (matches.length > 0) {
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index;
      const end = (i + 1 < matches.length) ? matches[i + 1].index : text.length;
      // Only the numbering/heading label itself is consumed here — if the question text was
      // written right on the same line (e.g. "## Q1: What is..."), it stays in `content` and
      // gets picked up below as the question stem.
      blocks.push({ num: matches[i][1], content: text.slice(start + matches[i][0].length, end) });
    }
  } else {
    // Fallback for text with no heading/numbering at all — split on "**Question:**" instead.
    const qMarkerRe = /\*{0,2}[ \t]*Question[ \t]*:[ \t]*\*{0,2}/gi;
    const qMatches = [...text.matchAll(qMarkerRe)];
    for (let i = 0; i < qMatches.length; i++) {
      const start = qMatches[i].index;
      const end = (i + 1 < qMatches.length) ? qMatches[i + 1].index : text.length;
      blocks.push({ num: String(i + 1), content: text.slice(start, end) });
    }
    // Last resort: no markers of any kind, but it still looks like one MCQ (has option lines) —
    // treat the entire paste as a single question rather than rejecting it outright.
    if (!blocks.length) {
      const hasOptionLine = /^[ \t]*(?:[-*•][ \t]*)?\*{0,2}\(?[A-Za-z][.):]\*{0,2}[ \t]+\S/m.test(text);
      if (hasOptionLine) blocks.push({ num: '1', content: text });
    }
  }

  if (!blocks.length) {
    return { questions: [], errors: [{ num: '-', reason: 'No question headings, "Question:" markers, or option lines (A, B, C...) found in this text.', raw: '' }] };
  }
  if (blocks.length > MAX_ROWS) {
    return { questions: [], errors: [{ num: '-', reason: `Too many questions (${blocks.length}). Please upload at most ${MAX_ROWS} at a time.`, raw: '' }] };
  }

  const questions = [], errors = [];
  for (const block of blocks) {
    const result = parseOneAIQuestionBlock(block.content, block.num, MAX_TEXT_LEN, MAX_OPTION_LEN);
    if (result.error) errors.push({ num: block.num, reason: result.error, raw: block.content.trim().slice(0, 300) });
    else questions.push(result.question);
  }
  return { questions, errors };
}



function parseOneAIQuestionBlock(content, num, MAX_TEXT_LEN, MAX_OPTION_LEN) {
  // "Question:" label is now optional — if it's missing, the question text is simply
  // everything from the start of this block up to the first option line (this is what makes
  // "## Q1: <the actual question>" work with no separate **Question:** line needed).
  const qMarkerRe = /\*{0,2}[ \t]*Question[ \t]*:[ \t]*\*{0,2}/i;
  const qMatch = qMarkerRe.exec(content);
  const afterQ = qMatch ? content.slice(qMatch.index + qMatch[0].length) : content;

  // Option lines: accepts "a)", "A.", "(A)", "- A)", "* A)", "**A)**" and combinations of these.
  const firstOptRe = /^[ \t]*(?:[-*•][ \t]*)?\*{0,2}\(?([A-Za-z])[.):]\*{0,2}[ \t]+(?=\S)/m;
  const firstOptMatch = firstOptRe.exec(afterQ);
  if (!firstOptMatch) return { error: 'No option lines (A), B), ...) found' };

  const questionText = afterQ.slice(0, firstOptMatch.index).replace(/[ \t]+$/gm, '').trim();
  if (!questionText) return { error: 'Empty question text' };

  // Options are bounded by whichever comes first: "Subject:" or the correct-answer line.
  const optsRegion = afterQ.slice(firstOptMatch.index);
  const subjectRe = /\*{0,2}[ \t]*Subject[ \t]*:[ \t]*\*{0,2}/i;
  const correctBoundRe = /Correct[ \t]*(?:Answer|Option|Choice)/i;
  const answerFallbackRe = /\*{0,2}[ \t]*(?:Answer|Ans|Key)[ \t]*:[ \t]*\*{0,2}/i;
  const subjBound = subjectRe.exec(optsRegion);
  const corrBound = correctBoundRe.exec(optsRegion) || answerFallbackRe.exec(optsRegion);
  let optsEnd = optsRegion.length;
  if (subjBound) optsEnd = Math.min(optsEnd, subjBound.index);
  if (corrBound) optsEnd = Math.min(optsEnd, corrBound.index);
  const optsBlockText = optsRegion.slice(0, optsEnd);

  const optLineRe = /^[ \t]*(?:[-*•][ \t]*)?\*{0,2}\(?([A-Za-z])[.):]\*{0,2}[ \t]+(.+?)[ \t]*$/gm;
  const options = [], letterIndex = {};
  let om;
  while ((om = optLineRe.exec(optsBlockText)) !== null) {
    const letter = om[1].toLowerCase();
    const optText = om[2].trim().replace(/\*{1,2}$/, '').trim(); // drop a trailing "**" if the whole line was bolded
    if (!optText || letterIndex.hasOwnProperty(letter)) continue;
    letterIndex[letter] = options.length;
    options.push(optText.slice(0, MAX_OPTION_LEN));
  }
  if (options.length < 2) return { error: `Only ${options.length} option(s) found` };

  // Correct-answer letter — tries "Correct Answer/Option/Choice: (x)" first, then falls back to
  // a bare "Answer:", "Ans:" or "Key:".
  let correctRe = /Correct[ \t]*(?:Answer|Option|Choice)[ \t]*:?[ \t]*\*{0,2}[ \t]*\(?[ \t]*([A-Za-z])[ \t]*\)?/i;
  let correctMatch = correctRe.exec(content);
  if (!correctMatch) {
    correctRe = /\b(?:Answer|Ans|Key)[ \t]*:?[ \t]*\*{0,2}[ \t]*\(?[ \t]*([A-Za-z])[ \t]*\)?/i;
    correctMatch = correctRe.exec(content);
  }
  if (!correctMatch) return { error: 'No "Correct Answer: (X)" found' };
  const correctLetter = correctMatch[1].toLowerCase();
  let correct_answer = letterIndex.hasOwnProperty(correctLetter) ? letterIndex[correctLetter] : -1;
  if (correct_answer === -1) {
    const alphaIdx = correctLetter.charCodeAt(0) - 97;
    if (alphaIdx >= 0 && alphaIdx < options.length) correct_answer = alphaIdx;
  }
  if (correct_answer === -1) return { error: `Correct answer letter "(${correctMatch[1]})" doesn't match any parsed option` };

  // Subject is optional metadata — kept as a tag so it's still searchable, never forced
  // into subject_id (that stays a single per-batch choice via the Step 1 picker above,
  // since a mixed past paper like a full module test legitimately spans many subjects).
  let subject = '';
  const subjFull = subjectRe.exec(content);
  if (subjFull) {
    const afterSubj = content.slice(subjFull.index + subjFull[0].length);
    const eol = afterSubj.indexOf('\n');
    subject = (eol === -1 ? afterSubj : afterSubj.slice(0, eol)).trim();
  }

  // Explanation = everything after the *whole* Correct-Answer line, up to the next standalone
  // "---" or the end of the block. A leading "Explanation:" label is stripped since the app
  // already shows it in its own labeled box. Only outer blank lines get trimmed — every internal
  // line break, blank-line paragraph gap, and "- " list item is left completely untouched.
  const correctLineEnd = content.indexOf('\n', correctMatch.index + correctMatch[0].length);
  let afterCorrectLine = correctLineEnd === -1 ? '' : content.slice(correctLineEnd + 1);
  const hrRe = /^[ \t]*-{3,}[ \t]*$/m;
  const hrMatch = hrRe.exec(afterCorrectLine);
  let explanation = hrMatch ? afterCorrectLine.slice(0, hrMatch.index) : afterCorrectLine;
  explanation = explanation.replace(/^[ \t\n]+/, ''); // drop leading blank lines so the label check below anchors correctly
  explanation = explanation.replace(/^\*{0,2}[ \t]*Explanation[ \t]*:?[ \t]*\*{0,2}[ \t]*\n?/i, '');
  explanation = explanation
    .replace(/[ \t]+$/gm, '')   // strip stray trailing spaces per line only
    .replace(/\n{3,}/g, '\n\n') // 3+ blank lines -> 1 blank line, never touches single \n's
    .trim()
    .slice(0, MAX_TEXT_LEN);

  return {
    question: {
      num, text: questionText.slice(0, MAX_TEXT_LEN), options, correct_answer, explanation,
      tags: subject ? [subject] : []
    }
  };
}



function previewAIQuestions() {
  const target = resolveBulkTarget();
  if (!target.ok) { showToast(target.errMsg); return; }
  const raw = document.getElementById('qai_text')?.value || '';
  if (!raw.trim()) { showToast('Paste some text or upload a file first'); return; }
  if (raw.length > 10 * 1024 * 1024) { showToast('Text is too large (max ~10 MB). Please split it into smaller batches.'); return; }

  const { questions, errors } = parseAIQuestionFile(raw);
  aiQuestionData = questions;

  const previewEl = document.getElementById('qaiPreview');
  const uploadBtn = document.getElementById('qaiUploadBtn');
  if (!questions.length) {
    previewEl.innerHTML = `<div class="badge badge-red">❌ ${esc(errors[0]?.reason || 'No questions could be parsed.')}</div>`;
    uploadBtn.style.display = 'none';
    return;
  }

  const sampleCards = questions.slice(0, 3).map(q => `
    <div class="card" style="margin-bottom:10px;font-size:13px">
      <div style="font-weight:700;margin-bottom:6px">Q${esc(q.num)}: ${esc(q.text)}</div>
      ${q.tags?.[0] ? `<div class="text-xs text-muted mb-2">🏷️ ${esc(q.tags[0])}</div>` : ''}
      <div style="margin-bottom:8px">${q.options.map((o, i) => `<div style="padding:2px 0${i === q.correct_answer ? ';color:var(--green);font-weight:700' : ''}">${String.fromCharCode(97 + i)}) ${esc(o)}${i === q.correct_answer ? ' ✓' : ''}</div>`).join('')}</div>
      <div class="exp-content" style="background:var(--gold-50);border-left:3px solid var(--gold-400);padding:8px 10px;border-radius:6px;font-size:12.5px">${q.explanation ? renderMd(q.explanation) : '<span style="color:var(--ink-4)">No explanation found</span>'}</div>
    </div>`).join('');

  previewEl.innerHTML = `
    <div class="badge badge-green" style="margin-bottom:8px">✅ ${questions.length} question(s) parsed successfully</div>
    ${errors.length ? `<div class="badge badge-red" style="margin-bottom:8px">⚠️ ${errors.length} skipped (couldn't parse)</div>
      <div class="text-xs text-muted" style="margin-bottom:10px">${errors.slice(0, 5).map(e => `Q${esc(e.num)}: ${esc(e.reason)}`).join('<br>')}${errors.length > 5 ? `<br>...and ${errors.length - 5} more` : ''}</div>` : ''}
    <div class="text-xs text-muted mb-2">The explanation formatting below is shown exactly as it will appear in the app:</div>
    ${sampleCards}
    ${questions.length > 3 ? `<div class="text-xs text-muted">...and ${questions.length - 3} more question(s) ready to upload</div>` : ''}`;
  uploadBtn.style.display = 'block';
}
window.previewAIQuestions = previewAIQuestions;



async function executeAIQuestionUpload() {
  if (!aiQuestionData.length) return;
  const target = resolveBulkTarget();
  if (!target.ok) return showToast(target.errMsg);
  const targetLabel = resolveBulkTargetLabel();
  showConfirm(`Add these <b>${aiQuestionData.length}</b> questions to:<br><b>${targetLabel}</b>?<br><small>Double-check this is right before continuing — it's the #1 way questions end up somewhere unexpected.</small>`, async () => {
    await _doExecuteAIQuestionUpload(target, targetLabel);
  }, 'Yes, Upload');
}
window.executeAIQuestionUpload = executeAIQuestionUpload;


async function _doExecuteAIQuestionUpload(target, targetLabel) {
  const { module_id: moduleId, subject_id: subjectId, paper_id: paperId, practice_test_id: testId } = target;
  if (!(await _maybeReplaceExisting())) return;

  showLoading(true, `Uploading ${aiQuestionData.length} questions...`);
  let success = 0, failed = 0, firstErr = '';
  for (const q of aiQuestionData) {
    const { error } = await sb.from('questions').insert({
      module_id: moduleId, subject_id: subjectId, paper_id: paperId, practice_test_id: testId,
      text: q.text, options: q.options, correct_answer: q.correct_answer,
      explanation: q.explanation || '', image_url: null, explanation_image_url: null,
      tags: q.tags || []
    });
    if (error) {
      failed++;
      console.error('AI-text question insert failed:', error);
      if (!firstErr) firstErr = [error.message, error.hint, error.details].filter(Boolean).join(' · ');
    } else success++;
  }
  showLoading(false);
  showToast(`✅ ${success} added to ${targetLabel}${failed ? `, ❌ ${failed} failed: ${firstErr}` : ''}`, failed ? 12000 : 3000);
  logAdminAction(`Bulk uploaded ${success} questions via AI-text import`);
  aiQuestionData = [];
  if (_afterLockedBulkUpload()) return;
  const taEl = document.getElementById('qai_text'); if (taEl) taEl.value = '';
  const fileEl = document.getElementById('qaiFile'); if (fileEl) fileEl.value = '';
  const summaryEl = document.getElementById('qaiFileSummary'); if (summaryEl) summaryEl.textContent = '';
  document.getElementById('qaiUploadBtn').style.display = 'none';
  document.getElementById('qaiPreview').innerHTML = '';
}



let bulkQData = [];


function previewBulkJSON() {
  const file = document.getElementById('bulkFile')?.files[0];
  if (!file) return;
  // SECURITY FIX: same oversized/malformed-data guards as the Excel/CSV path above.
  const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
  const MAX_ROWS = 2000;
  const MAX_TEXT_LEN = 5000;
  if (file.size > MAX_FILE_BYTES) {
    showToast('File is too large (max 10 MB). Please split it into smaller batches.');
    document.getElementById('bulkFile').value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      bulkQData = JSON.parse(e.target.result);
      if (!Array.isArray(bulkQData)) throw new Error('Must be an array');
      if (bulkQData.length > MAX_ROWS) throw new Error(`Too many rows (${bulkQData.length}). Please upload at most ${MAX_ROWS} questions at a time.`);
      bulkQData = bulkQData.map(q => ({
        ...q,
        text: String(q.text ?? '').slice(0, MAX_TEXT_LEN),
        explanation: q.explanation ? String(q.explanation).slice(0, MAX_TEXT_LEN) : q.explanation,
        options: Array.isArray(q.options) ? q.options.map(o => String(o ?? '').slice(0, 1000)) : q.options
      }));
      document.getElementById('bulkPreview').innerHTML = `
        <div class="badge badge-green" style="margin-bottom:8px">${bulkQData.length} questions found</div>
        ${bulkQData.slice(0, 3).map((q, i) => `<div class="card" style="margin-bottom:6px;font-size:13px"><strong>Q${i+1}:</strong> ${esc(q.text?.substring(0, 80))}...</div>`).join('')}
        ${bulkQData.length > 3 ? `<div class="text-xs text-muted">...and ${bulkQData.length - 3} more</div>` : ''}`;
      document.getElementById('bulkUploadBtn').style.display = 'block';
    } catch (err) { document.getElementById('bulkPreview').innerHTML = `<div class="badge badge-red">❌ Invalid JSON: ${esc(err.message)}</div>`; }
  };
  reader.readAsText(file);
}
window.previewBulkJSON = previewBulkJSON;



async function executeBulkUpload() {
  if (!bulkQData.length) return;
  const lock = window._bulkLockedTarget;
  const confirmMsg = lock
    ? `Add these <b>${bulkQData.length}</b> questions to:<br><b>${lock.type === 'paper' ? 'Past Paper' : 'Practice Test'} "${lock.title}"</b>?`
    : `Add these <b>${bulkQData.length}</b> questions?<br><small>Each row uses its own module_id/paper_id exactly as written in the JSON file (no shared target here) — double-check the file before continuing.</small>`;
  showConfirm(confirmMsg, async () => {
    await _doExecuteBulkUpload(lock);
  }, 'Yes, Upload');
}
window.executeBulkUpload = executeBulkUpload;


async function _doExecuteBulkUpload(lock) {
  if (!(await _maybeReplaceExisting())) return;
  showLoading(true, `Uploading ${bulkQData.length} questions...`);
  let success = 0, failed = 0, orphaned = 0, firstErr = '';
  for (const q of bulkQData) {
    // A locked Replace-All target overrides whatever parent each JSON row specifies —
    // the whole point of arriving here via "Replace All" is that every question in
    // this batch belongs to that one paper/test. Without a lock, each row keeps its
    // own module_id/subject_id/paper_id/practice_test_id as written (advanced/mixed-batch use).
    const parent = lock
      ? { module_id: null, subject_id: null, paper_id: lock.type === 'paper' ? lock.id : null, practice_test_id: lock.type === 'test' ? lock.id : null }
      : { module_id: q.module_id || null, subject_id: q.subject_id || null, paper_id: q.paper_id || null, practice_test_id: q.practice_test_id || null };
    // A question with none of these set still inserts "successfully" but then shows
    // up nowhere in the app — it just silently inflates the total question count.
    // Skip it here instead, with a reason, so that never happens invisibly again.
    if (!lock && !parent.module_id && !parent.paper_id) { orphaned++; continue; }
    const { error } = await sb.from('questions').insert({
      ...parent,
      text: q.text, options: q.options, correct_answer: q.correct_answer,
      explanation: q.explanation || '', image_url: q.image_url || null,
      explanation_image_url: q.explanation_image_url || null,
      difficulty: q.difficulty || 'medium', tags: q.tags || []
    });
    if (error) {
      failed++;
      console.error('Bulk question insert failed:', error);
      if (!firstErr) firstErr = [error.message, error.hint, error.details].filter(Boolean).join(' · ');
    } else success++;
  }
  showLoading(false);
  let msg = `✅ ${success} added`;
  if (failed) msg += `, ❌ ${failed} failed: ${firstErr}`;
  if (orphaned) msg += `. ⛔ ${orphaned} row${orphaned === 1 ? '' : 's'} skipped — no module_id or paper_id in the JSON, so ${orphaned === 1 ? 'it' : 'they'} would've shown up nowhere in the app`;
  showToast(msg, (failed || orphaned) ? 12000 : 3000);
  bulkQData = [];
  if (_afterLockedBulkUpload()) return;
}



function downloadJSONTemplate() {
  const template = [{
    module_id: 1, subject_id: null, paper_id: null, practice_test_id: null,
    text: "Which nerve innervates the deltoid muscle?",
    options: ["Radial nerve", "Axillary nerve", "Musculocutaneous nerve", "Ulnar nerve"],
    correct_answer: 1, explanation: "The axillary nerve (C5,C6) innervates the deltoid and teres minor.",
    tags: ["anatomy", "upper limb", "nerves"]
  }];
  const blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lumhsian_questions_template.json';
  a.click();
}
window.downloadJSONTemplate = downloadJSONTemplate;



let extraOptCount = 4;


function addExtraOption() {
  if (extraOptCount >= 6) return showToast('Max 6 options');
  const letters = ['E', 'F'];
  const idx = extraOptCount;
  const l = letters[idx - 4];
  const container = document.getElementById('q_opts_container');
  const div = document.createElement('div');
  div.className = 'input-group'; div.style.marginBottom = '8px';
  div.innerHTML = `<span style="width:28px;text-align:center;font-weight:700;flex-shrink:0;padding-top:14px">${l}</span><input id="q_opt_${idx}" class="input-field" placeholder="Option ${l}" style="margin:0">`;
  container.appendChild(div);
  const correctSel = document.getElementById('q_correct');
  const opt = document.createElement('option');
  opt.value = idx; opt.textContent = l;
  correctSel.appendChild(opt);
  extraOptCount++;
}
window.addExtraOption = addExtraOption;



async function loadSubjectsForQ() {
  const moduleId = document.getElementById('q_module')?.value;
  const subSel = document.getElementById('q_subject');
  if (!subSel) return;
  subSel.innerHTML = '<option value="">Any / Mixed</option>';
  if (!moduleId) return;
  const { data: subs } = await db(sb.from('subjects').select('id,name').eq('module_id', moduleId).order('display_order'), 'Subs error');
  for (const s of subs || []) {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name;
    subSel.appendChild(opt);
  }
}



// Renders a module's past papers as <optgroup> blocks by college (then by
// year, newest first) instead of a flat title-only list — mirrors the same
// College → Year structure students now browse, so picking the right paper
// stays easy even once a module has papers from several colleges/years.
function pastPapersOptgroupHtml(papers, selectedId, counts) {
  const byCollege = {};
  for (const p of (papers || [])) {
    const c = (p.college_name || '').trim() || 'No College Set';
    if (!byCollege[c]) byCollege[c] = [];
    byCollege[c].push(p);
  }
  const collegeNames = Object.keys(byCollege).sort((a, b) => {
    if (a === 'No College Set') return 1;
    if (b === 'No College Set') return -1;
    return a.localeCompare(b);
  });
  let html = '';
  for (const c of collegeNames) {
    const ps = byCollege[c].sort((a, b) => (b.paper_year || '').localeCompare(a.paper_year || '', undefined, { numeric: true }));
    html += `<optgroup label="${esc(c)}">`;
    for (const p of ps) {
      const yearPrefix = p.paper_year ? `${esc(p.paper_year)} — ` : '';
      const qCount = counts ? (counts[p.id] || 0) : null;
      const countSuffix = qCount !== null ? ` (${qCount} question${qCount === 1 ? '' : 's'} so far)` : '';
      html += `<option value="${p.id}" ${selectedId && p.id === selectedId ? 'selected' : ''}>${yearPrefix}${esc(p.title)} #${p.id}${countSuffix}</option>`;
    }
    html += `</optgroup>`;
  }
  return html;
}



// Populates the Academic Year dropdown for the cascading Year → College →
// Past Paper picker (Add Question uses prefix 'q', Bulk Upload uses 'qx').
async function loadYearsForPaperPicker(prefix) {
  const yearSel = document.getElementById(prefix + '_paper_year');
  if (!yearSel) return;
  const { data: years } = await db(sb.from('years').select('id,name').order('display_order'), 'Years error');
  yearSel.innerHTML = '<option value="" disabled selected>Select year...</option>' +
    (years || []).map(y => `<option value="${y.id}">${esc(y.name)}</option>`).join('');
}


// Populates the College dropdown once a Year is picked — only colleges that
// actually have at least one past paper for that year, so there's never a
// dead-end selection.
async function loadCollegesForPaperPicker(prefix) {
  const yearId = parseInt(document.getElementById(prefix + '_paper_year')?.value) || null;
  const collegeSel = document.getElementById(prefix + '_paper_college');
  const paperSel = document.getElementById(prefix + '_paper');
  if (collegeSel) collegeSel.innerHTML = '<option value="" disabled selected>Select college...</option>';
  if (paperSel) paperSel.innerHTML = '<option value="" disabled selected>Select college first</option>';
  if (!yearId || !collegeSel) return;
  const { data: papers } = await db(sb.from('past_papers').select('college_name').eq('year_id', yearId), 'Papers error');
  const collegeNames = [...new Set((papers || []).map(p => (p.college_name || '').trim()).filter(Boolean))].sort();
  collegeSel.innerHTML += collegeNames.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (!collegeNames.length) collegeSel.innerHTML = '<option value="" disabled selected>No colleges for this year yet</option>';
}


// Populates the actual Past Paper dropdown once both Year and College are
// picked — each option shows how many questions that paper already has, so
// it's obvious at a glance which papers still need content.
async function loadPapersForPaperPicker(prefix) {
  const yearId = parseInt(document.getElementById(prefix + '_paper_year')?.value) || null;
  const collegeName = document.getElementById(prefix + '_paper_college')?.value || null;
  const paperSel = document.getElementById(prefix + '_paper');
  if (!paperSel) return;
  paperSel.innerHTML = '<option value="" disabled selected>Select past paper...</option>';
  if (!yearId || !collegeName) return;
  const { data: papers } = await db(sb.from('past_papers').select('id,title').eq('year_id', yearId).eq('college_name', collegeName).order('display_order'), 'Papers error');
  const list = papers || [];
  const counts = await getQuestionCountsBy('paper_id', list.map(p => p.id));
  paperSel.innerHTML += list.map(p => `<option value="${p.id}">${esc(p.title)} #${p.id} (${counts[p.id] || 0} question${counts[p.id] === 1 ? '' : 's'} so far)</option>`).join('');
  if (!list.length) paperSel.innerHTML = '<option value="" disabled selected>No papers for this college/year yet</option>';
}
window.loadYearsForPaperPicker = loadYearsForPaperPicker;
window.loadCollegesForPaperPicker = loadCollegesForPaperPicker;
window.loadPapersForPaperPicker = loadPapersForPaperPicker;



// Practice-test options depend on BOTH module and subject: whole-module tests
// (subject_id null) always show, and the currently-picked subject's own tests are
// added on top — so switching Subject re-runs this to refresh what's relevant.
async function loadTestsForQ() {
  const moduleId = document.getElementById('q_module')?.value;
  const subjectId = document.getElementById('q_subject')?.value || null;
  const testSel = document.getElementById('q_test');
  if (!testSel) return;
  testSel.innerHTML = '<option value="">Not part of a practice test</option>';
  if (!moduleId) return;
  const { data: tests } = await db(sb.from('practice_tests').select('id,title,subject_id').eq('module_id', moduleId).order('display_order'), 'Tests error');
  for (const t of tests || []) {
    if (t.subject_id && (!subjectId || t.subject_id.toString() !== subjectId.toString())) continue;
    const opt = document.createElement('option');
    opt.value = t.id; opt.textContent = t.title + (t.subject_id ? '' : ' (Whole Module)');
    testSel.appendChild(opt);
  }
}
window.loadTestsForQ = loadTestsForQ;



async function onQModuleChange() {
  // Reset subject/test selections immediately so stale values can't persist
  const subSel = document.getElementById('q_subject');
  const testSel = document.getElementById('q_test');
  if (subSel) subSel.value = '';
  if (testSel) testSel.value = '';
  await Promise.all([loadSubjectsForQ(), loadTestsForQ()]);
}
window.onQModuleChange = onQModuleChange;



async function adminAddQuestion() {
  // Only read the fields belonging to whichever mode is active — the other mode's
  // dropdown is hidden but still exists in the DOM with whatever it was last left at,
  // so it must never be trusted here even if a value happens to linger in it.
  const qMode = window._qMode === 'paper' ? 'paper' : 'module';
  const module_id = qMode === 'module' ? (document.getElementById('q_module')?.value || null) : null;
  const subject_id = qMode === 'module' ? (document.getElementById('q_subject')?.value || null) : null;
  const paper_id = qMode === 'paper' ? (document.getElementById('q_paper')?.value || null) : null;
  const practice_test_id = qMode === 'module' ? (document.getElementById('q_test')?.value || null) : null;
  const text = document.getElementById('q_text')?.value.trim();
  const correct_answer = parseInt(document.getElementById('q_correct')?.value);
  const explanation = document.getElementById('q_exp')?.value.trim();
  const image_url = document.getElementById('q_img_url')?.value.trim() || null;
  const explanation_image_url = document.getElementById('q_exp_img_url')?.value.trim() || null;
  const difficulty = document.getElementById('q_diff')?.value || 'medium';
  const tagsRaw = document.getElementById('q_tags')?.value || '';
  const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);

  const options = [];
  for (let i = 0; i < extraOptCount; i++) {
    const val = document.getElementById(`q_opt_${i}`)?.value.trim();
    if (val) options.push(val);
  }

  if (qMode === 'module' && !module_id) return showToast('Select a Module first (Step 1 above)');
  if (qMode === 'paper' && !paper_id) return showToast('Select a Past Paper first (Step 1 above)');
  if (!text || options.length < 2) return showToast('Question text and at least 2 options required');
  if (correct_answer >= options.length) return showToast('Correct answer index out of range');

  await db(sb.from('questions').insert({ module_id, subject_id, paper_id, practice_test_id, text, options, correct_answer, explanation, image_url, explanation_image_url, difficulty, tags }), 'Add question failed');
  showToast('Question added ✓');
  // Reset only the question-specific fields — keep Module/Subject/Test/Past Paper selected
  // so admins can rapid-fire add many questions to the same paper without re-selecting each time
  ['q_text','q_exp','q_img_url','q_exp_img_url','q_tags'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  ['q_img_preview','q_exp_img_preview'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  for (let i = 0; i < 4; i++) { const el = document.getElementById(`q_opt_${i}`); if (el) el.value = ''; }
  resetExtraOptions();
}
window.adminAddQuestion = adminAddQuestion;



// Removes any 5th/6th option fields and their correct-answer entries,
// returning the Add Question form to a clean 4-option state.
function resetExtraOptions() {
  for (let i = 4; i < 6; i++) document.getElementById(`q_opt_${i}`)?.closest('.input-group')?.remove();
  const correctSel = document.getElementById('q_correct');
  if (correctSel) [...correctSel.options].forEach(o => { if (parseInt(o.value) >= 4) o.remove(); });
  extraOptCount = 4;
}



const QB_PAGE_SIZE = 50;


let _qbPage = 0;


// Populates the Past Paper / Practice Test filter dropdowns in Browse & Edit — separate
// from the Module filter since a question can be filed under either one instead.
async function loadBrowseFilterOptions() {
  const papSel = document.getElementById('qb_paper');
  const testSel = document.getElementById('qb_test');
  const [{ data: papers }, { data: tests }] = await Promise.all([
    db(sb.from('past_papers').select('id,title,college_name,paper_year').order('display_order'), 'Papers error'),
    db(sb.from('practice_tests').select('id,title,subjects(name)').order('display_order'), 'Tests error')
  ]);
  if (papSel) papSel.innerHTML = '<option value="">All Past Papers</option>' + pastPapersOptgroupHtml(papers, null, null);
  if (testSel) testSel.innerHTML = '<option value="">All Practice Tests</option>' +
    (tests || []).map(t => `<option value="${t.id}">${esc(t.title)}${t.subjects?.name ? ` (${esc(t.subjects.name)})` : ''}</option>`).join('');
}
window.loadBrowseFilterOptions = loadBrowseFilterOptions;



async function browseQuestions(page) {
  _qbPage = (typeof page === 'number') ? page : 0;
  const moduleId = document.getElementById('qb_module')?.value || '';
  const paperId = document.getElementById('qb_paper')?.value || '';
  const testId = document.getElementById('qb_test')?.value || '';
  const search = document.getElementById('qb_search')?.value.trim() || '';
  const list = document.getElementById('qBrowseList');
  if (!list) return;
  list.innerHTML = `<div class="spinner" style="margin:20px auto"></div>`;
  window._qbSelected = new Set(); // reset selection — the list below is rebuilt fresh
  const from = _qbPage * QB_PAGE_SIZE;
  const to = from + QB_PAGE_SIZE - 1;
  let query = sb.from('questions').select('id,text,correct_answer,options,difficulty,module_id,paper_id,practice_test_id,modules(name),past_papers(title,college_name,paper_year),practice_tests(title)', { count: 'exact' }).order('id', { ascending: false }).range(from, to);
  if (moduleId) query = query.eq('module_id', moduleId);
  if (paperId) query = query.eq('paper_id', paperId);
  if (testId) query = query.eq('practice_test_id', testId);
  if (search) query = query.ilike('text', `%${search}%`);
  const { data: qs, count, error } = await db(query, 'Browse failed');
  if (error) { list.innerHTML = '<div class="card"><p class="text-muted">Couldn\'t load questions. Pull down or retry.</p></div>'; return; }
  if (!qs?.length) { list.innerHTML = `<div class="card"><p class="text-muted">${_qbPage > 0 ? 'No more questions.' : 'No questions found.'}</p></div>`; return; }
  const totalPages = count ? Math.max(1, Math.ceil(count / QB_PAGE_SIZE)) : 1;
  list.innerHTML = `
    <div class="flex-between" style="background:var(--surface-3);border:1px solid var(--border);border-radius:var(--radius-md);padding:9px 12px;margin-bottom:10px">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:600;color:var(--ink-3)">
        <input type="checkbox" id="_qbSelectAll" onchange="_qbToggleSelectAll(this.checked)" style="width:17px;height:17px;accent-color:var(--gold-600)">
        Select all on this page
      </label>
      <button class="btn btn-danger btn-xs" id="_qbDeleteBtn" style="width:auto;opacity:.45;pointer-events:none" onclick="adminDeleteSelectedQuestions()" disabled>🗑 Delete Selected</button>
      <button class="btn btn-secondary btn-xs" id="_qbMoveBtn" style="width:auto;opacity:.45;pointer-events:none" onclick="openMoveSelectedModal()" disabled>🔀 Move Selected</button>
    </div>` +
    qs.map(q => {
      const paperBits = [q.past_papers?.college_name, q.past_papers?.paper_year].filter(Boolean).map(esc);
      const paperTag = q.past_papers?.title ? ` · 📜 ${paperBits.length ? paperBits.join(' ') + ' — ' : ''}${esc(q.past_papers.title)}` : '';
      return `
    <div class="admin-row">
      <input type="checkbox" class="qb-select" data-id="${q.id}" onchange="_qbSelectionChanged()" style="width:17px;height:17px;accent-color:var(--gold-600);flex-shrink:0;align-self:flex-start;margin-top:2px">
      <div class="admin-row-left">
        <div class="text-xs text-muted mb-1">${esc(q.modules?.name) || 'Unknown'} · <span class="badge badge-${q.difficulty==='easy'?'green':q.difficulty==='hard'?'red':'teal'}">${esc(q.difficulty)||'medium'}</span>${paperTag}${q.practice_tests?.title ? ` · 🎯 ${esc(q.practice_tests.title)}` : ''}</div>
        <div class="text-sm fw-600">${esc(q.text?.substring(0, 100))}${q.text?.length > 100 ? '...' : ''}</div>
        <div class="text-xs text-muted mt-1">✅ ${['A','B','C','D','E','F'][q.correct_answer] || '?'}: ${esc(q.options?.[q.correct_answer]) || '?'}</div>
      </div>
      <div class="admin-row-actions">
        <button class="btn btn-secondary btn-xs" onclick="adminEditQuestion(${q.id})">✏️ Edit</button>
        <button class="btn btn-danger btn-xs" onclick="adminDeleteQuestion(${q.id})">🗑</button>
      </div>
    </div>`;
    }).join('') + (totalPages > 1 ? `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px">
      <button class="btn btn-secondary btn-sm" style="width:auto" ${_qbPage===0?'disabled':''} onclick="browseQuestions(${_qbPage-1})">← Prev</button>
      <span class="text-xs text-muted">Page ${_qbPage+1} of ${totalPages} (${count} total)</span>
      <button class="btn btn-secondary btn-sm" style="width:auto" ${_qbPage+1>=totalPages?'disabled':''} onclick="browseQuestions(${_qbPage+1})">Next →</button>
    </div>` : '');
}
window.browseQuestions = browseQuestions;


function _qbSelectionChanged() {
  const ids = [...document.querySelectorAll('.qb-select:checked')].map(cb => parseInt(cb.dataset.id));
  window._qbSelected = new Set(ids);
  const btn = document.getElementById('_qbDeleteBtn');
  if (btn) {
    const n = window._qbSelected.size;
    btn.textContent = n ? `🗑 Delete Selected (${n})` : '🗑 Delete Selected';
    btn.disabled = n === 0;
    btn.style.opacity = n ? '1' : '.45';
    btn.style.pointerEvents = n ? 'auto' : 'none';
  }
  const moveBtn = document.getElementById('_qbMoveBtn');
  if (moveBtn) {
    const n = window._qbSelected.size;
    moveBtn.textContent = n ? `🔀 Move Selected (${n})` : '🔀 Move Selected';
    moveBtn.disabled = n === 0;
    moveBtn.style.opacity = n ? '1' : '.45';
    moveBtn.style.pointerEvents = n ? 'auto' : 'none';
  }
  const allBoxes = document.querySelectorAll('.qb-select');
  const allCb = document.getElementById('_qbSelectAll');
  if (allCb) allCb.checked = allBoxes.length > 0 && window._qbSelected.size === allBoxes.length;
}
window._qbSelectionChanged = _qbSelectionChanged;


function _qbToggleSelectAll(checked) {
  document.querySelectorAll('.qb-select').forEach(cb => { cb.checked = checked; });
  _qbSelectionChanged();
}
window._qbToggleSelectAll = _qbToggleSelectAll;


async function adminDeleteSelectedQuestions() {
  const ids = [...(window._qbSelected || [])];
  if (!ids.length) return showToast('Select at least one question first');
  showConfirm(`Delete ${ids.length} selected question${ids.length > 1 ? 's' : ''}? This can't be undone.`, async () => {
    await db(sb.from('questions').delete().in('id', ids), 'Bulk delete failed');
    showToast(`Deleted ${ids.length} question${ids.length > 1 ? 's' : ''} ✓`);
    browseQuestions(_qbPage);
  }, `Delete ${ids.length}`, true);
}
window.adminDeleteSelectedQuestions = adminDeleteSelectedQuestions;


// Recovers questions that already landed under the wrong parent (e.g. uploaded
// to a Module when they were meant for a Past Paper) — select them in the list
// above with the checkboxes, then move all of them to the correct destination
// in one action instead of opening each one individually in Edit Question.
window._mvMode = window._mvMode || 'module';

async function openMoveSelectedModal() {
  const ids = [...(window._qbSelected || [])];
  if (!ids.length) return showToast('Select at least one question first');
  const [{ data: modules }] = await Promise.all([db(sb.from('modules').select('id,name').order('name'), 'Modules error')]);
  const mOpts = (modules || []).map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:420px;max-height:90vh;overflow-y:auto">
      <div class="fw-700 mb-3">🔀 Move ${ids.length} Question${ids.length > 1 ? 's' : ''}</div>
      ${qModePaperToggleHtml('mv')}
      <div id="mv_moduleFields" style="display:${window._mvMode==='paper'?'none':'block'}">
        <label class="input-label">Move to Module</label>
        <select id="mv_module" class="input-field" title="Select module" aria-label="Select module">
          <option value="" disabled selected>Select module...</option>${mOpts}
        </select>
      </div>
      <div id="mv_paperFields" style="display:${window._mvMode==='paper'?'block':'none'}">
        <label class="input-label">Move to Past Paper</label>
        <select id="mv_paper" class="input-field" title="Select past paper" aria-label="Select past paper">
          <option value="" disabled selected>Select past paper...</option>
        </select>
      </div>
      <p class="text-xs text-muted mt-2">This replaces whatever module/paper/test each selected question currently has — it doesn't add a second tag.</p>
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="executeMoveSelected(this)">Move</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const { data: papers } = await db(sb.from('past_papers').select('id,title,college_name,paper_year').order('display_order'), 'Papers error');
  const papSel = document.getElementById('mv_paper');
  if (papSel) papSel.innerHTML += pastPapersOptgroupHtml(papers, null, null);
}
window.openMoveSelectedModal = openMoveSelectedModal;


async function executeMoveSelected(btnEl) {
  try {
    const ids = [...(window._qbSelected || [])];
    if (!ids.length) return;
    const mode = window._mvMode === 'paper' ? 'paper' : 'module';
    let update;
    if (mode === 'paper') {
      const paper_id = parseInt(document.getElementById('mv_paper').value) || null;
      if (!paper_id) { showToast('Select a Past Paper first'); return; }
      update = { module_id: null, subject_id: null, practice_test_id: null, paper_id };
    } else {
      const module_id = parseInt(document.getElementById('mv_module').value) || null;
      if (!module_id) { showToast('Select a Module first'); return; }
      update = { module_id, subject_id: null, practice_test_id: null, paper_id: null };
    }
    const { error } = await db(sb.from('questions').update(update).in('id', ids), 'Move failed');
    if (error) return;
    showToast(`Moved ${ids.length} question${ids.length > 1 ? 's' : ''} ✓`);
    btnEl.closest('[style*=fixed]').remove();
    browseQuestions(_qbPage);
  } catch (err) {
    console.error('Move selected failed:', err);
    showToast('Unexpected error: ' + err.message, 9000);
  }
}
window.executeMoveSelected = executeMoveSelected;


// 350ms after the last keystroke — used by the search box's oninput handler
// above so typing doesn't fire a Supabase query on every character.
const browseQuestionsDebounced = _debounce(() => browseQuestions(0), 350);
window.browseQuestionsDebounced = browseQuestionsDebounced;



async function adminEditQuestion(id) {
  const { data: q } = await db(sb.from('questions').select('*').eq('id', id).single(), 'Load failed');
  if (!q) return;
  const [subsRes, papersRes, testsRes] = await Promise.all([
    db(sb.from('subjects').select('id,name').eq('module_id', q.module_id).order('display_order'), 'Subs error'),
    db(sb.from('past_papers').select('id,title,college_name,paper_year').order('display_order'), 'Papers error'),
    db(sb.from('practice_tests').select('id,title,subject_id').eq('module_id', q.module_id).order('display_order'), 'Tests error')
  ]);
  const subs = subsRes.data || [], papers = papersRes.data || [];
  const paperQCounts = await getQuestionCountsBy('paper_id', papers.map(p => p.id));
  window._eqAllTests = testsRes.data || []; // held for _eqRefreshTestOptions() below while this modal is open
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:460px;max-height:90vh;overflow-y:auto">
      <div class="fw-700 mb-3">✏️ Edit Question</div>
      <label class="input-label">Question Text</label>
      <textarea id="_eq_text" class="input-field" rows="4" style="resize:vertical">${esc(q.text)}</textarea>
      <label class="input-label">Subject</label>
      <select id="_eq_subject" class="input-field" title="Subject" aria-label="Subject" onchange="_eqRefreshTestOptions(this.value)">
        <option value="">Any / Mixed</option>
        ${subs.map(s=>`<option value="${s.id}" ${s.id===q.subject_id?'selected':''}>${esc(s.name)}</option>`).join('')}
      </select>
      <label class="input-label">Practice Test</label>
      <select id="_eq_test" class="input-field" title="Practice test" aria-label="Practice test">
        ${_eqTestOptionsHtml(window._eqAllTests, q.subject_id, q.practice_test_id)}
      </select>
      <label class="input-label">Past Paper</label>
      <select id="_eq_paper" class="input-field" title="Past paper" aria-label="Past paper">
        <option value="">Not part of a past paper</option>
        ${pastPapersOptgroupHtml(papers, q.paper_id, paperQCounts)}
      </select>
      <label class="input-label">Explanation</label>
      <textarea id="_eq_exp" class="input-field" rows="3" placeholder="Explanation (optional)" style="resize:vertical">${esc(q.explanation)}</textarea>
      <label class="input-label">Question Image (optional)</label>
      <div class="upload-area" onclick="document.getElementById('_eq_img_file').click()">📸 ${q.image_url ? 'Replace image' : 'Upload question image'}</div>
      <input type="file" id="_eq_img_file" accept="image/*" style="display:none" onchange="previewAndUpload('_eq_img_file','_eq_img_url','_eq_img_preview')">
      <img id="_eq_img_preview" src="${esc(q.image_url)}" style="display:${q.image_url?'block':'none'};max-width:100%;border-radius:var(--radius-lg);margin:8px 0">
      <input id="_eq_img_url" class="input-field" value="${esc(q.image_url)}" placeholder="Question image URL" readonly>
      ${q.image_url ? `<button class="btn btn-ghost btn-xs" onclick="document.getElementById('_eq_img_url').value='';document.getElementById('_eq_img_preview').style.display='none'">🗑 Remove image</button>` : ''}
      <label class="input-label mt-2">Explanation Image (optional)</label>
      <div class="upload-area" onclick="document.getElementById('_eq_exp_img_file').click()">📸 ${q.explanation_image_url ? 'Replace image' : 'Upload explanation image'}</div>
      <input type="file" id="_eq_exp_img_file" accept="image/*" style="display:none" onchange="previewAndUpload('_eq_exp_img_file','_eq_exp_img_url','_eq_exp_img_preview')">
      <img id="_eq_exp_img_preview" src="${esc(q.explanation_image_url)}" style="display:${q.explanation_image_url?'block':'none'};max-width:100%;border-radius:var(--radius-lg);margin:8px 0">
      <input id="_eq_exp_img_url" class="input-field" value="${esc(q.explanation_image_url)}" placeholder="Explanation image URL" readonly>
      ${q.explanation_image_url ? `<button class="btn btn-ghost btn-xs" onclick="document.getElementById('_eq_exp_img_url').value='';document.getElementById('_eq_exp_img_preview').style.display='none'">🗑 Remove image</button>` : ''}
      <label class="input-label mt-2">Correct Answer</label>
      <select id="_eq_correct" class="input-field" title="Correct answer" aria-label="Correct answer">
        ${['A','B','C','D','E','F'].slice(0,(q.options||[]).length).map((l,i)=>`<option value="${i}" ${i===q.correct_answer?'selected':''}>${l}: ${esc((q.options||[])[i])}</option>`).join('')}
      </select>
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="saveEditedQuestion(${id}, this)">Save Changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.adminEditQuestion = adminEditQuestion;


// See saveEditedYear (near adminEditYear) for why this can't be an inline onclick
// IIFE. This one matters most of all seven — this is the screen used to manually
// fix a question that landed under the wrong module/paper/test, and it was
// silently failing to save every single time, for every question, ever.
async function saveEditedQuestion(id, btnEl) {
  try {
    const t = document.getElementById('_eq_text').value.trim();
    const e = document.getElementById('_eq_exp').value.trim();
    const c = parseInt(document.getElementById('_eq_correct').value);
    const subj = document.getElementById('_eq_subject').value || null;
    const test = document.getElementById('_eq_test').value || null;
    const pap = document.getElementById('_eq_paper').value || null;
    const img = document.getElementById('_eq_img_url').value.trim() || null;
    const expImg = document.getElementById('_eq_exp_img_url').value.trim() || null;
    if (!t) { showToast('Question text required'); return; }
    const { error } = await db(sb.from('questions').update({ text: t, explanation: e || null, correct_answer: c, subject_id: subj, practice_test_id: test, paper_id: pap, image_url: img, explanation_image_url: expImg }).eq('id', id), 'Edit failed');
    if (error) return;
    showToast('Question updated ✓');
    btnEl.closest('[style*=fixed]').remove();
    browseQuestions(_qbPage);
  } catch (err) {
    console.error('Edit question failed:', err);
    showToast('Unexpected error: ' + err.message, 9000);
  }
}
window.saveEditedQuestion = saveEditedQuestion;



// Builds the Practice Test <option> list for the Edit Question modal — whole-module
// tests always included, plus the given subject's own tests. Shared by the initial
// render and by _eqRefreshTestOptions() when Subject is changed inside the modal.
function _eqTestOptionsHtml(allTests, subjectId, selectedTestId) {
  const opts = ['<option value="">Not part of a practice test</option>'];
  for (const t of allTests || []) {
    if (t.subject_id && (!subjectId || t.subject_id.toString() !== subjectId.toString())) continue;
    opts.push(`<option value="${t.id}" ${t.id===selectedTestId?'selected':''}>${t.title}${t.subject_id ? '' : ' (Whole Module)'}</option>`);
  }
  return opts.join('');
}



function _eqRefreshTestOptions(subjectId) {
  const testSel = document.getElementById('_eq_test');
  if (testSel) testSel.innerHTML = _eqTestOptionsHtml(window._eqAllTests, subjectId || null, null);
}
window._eqRefreshTestOptions = _eqRefreshTestOptions;



async function adminDeleteQuestion(id) {
  showConfirm('Delete this question? This cannot be undone.', async () => {
    await db(sb.from('questions').delete().eq('id', id), 'Delete failed');
    showToast('Question deleted'); browseQuestions(_qbPage);
  }, 'Delete');
}
window.adminDeleteQuestion = adminDeleteQuestion;



// ==================== ANNOUNCEMENTS TAB ====================
// ==================== ADMIN: REPORTS & FEEDBACK ====================
const REPORTS_PAGE_SIZE = 30;


let _rfPage = 0;


async function adminReports(filter = 'all', token = window._adminRenderToken, page) {
  _rfPage = (typeof page === 'number') ? page : 0;
  const content = document.getElementById('adminContent');
  content.innerHTML = `<div class="spinner" style="margin:40px auto"></div>`;
  window._rfSelected = new Set(); // reset selection — the list below is rebuilt fresh
  const from = _rfPage * REPORTS_PAGE_SIZE;
  const to = from + REPORTS_PAGE_SIZE - 1;
  let query = sb.from('reports_feedback').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
  if (filter === 'pending') query = query.eq('status', 'pending');
  if (filter === 'question_report') query = query.eq('type', 'question_report');
  if (filter === 'feedback') query = query.eq('type', 'feedback');
  const { data, count } = await db(query, 'Reports load failed');
  const pendingCount = await getPendingReportsCount();
  updateReportsBadge(pendingCount);
  const totalPages = count ? Math.max(1, Math.ceil(count / REPORTS_PAGE_SIZE)) : 1;

  // Fetch the referenced questions as a separate, plain query and merge by id in JS,
  // rather than an embedded `questions(text,id)` join — a join depends on Supabase's
  // schema cache correctly recognizing the reports_feedback -> questions relationship,
  // and if that relationship isn't picked up, the WHOLE query errors out and the list
  // silently shows empty even though reports exist (which is what was happening here).
  const qIds = [...new Set((data || []).map(r => r.question_id).filter(Boolean))];
  let qMap = {};
  if (qIds.length) {
    const { data: qs } = await db(sb.from('questions').select('id,text').in('id', qIds), 'Questions load failed');
    (qs || []).forEach(q => { qMap[q.id] = q; });
  }

  if (_renderStale(token)) return;
  content.innerHTML = `
    <div class="flex-between mb-3">
      <div class="fw-700">🚩 Reports & Feedback</div>
      ${pendingCount ? `<span class="badge badge-amber">${pendingCount} pending</span>` : '<span class="badge badge-green">All caught up ✓</span>'}
    </div>
    <div class="btn-row mb-3">
      <button class="btn ${filter==='all'?'btn-primary':'btn-secondary'} btn-xs" onclick="adminReports('all')">All</button>
      <button class="btn ${filter==='pending'?'btn-primary':'btn-secondary'} btn-xs" onclick="adminReports('pending')">Pending</button>
      <button class="btn ${filter==='question_report'?'btn-primary':'btn-secondary'} btn-xs" onclick="adminReports('question_report')">🚩 Question Reports</button>
      <button class="btn ${filter==='feedback'?'btn-primary':'btn-secondary'} btn-xs" onclick="adminReports('feedback')">💬 Feedback</button>
    </div>
    ${data?.length ? `
    <div class="flex-between" style="background:var(--surface-3);border:1px solid var(--border);border-radius:var(--radius-md);padding:9px 12px;margin-bottom:10px">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:600;color:var(--ink-3)">
        <input type="checkbox" id="_rfSelectAll" onchange="_rfToggleSelectAll(this.checked)" style="width:17px;height:17px;accent-color:var(--gold-600)">
        Select all
      </label>
      <button class="btn btn-danger btn-xs" id="_rfDeleteBtn" style="width:auto;opacity:.45;pointer-events:none" onclick="adminDeleteSelectedReports('${filter}')" disabled>🗑 Delete Selected</button>
    </div>` : ''}
    ${!data?.length ? '<div class="card text-center"><p>No reports here.</p></div>' : data.map(r => {
      const q = r.question_id ? qMap[r.question_id] : null;
      return `
      <div class="card" style="margin-bottom:10px" id="_rfCard_${r.id}">
        <div class="flex-between mb-1">
          <div style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" class="rf-select" data-id="${r.id}" onchange="_rfSelectionChanged()" style="width:17px;height:17px;accent-color:var(--gold-600)">
            <span class="badge ${r.type === 'question_report' ? 'badge-amber' : 'badge-teal'}" style="font-size:10px">${r.type === 'question_report' ? '🚩 Question Report' : '💬 Feedback'}</span>
            <span class="badge ${r.status === 'pending' ? 'badge-amber' : 'badge-green'}" style="font-size:10px">${r.status === 'pending' ? 'Pending' : '✓ Replied'}</span>
          </div>
          <button class="btn-icon" style="width:28px;height:28px" title="Delete this report" onclick="adminDeleteReport(${r.id},'${filter}')">🗑</button>
        </div>
        <div class="text-xs text-muted mb-1">${esc(r.user_name) || 'Unknown'} (${esc(r.user_email)}) · ${timeAgo(new Date(r.created_at).getTime())}</div>
        ${q?.text ? `<div class="text-xs" style="background:var(--surface-2);border-radius:8px;padding:6px 8px;margin-bottom:6px"><strong>Question #${q.id}:</strong> ${esc(q.text.substring(0,100))}${q.text.length>100?'...':''} <button class="btn btn-ghost btn-xs" style="padding:2px 6px" onclick="adminEditQuestion(${q.id})">✏️ Fix</button></div>` : ''}
        <div class="text-sm mb-2">${renderMd(r.message)}</div>
        ${r.admin_reply ? `<div style="background:var(--gold-50);border-radius:10px;padding:8px 10px;margin-bottom:6px"><div class="text-xs fw-700" style="color:var(--gold-700)">Your reply:</div><div class="text-sm">${renderMd(r.admin_reply)}</div></div>` : `
        <div class="input-group" style="margin:0">
          <input class="input-field" id="_reply_${r.id}" placeholder="Write a reply..." maxlength="1000" style="margin:0">
          <button class="btn btn-primary" style="width:auto" onclick="adminReplyToReport(${r.id},'${filter}')">Send</button>
        </div>`}
      </div>`;
    }).join('')}
    ${totalPages > 1 ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px">
      <button class="btn btn-secondary btn-sm" style="width:auto" ${_rfPage===0?'disabled':''} onclick="adminReports('${filter}',undefined,${_rfPage-1})">← Prev</button>
      <span class="text-xs text-muted">Page ${_rfPage+1} of ${totalPages} (${count} total)</span>
      <button class="btn btn-secondary btn-sm" style="width:auto" ${_rfPage+1>=totalPages?'disabled':''} onclick="adminReports('${filter}',undefined,${_rfPage+1})">Next →</button>
    </div>` : ''}`;
}
window.adminReports = adminReports;



// Keeps the "Select all" checkbox and the "Delete Selected" button in sync with
// whichever individual row checkboxes are currently ticked.
function _rfSelectionChanged() {
  const ids = [...document.querySelectorAll('.rf-select:checked')].map(cb => parseInt(cb.dataset.id));
  window._rfSelected = new Set(ids);
  const btn = document.getElementById('_rfDeleteBtn');
  if (btn) {
    const n = window._rfSelected.size;
    btn.textContent = n ? `🗑 Delete Selected (${n})` : '🗑 Delete Selected';
    btn.disabled = n === 0;
    btn.style.opacity = n ? '1' : '.45';
    btn.style.pointerEvents = n ? 'auto' : 'none';
  }
  const allBoxes = document.querySelectorAll('.rf-select');
  const allCb = document.getElementById('_rfSelectAll');
  if (allCb) allCb.checked = allBoxes.length > 0 && window._rfSelected.size === allBoxes.length;
}
window._rfSelectionChanged = _rfSelectionChanged;



function _rfToggleSelectAll(checked) {
  document.querySelectorAll('.rf-select').forEach(cb => { cb.checked = checked; });
  _rfSelectionChanged();
}
window._rfToggleSelectAll = _rfToggleSelectAll;



async function adminDeleteReport(id, filter) {
  showConfirm('Delete this report/feedback? This cannot be undone.', async () => {
    await db(sb.from('reports_feedback').delete().eq('id', id), 'Delete failed');
    showToast('Deleted 🗑');
    logAdminAction('Deleted a report/feedback', `Report #${id}`);
    adminReports(filter);
  }, 'Delete', true);
}
window.adminDeleteReport = adminDeleteReport;



async function adminDeleteSelectedReports(filter) {
  const ids = [...(window._rfSelected || [])];
  if (!ids.length) return showToast('Select at least one report first');
  showConfirm(`Delete ${ids.length} selected report${ids.length > 1 ? 's' : ''}? This cannot be undone.`, async () => {
    await db(sb.from('reports_feedback').delete().in('id', ids), 'Bulk delete failed');
    showToast(`Deleted ${ids.length} ✓`);
    logAdminAction('Bulk-deleted reports/feedback', `${ids.length} item(s): ${ids.join(', ')}`);
    adminReports(filter);
  }, `Delete ${ids.length}`, true);
}
window.adminDeleteSelectedReports = adminDeleteSelectedReports;



async function adminReplyToReport(id, filter) {
  const reply = document.getElementById(`_reply_${id}`)?.value.trim();
  if (!reply) return showToast('Please type a reply');
  await db(sb.from('reports_feedback').update({ admin_reply: reply, status: 'replied', replied_at: new Date().toISOString() }).eq('id', id), 'Reply failed');
  showToast('Reply sent ✓');
  logAdminAction('Replied to a report/feedback', `Report #${id}`);
  adminReports(filter);
}
window.adminReplyToReport = adminReplyToReport;



// ==================== ERROR LOGS TAB ====================
const ERRORLOG_PAGE_SIZE = 30;


let _elPage = 0;


async function adminErrorLogs(token = window._adminRenderToken, page) {
  _elPage = (typeof page === 'number') ? page : 0;
  const content = document.getElementById('adminContent');
  content.innerHTML = `<div class="spinner" style="margin:40px auto"></div>`;
  window._elSelected = new Set();
  const from = _elPage * ERRORLOG_PAGE_SIZE;
  const to = from + ERRORLOG_PAGE_SIZE - 1;
  const { data, count } = await db(sb.from('error_logs').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to), 'Error logs load failed');
  if (_renderStale(token)) return;
  const totalPages = count ? Math.max(1, Math.ceil(count / ERRORLOG_PAGE_SIZE)) : 1;
  content.innerHTML = `
    <div class="flex-between mb-3">
      <div class="fw-700">🐞 Error Logs</div>
      <span class="badge ${count ? 'badge-amber' : 'badge-green'}">${count || 0} total</span>
    </div>
    <p class="text-xs text-muted mb-3">Auto-captured from students' devices, newest first. Safe to delete once a fix is confirmed live.</p>
    ${data?.length ? `
    <div class="flex-between" style="background:var(--surface-3);border:1px solid var(--border);border-radius:var(--radius-md);padding:9px 12px;margin-bottom:10px">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:600;color:var(--ink-3)">
        <input type="checkbox" id="_elSelectAll" onchange="_elToggleSelectAll(this.checked)" style="width:17px;height:17px;accent-color:var(--gold-600)">
        Select all
      </label>
      <button class="btn btn-danger btn-xs" id="_elDeleteBtn" style="width:auto;opacity:.45;pointer-events:none" onclick="adminDeleteSelectedErrorLogs()" disabled>🗑 Delete Selected</button>
    </div>` : ''}
    ${!data?.length ? '<div class="card text-center"><p>No errors logged yet 🎉</p></div>' : data.map(r => `
      <div class="card" style="margin-bottom:10px">
        <div class="flex-between mb-1">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <input type="checkbox" class="el-select" data-id="${r.id}" onchange="_elSelectionChanged()" style="width:17px;height:17px;accent-color:var(--gold-600);flex-shrink:0">
            <span class="badge badge-amber" style="font-size:10px">${r.source || 'error'}</span>
            <span class="text-xs text-muted">${timeAgo(new Date(r.created_at).getTime())}</span>
          </div>
          <button class="btn-icon" style="width:28px;height:28px;flex-shrink:0" title="Delete" onclick="adminDeleteErrorLog(${r.id})">🗑</button>
        </div>
        <div class="text-sm fw-700" style="word-break:break-word">${esc(r.message)}</div>
        <div class="text-xs text-muted mt-1">${r.screen ? `📍 ${esc(r.screen)} · ` : ''}${esc(r.user_email) || 'not logged in'} · v${esc(r.app_version) || '?'}</div>
        ${r.stack ? `<details style="margin-top:6px"><summary class="text-xs" style="cursor:pointer;color:var(--gold-700)">Stack trace</summary><pre style="font-size:10px;background:var(--surface-2);border-radius:8px;padding:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;margin-top:4px">${esc(r.stack)}</pre></details>` : ''}
      </div>`).join('')}
    ${totalPages > 1 ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px">
      <button class="btn btn-secondary btn-sm" style="width:auto" ${_elPage===0?'disabled':''} onclick="adminErrorLogs(undefined,${_elPage-1})">← Prev</button>
      <span class="text-xs text-muted">Page ${_elPage+1} of ${totalPages} (${count} total)</span>
      <button class="btn btn-secondary btn-sm" style="width:auto" ${_elPage+1>=totalPages?'disabled':''} onclick="adminErrorLogs(undefined,${_elPage+1})">Next →</button>
    </div>` : ''}`;
}
window.adminErrorLogs = adminErrorLogs;



function _elSelectionChanged() {
  const ids = [...document.querySelectorAll('.el-select:checked')].map(cb => parseInt(cb.dataset.id));
  window._elSelected = new Set(ids);
  const btn = document.getElementById('_elDeleteBtn');
  if (btn) {
    const n = window._elSelected.size;
    btn.textContent = n ? `🗑 Delete Selected (${n})` : '🗑 Delete Selected';
    btn.disabled = n === 0;
    btn.style.opacity = n ? '1' : '.45';
    btn.style.pointerEvents = n ? 'auto' : 'none';
  }
  const allBoxes = document.querySelectorAll('.el-select');
  const allCb = document.getElementById('_elSelectAll');
  if (allCb) allCb.checked = allBoxes.length > 0 && window._elSelected.size === allBoxes.length;
}
window._elSelectionChanged = _elSelectionChanged;



function _elToggleSelectAll(checked) {
  document.querySelectorAll('.el-select').forEach(cb => { cb.checked = checked; });
  _elSelectionChanged();
}
window._elToggleSelectAll = _elToggleSelectAll;



async function adminDeleteErrorLog(id) {
  showConfirm('Delete this error log entry?', async () => {
    await db(sb.from('error_logs').delete().eq('id', id), 'Delete failed');
    showToast('Deleted 🗑');
    adminErrorLogs();
  }, 'Delete', true);
}
window.adminDeleteErrorLog = adminDeleteErrorLog;



async function adminDeleteSelectedErrorLogs() {
  const ids = [...(window._elSelected || [])];
  if (!ids.length) return showToast('Select at least one entry first');
  showConfirm(`Delete ${ids.length} selected log${ids.length > 1 ? 's' : ''}?`, async () => {
    await db(sb.from('error_logs').delete().in('id', ids), 'Bulk delete failed');
    showToast(`Deleted ${ids.length} ✓`);
    adminErrorLogs();
  }, `Delete ${ids.length}`, true);
}
window.adminDeleteSelectedErrorLogs = adminDeleteSelectedErrorLogs;



async function adminAnnouncements(token = window._adminRenderToken) {
  // Best-effort cleanup — notifications auto-expire after 48h from the
  // student's point of view regardless (checkNewNotifications filters them
  // out at query time), but this keeps the table from growing forever. Not
  // awaited: if it fails or is slow, it shouldn't hold up loading the screen.
  db(sb.from('app_notifications').delete().lt('created_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString()), 'Cleanup failed');
  db(sb.from('announcements').delete().lt('created_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString()), 'Cleanup failed');

  const { data: announcements } = await db(sb.from('announcements').select('*').order('created_at', { ascending: false }), 'Announce error');

  if (_renderStale(token)) return;
  const { data: sentNotifs } = await db(sb.from('app_notifications').select('*').order('created_at', { ascending: false }), 'Notif load failed');
  const notifList = (sentNotifs || []).map(n => {
    const hoursLeft = Math.max(0, Math.round(48 - (Date.now() - new Date(n.created_at).getTime()) / 3600000));
    return `
    <div class="admin-row">
      <div class="admin-row-left">
        <div class="fw-700">${esc(n.title) || '(No title)'}</div>
        ${n.body ? `<div class="text-xs text-muted">${esc(n.body)}</div>` : ''}
        ${n.image_url ? `<img src="${esc(n.image_url)}" style="max-width:160px;border-radius:var(--radius-md);margin-top:6px">` : ''}
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
          <span class="chip" style="font-size:10px">${new Date(n.created_at).toLocaleDateString()}</span>
          <span class="chip" style="font-size:10px">⏳ expires in ${hoursLeft}h</span>
          ${n.target_college === 'Others' ? '<span class="chip" style="font-size:10px">🌐 Others</span>' : (n.target_college ? `<span class="chip" style="font-size:10px">🏫 ${esc(n.target_college)}</span>` : '<span class="chip" style="font-size:10px">👥 All Students</span>')}
        </div>
      </div>
      <div class="admin-row-actions">
        <button class="btn btn-danger btn-xs" onclick="deleteSentNotification(${n.id})">🗑</button>
      </div>
    </div>`;
  }).join('');

  const list = (announcements || []).map(a => `
    <div class="admin-row">
      <div class="admin-row-left">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:24px">${esc(a.emoji) || '📢'}</span>
          <div>
            <div class="fw-700">${esc(a.title) || '(No title)'}</div>
            <div class="text-xs text-muted">${esc(a.body) || ''}</div>
          </div>
        </div>
        ${a.image_url ? `<img src="${esc(a.image_url)}" style="max-width:160px;border-radius:var(--radius-md);margin-top:6px">` : ''}
        <div style="margin-top:6px;display:flex;gap:6px">
          <span class="badge ${a.is_active ? 'badge-green' : 'badge-amber'}">${a.is_active ? '🟢 Live' : '⏸ Paused'}</span>
          <span class="chip" style="font-size:10px">${new Date(a.created_at).toLocaleDateString()}</span>
          ${a.target_college === 'Others' ? '<span class="chip" style="font-size:10px">🌐 Others</span>' : (a.target_college ? `<span class="chip" style="font-size:10px">🏫 ${a.target_college}</span>` : '<span class="chip" style="font-size:10px">👥 All Students</span>')}
        </div>
      </div>
      <div class="admin-row-actions">
        <button class="btn btn-secondary btn-xs" onclick="toggleAnnounce(${a.id},${a.is_active})">${a.is_active ? '⏸ Pause' : '▶ Activate'}</button>
        <button class="btn btn-danger btn-xs" onclick="deleteAnnounce(${a.id})">🗑</button>
      </div>
    </div>`).join('');

  const { data: colleges } = await db(sb.from('colleges').select('name').order('name'), 'Colleges error');
  const collegeOpts = (colleges || []).map(c => `<option value="${c.name}">${c.name}</option>`).join('');

  document.getElementById('adminContent').innerHTML = `
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">🔔 Send Notification</div>
      <p class="text-xs text-muted mb-2">Goes to every student's notification bell (🔔 icon on Home) and auto-removes itself after 48 hours — no cleanup needed. Different from the banner below: this is for things students should be specifically alerted to, like exam dates or new features.</p>
      <label class="input-label">Title</label>
      <input id="ntf_title" class="input-field" placeholder="e.g. 📅 2nd Year Module Exam, June 30">
      <label class="input-label">Message (optional)</label>
      <textarea id="ntf_body" class="input-field" rows="2" placeholder="Extra details..."></textarea>
      <label class="input-label">Image (optional)</label>
      <div class="upload-area" onclick="document.getElementById('ntf_img_file').click()">📸 Upload image</div>
      <input type="file" id="ntf_img_file" accept="image/*" style="display:none" onchange="previewAndUpload('ntf_img_file','ntf_img_url','ntf_img_preview')">
      <img id="ntf_img_preview" style="display:none;max-width:100%;border-radius:var(--radius-lg);margin:8px 0">
      <input id="ntf_img_url" class="input-field" placeholder="Image URL" readonly>
      <label class="input-label">Target Audience</label>
      <select id="ntf_college" class="input-field" title="Target college" aria-label="Target college">
        <option value="">👥 All Students</option>
        <option value="Others">🌐 Others (students whose college isn't listed)</option>
        ${collegeOpts}
      </select>
      <button class="btn btn-primary mt-2" onclick="adminSendNotification()">🔔 Send to Notification Bell</button>
    </div>
    <div class="fw-700 mb-2">📋 Sent Notifications <span class="text-xs text-muted" style="font-weight:500">(auto-expire after 48h)</span></div>
    ${notifList || '<div class="card"><p class="text-muted">No notifications sent yet.</p></div>'}
    <div style="height:20px"></div>

    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">📢 Create Announcement</div>
      <label class="input-label">Emoji Icon</label>
      <input id="an_emoji" class="input-field" value="📢" placeholder="Emoji">
      <label class="input-label">Title</label>
      <input id="an_title" class="input-field" placeholder="Announcement title">
      <label class="input-label">Body Text</label>
      <textarea id="an_body" class="input-field" rows="2" placeholder="Details..."></textarea>
      <label class="input-label">Image (optional)</label>
      <div class="upload-area" onclick="document.getElementById('an_img_file').click()">📸 Upload image</div>
      <input type="file" id="an_img_file" accept="image/*" style="display:none" onchange="previewAndUpload('an_img_file','an_img_url','an_img_preview')">
      <img id="an_img_preview" style="display:none;max-width:100%;border-radius:var(--radius-lg);margin:8px 0">
      <input id="an_img_url" class="input-field" placeholder="Image URL" readonly>
      <label class="input-label">Target Audience</label>
      <select id="an_college" class="input-field" title="Target college" aria-label="Target college">
        <option value="">👥 All Students</option>
        <option value="Others">🌐 Others (students whose college isn't listed)</option>
        ${collegeOpts}
      </select>
      <label class="input-label">Announcement Type</label>
      <select id="an_type" class="input-field" title="Announcement type" aria-label="Announcement type">
        <option value="general">📢 General Info</option>
        <option value="exam">📝 Exam Alert</option>
        <option value="feature">✨ New Feature</option>
        <option value="maintenance">⚠️ Maintenance</option>
      </select>
      <div style="margin-top:10px"><label><input type="checkbox" id="an_active" checked> <span class="text-sm">Publish immediately (show to students)</span></label></div>
      <button class="btn btn-primary mt-3" onclick="adminAddAnnouncement()">📤 Publish Announcement</button>
    </div>
    <div class="fw-700 mb-2">📋 All Announcements</div>
    ${list || '<div class="card"><p class="text-muted">No announcements yet.</p></div>'}`;
}



async function adminSendNotification() {
  const title = document.getElementById('ntf_title').value.trim();
  const body = document.getElementById('ntf_body').value.trim();
  const image_url = document.getElementById('ntf_img_url').value.trim() || null;
  const college = document.getElementById('ntf_college').value || null;
  if (!title) return showToast('Please enter a title');
  await db(sb.from('app_notifications').insert({ title, body, image_url, target_college: college }), 'Send failed');
  showToast('🔔 Notification sent ✓');
  logAdminAction('Sent a notification', title);
  document.getElementById('ntf_title').value = '';
  document.getElementById('ntf_body').value = '';
  document.getElementById('ntf_img_url').value = '';
  const preview = document.getElementById('ntf_img_preview');
  if (preview) { preview.style.display = 'none'; preview.src = ''; }
  adminAnnouncements();
}
window.adminSendNotification = adminSendNotification;



async function deleteSentNotification(id) {
  showConfirm('Delete this notification? Students will stop seeing it immediately.', async () => {
    await db(sb.from('app_notifications').delete().eq('id', id), 'Delete failed');
    showToast('Deleted');
    adminAnnouncements();
  }, 'Delete');
}
window.deleteSentNotification = deleteSentNotification;



async function adminAddAnnouncement() {
  const emoji = document.getElementById('an_emoji').value.trim() || '📢';
  const title = document.getElementById('an_title').value.trim();
  const body = document.getElementById('an_body').value.trim();
  const image_url = document.getElementById('an_img_url').value.trim() || null;
  const target_college = document.getElementById('an_college').value || null;
  const type = document.getElementById('an_type').value;
  const is_active = document.getElementById('an_active').checked;
  if (!title) return showToast('Title required');
  await db(sb.from('announcements').insert({ emoji, title, body, image_url, target_college, type, is_active, created_at: new Date().toISOString() }), 'Add failed');
  cacheClear('announcements');
  showToast('Announcement published ✓'); adminAnnouncements();
}
window.adminAddAnnouncement = adminAddAnnouncement;



async function toggleAnnounce(id, current) {
  await db(sb.from('announcements').update({ is_active: !current }).eq('id', id), 'Toggle failed');
  cacheClear('announcements');
  showToast(current ? 'Paused' : 'Activated'); adminAnnouncements();
}
window.toggleAnnounce = toggleAnnounce;



async function deleteAnnounce(id) {
  showConfirm('Delete this announcement?', async () => {
    await db(sb.from('announcements').delete().eq('id', id), 'Delete failed');
    cacheClear('announcements');
    showToast('Deleted'); adminAnnouncements();
  }, 'Delete');
}
window.deleteAnnounce = deleteAnnounce;



// ==================== COLLEGES TAB ====================
async function adminColleges(token = window._adminRenderToken) {
  const { data: colleges } = await db(sb.from('colleges').select('*').order('name'), 'Colleges error');
  if (_renderStale(token)) return;
  document.getElementById('adminContent').innerHTML = `
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">ℹ️ About Colleges</div>
      <p class="text-sm">Colleges control which institutions students can select during signup. Add a college and mark it Active to make it selectable. Students whose college isn't listed yet can choose "Others" instead, and you can still target announcements/notifications at "Others" specifically. Deactivate a college to hide it from new signups without affecting its existing students.</p>
    </div>
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">➕ Add College</div>
      <label class="input-label">College Full Name</label>
      <input id="col_name" class="input-field" placeholder="e.g., Bilawal Medical College, Jamshoro">
      <label class="input-label">Short Name / Abbreviation</label>
      <input id="col_abbr" class="input-field" placeholder="e.g., BMC">
      <label class="input-label">City / Location</label>
      <input id="col_city" class="input-field" placeholder="e.g., Jamshoro">
      <label class="input-label">Province</label>
      <select id="col_province" class="input-field" title="Select province" aria-label="Select province">
        <option value="Sindh">Sindh</option>
        <option value="Punjab">Punjab</option>
        <option value="KPK">KPK</option>
        <option value="Balochistan">Balochistan</option>
        <option value="Federal">Federal</option>
      </select>
      <label class="input-label">College Logo</label>
      <div class="upload-area" onclick="document.getElementById('col_logo_file').click()">📸 Upload logo</div>
      <input type="file" id="col_logo_file" accept="image/*" style="display:none" onchange="previewAndUpload('col_logo_file','col_logo_url','col_logo_preview')">
      <img id="col_logo_preview" style="display:none;max-width:120px;border-radius:var(--radius-md);margin:8px 0">
      <input id="col_logo_url" class="input-field" placeholder="Logo URL" readonly>
      <label class="input-label">Website (optional)</label>
      <input id="col_website" class="input-field" placeholder="https://...">
      <div style="margin-top:10px"><label><input type="checkbox" id="col_active" checked> <span class="text-sm">Active (visible in signup dropdown)</span></label></div>
      <button class="btn btn-primary mt-3" onclick="adminAddCollege()">Add College</button>
    </div>
    <div class="fw-700 mb-2">🏫 Registered Colleges</div>
    ${(colleges || []).map(c => `
      <div class="admin-row">
        <div class="admin-row-left" style="display:flex;gap:10px;align-items:center">
          ${c.logo_url ? `<img src="${c.logo_url}" style="width:40px;height:40px;border-radius:var(--radius-md);object-fit:contain">` : '<div style="width:40px;height:40px;border-radius:var(--radius-md);background:var(--surface-3);display:flex;align-items:center;justify-content:center">🏫</div>'}
          <div>
            <div class="fw-700">${c.name} <span class="badge badge-teal" style="font-size:10px">${c.abbreviation || ''}</span></div>
            <div class="text-xs text-muted">${c.city || ''} · ${c.province || ''}</div>
            <div class="badge ${c.is_active ? 'badge-green' : 'badge-amber'} mt-1">${c.is_active ? 'Active' : 'Inactive'}</div>
          </div>
        </div>
        <div class="admin-row-actions">
          <button class="btn btn-secondary btn-xs" onclick="adminToggleCollege(${c.id},${c.is_active})">${c.is_active ? 'Deactivate' : 'Activate'}</button>
          <button class="btn btn-danger btn-xs" onclick="adminDeleteCollege(${c.id})">🗑</button>
        </div>
      </div>`).join('') || '<div class="card"><p class="text-muted">No colleges added yet.</p></div>'}`;
}



async function adminAddCollege() {
  const name = document.getElementById('col_name').value.trim();
  const abbreviation = document.getElementById('col_abbr').value.trim();
  const city = document.getElementById('col_city').value.trim();
  const province = document.getElementById('col_province').value;
  const logo_url = document.getElementById('col_logo_url').value.trim() || null;
  const website = document.getElementById('col_website').value.trim() || null;
  const is_active = document.getElementById('col_active').checked;
  if (!name) return showToast('College name required');
  await db(sb.from('colleges').insert({ name, abbreviation, city, province, logo_url, website, is_active }), 'Add failed');
  cacheClear('colleges');
  showToast('College added ✓'); adminColleges();
}
window.adminAddCollege = adminAddCollege;



async function adminToggleCollege(id, current) {
  await db(sb.from('colleges').update({ is_active: !current }).eq('id', id), 'Toggle failed');
  cacheClear('colleges');
  showToast(current ? 'College deactivated' : 'College activated'); adminColleges();
}
window.adminToggleCollege = adminToggleCollege;



async function adminDeleteCollege(id) {
  showConfirm('Delete this college?<br><small>Existing students from this college will not be affected.</small>', async () => {
    await db(sb.from('colleges').delete().eq('id', id), 'Delete failed');
    cacheClear('colleges');
    showToast('College deleted'); adminColleges();
  }, 'Delete');
}
window.adminDeleteCollege = adminDeleteCollege;



function adminViewAsStudent() {
  localStorage.setItem('lum_admin_preview', 'true');
  window._isAdminPreview = true;
  // Store admin state
  window._adminBackup = { ...window.currentUser };
  window.currentUser = { ...window.currentUser, is_admin: false };
  // Show bottom nav
  document.getElementById('bottomNav').classList.add('show');
  // Add return button
  const retBtn = document.createElement('div');
  retBtn.id = 'adminReturnBar';
  retBtn.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#7a5c00;color:white;padding:10px 16px;z-index:9000;display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:600';
  retBtn.innerHTML = `<span>👁 Admin Preview Mode <span style="opacity:.75;font-weight:500">· every year unlocked</span></span><button onclick="exitAdminPreview()" style="background:rgba(255,255,255,.2);border:none;color:white;padding:6px 14px;border-radius:999px;font-size:12px;font-weight:700;cursor:pointer">← Back to Admin</button>`;
  document.body.prepend(retBtn);
  document.body.style.paddingTop = '44px';
  // The admin account's own boot path (handleAuthedSession) returns straight to
  // the admin panel and never restores selectedYear from localStorage the way a
  // real student's does — so on a fresh reload this used to be null again even
  // after already picking a year in an earlier preview session, and Preview Mode
  // would show the year-select screen every single time. Restore it here too.
  if (!window.selectedYear) {
    const savedYear = localStorage.getItem('lum_year');
    if (savedYear) { try { window.selectedYear = JSON.parse(savedYear); } catch(e) {} }
  }
  if (!window.selectedYear) loadYearScreen();
  else { renderHome(); showScreen('home'); }
  showToast('👁 Viewing as student');
}
window.adminViewAsStudent = adminViewAsStudent;



function exitAdminPreview() {
  localStorage.removeItem('lum_admin_preview');
  window._isAdminPreview = false;
  window.currentUser = window._adminBackup || window.currentUser;
  window.currentUser.is_admin = true;
  const bar = document.getElementById('adminReturnBar');
  if (bar) bar.remove();
  document.body.style.paddingTop = '';
  document.getElementById('bottomNav').classList.remove('show');
  renderAdminPanel();
  showScreen('admin');
  showToast('Welcome back to Admin Panel');
}
window.exitAdminPreview = exitAdminPreview;

// ==================== MONETIZATION TAB ====================
async function adminMonetization(token = window._adminRenderToken) {
  const { data: plans } = await db(
    sb.from('subscription_plans').select('*').order('price'),
    'Plans error'
  );
  // Revenue/active-count stats need to cover every subscription, not just a
  // recent slice — but they only need 2 tiny columns, not the full row plus
  // a users(...) join, which is what the "Recent Subscriptions" list below
  // actually needs. Splitting these keeps both queries lightweight while
  // making the stats accurate regardless of how many subscriptions exist.
  const [{ data: allActiveSubs }, { data: recentSubs }, { data: donations }] = await Promise.all([
    db(sb.from('subscriptions').select('plan_id').eq('status', 'active'), 'Subs error'),
    db(sb.from('subscriptions').select('*, users(name,email,college)').order('created_at', { ascending: false }).limit(10), 'Subs error'),
    db(sb.from('donation_campaigns').select('*').order('created_at', { ascending: false }), 'Donations error')
  ]);
  const { data: settings } = await db(
    sb.from('system_settings').select('*').in('key', ['payment_enabled','free_trial_days','currency','payment_gateway','razorpay_key','stripe_key']),
    'Settings error'
  );
  const getSetting = (key, def = '') => settings?.find(s => s.key === key)?.value || def;
  if (_renderStale(token)) return;
  const totalRevenue = (allActiveSubs || []).reduce((a, s) => {
    const plan = (plans || []).find(p => p.id === s.plan_id);
    return a + (plan?.price || 0);
  }, 0);

  const activeSubs = (allActiveSubs || []).length;

  document.getElementById('adminContent').innerHTML = `
    <!-- Revenue Overview -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px">
      <div class="stat-box"><div class="stat-val" style="color:var(--green)">₨${totalRevenue.toLocaleString()}</div><div class="stat-key">Total Revenue</div></div>
      <div class="stat-box"><div class="stat-val">${activeSubs}</div><div class="stat-key">Active Subs</div></div>
      <div class="stat-box"><div class="stat-val">${(plans||[]).length}</div><div class="stat-key">Plans</div></div>
    </div>

    <!-- Payment Settings -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">💳 Payment Settings</div>
      <div class="flex-between mb-2">
        <span class="text-sm fw-600">Enable Payments</span>
        <label class="toggle-switch">
          <input type="checkbox" id="pay_enabled" ${getSetting('payment_enabled') === 'true' ? 'checked' : ''} onchange="saveSetting('payment_enabled',this.checked)">
          <span class="toggle-knob"></span>
        </label>
      </div>
      <label class="input-label">Currency</label>
      <select id="pay_currency" class="input-field" title="Currency" aria-label="Currency" onchange="saveSetting('currency',this.value)">
        <option value="PKR" ${getSetting('currency') === 'PKR' ? 'selected' : ''}>🇵🇰 PKR (Pakistani Rupee)</option>
        <option value="USD" ${getSetting('currency') === 'USD' ? 'selected' : ''}>🇺🇸 USD (US Dollar)</option>
        <option value="INR" ${getSetting('currency') === 'INR' ? 'selected' : ''}>🇮🇳 INR (Indian Rupee)</option>
        <option value="GBP" ${getSetting('currency') === 'GBP' ? 'selected' : ''}>🇬🇧 GBP (British Pound)</option>
      </select>
      <label class="input-label">Free Trial Days</label>
      <input id="trial_days" type="number" class="input-field" value="${getSetting('free_trial_days','7')}" placeholder="e.g. 7">
      <button class="btn btn-secondary btn-sm mt-1" onclick="saveSetting('free_trial_days',document.getElementById('trial_days').value)">Save Trial Days</button>
      <label class="input-label mt-3">Payment Gateway</label>
      <select id="pay_gateway" class="input-field" title="Payment gateway" aria-label="Payment gateway" onchange="showGatewayFields(this.value)">
        <option value="manual" ${getSetting('payment_gateway') === 'manual' ? 'selected' : ''}>💵 Manual (Bank Transfer / EasyPaisa / JazzCash)</option>
        <option value="stripe" ${getSetting('payment_gateway') === 'stripe' ? 'selected' : ''}>💳 Stripe</option>
        <option value="razorpay" ${getSetting('payment_gateway') === 'razorpay' ? 'selected' : ''}>💳 Razorpay</option>
      </select>
      <div id="gatewayFields"></div>
      <label class="input-label mt-2">Manual Payment Instructions (shown to students)</label>
      <textarea id="pay_instructions" class="input-field" rows="3" placeholder="e.g., Send payment to EasyPaisa: 03XX-XXXXXXX then send screenshot to admin...">${getSetting('payment_instructions','')}</textarea>
      <button class="btn btn-primary mt-2" onclick="savePaymentInstructions()">Save Instructions</button>
    </div>

    <!-- Subscription Plans -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">📋 Subscription Plans</div>
      ${(plans||[]).map(p => `
        <div class="admin-row">
          <div class="admin-row-left">
            <div class="fw-700">${p.name} <span class="badge ${p.is_active ? 'badge-green' : 'badge-amber'}">${p.is_active ? 'Active' : 'Draft'}</span></div>
            <div class="text-sm text-muted">${p.description || ''}</div>
            <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">
              <span class="chip" style="font-size:11px">💰 ${getSetting('currency','PKR')} ${p.price}/${p.billing_cycle || 'month'}</span>
              <span class="chip" style="font-size:11px">⏱ ${p.duration_days} days</span>
              ${p.is_featured ? '<span class="badge badge-teal">⭐ Featured</span>' : ''}
            </div>
            <div class="text-xs text-muted mt-1">Features: ${(p.features || []).join(' · ')}</div>
          </div>
          <div class="admin-row-actions">
            <button class="btn btn-secondary btn-xs" onclick="editPlan(${p.id})">✏️ Edit</button>
            <button class="btn btn-secondary btn-xs" onclick="togglePlan(${p.id},${p.is_active})">${p.is_active ? 'Unpublish' : 'Publish'}</button>
            <button class="btn btn-danger btn-xs" onclick="deletePlan(${p.id})">🗑</button>
          </div>
        </div>`).join('') || '<p class="text-muted">No plans yet.</p>'}
      <hr class="divider">
      <div class="fw-700 mb-2">➕ Create Plan</div>
      <label class="input-label">Plan Name</label>
      <input id="plan_name" class="input-field" placeholder="e.g., Basic, Pro, Premium">
      <label class="input-label">Description</label>
      <input id="plan_desc" class="input-field" placeholder="Short description">
      <label class="input-label">Price (in selected currency)</label>
      <input id="plan_price" type="number" class="input-field" placeholder="e.g., 500">
      <label class="input-label">Billing Cycle</label>
      <select id="plan_cycle" class="input-field" title="Billing cycle" aria-label="Billing cycle">
        <option value="month">Monthly</option>
        <option value="3months">3 Months</option>
        <option value="6months">6 Months</option>
        <option value="year">Yearly</option>
        <option value="lifetime">Lifetime</option>
      </select>
      <label class="input-label">Duration (days)</label>
      <input id="plan_days" type="number" class="input-field" placeholder="e.g., 30">
      <label class="input-label">Features (comma separated)</label>
      <input id="plan_features" class="input-field" placeholder="All MCQs, Past Papers, AI Tutor, Leaderboard">
      <div style="margin-top:8px;display:flex;gap:12px;flex-wrap:wrap">
        <label><input type="checkbox" id="plan_featured"> <span class="text-sm">Mark as Featured</span></label>
        <label><input type="checkbox" id="plan_free"> <span class="text-sm">Free Plan (price = 0)</span></label>
      </div>
      <button class="btn btn-primary mt-3" onclick="createPlan()">Create Plan</button>
    </div>

    <!-- Donation Campaigns -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">💛 Donation Campaigns</div>
      <p class="text-xs text-muted mb-3">Shows as a compact card on the student dashboard, below stats — stays visible until you pause or delete it (no auto-expiry, unlike announcements).</p>
      ${(donations || []).map(d => `
        <div class="admin-row">
          <div class="admin-row-left">
            <div class="fw-700">${esc(d.title) || '(No title)'} <span class="badge ${d.is_active ? 'badge-green' : 'badge-amber'}">${d.is_active ? '🟢 Live' : '⏸ Paused'}</span></div>
            <div class="text-sm text-muted">${esc(d.description) || ''}</div>
            ${d.purpose ? `<div class="text-xs text-muted mt-1">🎯 ${esc(d.purpose)}</div>` : ''}
            ${d.image_url ? `<img src="${esc(d.image_url)}" style="max-width:160px;border-radius:var(--radius-md);margin-top:6px">` : ''}
            ${d.donation_link ? `<div class="text-xs mt-1"><a href="${esc(d.donation_link)}" target="_blank" style="color:var(--gold-600)">${esc(d.donation_link)}</a></div>` : ''}
          </div>
          <div class="admin-row-actions">
            <button class="btn btn-secondary btn-xs" onclick="adminEditDonation(${d.id})">✏️</button>
            <button class="btn btn-secondary btn-xs" onclick="toggleDonation(${d.id},${d.is_active})">${d.is_active ? '⏸ Pause' : '▶ Activate'}</button>
            <button class="btn btn-danger btn-xs" onclick="deleteDonation(${d.id})">🗑</button>
          </div>
        </div>`).join('') || '<p class="text-muted mb-3">No donation campaigns yet.</p>'}
      <hr class="divider">
      <div class="fw-700 mb-2">➕ Create Campaign</div>
      <label class="input-label">Title</label>
      <input id="dn_title" class="input-field" placeholder="e.g., Help Keep LUMHSian Pro Free">
      <label class="input-label">Description</label>
      <textarea id="dn_desc" class="input-field" rows="2" placeholder="Short, honest explanation of why you're asking"></textarea>
      <label class="input-label">Purpose (optional)</label>
      <input id="dn_purpose" class="input-field" placeholder="e.g., Server & AI costs">
      <label class="input-label">Image (optional)</label>
      <div class="upload-area" onclick="document.getElementById('dn_img_file').click()">📸 Upload image</div>
      <input type="file" id="dn_img_file" accept="image/*" style="display:none" onchange="previewAndUpload('dn_img_file','dn_img_url','dn_img_preview')">
      <img id="dn_img_preview" style="display:none;max-width:100%;border-radius:var(--radius-lg);margin:8px 0">
      <input id="dn_img_url" class="input-field" placeholder="Image URL" readonly>
      <label class="input-label">Donation Link / Payment Details</label>
      <input id="dn_link" class="input-field" placeholder="Payment link, or EasyPaisa/JazzCash number">
      <button class="btn btn-primary mt-2" onclick="adminAddDonation()">Create Campaign</button>
    </div>

    <!-- Active Subscriptions -->
    <div class="card">
      <div class="fw-700 mb-2">👥 Recent Subscriptions</div>
      ${(recentSubs||[]).map(s => {
        const plan = (plans||[]).find(p => p.id === s.plan_id);
        return `<div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
          <div>
            <div class="fw-600 text-sm">${s.users?.name || s.user_email}</div>
            <div class="text-xs text-muted">${plan?.name || 'Unknown plan'} · ${new Date(s.created_at).toLocaleDateString()}</div>
          </div>
          <div style="text-align:right">
            <span class="badge ${s.status === 'active' ? 'badge-green' : s.status === 'pending' ? 'badge-amber' : 'badge-red'}">${s.status}</span>
            ${s.status === 'pending' ? `<br><button class="btn btn-secondary btn-xs mt-1" onclick="approveSubscription('${s.id}')">✅ Approve</button>` : ''}
          </div>
        </div>`;
      }).join('') || '<p class="text-muted">No subscriptions yet.</p>'}
    </div>`;

  showGatewayFields(getSetting('payment_gateway', 'manual'));
}
window.adminMonetization = adminMonetization;



async function adminAddDonation() {
  const title = document.getElementById('dn_title').value.trim();
  const description = document.getElementById('dn_desc').value.trim();
  const purpose = document.getElementById('dn_purpose').value.trim() || null;
  const image_url = document.getElementById('dn_img_url').value.trim() || null;
  const donation_link = document.getElementById('dn_link').value.trim() || null;
  if (!title) return showToast('Title required');
  await db(sb.from('donation_campaigns').insert({ title, description, purpose, image_url, donation_link, is_active: true }), 'Add failed');
  showToast('Donation campaign created ✓');
  logAdminAction('Created donation campaign', title);
  adminMonetization();
}
window.adminAddDonation = adminAddDonation;


async function toggleDonation(id, isActive) {
  await db(sb.from('donation_campaigns').update({ is_active: !isActive }).eq('id', id), 'Update failed');
  showToast(isActive ? 'Paused' : 'Activated');
  adminMonetization();
}
window.toggleDonation = toggleDonation;


async function deleteDonation(id) {
  showConfirm('Delete this donation campaign? This can\'t be undone.', async () => {
    await db(sb.from('donation_campaigns').delete().eq('id', id), 'Delete failed');
    showToast('Deleted');
    adminMonetization();
  }, 'Delete', true);
}
window.deleteDonation = deleteDonation;


async function adminEditDonation(id) {
  const { data: d } = await db(sb.from('donation_campaigns').select('*').eq('id', id).single(), 'Load failed');
  if (!d) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:420px;max-height:90vh;overflow-y:auto">
      <div class="fw-700 mb-3">✏️ Edit Donation Campaign</div>
      <label class="input-label">Title</label>
      <input id="_ed_title" class="input-field" value="${esc(d.title||'')}">
      <label class="input-label">Description</label>
      <textarea id="_ed_desc" class="input-field" rows="2">${esc(d.description||'')}</textarea>
      <label class="input-label">Purpose</label>
      <input id="_ed_purpose" class="input-field" value="${esc(d.purpose||'')}">
      <label class="input-label">Image (optional)</label>
      <div class="upload-area" onclick="document.getElementById('_ed_img_file').click()">📸 Change image</div>
      <input type="file" id="_ed_img_file" accept="image/*" style="display:none" onchange="previewAndUpload('_ed_img_file','_ed_img_url','_ed_img_preview')">
      <img id="_ed_img_preview" src="${esc(d.image_url||'')}" style="display:${d.image_url?'block':'none'};max-width:100%;border-radius:var(--radius-lg);margin:8px 0">
      <input id="_ed_img_url" class="input-field" value="${esc(d.image_url||'')}" placeholder="Image URL" readonly>
      <label class="input-label">Donation Link / Payment Details</label>
      <input id="_ed_link" class="input-field" value="${esc(d.donation_link||'')}">
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="saveEditedDonation(${d.id}, this)">Save Changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.adminEditDonation = adminEditDonation;


// See saveEditedYear (near adminEditYear) for why this can't be an inline onclick IIFE.
async function saveEditedDonation(id, btnEl) {
  try {
    const title = document.getElementById('_ed_title').value.trim();
    const description = document.getElementById('_ed_desc').value.trim();
    const purpose = document.getElementById('_ed_purpose').value.trim() || null;
    const image_url = document.getElementById('_ed_img_url').value.trim() || null;
    const donation_link = document.getElementById('_ed_link').value.trim() || null;
    if (!title) { showToast('Title required'); return; }
    const { error } = await db(sb.from('donation_campaigns').update({ title, description, purpose, image_url, donation_link }).eq('id', id), 'Edit failed');
    if (error) return;
    showToast('Campaign updated ✓');
    btnEl.closest('[style*=fixed]').remove();
    adminMonetization();
  } catch (err) {
    console.error('Edit donation failed:', err);
    showToast('Unexpected error: ' + err.message, 9000);
  }
}
window.saveEditedDonation = saveEditedDonation;



function showGatewayFields(gateway) {
  const container = document.getElementById('gatewayFields');
  if (!container) return;
  if (gateway === 'stripe') {
    container.innerHTML = `
      <label class="input-label mt-2">Stripe Publishable Key</label>
      <input id="stripe_pk" class="input-field" maxlength="300" placeholder="pk_live_...">
      <label class="input-label">Stripe Secret Key</label>
      <input id="stripe_sk" class="input-field" type="password" maxlength="300" placeholder="sk_live_...">
      <button class="btn btn-secondary btn-sm mt-1" onclick="saveGatewayKeys('stripe')">Save Keys</button>`;
  } else if (gateway === 'razorpay') {
    container.innerHTML = `
      <label class="input-label mt-2">Razorpay Key ID</label>
      <input id="razorpay_key" class="input-field" maxlength="300" placeholder="rzp_live_...">
      <label class="input-label">Razorpay Secret</label>
      <input id="razorpay_secret" class="input-field" type="password" maxlength="300" placeholder="...">
      <button class="btn btn-secondary btn-sm mt-1" onclick="saveGatewayKeys('razorpay')">Save Keys</button>`;
  } else {
    container.innerHTML = '';
  }
  saveSetting('payment_gateway', gateway);
}
window.showGatewayFields = showGatewayFields;



async function saveGatewayKeys(gateway) {
  if (gateway === 'stripe') {
    await saveSetting('stripe_pk', document.getElementById('stripe_pk')?.value);
    await saveSetting('stripe_sk', document.getElementById('stripe_sk')?.value);
  } else if (gateway === 'razorpay') {
    await saveSetting('razorpay_key', document.getElementById('razorpay_key')?.value);
    await saveSetting('razorpay_secret', document.getElementById('razorpay_secret')?.value);
  }
  showToast('Gateway keys saved ✓');
}
window.saveGatewayKeys = saveGatewayKeys;



async function savePaymentInstructions() {
  await saveSetting('payment_instructions', document.getElementById('pay_instructions')?.value);
  showToast('Instructions saved ✓');
}
window.savePaymentInstructions = savePaymentInstructions;



async function createPlan() {
  const name = document.getElementById('plan_name').value.trim();
  const description = document.getElementById('plan_desc').value.trim();
  const price = parseFloat(document.getElementById('plan_price').value) || 0;
  const billing_cycle = document.getElementById('plan_cycle').value;
  const duration_days = parseInt(document.getElementById('plan_days').value) || 30;
  const featuresRaw = document.getElementById('plan_features').value;
  const features = featuresRaw.split(',').map(f => f.trim()).filter(Boolean);
  const is_featured = document.getElementById('plan_featured').checked;
  const is_free = document.getElementById('plan_free').checked;
  if (!name) return showToast('Plan name required');
  await db(sb.from('subscription_plans').insert({ name, description, price: is_free ? 0 : price, billing_cycle, duration_days, features, is_featured, is_active: false, is_free }), 'Create plan failed');
  cacheClear('subscription_plans');
  showToast('Plan created ✓'); adminMonetization();
}
window.createPlan = createPlan;



async function togglePlan(id, current) {
  await db(sb.from('subscription_plans').update({ is_active: !current }).eq('id', id), 'Toggle failed');
  cacheClear('subscription_plans');
  showToast(current ? 'Plan unpublished' : 'Plan published ✓'); adminMonetization();
}
window.togglePlan = togglePlan;



async function deletePlan(id) {
  showConfirm('Delete this subscription plan?', async () => {
    await db(sb.from('subscription_plans').delete().eq('id', id), 'Delete failed');
    cacheClear('subscription_plans');
    showToast('Plan deleted'); adminMonetization();
  }, 'Delete');
}
window.deletePlan = deletePlan;



async function approveSubscription(id) {
  const { data: sub } = await db(sb.from('subscriptions').select('*,subscription_plans(duration_days)').eq('id', id).single(), 'Load failed');
  if (!sub) return;
  const expiry = new Date(Date.now() + (sub.subscription_plans?.duration_days || 30) * 86400000).toISOString();
  const { error } = await adminRPC('admin_approve_subscription', { p_sub_id: id, p_expires_at: expiry });
  if (error) return showToast('Approve failed: ' + error.message);
  showToast('Subscription approved ✓'); adminMonetization();
}
window.approveSubscription = approveSubscription;



// ==================== APP SETTINGS TAB ====================
async function adminAppSettings(token = window._adminRenderToken) {
  const { data: allSettings } = await db(sb.from('system_settings').select('*'), 'Settings error');
  const { data: flags } = await db(sb.from('feature_flags').select('*').order('name'), 'Flags error');
  if (_renderStale(token)) return;
  const S = key => allSettings?.find(s => s.key === key)?.value || '';

  document.getElementById('adminContent').innerHTML = `
    <!-- Branding -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">🎨 Branding & App Identity</div>
      <label class="input-label">App Name</label>
      <input id="set_appname" class="input-field" value="${S('app_name') || 'LUMHSian'}" placeholder="App name">
      <label class="input-label">App Tagline / Subtitle</label>
      <input id="set_tagline" class="input-field" value="${S('app_tagline') || 'AI-powered MBBS QBank'}" placeholder="Tagline">
      <label class="input-label">Welcome Message (shown on login screen)</label>
      <textarea id="set_welcome" class="input-field" rows="2" placeholder="e.g., Welcome! Practice smarter and score higher.">${S('welcome_message') || ''}</textarea>
      <label class="input-label">App For (shown as pill on splash)</label>
      <input id="set_for" class="input-field" value="${S('app_for') || ''}" placeholder="e.g., MBBS Students Across Pakistan">
      <label class="input-label">App Logo URL</label>
      <div class="upload-area" onclick="document.getElementById('logo_file').click()">
        ${S('app_logo') ? `<img src="${S('app_logo')}" style="height:48px">` : '📸 Upload Logo'}
      </div>
      <input type="file" id="logo_file" accept="image/*" style="display:none" onchange="uploadLogo()">
      <input id="set_logo" class="input-field" value="${S('app_logo')}" placeholder="Logo URL" style="margin-top:8px">
      <label class="input-label">Primary Color</label>
      <input type="color" id="set_color" class="input-field" style="height:44px;padding:4px 12px" value="${S('primary_color') || '#c9980a'}">
      <label class="input-label">Accent Color</label>
      <input type="color" id="set_accent" class="input-field" style="height:44px;padding:4px 12px" value="${S('accent_color') || '#e8a820'}">
      <button class="btn btn-primary mt-2" onclick="saveBranding()">💾 Save Branding</button>
    </div>

    <!-- About This App (shown in Profile → About) -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-1">ℹ️ About This App</div>
      <p class="text-xs text-muted mb-2">Pics + text about the app, shown to every student in Profile → About. Good for a feature highlight, a "how to use" tip, or anything you want students to know.</p>
      <label class="input-label">Image (optional)</label>
      <div class="upload-area" onclick="document.getElementById('ab_img_file').click()">📸 Upload image</div>
      <input type="file" id="ab_img_file" accept="image/*" style="display:none" onchange="previewAndUpload('ab_img_file','ab_img_url','ab_img_preview')">
      <img id="ab_img_preview" style="display:none;max-width:100%;border-radius:var(--radius-lg);margin:8px 0">
      <input id="ab_img_url" class="input-field" placeholder="Image URL" readonly>
      <label class="input-label">Title</label>
      <input id="ab_title" class="input-field" placeholder="e.g. New: AI Tutor is here!">
      <label class="input-label">Description</label>
      <textarea id="ab_desc" class="input-field" rows="3" placeholder="Details students will read..."></textarea>
      <button class="btn btn-primary mt-2" onclick="adminAddAboutCard()">➕ Add to Profile</button>
      <div id="aboutCardsList" style="margin-top:12px"></div>
    </div>

    <!-- App Wallpaper -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">🖼️ App Background Wallpaper</div>
      <p class="text-xs text-muted mb-2">Optional subtle background for the whole app. Leave empty for the default clean look.</p>
      <div class="upload-area" onclick="document.getElementById('wallpaper_file').click()">
        ${S('app_wallpaper_url') ? `<img src="${S('app_wallpaper_url')}" style="height:60px;border-radius:8px">` : '📸 Upload Wallpaper'}
      </div>
      <input type="file" id="wallpaper_file" accept="image/*" style="display:none" onchange="uploadWallpaper()">
      <div class="btn-row mt-2">
        <input type="range" id="set_wallpaper_opacity" min="5" max="100" value="${S('app_wallpaper_opacity') || '8'}" style="flex:1">
        <span class="text-xs text-muted">Opacity</span>
      </div>
      <button class="btn btn-secondary btn-sm mt-2" onclick="saveSetting('app_wallpaper_opacity',document.getElementById('set_wallpaper_opacity').value);applyWallpaper();showToast('Saved ✓')">Save Opacity</button>
      ${S('app_wallpaper_url') ? `<button class="btn btn-ghost btn-sm mt-1" onclick="saveSetting('app_wallpaper_url','');applyWallpaper();adminAppSettings()">🗑 Remove Wallpaper</button>` : ''}
    </div>

    <!-- What's New -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">🆕 "What's New" Popup</div>
      <p class="text-xs text-muted mb-2">Shows once to every student after you publish an update. Bump the version to show it again.</p>
      <label class="input-label">Version Tag</label>
      <input id="set_wn_version" class="input-field" value="${S('whats_new_version') || '1.0'}" placeholder="e.g. 1.1">
      <label class="input-label">What's New Text</label>
      <textarea id="set_wn_text" class="input-field" rows="3" placeholder="e.g. ✨ New: Custom Test Builder, Weak Topics review, and more!">${S('whats_new_text')}</textarea>
      <button class="btn btn-primary mt-2" onclick="saveSetting('whats_new_version',document.getElementById('set_wn_version').value);saveSetting('whats_new_text',document.getElementById('set_wn_text').value);showToast('Published ✓ Students will see it next time they open the app.')">📣 Publish Update Note</button>
    </div>

    <!-- Backup -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">📦 Database Backup</div>
      <p class="text-xs text-muted mb-2">Downloads a full JSON snapshot of your data (questions, users, settings, etc.) for safekeeping.</p>
      <button class="btn btn-secondary" onclick="exportFullBackup()">📥 Download Full Backup</button>
    </div>

    <!-- Privacy & Legal Text -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">🔒 Privacy & Legal Messages</div>
      <p class="text-xs text-muted mb-2">Privacy Policy and Terms of Service already have full pages in-app (Profile → About & Legal). The fields below are optional extras.</p>
      <label class="input-label">Privacy Banner Message</label>
      <textarea id="set_privacy" class="input-field" rows="2" placeholder="e.g., Your data is safe with us and never shared with third parties.">${S('privacy_message') || 'Your data is safe with us and is never shared with third parties.'}</textarea>
      <label class="input-label">Terms of Service URL (optional, adds a "view full terms" link)</label>
      <input id="set_tos" class="input-field" value="${S('tos_url')}" placeholder="https://...">
      <label class="input-label">Privacy Policy URL (optional, adds a "view full policy" link)</label>
      <input id="set_pp" class="input-field" value="${S('privacy_policy_url')}" placeholder="https://...">
      <label class="input-label">Contact Email (shown on forgot password & legal pages)</label>
      <input id="set_email" class="input-field" value="${S('contact_email') || ADMIN_EMAIL}" placeholder="admin@...">
      <button class="btn btn-primary mt-2" onclick="saveLegalSettings()">💾 Save Legal</button>
    </div>

    <!-- Maintenance & Access -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">⚙️ System Control</div>
      <div class="flex-between mb-3">
        <div>
          <div class="fw-600">🚧 Maintenance Mode</div>
          <div class="text-xs text-muted">Students will see maintenance message and cannot login</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="set_maintenance" ${S('maintenance_mode') === 'true' ? 'checked' : ''} onchange="toggleMaintenanceMode(this.checked)">
          <span class="toggle-knob"></span>
        </label>
      </div>
      <label class="input-label">Maintenance Message</label>
      <textarea id="set_maint_msg" class="input-field" rows="2" placeholder="e.g., App is under maintenance. Back soon!">${S('maintenance_message') || 'App is under maintenance. Please check back later.'}</textarea>
      <button class="btn btn-secondary btn-sm" onclick="saveSetting('maintenance_message',document.getElementById('set_maint_msg').value)">Save Message</button>
      <hr class="divider">
      <div class="flex-between mb-2">
        <div>
          <div class="fw-600">🆕 New Signup</div>
          <div class="text-xs text-muted">Allow new student registrations</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="set_signup" ${S('signup_enabled') !== 'false' ? 'checked' : ''} onchange="saveSetting('signup_enabled',this.checked)">
          <span class="toggle-knob"></span>
        </label>
      </div>
      <div class="flex-between mb-2">
        <div>
          <div class="fw-600">📧 OTP Verification</div>
          <div class="text-xs text-muted">Require email OTP on signup</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="set_otp" ${S('otp_required') !== 'false' ? 'checked' : ''} onchange="saveSetting('otp_required',this.checked)">
          <span class="toggle-knob"></span>
        </label>
      </div>
      <div class="flex-between">
        <div>
          <div class="fw-600">🌐 Public Leaderboard</div>
          <div class="text-xs text-muted">Show leaderboard to all students</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="set_lb" ${S('leaderboard_public') !== 'false' ? 'checked' : ''} onchange="saveSetting('leaderboard_public',this.checked)">
          <span class="toggle-knob"></span>
        </label>
      </div>
    </div>

    <!-- Feature Flags -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">🚩 Feature Flags (Turn Features ON/OFF)</div>
      <p class="text-xs text-muted mb-3">Control which features are available to students without changing code.</p>
      ${(flags||[]).map(f => `
        <div class="flex-between" style="padding:10px 0;border-bottom:1px solid var(--border)">
          <div>
            <div class="fw-600 text-sm">${f.label || f.name}</div>
            <div class="text-xs text-muted">${f.description || ''}</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" ${f.is_enabled ? 'checked' : ''} onchange="toggleFeatureFlag('${f.name}',this.checked)">
            <span class="toggle-knob"></span>
          </label>
        </div>`).join('') || `
        <p class="text-muted text-sm">No feature flags. Creating defaults...</p>
        <button class="btn btn-secondary btn-sm mt-2" onclick="createDefaultFlags()">Create Default Flags</button>`}
    </div>

    <!-- AI Settings -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">🤖 AI Tutor Settings</div>
      <p class="text-xs text-muted mb-2">This powers the "🤖 Explain with AI" button students see during practice/review. Works with any OpenAI-compatible API (DeepSeek, OpenAI) or Google Gemini.</p>
      <label class="input-label">AI Provider</label>
      <select id="ai_provider" class="input-field" title="AI provider" aria-label="AI provider">
        <option value="deepseek" ${S('ai_provider') === 'deepseek' || !S('ai_provider') ? 'selected' : ''}>DeepSeek</option>
        <option value="openai" ${S('ai_provider') === 'openai' ? 'selected' : ''}>OpenAI GPT</option>
        <option value="gemini" ${S('ai_provider') === 'gemini' ? 'selected' : ''}>Google Gemini</option>
      </select>
      <label class="input-label">AI API URL</label>
      <input id="set_ai_url" class="input-field" value="${S('ai_api_url') || 'https://api.deepseek.com/v1'}" placeholder="e.g. https://api.deepseek.com/v1">
      <div class="text-xs text-muted mb-2">DeepSeek: <code>https://api.deepseek.com/v1</code> · OpenAI: <code>https://api.openai.com/v1</code> · Gemini: <code>https://generativelanguage.googleapis.com/v1beta</code></div>
      <label class="input-label">AI Model Name</label>
      <input id="set_ai_model" class="input-field" value="${S('ai_model') || 'deepseek-chat'}" placeholder="e.g. deepseek-chat, gpt-4o-mini, gemini-1.5-flash">
      <label class="input-label">Global AI API Key (shared for all students)</label>
      <input id="set_ai_key" class="input-field" type="password" value="" maxlength="300" placeholder="${S('ai_key_set') === 'true' ? '🔒 Key already saved, leave blank to keep it' : 'Enter your API key...'}">
      <div class="text-xs text-muted mb-2">Students never see or need their own key. This one key powers AI Tutor for everyone. For security, a saved key is never shown back here, so leave this field blank when saving other settings to keep it unchanged.</div>
      <label class="input-label">AI Tutor Personality / Instructions</label>
      <textarea id="set_ai_prompt" class="input-field" rows="3" style="resize:vertical">${S('ai_system_prompt') || 'You are an expert MBBS tutor for Pakistani medical students. Explain concepts clearly in simple English. Be concise, accurate, and encouraging.'}</textarea>
      <div class="flex-between mb-2">
        <div><div class="fw-600 text-sm">AI Tutor Feature</div><div class="text-xs text-muted">Enable AI explanations for students</div></div>
        <label class="toggle-switch">
          <input type="checkbox" id="set_ai_enabled" ${S('ai_enabled') !== 'false' ? 'checked' : ''}>
          <span class="toggle-knob"></span>
        </label>
      </div>
      <div class="btn-row">
        <button class="btn btn-secondary" onclick="saveAISettings()">💾 Save AI Settings</button>
        <button class="btn btn-primary" onclick="testAIConnection()">🔌 Test Connection</button>
      </div>
      <div id="aiTestResult" style="margin-top:10px"></div>
    </div>

    <!-- Donations Settings -->
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">💛 Donations Settings</div>
      <p class="text-xs text-muted mb-2">Shows a "Support Us" option to students in their Profile, with whatever payment details you enter below. Toggle off any time to hide it completely.</p>
      <div class="flex-between mb-2">
        <div><div class="fw-600 text-sm">Donations Feature</div><div class="text-xs text-muted">Show "Support Us" to students</div></div>
        <label class="toggle-switch">
          <input type="checkbox" id="set_don_enabled" ${S('donation_enabled') === 'true' ? 'checked' : ''}>
          <span class="toggle-knob"></span>
        </label>
      </div>
      <label class="input-label">JazzCash Number</label>
      <input id="set_don_jazzcash" class="input-field" value="${S('donation_jazzcash')}" placeholder="e.g. 0300-1234567 (Name)">
      <label class="input-label">Easypaisa Number</label>
      <input id="set_don_easypaisa" class="input-field" value="${S('donation_easypaisa')}" placeholder="e.g. 0345-1234567 (Name)">
      <label class="input-label">Bank Account Details</label>
      <textarea id="set_don_bank" class="input-field" rows="2" style="resize:vertical" placeholder="e.g. Meezan Bank, Account Title, Account No.">${S('donation_bank')}</textarea>
      <label class="input-label">Message to Students</label>
      <textarea id="set_don_message" class="input-field" rows="2" style="resize:vertical" placeholder="e.g. Help us keep LUMHSian free for everyone!">${S('donation_message') || 'Help us keep this app free and growing for every student. Any contribution helps!'}</textarea>
      <div class="btn-row mt-2">
        <button class="btn btn-secondary" onclick="saveDonationSettings()">💾 Save Donation Settings</button>
      </div>
    </div>

    <!-- Audit Log -->
    <div class="card">
      <div class="fw-700 mb-2">📋 Recent Admin Actions</div>
      <div id="auditLogList"><div class="spinner" style="margin:12px auto"></div></div>
    </div>`;

  loadAuditLog();
  loadAboutCardsList();
}
window.adminAppSettings = adminAppSettings;



async function saveDonationSettings() {
  const enabled = document.getElementById('set_don_enabled').checked;
  const jazzcash = document.getElementById('set_don_jazzcash').value.trim();
  const easypaisa = document.getElementById('set_don_easypaisa').value.trim();
  const bank = document.getElementById('set_don_bank').value.trim();
  const message = document.getElementById('set_don_message').value.trim();
  await Promise.all([
    saveSetting('donation_enabled', enabled),
    saveSetting('donation_jazzcash', jazzcash),
    saveSetting('donation_easypaisa', easypaisa),
    saveSetting('donation_bank', bank),
    saveSetting('donation_message', message)
  ]);
  await loadAppSettings();
  showToast('Donation settings saved ✓');
  logAdminAction('Updated Donation settings');
}
window.saveDonationSettings = saveDonationSettings;



// ==================== ABOUT CARDS (Profile → About) ====================
async function loadAboutCardsList() {
  const el = document.getElementById('aboutCardsList');
  if (!el) return;
  const r = await sb.from('about_cards').select('*').order('created_at', { ascending: true });
  if (r.error) { el.innerHTML = '<p class="text-xs text-muted">⚠️ Run the About Cards setup SQL first (see chat), then reload this tab.</p>'; return; }
  const cards = r.data;
  if (!cards || !cards.length) { el.innerHTML = '<p class="text-xs text-muted">No About cards yet. Add one above.</p>'; return; }
  el.innerHTML = cards.map(c => `
    <div class="admin-row">
      <div class="admin-row-left">
        <div style="display:flex;gap:8px;align-items:flex-start">
          ${c.image_url ? `<img src="${esc(c.image_url)}" style="width:44px;height:44px;object-fit:cover;border-radius:var(--radius-md);flex-shrink:0">` : ''}
          <div>
            <div class="fw-700">${esc(c.title) || '(No title)'}</div>
            <div class="text-xs text-muted">${esc(c.description) || ''}</div>
            <span class="badge ${c.is_active ? 'badge-green' : 'badge-amber'}" style="margin-top:4px;display:inline-block">${c.is_active ? '🟢 Visible to students' : '⏸ Hidden'}</span>
          </div>
        </div>
      </div>
      <div class="admin-row-actions">
        <button class="btn btn-secondary btn-xs" onclick="toggleAboutCard(${c.id},${c.is_active})">${c.is_active ? '⏸ Hide' : '▶ Show'}</button>
        <button class="btn btn-danger btn-xs" onclick="deleteAboutCard(${c.id})">🗑</button>
      </div>
    </div>`).join('');
}



async function adminAddAboutCard() {
  const image_url = document.getElementById('ab_img_url').value.trim() || null;
  const title = document.getElementById('ab_title').value.trim();
  const description = document.getElementById('ab_desc').value.trim();
  if (!title) return showToast('Please enter a title');
  await db(sb.from('about_cards').insert({ image_url, title, description, is_active: true, created_at: new Date().toISOString() }), 'Add failed');
  showToast('Added to Profile → About ✓');
  logAdminAction('Added an About card', title);
  document.getElementById('ab_title').value = '';
  document.getElementById('ab_desc').value = '';
  document.getElementById('ab_img_url').value = '';
  const prev = document.getElementById('ab_img_preview'); if (prev) prev.style.display = 'none';
  loadAboutCardsList();
}
window.adminAddAboutCard = adminAddAboutCard;



async function toggleAboutCard(id, current) {
  await db(sb.from('about_cards').update({ is_active: !current }).eq('id', id), 'Toggle failed');
  showToast(current ? 'Hidden from students' : 'Now visible to students');
  loadAboutCardsList();
}
window.toggleAboutCard = toggleAboutCard;



async function deleteAboutCard(id) {
  showConfirm('Delete this About card?', async () => {
    await db(sb.from('about_cards').delete().eq('id', id), 'Delete failed');
    showToast('Deleted');
    loadAboutCardsList();
  }, 'Delete');
}
window.deleteAboutCard = deleteAboutCard;



async function saveAISettings() {
  const provider = document.getElementById('ai_provider').value;
  const url = document.getElementById('set_ai_url').value.trim();
  const model = document.getElementById('set_ai_model').value.trim();
  const key = document.getElementById('set_ai_key').value.trim();
  const prompt = document.getElementById('set_ai_prompt').value.trim();
  const enabled = document.getElementById('set_ai_enabled').checked;
  const saves = [
    saveSetting('ai_provider', provider),
    saveSetting('ai_api_url', url),
    saveSetting('ai_model', model),
    saveSetting('ai_system_prompt', prompt),
    saveSetting('ai_enabled', enabled)
  ];
  // Only touch the key if admin actually typed a new one — an empty field means "keep existing key".
  if (key) {
    saves.push(saveSetting('ai_api_key', key));
    saves.push(saveSetting('ai_key_set', 'true'));
  }
  await Promise.all(saves);
  // Keep the Feature Flags "AI Tutor" toggle in sync with this checkbox —
  // they used to be two disconnected switches that both looked like a kill
  // switch but only one worked. See isAIEnabled().
  await db(sb.from('feature_flags').update({ is_enabled: enabled }).eq('name', 'ai_tutor'), 'Flag sync failed');
  document.getElementById('set_ai_key').value = '';
  await loadAppSettings(); // refresh the in-memory cache so it's used immediately
  showToast('AI settings saved ✓');
  logAdminAction('Updated AI Tutor settings');
}
window.saveAISettings = saveAISettings;



async function testAIConnection() {
  const el = document.getElementById('aiTestResult');
  el.innerHTML = `<div class="spinner" style="margin:8px auto"></div>`;
  // Save first so the test uses exactly what's on screen right now
  await saveAISettings();
  const reply = await callAIRaw('Reply with exactly one short sentence confirming you are connected.');
  if (reply.ok) {
    el.innerHTML = `<div class="badge badge-green">✅ Connected. AI replied: "${esc(reply.text.slice(0,120))}"</div>`;
  } else {
    el.innerHTML = `<div class="badge badge-red">❌ Failed: ${esc(reply.text)}</div>`;
  }
}
window.testAIConnection = testAIConnection;



async function loadAuditLog() {
  const { data: logs } = await db(
    sb.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(20),
    'Audit error'
  );
  const el = document.getElementById('auditLogList');
  if (!el) return;
  el.innerHTML = (logs||[]).map(l => `
    <div style="padding:8px 0;border-bottom:1px solid var(--border)">
      <div class="text-sm fw-600">${l.action}</div>
      <div class="text-xs text-muted">${l.admin_email} · ${l.details || ''} · ${timeAgo(new Date(l.created_at).getTime())}</div>
    </div>`).join('') || '<p class="text-muted text-sm">No actions yet.</p>';
}



async function saveBranding() {
  await Promise.all([
    saveSetting('app_name', document.getElementById('set_appname').value),
    saveSetting('app_tagline', document.getElementById('set_tagline').value),
    saveSetting('app_logo', document.getElementById('set_logo').value),
    saveSetting('primary_color', document.getElementById('set_color').value),
    saveSetting('accent_color', document.getElementById('set_accent').value),
    saveSetting('welcome_message', document.getElementById('set_welcome').value),
    saveSetting('app_for', document.getElementById('set_for').value),
  ]);
  await loadAppSettings();
  applyBranding();
  showToast('Branding saved ✓');
  logAdminAction('Updated branding settings');
}
window.saveBranding = saveBranding;



async function saveLegalSettings() {
  await Promise.all([
    saveSetting('privacy_message', document.getElementById('set_privacy').value),
    saveSetting('tos_url', document.getElementById('set_tos').value),
    saveSetting('privacy_policy_url', document.getElementById('set_pp').value),
    saveSetting('contact_email', document.getElementById('set_email').value),
  ]);
  showToast('Legal settings saved ✓');
}
window.saveLegalSettings = saveLegalSettings;



async function toggleMaintenanceMode(enabled) {
  await saveSetting('maintenance_mode', enabled);
  window.maintenanceMode = enabled;
  showToast(enabled ? '🚧 Maintenance mode ON' : '✅ Maintenance mode OFF');
  logAdminAction(enabled ? 'Enabled maintenance mode' : 'Disabled maintenance mode');
}
window.toggleMaintenanceMode = toggleMaintenanceMode;



async function toggleFeatureFlag(name, enabled) {
  await db(sb.from('feature_flags').update({ is_enabled: enabled }).eq('name', name), 'Flag update failed');
  cacheClear('feature_flags');
  if (name === 'ai_tutor') {
    // Keep the AI Tutor Settings checkbox in sync with this flag — see isAIEnabled().
    await saveSetting('ai_enabled', enabled);
    await loadAppSettings();
  }
  showToast(`${name}: ${enabled ? 'Enabled' : 'Disabled'}`);
  logAdminAction(`Feature flag '${name}' set to ${enabled}`);
}
window.toggleFeatureFlag = toggleFeatureFlag;



async function createDefaultFlags() {
  const defaultFlags = [
    { name: 'ai_tutor', label: '🤖 AI Tutor', description: 'AI-powered explanation for MCQs', is_enabled: true },
    { name: 'leaderboard', label: '🏆 Leaderboard', description: 'Show student rankings', is_enabled: true },
    { name: 'bookmarks', label: '📖 Bookmarks', description: 'Save MCQs for later review', is_enabled: true },
    { name: 'past_papers', label: '📜 Past Papers', description: 'Timed past paper exams', is_enabled: true },
    { name: 'planner', label: '📅 Study Planner', description: 'Daily goal and streak system', is_enabled: true },
    { name: 'dark_mode', label: '🌙 Dark Mode', description: 'Dark theme option for students', is_enabled: false },
    { name: 'notifications', label: '🔔 Push Notifications', description: 'Browser push notifications', is_enabled: false },
    { name: 'adaptive_quiz', label: '🧠 Adaptive Quiz', description: 'Difficulty adapts to student performance', is_enabled: false },
    { name: 'negative_marking', label: '➖ Negative Marking', description: 'Deduct marks for wrong answers', is_enabled: false },
    { name: 'video_explanations', label: '🎥 Video Explanations', description: 'Video support in explanations', is_enabled: false },
  ];
  for (const f of defaultFlags) {
    await db(sb.from('feature_flags').upsert(f, { onConflict: 'name' }), 'Flag create failed');
  }
  cacheClear('feature_flags');
  showToast('Default flags created ✓');
  adminAppSettings();
}
window.createDefaultFlags = createDefaultFlags;



async function uploadWallpaper() {
  const file = document.getElementById('wallpaper_file')?.files[0];
  if (!file) return;
  openImageCropper(file, 0.6, async (blob) => {
    showLoading(true, 'Uploading wallpaper...');
    const path = `branding/wallpaper_${Date.now()}.jpg`;
    const { error } = await sb.storage.from('module-images').upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
    if (error) { showLoading(false); showToast('Upload failed'); return; }
    const { data: urlData } = sb.storage.from('module-images').getPublicUrl(path);
    await saveSetting('app_wallpaper_url', urlData.publicUrl);
    await loadAppSettings();
    applyWallpaper();
    showLoading(false); showToast('Wallpaper uploaded ✓');
    adminAppSettings();
  });
}
window.uploadWallpaper = uploadWallpaper;



export function applyWallpaper() {
  const url = getSetting('app_wallpaper_url', '');
  const opacityVal = (parseInt(getSetting('app_wallpaper_opacity', '8')) || 8);
  const opacity = opacityVal / 100; // e.g. 8 → 0.08, 80 → 0.80
  let el = document.getElementById('_appWallpaper');
  if (!el) {
    el = document.createElement('div');
    el.id = '_appWallpaper';
    el.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;background-size:cover;background-position:center;transition:opacity .3s';
    document.body.prepend(el);
  }
  if (url) {
    el.style.backgroundImage = `url('${url}')`;
    el.style.opacity = opacity;
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}
window.applyWallpaper = applyWallpaper;



async function exportFullBackup() {
  showLoading(true, 'Preparing backup...');
  const tables = ['users','user_stats','colleges','years','modules','year_modules','subjects','past_papers',
    'questions','bookmarks','announcements','system_settings','feature_flags','reports_feedback',
    'question_comments','custom_tests','subscription_plans','subscriptions'];
  const backup = { exported_at: new Date().toISOString(), app: 'LUMHSian' };
  const failedTables = [];
  try {
    for (const t of tables) {
      try {
        const { data, error } = await sb.from(t).select('*');
        if (error) throw error;
        backup[t] = data || [];
      } catch (e) {
        // One inaccessible/failed table shouldn't abort the whole backup —
        // export what we can and tell the admin which parts are missing.
        console.warn(`Backup: failed to export table '${t}'`, e);
        backup[t] = [];
        failedTables.push(t);
      }
    }
  } finally {
    showLoading(false);
  }
  if (failedTables.length) showToast(`⚠️ ${failedTables.length} table(s) couldn't be exported: ${failedTables.join(', ')}`, 9000);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lumhsian_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  showToast('Backup downloaded ✓');
  logAdminAction('Downloaded full database backup');
}
window.exportFullBackup = exportFullBackup;



async function uploadLogo() {
  const file = document.getElementById('logo_file')?.files[0];
  if (!file) return;
  openImageCropper(file, 1, async (blob) => {
    showLoading(true, 'Uploading logo...');
    const path = `branding/logo_${Date.now()}.jpg`;
    const { error } = await sb.storage.from('module-images').upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
    if (error) { showLoading(false); showToast('Upload failed'); return; }
    const { data: urlData } = sb.storage.from('module-images').getPublicUrl(path);
    document.getElementById('set_logo').value = urlData.publicUrl;
    showLoading(false); showToast('Logo uploaded ✓');
  });
}
window.uploadLogo = uploadLogo;



async function applyBranding() {
  const { data: settings } = await db(sb.from('system_settings').select('*').in('key', ['app_name','app_tagline','primary_color','accent_color','privacy_message','welcome_message','app_for']), 'Settings error');
  const S = key => settings?.find(s => s.key === key)?.value || '';
  if (S('primary_color')) document.documentElement.style.setProperty('--gold-600', S('primary_color'));
  if (S('accent_color')) document.documentElement.style.setProperty('--gold-400', S('accent_color'));
  if (S('app_name')) { const el = document.getElementById('splashAppName'); if (el) el.textContent = S('app_name'); }
  if (S('app_tagline')) { const el = document.getElementById('appTagline'); if (el) el.textContent = S('app_tagline'); }
  if (S('app_for')) { const el = document.getElementById('splashAppForPill'); if (el) { el.textContent = '🎓 ' + S('app_for'); el.style.display = 'inline-block'; } }
  if (S('welcome_message')) { const el = document.getElementById('splashWelcomeMessage'); if (el) { el.textContent = S('welcome_message'); el.style.display = 'block'; } }
  if (S('privacy_message')) window._privacyMsg = S('privacy_message');
}



// ==================== ANALYTICS TAB ====================
async function adminAnalytics(token = window._adminRenderToken) {
  if (_renderStale(token)) return;
  document.getElementById('adminContent').innerHTML = `
    <div class="tab-bar">
      <button class="tab-btn active" onclick="analyticsTab('realtime',this)">🟢 Real-Time</button>
      <button class="tab-btn" onclick="analyticsTab('engagement',this)">📈 Engagement</button>
      <button class="tab-btn" onclick="analyticsTab('content',this)">📚 Content</button>
      <button class="tab-btn" onclick="analyticsTab('retention',this)">🔄 Retention</button>
    </div>
    <div id="analyticsBody"></div>`;
  analyticsTab('realtime', document.querySelector('.tab-bar .tab-btn'));
}



function analyticsTab(tab, btn) {
  document.querySelectorAll('#adminContent .tab-bar .tab-btn').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  const fns = { realtime: analyticsRealtime, engagement: analyticsEngagement, content: analyticsContent, retention: analyticsRetention };
  if (fns[tab]) fns[tab]();
}
window.analyticsTab = analyticsTab;



async function analyticsRealtime() {
  const now = Date.now();
  const [usersRes, statsRes] = await Promise.all([
    db(sb.from('users').select('name,email,college,gender,last_active,last_heartbeat,current_screen'), 'Users error'),
    db(sb.from('user_stats').select('email,total_tests,total_questions,streak'), 'Stats error')
  ]);
  const users = usersRes.data || [];
  const online = users.filter(u => u.last_heartbeat && (now - new Date(u.last_heartbeat).getTime()) < 120000);
  const activeToday = users.filter(u => u.last_active && (now - u.last_active) < 86400000);

  const collegeOnline = {};
  for (const u of online) {
    const c = u.college || 'Unknown';
    collegeOnline[c] = (collegeOnline[c] || 0) + 1;
  }

  document.getElementById('analyticsBody').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px">
      <div class="stat-box"><div class="stat-val" style="color:var(--green)">${online.length}</div><div class="stat-key">🟢 Online Now</div></div>
      <div class="stat-box"><div class="stat-val">${activeToday.length}</div><div class="stat-key">Active Today</div></div>
      <div class="stat-box"><div class="stat-val">${users.length}</div><div class="stat-key">Total Students</div></div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="flex-between mb-2">
        <div class="fw-700">🟢 Live Students (${online.length})</div>
        <button class="btn btn-ghost btn-xs" onclick="analyticsRealtime()">🔄 Refresh</button>
      </div>
      ${online.length ? online.map(u => `
        <div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="adminViewStudentDetail('${u.email}')">
          <div>
            <div class="fw-600 text-sm">${esc(u.name) || esc(u.email)}</div>
            <div class="text-xs text-muted">${esc(u.college) || 'No college'} · ${u.current_screen ? '📍 ' + esc(u.current_screen) : 'Active'}</div>
          </div>
          <span class="badge badge-green" style="font-size:10px">🟢 Online</span>
        </div>`).join('') : '<p class="text-muted text-sm">No students online right now.</p>'}
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">🏫 Online by College</div>
      ${Object.entries(collegeOnline).map(([c, n]) => `
        <div class="flex-between" style="padding:6px 0;border-bottom:1px solid var(--border)">
          <span class="text-sm fw-600">${esc(c)}</span>
          <span class="badge badge-green">${n} online</span>
        </div>`).join('') || '<p class="text-muted text-sm">No data</p>'}
    </div>

    <div class="card">
      <div class="fw-700 mb-2">📅 Active Today by College</div>
      ${(() => {
        const map = {};
        for (const u of activeToday) { const c = u.college||'Unknown'; map[c] = (map[c]||0)+1; }
        return Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([c,n]) => `
          <div class="flex-between" style="padding:6px 0;border-bottom:1px solid var(--border)">
            <span class="text-sm fw-600">${c}</span>
            <div style="display:flex;align-items:center;gap:8px">
              <div class="progress-track" style="width:80px;margin:0"><div class="progress-fill" style="width:${Math.round(n/activeToday.length*100)}%"></div></div>
              <span class="badge badge-teal">${n}</span>
            </div>
          </div>`).join('') || '<p class="text-muted text-sm">No data</p>';
      })()}
    </div>`;

  // Auto-refresh every 30 seconds
  clearTimeout(window._realtimeTimer);
  window._realtimeTimer = setTimeout(() => {
    if (document.getElementById('analyticsBody')) analyticsRealtime();
  }, 30000);
}
window.analyticsRealtime = analyticsRealtime;



async function analyticsEngagement() {
  const { data: stats } = await db(sb.from('user_stats').select('*'), 'Stats error');
  const { data: users } = await db(sb.from('users').select('college,gender,joined'), 'Users error');
  const all = stats || [];

  const totalTests = all.reduce((a, s) => a + (s.total_tests||0), 0);
  const totalQ = all.reduce((a, s) => a + (s.total_questions||0), 0);
  const totalCorrect = all.reduce((a, s) => a + (s.total_correct||0), 0);
  const avgAcc = totalQ ? Math.round(totalCorrect/totalQ*100) : 0;
  const avgStreak = all.length ? Math.round(all.reduce((a,s)=>a+(s.streak||0),0)/all.length) : 0;
  const activeStreaks = all.filter(s => (s.streak||0) >= 7).length;

  // History analysis
  const allHistory = all.flatMap(s => s.history || []);
  const byModule = {};
  const byType = {};
  for (const h of allHistory) {
    if (h.module) byModule[h.module] = (byModule[h.module]||0)+1;
    if (h.type) byType[h.type] = (byType[h.type]||0)+1;
  }

  document.getElementById('analyticsBody').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:16px">
      <div class="stat-box"><div class="stat-val">${totalTests.toLocaleString()}</div><div class="stat-key">Total Tests</div></div>
      <div class="stat-box"><div class="stat-val">${totalQ.toLocaleString()}</div><div class="stat-key">Q Attempted</div></div>
      <div class="stat-box"><div class="stat-val">${avgAcc}%</div><div class="stat-key">Avg Accuracy</div></div>
      <div class="stat-box"><div class="stat-val">${avgStreak}</div><div class="stat-key">Avg Streak</div></div>
      <div class="stat-box"><div class="stat-val">${activeStreaks}</div><div class="stat-key">7+ Day Streaks</div></div>
      <div class="stat-box"><div class="stat-val">${allHistory.length}</div><div class="stat-key">Total Sessions</div></div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">📚 Most Used Modules</div>
      ${Object.entries(byModule).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([m,c]) => `
        <div class="flex-between" style="padding:7px 0;border-bottom:1px solid var(--border)">
          <span class="text-sm fw-600">${m}</span>
          <div style="display:flex;align-items:center;gap:8px">
            <div class="progress-track" style="width:80px;margin:0"><div class="progress-fill" style="width:${Math.round(c/allHistory.length*100)}%"></div></div>
            <span class="text-xs fw-700">${c} tests</span>
          </div>
        </div>`).join('') || '<p class="text-muted">No data</p>'}
    </div>

    <div class="card">
      <div class="fw-700 mb-2">📝 Test Types Distribution</div>
      ${Object.entries(byType).map(([t,c]) => `
        <div class="flex-between" style="padding:7px 0;border-bottom:1px solid var(--border)">
          <span class="text-sm fw-600">${t}</span>
          <span class="badge badge-teal">${c}</span>
        </div>`).join('') || '<p class="text-muted">No data</p>'}
    </div>`;
}



async function analyticsContent() {
  const { data: questions } = await db(
    sb.from('questions').select('id,module_id,difficulty,modules(name)'),
    'Q error'
  );
  const qs = questions || [];
  const byDiff = { easy: 0, medium: 0, hard: 0 };
  const byModule = {};
  for (const q of qs) {
    byDiff[q.difficulty || 'medium']++;
    const name = q.modules?.name || 'Unknown';
    byModule[name] = (byModule[name] || 0) + 1;
  }

  const { data: bookmarks } = await db(
    sb.from('bookmarks').select('question_id,was_correct'),
    'Bookmarks error'
  );
  const wrongBookmarks = (bookmarks||[]).filter(b => b.was_correct === false).length;

  document.getElementById('analyticsBody').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px">
      <div class="stat-box"><div class="stat-val">${qs.length}</div><div class="stat-key">Total MCQs</div></div>
      <div class="stat-box"><div class="stat-val" style="color:var(--green)">${byDiff.easy}</div><div class="stat-key">Easy</div></div>
      <div class="stat-box"><div class="stat-val" style="color:var(--amber)">${byDiff.medium}</div><div class="stat-key">Medium</div></div>
      <div class="stat-box"><div class="stat-val" style="color:var(--red)">${byDiff.hard}</div><div class="stat-key">Hard</div></div>
      <div class="stat-box"><div class="stat-val">${(bookmarks||[]).length}</div><div class="stat-key">Bookmarks</div></div>
      <div class="stat-box"><div class="stat-val" style="color:var(--red)">${wrongBookmarks}</div><div class="stat-key">Saved Wrong Q</div></div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">📚 Questions by Module</div>
      ${Object.entries(byModule).sort((a,b)=>b[1]-a[1]).map(([m,c]) => `
        <div class="flex-between" style="padding:7px 0;border-bottom:1px solid var(--border)">
          <span class="text-sm fw-600">${m}</span>
          <div style="display:flex;align-items:center;gap:8px">
            <div class="progress-track" style="width:80px;margin:0"><div class="progress-fill" style="width:${qs.length?Math.round(c/qs.length*100):0}%"></div></div>
            <span class="text-xs fw-700">${c}</span>
          </div>
        </div>`).join('') || '<p class="text-muted">No questions</p>'}
    </div>

    <div class="card">
      <div class="fw-700 mb-2">📊 Difficulty Distribution</div>
      <canvas id="diffCanvas" height="100" style="width:100%"></canvas>
    </div>`;

  requestAnimationFrame(() => {
    const canvas = document.getElementById('diffCanvas');
    if (!canvas) return;
    canvas.width = canvas.parentElement.offsetWidth - 40;
    const ctx = canvas.getContext('2d');
    const data = [byDiff.easy, byDiff.medium, byDiff.hard];
    const colors = ['#059669', '#d97706', '#dc2626'];
    const labels = ['Easy', 'Medium', 'Hard'];
    const total = data.reduce((a,b) => a+b, 0) || 1;
    const W = canvas.width, H = 100;
    const barW = Math.floor(W / 3) - 16;
    const maxVal = Math.max(...data, 1);
    ctx.clearRect(0, 0, W, H);
    data.forEach((v, i) => {
      const bH = Math.round((v / maxVal) * 70);
      const x = i * (W / 3) + 8;
      ctx.fillStyle = colors[i];
      ctx.beginPath();
      ctx.roundRect(x, 75 - bH, barW, bH || 2, [4,4,0,0]);
      ctx.fill();
      ctx.fillStyle = '#171717'; ctx.font = 'bold 11px Inter'; ctx.textAlign = 'center';
      ctx.fillText(`${labels[i]}: ${v}`, x + barW/2, 88);
      if (v > 0) { ctx.fillStyle = colors[i]; ctx.fillText(`${Math.round(v/total*100)}%`, x + barW/2, 72 - bH); }
    });
  });
}



async function analyticsRetention() {
  const { data: users } = await db(sb.from('users').select('joined,last_active,college'), 'Users error');
  const { data: stats } = await db(sb.from('user_stats').select('email,total_tests,streak,last_practice_date,history'), 'Stats error');
  const now = Date.now();
  const all = users || [];

  const dau = all.filter(u => u.last_active > now - 86400000).length;
  const wau = all.filter(u => u.last_active > now - 604800000).length;
  const mau = all.filter(u => u.last_active > now - 2592000000).length;
  const streakAvg = stats?.length ? Math.round((stats||[]).reduce((a,s)=>a+(s.streak||0),0)/stats.length) : 0;
  const churnedUsers = all.filter(u => !u.last_active || (now - u.last_active) > 2592000000).length;

  // Cohort: signups per month
  const cohortMap = {};
  for (const u of all) {
    if (!u.joined) continue;
    const d = new Date(u.joined);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    cohortMap[key] = (cohortMap[key]||0)+1;
  }

  document.getElementById('analyticsBody').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px">
      <div class="stat-box"><div class="stat-val" style="color:var(--green)">${dau}</div><div class="stat-key">DAU (Today)</div></div>
      <div class="stat-box"><div class="stat-val">${wau}</div><div class="stat-key">WAU (7 Days)</div></div>
      <div class="stat-box"><div class="stat-val">${mau}</div><div class="stat-key">MAU (30 Days)</div></div>
      <div class="stat-box"><div class="stat-val">${all.length ? Math.round(dau/all.length*100) : 0}%</div><div class="stat-key">DAU/Total</div></div>
      <div class="stat-box"><div class="stat-val">${streakAvg}</div><div class="stat-key">Avg Streak</div></div>
      <div class="stat-box"><div class="stat-val" style="color:var(--red)">${churnedUsers}</div><div class="stat-key">Churned (30d)</div></div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">📅 Monthly Signups (Cohorts)</div>
      ${Object.entries(cohortMap).sort().slice(-6).map(([month, count]) => `
        <div class="flex-between" style="padding:7px 0;border-bottom:1px solid var(--border)">
          <span class="text-sm fw-600">${month}</span>
          <div style="display:flex;align-items:center;gap:8px">
            <div class="progress-track" style="width:100px;margin:0"><div class="progress-fill" style="width:${Math.round(count/Math.max(...Object.values(cohortMap))*100)}%"></div></div>
            <span class="badge badge-teal">${count} signups</span>
          </div>
        </div>`).join('') || '<p class="text-muted">Not enough data yet</p>'}
    </div>

    <div class="card">
      <div class="fw-700 mb-2">🏫 Retention by College</div>
      ${(() => {
        const collegeMap = {};
        for (const u of all) {
          const c = u.college||'Unknown';
          if (!collegeMap[c]) collegeMap[c] = { total:0, activeToday:0, activeWeek:0 };
          collegeMap[c].total++;
          if (u.last_active > now - 86400000) collegeMap[c].activeToday++;
          if (u.last_active > now - 604800000) collegeMap[c].activeWeek++;
        }
        return Object.entries(collegeMap).map(([c, d]) => `
          <div style="padding:10px 0;border-bottom:1px solid var(--border)">
            <div class="fw-600 text-sm mb-1">${c} <span class="text-xs text-muted">(${d.total} total)</span></div>
            <div class="flex-between">
              <span class="text-xs">Today: ${d.activeToday}</span>
              <span class="text-xs">This week: ${d.activeWeek}</span>
              <span class="text-xs">Retention: ${d.total ? Math.round(d.activeWeek/d.total*100) : 0}%</span>
            </div>
          </div>`).join('');
      })()}
    </div>`;
}



// ==================== SHARED SETTINGS HELPERS ====================
async function saveSetting(key, value) {
  await db(
    sb.from('system_settings').upsert({ key, value: String(value), updated_at: new Date().toISOString() }, { onConflict: 'key' }),
    'Setting save failed'
  );
  cacheClear('settings'); // so the change is picked up immediately, not masked by the local cache
}
window.saveSetting = saveSetting;



// getSetting is defined once, further below, as a synchronous cache lookup
// (used everywhere inline in templates, e.g. getSetting('app_tagline','')).

async function logAdminAction(action, details = '') {
  await db(sb.from('audit_logs').insert({ action, details, admin_email: window.currentUser?.email, created_at: new Date().toISOString() }), 'Log failed');
}
window.logAdminAction = logAdminAction;



// ==================== STARTUP OVERRIDE ====================
// heartbeat and notifications started after login below

// Auto-refresh admin live bar every 2 minutes
setInterval(() => {
  if (window.currentUser?.is_admin && document.getElementById('adminLiveBar')) {
    loadAdminLiveBar();
  }
}, 120000);

// ==================== MISSING FUNCTIONS FROM EARLIER PARTS ====================

// editPlan (referenced in Part 4 but not defined)
async function editPlan(id) {
  const { data: p } = await db(sb.from('subscription_plans').select('*').eq('id', id).single(), 'Load failed');
  if (!p) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:420px;max-height:90vh;overflow-y:auto">
      <div class="fw-700 mb-3">✏️ Edit Plan</div>
      <label class="input-label">Plan Name</label>
      <input id="_epl_name" class="input-field" value="${esc(p.name)}">
      <label class="input-label">Price (PKR)</label>
      <input id="_epl_price" type="number" class="input-field" title="Plan price" aria-label="Plan price" value="${p.price||0}">
      <label class="input-label">Duration (days)</label>
      <input id="_epl_days" type="number" class="input-field" title="Duration in days" aria-label="Duration in days" value="${p.duration_days||30}">
      <label class="input-label">Description</label>
      <input id="_epl_desc" class="input-field" value="${esc(p.description||'')}">
      <label class="input-label">Features (comma separated)</label>
      <textarea id="_epl_feat" class="input-field" rows="3" style="resize:vertical">${esc((p.features||[]).join(', '))}</textarea>
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="saveEditedPlan(${p.id}, this)">Save Changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.editPlan = editPlan;


// See saveEditedYear (near adminEditYear) for why this can't be an inline onclick
// IIFE. IDs renamed from _ep_* to _epl_* here since "Edit Plan" and "Edit Past
// Paper" both previously used the same _ep_ prefix — harmless while only one
// modal is ever open at a time, but renamed anyway to remove the ambiguity now
// that both have dedicated save functions sitting in the same file.
async function saveEditedPlan(id, btnEl) {
  try {
    const n = document.getElementById('_epl_name').value.trim();
    const pr = parseFloat(document.getElementById('_epl_price').value) || 0;
    const dy = parseInt(document.getElementById('_epl_days').value) || 30;
    const d = document.getElementById('_epl_desc').value.trim();
    const f = document.getElementById('_epl_feat').value.split(',').map(x => x.trim()).filter(Boolean);
    if (!n) { showToast('Plan name required'); return; }
    const { error } = await db(sb.from('subscription_plans').update({ name: n, price: pr, description: d, duration_days: dy, features: f }).eq('id', id), 'Edit failed');
    if (error) return;
    cacheClear('subscription_plans');
    showToast('Plan updated ✓');
    logAdminAction('Edited subscription plan: ' + n);
    btnEl.closest('[style*=fixed]').remove();
    adminMonetization();
  } catch (err) {
    console.error('Edit plan failed:', err);
    showToast('Unexpected error: ' + err.message, 9000);
  }
}
window.saveEditedPlan = saveEditedPlan;



// ==================== ADMIN MEDIA LIBRARY ====================
const MEDIA_PAGE_SIZE = 40;


let _mlPage = 0;


async function adminMediaLibrary(token = window._adminRenderToken, page) {
  _mlPage = (typeof page === 'number') ? page : 0;
  showToast('Loading media library...');
  const from = _mlPage * MEDIA_PAGE_SIZE;
  const to = from + MEDIA_PAGE_SIZE - 1;
  const { data: files, count } = await db(
    sb.from('media_library').select('*', { count: 'exact' }).order('uploaded_at', { ascending: false }).range(from, to),
    'Media error'
  );

  if (_renderStale(token)) return;
  const totalPages = count ? Math.max(1, Math.ceil(count / MEDIA_PAGE_SIZE)) : 1;
  document.getElementById('adminContent').innerHTML = `
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">📁 Upload to Library</div>
      <div class="upload-area" onclick="document.getElementById('mediaUploadInput').click()">
        <div style="font-size:32px">📸</div>
        <div class="text-sm mt-1">Click to upload image/document</div>
        <div class="text-xs text-muted">PNG, JPG, PDF, WebP</div>
      </div>
      <input type="file" id="mediaUploadInput" accept="image/*,.pdf" style="display:none" onchange="uploadToLibrary()">
      <input id="mediaTag" class="input-field" placeholder="Tag (e.g., anatomy, physiology)" style="margin-top:8px">
    </div>
    <div class="fw-700 mb-2">🖼 Uploaded Files (${count ?? (files||[]).length})</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px">
      ${(files||[]).map(f => `
        <div style="border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;cursor:pointer" onclick="copyMediaUrl('${f.url}')">
          ${f.type?.startsWith('image') ? `<img src="${f.url}" style="width:100%;height:90px;object-fit:cover">` : `<div style="height:90px;display:flex;align-items:center;justify-content:center;font-size:32px;background:var(--surface-3)">📄</div>`}
          <div style="padding:6px;font-size:10px;color:var(--ink-4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.name || 'File'}</div>
          <div style="padding:0 6px 6px;display:flex;gap:4px">
            <button class="btn btn-ghost btn-xs" style="flex:1;font-size:10px" onclick="event.stopPropagation();copyMediaUrl('${f.url}')">📋 Copy</button>
            <button class="btn btn-danger btn-xs" style="width:auto;padding:4px 8px;font-size:10px" onclick="event.stopPropagation();deleteMedia(${f.id})">🗑</button>
          </div>
        </div>`).join('') || '<p class="text-muted">No files uploaded yet.</p>'}
    </div>
    ${totalPages > 1 ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px">
      <button class="btn btn-secondary btn-sm" style="width:auto" ${_mlPage===0?'disabled':''} onclick="adminMediaLibrary(undefined,${_mlPage-1})">← Prev</button>
      <span class="text-xs text-muted">Page ${_mlPage+1} of ${totalPages} (${count} total)</span>
      <button class="btn btn-secondary btn-sm" style="width:auto" ${_mlPage+1>=totalPages?'disabled':''} onclick="adminMediaLibrary(undefined,${_mlPage+1})">Next →</button>
    </div>` : ''}`;
}
window.adminMediaLibrary = adminMediaLibrary;



async function uploadToLibrary() {
  const file = document.getElementById('mediaUploadInput')?.files[0];
  if (!file) return;
  const tag = document.getElementById('mediaTag')?.value.trim() || 'general';
  showLoading(true, 'Uploading...');
  const ext = file.name.split('.').pop();
  const path = `library/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const bucket = file.type.startsWith('image') ? 'module-images' : 'question-images';
  const { error } = await sb.storage.from(bucket).upload(path, file, { upsert: true });
  if (error) { showLoading(false); showToast('Upload failed: ' + error.message); return; }
  const { data: urlData } = sb.storage.from(bucket).getPublicUrl(path);
  await db(sb.from('media_library').insert({
    name: file.name, url: urlData.publicUrl, type: file.type,
    tag, size: file.size, uploaded_at: new Date().toISOString(),
    uploaded_by: window.currentUser.email
  }), 'Save to library failed');
  showLoading(false); showToast('Uploaded to library ✓');
  adminMediaLibrary();
}
window.uploadToLibrary = uploadToLibrary;



function copyMediaUrl(url) {
  navigator.clipboard.writeText(url).then(() => showToast('URL copied! ✓'));
}
window.copyMediaUrl = copyMediaUrl;



async function deleteMedia(id) {
  showConfirm('Delete this image from library?', async () => {
    await db(sb.from('media_library').delete().eq('id', id), 'Delete failed');
    showToast('Deleted'); adminMediaLibrary();
  }, 'Delete');
}
window.deleteMedia = deleteMedia;
