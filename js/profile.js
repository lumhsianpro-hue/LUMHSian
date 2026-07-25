import { timeAgo } from './admin.js';
import { APP_VERSION, _isStandalone, getRankInfo, getSetting, getUserStats, isAIEnabled, renderHome } from './app.js';
import { logout, populateCollegeSelect } from './auth.js';
import { showScreen } from './navigation.js';
import { RESUME_KEY } from './quiz.js';
import { db, sb } from './supabase.js';
import { ICON_BOOK, ICON_BUILDING, ICON_MEDAL, ICON_TARGET, cacheGet, cacheSet, closeModal, esc, escJs, renderAvatar, renderMd, showConfirm, showToast, skeletonList } from './utils.js';



// ==================== AI TUTOR ====================
function openDonateModal() {
  const jazzcash = getSetting('donation_jazzcash','');
  const easypaisa = getSetting('donation_easypaisa','');
  const bank = getSetting('donation_bank','');
  const message = getSetting('donation_message','Help us keep this app free and growing for every student. Any contribution helps!');
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  const row = (label, value, icon) => value ? `
    <div class="card" style="margin-bottom:10px;padding:14px">
      <div class="text-xs text-muted mb-1">${icon} ${label}</div>
      <div class="flex-between">
        <div class="fw-700">${value}</div>
        <button class="btn btn-secondary btn-xs" onclick="navigator.clipboard?.writeText('${value.replace(/'/g,"\\'")}');showToast('Copied ✓')">📋 Copy</button>
      </div>
    </div>` : '';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:420px;max-height:90vh;overflow-y:auto">
      <div style="font-size:40px;text-align:center;margin-bottom:8px">💛</div>
      <div class="fw-700 text-center mb-2" style="font-size:17px">Support LUMHSian</div>
      <p class="text-sm text-muted text-center mb-3">${message}</p>
      ${row('JazzCash', jazzcash, '📱')}
      ${row('Easypaisa', easypaisa, '📱')}
      ${row('Bank Account', bank, '🏦')}
      ${!jazzcash && !easypaisa && !bank ? '<p class="text-sm text-muted text-center">Payment details coming soon.</p>' : ''}
      <button class="btn btn-ghost mt-2" style="width:100%" onclick="this.closest('[style*=fixed]').remove()">Close</button>
    </div>`;
  document.body.appendChild(overlay);
}
window.openDonateModal = openDonateModal;



function openFeedbackModal() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10005;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:420px">
      <div class="fw-700 mb-1">💬 Send Feedback</div>
      <p class="text-sm text-muted mb-3">Suggestions, bugs, or anything else you'd like the admin to know.</p>
      <textarea id="_rpt_msg" class="input-field" rows="4" placeholder="Type your feedback..." maxlength="2000" style="resize:vertical"></textarea>
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="submitReport(this,null)">Send Feedback</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.openFeedbackModal = openFeedbackModal;



async function openMyReports() {
  const overlay = document.createElement('div');
  overlay.id = 'myReportsOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10005;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:20px;width:100%;max-width:440px;max-height:85vh;overflow-y:auto">
      <div class="flex-between mb-3">
        <span class="fw-700">📬 My Reports &amp; Feedback</span>
        <button onclick="this.closest('[style*=fixed]').remove()" style="background:none;border:none;font-size:18px;cursor:pointer">✕</button>
      </div>
      <button class="btn btn-secondary btn-sm mb-3" style="width:100%" onclick="this.closest('[style*=fixed]').remove();openFeedbackModal()">💬 Send New Feedback</button>
      <div id="myReportsList">${skeletonList(2, false)}</div>
    </div>`;
  document.body.appendChild(overlay);
  const { data } = await db(sb.from('reports_feedback').select('*').eq('user_email', window.currentUser.email).order('created_at', { ascending: false }), 'Load failed');
  const list = document.getElementById('myReportsList');
  if (!data?.length) { list.innerHTML = '<p class="text-sm text-muted text-center">No reports yet.</p>'; return; }
  const qIds = [...new Set(data.map(r => r.question_id).filter(Boolean))];
  let qMap = {};
  if (qIds.length) {
    const { data: qs } = await db(sb.from('questions').select('id,text').in('id', qIds), 'Questions load failed');
    (qs || []).forEach(q => { qMap[q.id] = q; });
  }
  list.innerHTML = data.map(r => {
    const q = r.question_id ? qMap[r.question_id] : null;
    return `
    <div class="card" style="margin-bottom:10px">
      <div class="flex-between mb-1">
        <span class="badge ${r.type === 'question_report' ? 'badge-amber' : 'badge-teal'}" style="font-size:10px">${r.type === 'question_report' ? '🚩 Question Report' : '💬 Feedback'}</span>
        <span class="badge ${r.status === 'pending' ? 'badge-amber' : 'badge-green'}" style="font-size:10px">${r.status === 'pending' ? 'Pending' : '✓ Replied'}</span>
      </div>
      ${q?.text ? `<div class="text-xs text-muted mb-1">Re: ${esc(q.text.substring(0,70))}...</div>` : ''}
      <div class="text-sm mb-1">${renderMd(r.message)}</div>
      <div class="text-xs text-muted">${timeAgo(new Date(r.created_at).getTime())}</div>
      ${r.admin_reply ? `<div style="background:var(--gold-50);border-radius:10px;padding:8px 10px;margin-top:8px"><div class="text-xs fw-700" style="color:var(--gold-700)">Admin reply:</div><div class="text-sm">${renderMd(r.admin_reply)}</div></div>` : ''}
    </div>`;
  }).join('');
}
window.openMyReports = openMyReports;



export async function renderStats() {
  const wrap = document.getElementById('statsPageWrap');
  wrap.innerHTML = `${skeletonList(4)}`;
  const stats = await getUserStats(true);
  const history = stats.history || [];
  const acc = stats.total_questions ? Math.round((stats.total_correct / stats.total_questions) * 100) : 0;

  // Performance by type
  const byType = {};
  for (const h of history) {
    if (!byType[h.type]) byType[h.type] = { count: 0, totalPct: 0 };
    byType[h.type].count++;
    byType[h.type].totalPct += h.percent || 0;
  }

  const typeHtml = Object.entries(byType).map(([type, d]) => `
    <div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
      <span class="text-sm">${type}</span>
      <div style="text-align:right">
        <div class="fw-700" style="font-size:14px">${Math.round(d.totalPct / d.count)}% avg</div>
        <div class="text-xs text-muted">${d.count} tests</div>
      </div>
    </div>`).join('') || '<p class="text-muted">No data yet.</p>';

  // Recent history
  const histHtml = history.slice(0, 15).map(h => `
    <div class="flex-between" style="padding:10px 0;border-bottom:1px solid var(--border)">
      <div>
        <div class="fw-600 text-sm">${h.module}</div>
        <div class="text-xs text-muted">${h.date} · ${h.type}</div>
      </div>
      <div style="text-align:right">
        <div class="fw-700" style="color:${h.percent >= 60 ? 'var(--green)' : 'var(--red)'};font-size:15px">${h.percent}%</div>
        <div class="text-xs text-muted">${h.correct}/${h.total}</div>
      </div>
    </div>`).join('') || '<p class="text-muted">No tests yet.</p>';

  // Weak Topics — subject-level keys look like "moduleId_subjectId"
  const weakEntries = Object.entries(stats.subject_stats || {})
    .filter(([k, v]) => k.includes('_') && v.total >= 5)
    .map(([k, v]) => ({ subjectId: k.split('_')[1], moduleId: k.split('_')[0], acc: Math.round((v.correct / v.total) * 100), total: v.total }))
    .filter(e => e.acc < 65)
    .sort((a, b) => a.acc - b.acc)
    .slice(0, 5);

  let weakHtml = '<p class="text-sm text-muted">Not enough data yet. Keep practicing by subject and we\'ll spot your weak areas here.</p>';
  if (weakEntries.length) {
    const { data: subs } = await db(sb.from('subjects').select('id,name,module_id,modules(name)').in('id', weakEntries.map(e => e.subjectId)), 'Subjects error');
    weakHtml = weakEntries.map(e => {
      const s = subs?.find(s => s.id == e.subjectId);
      if (!s) return '';
      return `
        <div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
          <div>
            <div class="fw-600 text-sm">${s.name}</div>
            <div class="text-xs text-muted">${s.modules?.name || ''} · ${e.total} questions attempted</div>
          </div>
          <div style="text-align:right">
            <div class="fw-700" style="color:var(--red)">${e.acc}%</div>
            <button class="btn btn-secondary btn-xs mt-1" onclick="startTest('practice',${s.module_id},'${(s.modules?.name||'').replace(/'/g,"\\'")}',${s.id},null,null)">Practice →</button>
          </div>
        </div>`;
    }).join('');
  }

  // Badges (computed live from existing stats — no extra DB table needed)
  const badgeDefs = [
    { id: 'first_test', icon: ICON_TARGET, label: 'First Steps', desc: 'Completed your first test', earned: (stats.total_tests||0) >= 1 },
    { id: 'century', icon: '💯', label: 'Century Club', desc: '100+ questions answered', earned: (stats.total_questions||0) >= 100 },
    { id: 'perfectionist', icon: '🌟', label: 'Perfectionist', desc: 'Scored 100% in a test', earned: (stats.best_score||0) >= 100 },
    { id: 'streak7', icon: '🔥', label: '7-Day Streak', desc: '7 days in a row', earned: (stats.streak||0) >= 7 },
    { id: 'streak30', icon: ICON_MEDAL, label: '30-Day Streak', desc: '30 days in a row', earned: (stats.streak||0) >= 30 },
    { id: 'marathon', icon: '🏃', label: 'Marathon', desc: '50+ tests completed', earned: (stats.total_tests||0) >= 50 },
    { id: 'sharp', icon: '🧠', label: 'Sharp Mind', desc: '80%+ overall accuracy', earned: acc >= 80 && (stats.total_questions||0) >= 50 }
  ];
  const badgesHtml = badgeDefs.map(b => `
    <div style="text-align:center;opacity:${b.earned ? '1' : '.35'}">
      <div style="font-size:30px">${b.icon}</div>
      <div class="text-xs fw-600" style="margin-top:2px">${b.label}</div>
    </div>`).join('');

  // Canvas chart
  wrap.innerHTML = `
    <div class="card-teal" style="margin-bottom:16px">
      <h2>Your Statistics</h2>
      <p>${window.currentUser.name} · ${window.selectedYear?.name || ''}</p>
    </div>

    <div class="stat-grid">
      <div class="stat-box">
        <div class="stat-val">${acc}%</div>
        <div class="stat-key">Overall Accuracy</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${stats.total_tests || 0}</div>
        <div class="stat-key">Tests Taken</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${stats.streak || 0}🔥</div>
        <div class="stat-key">Day Streak</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${stats.best_score || 0}%</div>
        <div class="stat-key">Best Score</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${stats.total_correct || 0}</div>
        <div class="stat-key">Correct</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${(stats.total_questions || 0) - (stats.total_correct || 0)}</div>
        <div class="stat-key">Incorrect</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">${ICON_TARGET} Weak Topics</div>
      ${weakHtml}
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">🏅 Badges</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">${badgesHtml}</div>
    </div>

    ${history.length >= 3 ? `
    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">📈 Last 10 Test Scores</div>
      <canvas id="perfCanvas" height="140" style="width:100%"></canvas>
    </div>` : ''}

    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">📁 Performance by Type</div>
      ${typeHtml}
    </div>

    <div class="card">
      <div class="fw-700 mb-2">🕓 Recent Tests</div>
      ${histHtml}
    </div>
    <div style="height:16px"></div>`;

  // Draw chart
  if (history.length >= 3) {
    const canvas = document.getElementById('perfCanvas');
    if (canvas) {
      canvas.width = canvas.parentElement.offsetWidth - 40;
      const ctx = canvas.getContext('2d');
      const data = history.slice(0, 10).reverse().map(h => h.percent);
      const W = canvas.width, H = 140;
      const padL = 32, padR = 12, padT = 12, padB = 24;
      const chartW = W - padL - padR, chartH = H - padT - padB;
      ctx.clearRect(0, 0, W, H);
      // Grid lines
      ctx.strokeStyle = '#e5e5e5'; ctx.lineWidth = 1;
      [0, 25, 50, 75, 100].forEach(v => {
        const y = padT + chartH - (v / 100) * chartH;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + chartW, y); ctx.stroke();
        ctx.fillStyle = '#404040'; ctx.font = '10px Inter'; ctx.textAlign = 'right';
        ctx.fillText(v + '%', padL - 4, y + 4);
      });
      // Line
      const step = chartW / Math.max(data.length - 1, 1);
      ctx.beginPath(); ctx.strokeStyle = '#c9980a'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
      data.forEach((v, i) => { const x = padL + i * step, y = padT + chartH - (v / 100) * chartH; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
      ctx.stroke();
      // Dots + labels
      data.forEach((v, i) => {
        const x = padL + i * step, y = padT + chartH - (v / 100) * chartH;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = v >= 60 ? '#059669' : '#dc2626'; ctx.fill();
        ctx.strokeStyle = 'white'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#171717'; ctx.font = 'bold 10px Inter'; ctx.textAlign = 'center';
        ctx.fillText(v + '%', x, y - 8);
      });
    }
  }
}



// ==================== PROFILE ====================
// ==================== ABOUT / PRIVACY / TERMS (full pages, reached from Profile
// after signing in, or directly from the login screen before signing in) ====================
// Returns from the standalone legal page (opened from the login screen) to
// wherever makes sense — back to the login screen if nobody's signed in yet,
// or Home in the rare case this was somehow reached while already signed in.
function _closeLegalPage() {
  if (window.currentUser) { renderHome(); showScreen('home'); }
  else showScreen('splash', false);
}



async function showAboutPage(standalone = false) {
  const wrap = document.getElementById(standalone ? 'legalPageWrap' : 'profilePageWrap');
  const backAction = standalone ? '_closeLegalPage()' : 'renderProfile()';
  if (standalone) showScreen('legalpage', false);
  wrap.innerHTML = `<button class="back-btn" onclick="${backAction}">← Back</button><div class="spinner" style="margin:30px auto"></div>`;
  // Silent fetch — if the about_cards table hasn't been created yet, just show none, no error toast.
  let aboutCards = [];
  try {
    const r = await sb.from('about_cards').select('*').eq('is_active', true).order('created_at', { ascending: true });
    if (!r.error && r.data) aboutCards = r.data;
  } catch (e) { /* table not set up yet — that's fine */ }

  const appName = getSetting('app_name', 'LUMHSian');
  wrap.innerHTML = `
    <button class="back-btn" onclick="${backAction}">← Back</button>
    <div class="card" style="margin-bottom:16px;padding:24px 20px;text-align:center">
      <img src="icon.png" style="width:56px;height:56px;border-radius:16px;margin-bottom:12px">
      <div style="font-family:var(--font-display);font-size:20px;font-weight:800;margin-bottom:4px">${esc(appName)}</div>
      <div style="font-size:12px;color:var(--gold-700);font-weight:700;margin-bottom:14px">${esc(getSetting('app_tagline', 'AI-powered MBBS Prep Platform'))}</div>
      <div style="font-size:13px;color:var(--ink-3);line-height:1.7;text-align:left">Built for MBBS students preparing for their exams, ${esc(appName)} brings together an organized question bank, past papers, and progress tracking in one place, so revision time goes into actually learning, not hunting for material.</div>
    </div>

    <div class="section-label">What's inside</div>
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:20px;flex-shrink:0">📚</div>
        <div><div class="fw-700 text-sm">Question Bank</div><div class="text-xs text-muted" style="line-height:1.5">MCQs organized by year → module → subject, so you always know exactly what you're practicing</div></div>
      </div>
      <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:20px;flex-shrink:0">⏱️</div>
        <div><div class="fw-700 text-sm">Two Test Modes</div><div class="text-xs text-muted" style="line-height:1.5">Timed Attempt mode for real exam pressure, untimed Review mode for focused learning</div></div>
      </div>
      <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:20px;flex-shrink:0">📄</div>
        <div><div class="fw-700 text-sm">Past Papers</div><div class="text-xs text-muted" style="line-height:1.5">Practice with real past papers alongside the regular question bank</div></div>
      </div>
      <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:20px;flex-shrink:0">🔖</div>
        <div><div class="fw-700 text-sm">Bookmarks & Wrong Attempts</div><div class="text-xs text-muted" style="line-height:1.5">Save tough questions and revisit everything you have gotten wrong until it sticks</div></div>
      </div>
      <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:20px;flex-shrink:0">📅</div>
        <div><div class="fw-700 text-sm">Study Planner</div><div class="text-xs text-muted" style="line-height:1.5">Daily goals and streaks to keep your revision consistent</div></div>
      </div>
      <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:20px;flex-shrink:0">🏆</div>
        <div><div class="fw-700 text-sm">Leaderboard</div><div class="text-xs text-muted" style="line-height:1.5">See how you stack up against your batch, or switch on Anonymous mode anytime</div></div>
      </div>
      <div style="display:flex;gap:12px;padding:10px 0">
        <div style="font-size:20px;flex-shrink:0">🤖</div>
        <div><div class="fw-700 text-sm">AI Tutor</div><div class="text-xs text-muted" style="line-height:1.5">Ask for a plain-language explanation whenever you are stuck on a question</div></div>
      </div>
    </div>

    ${aboutCards.map(c => `
      <div class="card" style="margin-bottom:16px;padding:0;overflow:hidden">
        ${c.image_url ? `<img src="${esc(c.image_url)}" style="width:100%;max-height:160px;object-fit:cover;display:block">` : ''}
        <div style="padding:14px 16px">
          <div class="fw-700" style="margin-bottom:4px">${esc(c.title)}</div>
          ${c.description ? `<div style="font-size:12px;color:var(--ink-3);line-height:1.6">${esc(c.description)}</div>` : ''}
        </div>
      </div>`).join('')}

    <div style="text-align:center;margin-top:8px;font-size:11px;color:var(--ink-4)">Version ${APP_VERSION}</div>
    <div style="height:24px"></div>`;
}
window.showAboutPage = showAboutPage;



function showPrivacyPolicyPage(standalone = false) {
  const wrap = document.getElementById(standalone ? 'legalPageWrap' : 'profilePageWrap');
  const backAction = standalone ? '_closeLegalPage()' : 'renderProfile()';
  if (standalone) showScreen('legalpage', false);
  const appName = getSetting('app_name', 'LUMHSian');
  const contactEmail = getSetting('contact_email', 'lumhsianpro@gmail.com');
  const externalUrl = getSetting('privacy_policy_url', '');
  wrap.innerHTML = `
    <button class="back-btn" onclick="${backAction}">← Back</button>
    <div style="font-family:var(--font-display);font-size:20px;font-weight:800;margin-bottom:4px">Privacy Policy</div>
    <div class="text-xs text-muted mb-3">Last updated: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
    <div class="card" style="line-height:1.75;font-size:13.5px;color:var(--ink-3)">
      <p style="margin-bottom:14px">This policy explains what information ${esc(appName)} collects, how it is used, and the choices you have. By using ${esc(appName)}, you agree to this policy.</p>

      <div class="fw-700 mb-1">1. Information we collect</div>
      <p style="margin-bottom:14px">When you sign in with Google, we receive your <strong>name and email address</strong>. During signup you may also add your <strong>phone number, college/university, gender and academic year</strong>. These help personalize your question bank and are never required to be public. As you use the app we store your <strong>test attempts, scores, streaks, bookmarks and study activity</strong> so your progress can be tracked and shown back to you. If you contact us through Reports & Feedback, we store the <strong>message you send and our reply</strong>. Basic technical details (like a screen name or app version) are logged automatically <strong>only when something goes wrong</strong>, to help us fix bugs.</p>

      <div class="fw-700 mb-1">2. How we use it</div>
      <p style="margin-bottom:14px">Your data is used to run the app for you: showing the right questions for your year, tracking your accuracy and streaks, powering the leaderboard, and replying to feedback or reports you send. We do not use your data for advertising, and we do not sell it to anyone.</p>

      <div class="fw-700 mb-1">3. AI Tutor</div>
      <p style="margin-bottom:14px">If you use the AI Tutor feature, the question text you ask about is sent to an AI service provider to generate an explanation. This is only triggered when you actively use the feature.</p>

      <div class="fw-700 mb-1">4. Leaderboard visibility</div>
      <p style="margin-bottom:14px">By default your name and college may be visible to other students on the leaderboard. You can switch this off anytime from Profile → Leaderboard Privacy to appear anonymously instead.</p>

      <div class="fw-700 mb-1">5. Where your data lives</div>
      <p style="margin-bottom:14px">Your data is stored with Supabase, a secure cloud database provider, and protected by access rules that keep your personal records visible only to you and app administrators. Google is used only to verify your identity when you sign in. We never see or store your Google password.</p>

      <div class="fw-700 mb-1">6. Your choices</div>
      <p style="margin-bottom:14px">You can update your name, college and phone number anytime from your Profile. To request a copy of your data or to have your account and data deleted, contact us using the details below, and we will act on verified requests within a reasonable time.</p>

      <div class="fw-700 mb-1">7. Changes to this policy</div>
      <p style="margin-bottom:14px">If this policy changes in a meaningful way, we will let you know inside the app. Continued use after an update means you accept the revised policy.</p>

      <div class="fw-700 mb-1">8. Contact us</div>
      <p style="margin-bottom:0">Questions about this policy or your data? Reach us at <a href="mailto:${esc(contactEmail)}" style="color:var(--gold-700)">${esc(contactEmail)}</a> or through Profile → My Reports & Feedback.</p>
    </div>
    ${externalUrl ? `<div style="text-align:center;margin-top:14px"><a href="${esc(externalUrl)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--gold-700);text-decoration:underline">🔗 View full policy on our website</a></div>` : ''}
    <div style="height:24px"></div>`;
}
window.showPrivacyPolicyPage = showPrivacyPolicyPage;



function showTermsPage(standalone = false) {
  const wrap = document.getElementById(standalone ? 'legalPageWrap' : 'profilePageWrap');
  const backAction = standalone ? '_closeLegalPage()' : 'renderProfile()';
  if (standalone) showScreen('legalpage', false);
  const appName = getSetting('app_name', 'LUMHSian');
  const contactEmail = getSetting('contact_email', 'lumhsianpro@gmail.com');
  const externalUrl = getSetting('tos_url', '');
  wrap.innerHTML = `
    <button class="back-btn" onclick="${backAction}">← Back</button>
    <div style="font-family:var(--font-display);font-size:20px;font-weight:800;margin-bottom:4px">Terms of Service</div>
    <div class="text-xs text-muted mb-3">Last updated: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
    <div class="card" style="line-height:1.75;font-size:13.5px;color:var(--ink-3)">
      <p style="margin-bottom:14px">These terms cover your use of ${esc(appName)}. By creating an account, you agree to them.</p>

      <div class="fw-700 mb-1">1. Your account</div>
      <p style="margin-bottom:14px">You sign in with Google and are expected to provide accurate profile information. Your account is for your personal use only. Please do not share your login or let others use your account.</p>

      <div class="fw-700 mb-1">2. Acceptable use</div>
      <p style="margin-bottom:14px">Please use ${esc(appName)} fairly: do not copy, scrape or redistribute the question bank or past papers, do not attempt to disrupt the app or access other students' data, and do not misuse the AI Tutor to generate content unrelated to your studies.</p>

      <div class="fw-700 mb-1">3. Educational content, not a substitute for official material</div>
      <p style="margin-bottom:14px">${esc(appName)} is a self-study aid. Questions, explanations and AI Tutor responses are meant to support your exam preparation, not replace your official curriculum, textbooks, or the guidance of your instructors. Always verify anything critical against your institution's official material before relying on it for an exam or clinical decision.</p>

      ${getSetting('payment_enabled', 'false') === 'true' ? `<div class="fw-700 mb-1">4. Subscriptions & payments</div>
      <p style="margin-bottom:14px">Paid plans unlock additional access as described at the time of purchase, billed at the price and cycle shown in the app. Subscriptions continue until cancelled from your end or by us for a terms violation. For billing issues or refund requests, contact us. We handle these case by case.</p>` : ''}

      <div class="fw-700 mb-1">${getSetting('payment_enabled', 'false') === 'true' ? '5' : '4'}. Content & ownership</div>
      <p style="margin-bottom:14px">Questions, explanations and app content belong to ${esc(appName)} or its content contributors and are licensed to you for personal, non-commercial study use only. Feedback or reports you submit may be used by us to improve the app.</p>

      <div class="fw-700 mb-1">${getSetting('payment_enabled', 'false') === 'true' ? '6' : '5'}. No warranty</div>
      <p style="margin-bottom:14px">${esc(appName)} is provided "as is." While we work to keep questions accurate and the app running smoothly, we cannot guarantee it will always be error-free or uninterrupted.</p>

      <div class="fw-700 mb-1">${getSetting('payment_enabled', 'false') === 'true' ? '7' : '6'}. Account suspension</div>
      <p style="margin-bottom:14px">We may suspend or terminate accounts that violate these terms, such as sharing logins, abusing the platform, or attempting to access other users' data.</p>

      <div class="fw-700 mb-1">${getSetting('payment_enabled', 'false') === 'true' ? '8' : '7'}. Changes</div>
      <p style="margin-bottom:14px">We may update these terms as the app evolves. Meaningful changes will be announced in-app, and continuing to use ${esc(appName)} afterward means you accept them.</p>

      <div class="fw-700 mb-1">${getSetting('payment_enabled', 'false') === 'true' ? '9' : '8'}. Contact</div>
      <p style="margin-bottom:0">Questions about these terms? Reach us at <a href="mailto:${esc(contactEmail)}" style="color:var(--gold-700)">${esc(contactEmail)}</a>.</p>
    </div>
    ${externalUrl ? `<div style="text-align:center;margin-top:14px"><a href="${esc(externalUrl)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--gold-700);text-decoration:underline">🔗 View full terms on our website</a></div>` : ''}
    <div style="height:24px"></div>`;
}
window.showTermsPage = showTermsPage;



export async function renderProfile() {
  const wrap = document.getElementById('profilePageWrap');
  wrap.innerHTML = `${skeletonList(4)}`;
  const stats = await getUserStats();
  const acc = stats.total_questions ? Math.round((stats.total_correct / stats.total_questions) * 100) : 0;

  const rankInfo = await getRankInfo();
  const totalQ = stats.total_questions || 0;
  const bestScore = stats.best_score || 0;
  const isFemale = window.currentUser.gender === 'female';

  // Achievements
  const achievements = [];
  if (stats.total_tests >= 1) achievements.push({ icon: ICON_TARGET, label: 'First Test' });
  if (stats.total_tests >= 10) achievements.push({ icon: '📚', label: '10 Tests' });
  if (stats.total_tests >= 50) achievements.push({ icon: '🏅', label: '50 Tests' });
  if (acc >= 70) achievements.push({ icon: '⭐', label: 'Star Performer' });
  if (acc >= 90) achievements.push({ icon: '🏆', label: 'Top Scorer' });
  if (stats.streak >= 7) achievements.push({ icon: '🔥', label: '7-Day Streak' });
  if (stats.streak >= 30) achievements.push({ icon: '💎', label: '30-Day Streak' });
  if (totalQ >= 100) achievements.push({ icon: '💯', label: '100 Questions' });
  if (totalQ >= 500) achievements.push({ icon: ICON_MEDAL, label: '500 Questions' });

  wrap.innerHTML = `
    <!-- Profile Hero -->
    <div class="profile-hero">
      <div class="profile-avatar-ring">${renderAvatar(window.currentUser.name, 80)}</div>
      <div style="font-family:var(--font-display);font-size:22px;font-weight:800;position:relative;z-index:1">Dr. ${esc(window.currentUser.name)}</div>
      <div style="font-size:13px;opacity:.6;margin-top:4px;position:relative;z-index:1">${esc(window.currentUser.email)}</div>
      <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin-top:12px;position:relative;z-index:1">
        ${window.currentUser.college ? `<span class="achievement-pill">🏫 ${esc(window.currentUser.college)}</span>` : ''}
        <span class="achievement-pill">📚 ${window.selectedYear?.name || 'N/A'}</span>
        ${rankInfo.rank ? `<span class="achievement-pill">🏆 Rank #${rankInfo.rank}/${rankInfo.total}</span>` : ''}
        <span class="achievement-pill">${isFemale ? '👩‍⚕️ Female' : '👨‍⚕️ Male'}</span>
      </div>
    </div>

    ${localStorage.getItem(RESUME_KEY) ? `
    <div class="card" style="margin-bottom:12px;background:var(--gold-50);border-color:var(--gold-300);display:flex;align-items:center;justify-content:space-between;gap:10px" onclick="checkResumableTest()">
      <div style="display:flex;align-items:center;gap:10px"><span style="font-size:20px">⏳</span><span class="fw-700 text-sm">You have an unfinished test</span></div>
      <button class="btn btn-secondary btn-xs" style="width:auto" onclick="event.stopPropagation();checkResumableTest()">▶ Resume</button>
    </div>` : ''}

    <!-- Stats Grid -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:4px">
      <div class="stat-box" style="background:linear-gradient(135deg,var(--gold-50),var(--surface));border-color:var(--gold-200)">
        <div class="stat-val" style="color:var(--gold-700)">${acc}%</div><div class="stat-key">Accuracy</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${stats.total_tests || 0}</div><div class="stat-key">Tests</div>
      </div>
      <div class="stat-box" style="background:linear-gradient(135deg,var(--amber-light),var(--surface));border-color:var(--amber)">
        <div class="stat-val" style="color:var(--amber)">${stats.streak || 0}🔥</div><div class="stat-key">Streak</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
      <div class="stat-box"><div class="stat-val">${totalQ}</div><div class="stat-key">Questions</div></div>
      <div class="stat-box"><div class="stat-val">${bestScore}%</div><div class="stat-key">Best Score</div></div>
      <div class="stat-box"><div class="stat-val">${stats.total_correct || 0}</div><div class="stat-key">Correct</div></div>
    </div>

    ${achievements.length ? `
    <div class="section-label">Achievements</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">
      ${achievements.map(a => `<div style="background:var(--gold-50);border:1px solid var(--gold-200);border-radius:var(--radius-full);padding:6px 14px;font-size:12px;font-weight:600;color:var(--gold-700)">${a.icon} ${a.label}</div>`).join('')}
    </div>` : ''}

    <div class="section-label">Account</div>
    <div class="list-item no-hover" onclick="openModal('modalName')">
      <div class="list-item-left"><div class="list-item-icon">✏️</div><div><div class="list-item-title">Edit Name</div><div class="list-item-sub">${window.currentUser.name}</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>
    <div class="list-item no-hover" onclick="editCollege()">
      <div class="list-item-left"><div class="list-item-icon">${ICON_BUILDING}</div><div><div class="list-item-title">College</div><div class="list-item-sub">${window.currentUser.college || 'Not set (tap to add)'}</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>
    <div class="list-item no-hover" onclick="editPhone()">
      <div class="list-item-left"><div class="list-item-icon">📱</div><div><div class="list-item-title">Phone Number</div><div class="list-item-sub">${window.currentUser.phone || 'Not set (tap to add)'}</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>
    <div class="list-item no-hover" onclick="openPrivacyModal()">
      <div class="list-item-left"><div class="list-item-icon">👁</div><div><div class="list-item-title">Leaderboard Privacy</div><div class="list-item-sub">${window.currentUser.show_on_leaderboard ? 'Showing name & college' : 'Anonymous mode on'}</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>
    ${!_isStandalone ? `<div class="list-item no-hover" onclick="_triggerInstall()">
      <div class="list-item-left"><div class="list-item-icon">📲</div><div><div class="list-item-title">Install App</div><div class="list-item-sub">Add LUMHSian to your Home Screen</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>` : ''}

    <div class="section-label">Study Tools</div>
    <div class="list-item" onclick="navGo('bookmarks')">
      <div class="list-item-left"><div class="list-item-icon">${ICON_BOOK}</div><div><div class="list-item-title">Saved Questions</div><div class="list-item-sub">Your bookmarks</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>
    <div class="list-item" onclick="navGo('wrongattempts')">
      <div class="list-item-left"><div class="list-item-icon">❌</div><div><div class="list-item-title">Wrong Attempts</div><div class="list-item-sub">Questions you got wrong, revise & clear</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>
    <div class="list-item" onclick="navGo('planner')">
      <div class="list-item-left"><div class="list-item-icon">📅</div><div><div class="list-item-title">Study Planner</div><div class="list-item-sub">Daily goals & streak tracking</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>
    <div class="list-item" onclick="navGo('stats')">
      <div class="list-item-left"><div class="list-item-icon">📊</div><div><div class="list-item-title">Detailed Stats</div><div class="list-item-sub">Performance analytics</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>

    <div class="section-label">App</div>
    <div class="list-item" onclick="changeYear()">
      <div class="list-item-left"><div class="list-item-icon">📅</div><div><div class="list-item-title">Change Year</div><div class="list-item-sub">Currently: ${window.selectedYear?.name || 'Not set'}</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>
    ${isAIEnabled() ? `
    <div class="list-item" onclick="openAITutor()">
      <div class="list-item-left"><div class="list-item-icon">🤖</div><div><div class="list-item-title">AI Tutor</div><div class="list-item-sub">${getSetting('ai_key_set','') === 'true' ? '✅ Tap to ask a question' : '⚠️ Not set up by admin yet'}</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>` : ''}
    <div class="list-item" onclick="openMyReports()">
      <div class="list-item-left"><div class="list-item-icon">📬</div><div><div class="list-item-title">My Reports & Feedback</div><div class="list-item-sub">Report questions, send feedback, see replies</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>
    ${getSetting('payment_enabled','false') === 'true' ? `
    <div class="list-item" onclick="showSubscriptionPlans()">
      <div class="list-item-left"><div class="list-item-icon">💎</div><div><div class="list-item-title">View Plans</div><div class="list-item-sub">Upgrade for full access</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>` : ''}
    ${getSetting('donation_enabled','false') === 'true' ? `
    <div class="list-item" onclick="openDonateModal()">
      <div class="list-item-left"><div class="list-item-icon">💛</div><div><div class="list-item-title">Support Us</div><div class="list-item-sub">Help keep this app free</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>` : ''}
    <div class="list-item no-hover" onclick="toggleDarkMode()">
      <div class="list-item-left"><div class="list-item-icon">🌙</div><div><div class="list-item-title">Dark Mode</div><div class="list-item-sub">${localStorage.getItem('dark_mode')==='true'?'On':'Off'}</div></div></div>
      <label class="toggle-switch" onclick="event.preventDefault()">
        <input type="checkbox" ${localStorage.getItem('dark_mode')==='true'?'checked':''} tabindex="-1">
        <span class="toggle-knob"></span>
      </label>
    </div>
    <div class="list-item no-hover" onclick="toggleNotifications(${localStorage.getItem('notif_enabled')==='false'})">
      <div class="list-item-left"><div class="list-item-icon">🔔</div><div><div class="list-item-title">Notifications</div><div class="list-item-sub">${localStorage.getItem('notif_enabled')==='false'?'Off':'On'}</div></div></div>
      <label class="toggle-switch" onclick="event.preventDefault()">
        <input type="checkbox" ${localStorage.getItem('notif_enabled')==='false'?'':'checked'} tabindex="-1">
        <span class="toggle-knob"></span>
      </label>
    </div>
    <div class="list-item no-hover" onclick="toggleSoundEffects(${localStorage.getItem('sound_enabled')==='false'})">
      <div class="list-item-left"><div class="list-item-icon">🔊</div><div><div class="list-item-title">Sound Effects</div><div class="list-item-sub">${localStorage.getItem('sound_enabled')==='false'?'Off':'On'}</div></div></div>
      <label class="toggle-switch" onclick="event.preventDefault()">
        <input type="checkbox" ${localStorage.getItem('sound_enabled')==='false'?'':'checked'} tabindex="-1">
        <span class="toggle-knob"></span>
      </label>
    </div>

    <div class="section-label">About & Legal</div>
    <div class="list-item" onclick="showAboutPage()">
      <div class="list-item-left"><div class="list-item-icon">ℹ️</div><div><div class="list-item-title">About ${esc(getSetting('app_name','LUMHSian'))}</div><div class="list-item-sub">What this app does & what's inside</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>
    <div class="list-item" onclick="showPrivacyPolicyPage()">
      <div class="list-item-left"><div class="list-item-icon">🔒</div><div><div class="list-item-title">Privacy Policy</div><div class="list-item-sub">What we collect & how it's used</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>
    <div class="list-item" onclick="showTermsPage()">
      <div class="list-item-left"><div class="list-item-icon">📃</div><div><div class="list-item-title">Terms of Service</div><div class="list-item-sub">Rules for using the app</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>

    <div class="section-label" style="margin-top:4px"></div>
    <button class="btn btn-danger" style="width:100%" onclick="confirmLogout()">🚪 Logout</button>
    <div style="text-align:center;margin-top:16px;font-size:11px;color:var(--ink-4)">🔒 Your data is encrypted and never shared with third parties</div>
    <div style="height:24px"></div>`;
}
window.renderProfile = renderProfile;



function confirmLogout() { showConfirm('Are you sure you want to logout?', logout, 'Logout', false); }
window.confirmLogout = confirmLogout;



// Profile modals
function editCollege() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:400px">
      <div class="fw-700 mb-1">🏫 Edit College</div>
      <div class="text-xs text-muted mb-3">Select your college/university. Choose Others if it isn't listed yet</div>
      <select id="_ec_coll" class="input-field" title="College / University" aria-label="College / University"><option value="">Loading...</option></select>
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="(async()=>{
          const c=document.getElementById('_ec_coll').value.trim();
          if(!c)return showToast('Select a college');
          await db(sb.from('users').update({college:c}).eq('email','${window.currentUser.email}'),'Update failed');
          currentUser.college=c;
          showToast('College updated ✓');
          this.closest('[style*=fixed]').remove();
          renderProfile();
        })()">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  populateCollegeSelect('_ec_coll', window.currentUser.college || '');
}
window.editCollege = editCollege;



function editPhone() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:400px">
      <div class="fw-700 mb-1">📱 Phone Number</div>
      <div class="text-xs text-muted mb-3">Used by admin for contact regarding your account</div>
      <input id="_ep_phone" class="input-field" type="tel" placeholder="03XX-XXXXXXX" value="${window.currentUser.phone||''}">
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="(async()=>{
          const p=document.getElementById('_ep_phone').value.trim();
          await db(sb.from('users').update({phone:p}).eq('email','${window.currentUser.email}'),'Update failed');
          currentUser.phone=p;
          showToast('Phone updated ✓');
          this.closest('[style*=fixed]').remove();
          renderProfile();
        })()">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.editPhone = editPhone;



async function saveName() {
  const newName = document.getElementById('newNameVal').value.trim();
  if (!newName) return showToast('Enter a name');
  await db(sb.from('users').update({ name: newName }).eq('email', window.currentUser.email), 'Name update failed');
  window.currentUser.name = newName;
  closeModal('modalName');
  showToast('Name updated ✓');
  renderProfile();
}
window.saveName = saveName;



async function savePrivacy() {
  const val = document.getElementById('privLeaderboard').checked;
  await db(sb.from('users').update({ show_on_leaderboard: val }).eq('email', window.currentUser.email), 'Privacy save failed');
  window.currentUser.show_on_leaderboard = val;
  showToast('Privacy settings saved ✓');
}
window.savePrivacy = savePrivacy;



// ==================== BOOKMARKS ====================
export async function renderBookmarks() {
  const wrap = document.getElementById('bookmarksPageWrap');
  wrap.innerHTML = `${skeletonList(4)}`;
  const { data: bookmarks } = await db(
    sb.from('bookmarks').select('*, questions(id,text,options,correct_answer,explanation,image_url,module_id,subject_id,paper_id,modules(name),subjects(name),past_papers(title))').eq('email', window.currentUser.email).order('added_at', { ascending: false }),
    'Bookmarks load failed'
  );

  if (!bookmarks?.length) {
    wrap.innerHTML = `<div class="card text-center" style="padding:40px 20px">
      <div style="font-size:48px">📖</div>
      <h3 style="margin-top:12px">No Bookmarks Yet</h3>
      <p class="mt-2">Tap the Bookmark button during a test to save questions here.</p>
    </div>`;
    return;
  }

  const groupByCorrect = { correct: [], wrong: [], skipped: [] };
  for (const b of bookmarks) {
    if (b.was_correct === true) groupByCorrect.correct.push(b);
    else if (b.was_correct === false) groupByCorrect.wrong.push(b);
    else groupByCorrect.skipped.push(b);
  }

  const renderGroup = (label, items) => {
    if (!items.length) return '';
    return `<div class="section-label">${label} (${items.length})</div>` +
      items.map(b => {
        const q = b.questions;
        // Build context line: Module › Subject or Paper
        const contextParts = [];
        if (q?.modules?.name) contextParts.push(q.modules.name);
        if (q?.past_papers?.title) contextParts.push(q.past_papers.title);
        else if (q?.subjects?.name) contextParts.push(q.subjects.name);
        const contextLine = contextParts.length ? `<div class="text-xs text-muted" style="margin-bottom:6px;color:var(--gold-600)">📍 ${contextParts.join(' › ')}</div>` : '';
        return `<div class="card" style="margin-bottom:8px">
          ${contextLine}
          <div style="font-size:14px;font-weight:600;line-height:1.5;margin-bottom:10px">${q?.text?.substring(0, 120) || 'Question not found'}${(q?.text?.length || 0) > 120 ? '...' : ''}</div>
          <div class="btn-row">
            <button class="btn btn-secondary btn-xs" onclick="showBookmarkedQ(${q?.id})">View Question</button>
            <button class="btn btn-ghost btn-xs" style="color:var(--red)" onclick="confirmRemoveBookmark(${q?.id})">Remove</button>
          </div>
        </div>`;
      }).join('');
  };

  wrap.innerHTML = `
    <div class="card-teal" style="margin-bottom:16px">
      <h2>📖 Bookmarks</h2>
      <p>${bookmarks.length} saved questions</p>
    </div>
    ${renderGroup('❌ Need Review (Wrong)', groupByCorrect.wrong)}
    ${renderGroup('✅ Correct', groupByCorrect.correct)}
    ${renderGroup('⏭ Skipped', groupByCorrect.skipped)}
    <div style="height:16px"></div>`;
}
window.renderBookmarks = renderBookmarks;



async function showBookmarkedQ(qid) {
  if (!qid) return showToast('Question not found');
  const { data: q } = await db(sb.from('questions').select('*').eq('id', qid).single(), 'Question load failed');
  if (!q) return showToast('Question not found');
  const letters = ['A','B','C','D','E','F'];
  const opts = Array.isArray(q.options) ? q.options : JSON.parse(q.options || '[]');
  const optHtml = opts.map((o, i) => `<div style="padding:10px 14px;border-radius:12px;margin-bottom:6px;font-size:14px;border:1.5px solid ${i === q.correct_answer ? 'var(--green)' : 'var(--border)'};background:${i === q.correct_answer ? 'var(--green-light)' : 'var(--surface)'}"><span style="font-weight:700;margin-right:8px">${letters[i]}.</span>${esc(o)}</div>`).join('');
  const wrap = document.getElementById('bookmarksPageWrap');
  wrap.innerHTML = `
    <button class="back-btn" onclick="renderBookmarks()">← Back to Bookmarks</button>
    <div class="card-elevated" style="margin-bottom:20px">
      <div style="font-size:15px;font-weight:600;line-height:1.6">${esc(q.text)}</div>
      ${q.image_url ? `<img src="${esc(q.image_url)}" style="max-width:100%;border-radius:12px;margin-top:10px" onerror="this.style.display='none'">` : ''}
    </div>
    ${optHtml}
    <button class="btn btn-ghost btn-sm mt-2" id="bmExpBtn_${q.id}" onclick="document.getElementById('bmExpPanel_${q.id}').style.display='block';this.style.display='none'">📖 Show Explanation</button>
    <div class="explanation-box" id="bmExpPanel_${q.id}" style="display:none;margin-top:12px">
      <div class="exp-label">✅ Correct: ${esc(opts[q.correct_answer]) || ''}</div>
      <div class="exp-content" style="margin-top:6px">${q.explanation ? renderMd(q.explanation) : '<span style="color:var(--ink-4)">No explanation yet.</span>'}</div>
      ${q.explanation_image_url ? `<img src="${esc(q.explanation_image_url)}" style="max-width:100%;border-radius:12px;margin-top:10px" onerror="this.style.display='none'">` : ''}
      <button class="btn btn-ghost btn-xs mt-2" onclick="document.getElementById('bmExpPanel_${q.id}').style.display='none';document.getElementById('bmExpBtn_${q.id}').style.display=''">🙈 Hide Explanation</button>
    </div>
    <div class="btn-row mt-3">
      ${isAIEnabled() ? `<button class="btn btn-ghost" onclick="openAITutor('${escJs(q.text)}','${escJs(q.explanation||'')}')">🤖 Explain with AI</button>` : ''}
      <button class="btn btn-ghost" onclick="openReportModal(${q.id})">🚩 Report</button>
    </div>
    <button class="btn btn-ghost mt-2" style="color:var(--red);width:100%" onclick="confirmRemoveBookmark(${q.id})">🗑 Remove Bookmark</button>
  `;
}
window.showBookmarkedQ = showBookmarkedQ;



function confirmRemoveBookmark(qid) {
  showConfirm('Remove this question from your bookmarks?', () => removeBookmarkById(qid), 'Remove', true);
}
window.confirmRemoveBookmark = confirmRemoveBookmark;



async function removeBookmarkById(qid) {
  await db(sb.from('bookmarks').delete().eq('email', window.currentUser.email).eq('question_id', qid), 'Remove failed');
  showToast('Bookmark removed');
  renderBookmarks();
}



// ==================== WRONG ATTEMPTS ====================
export async function renderWrongAttempts() {
  const wrap = document.getElementById('wrongAttemptsPageWrap');
  wrap.innerHTML = `${skeletonList(3)}`;
  const { data: wrongs } = await db(
    sb.from('wrong_attempts').select('*, questions(id,text,options,correct_answer,explanation,image_url,module_id,subject_id,paper_id,modules(name),subjects(name),past_papers(title))').eq('email', window.currentUser.email).order('last_wrong_at', { ascending: false }),
    'Wrong attempts load failed'
  );

  if (!wrongs?.length) {
    wrap.innerHTML = `<div class="card text-center" style="padding:40px 20px">
      <div style="font-size:48px">✅</div>
      <h3 style="margin-top:12px">No Wrong Attempts</h3>
      <p class="mt-2">Questions you answer incorrectly during a test are saved here automatically, so you can come back and revise them.</p>
    </div>`;
    return;
  }

  const rows = wrongs.map(w => {
    const q = w.questions;
    // Build context line: Module › Subject or Paper — same convention as Bookmarks
    const contextParts = [];
    if (q?.modules?.name) contextParts.push(q.modules.name);
    if (q?.past_papers?.title) contextParts.push(q.past_papers.title);
    else if (q?.subjects?.name) contextParts.push(q.subjects.name);
    const contextLine = contextParts.length ? `<div class="text-xs text-muted" style="margin-bottom:6px;color:var(--gold-600)">📍 ${contextParts.join(' › ')}</div>` : '';
    const missedBadge = (w.wrong_count || 1) > 1 ? ` <span class="badge badge-red">Missed ${w.wrong_count}×</span>` : '';
    return `<div class="card" style="margin-bottom:8px">
      ${contextLine}
      <div style="font-size:14px;font-weight:600;line-height:1.5;margin-bottom:10px">${q?.text?.substring(0, 120) || 'Question not found'}${(q?.text?.length || 0) > 120 ? '...' : ''}${missedBadge}</div>
      <div class="btn-row">
        <button class="btn btn-secondary btn-xs" onclick="showWrongQ(${q?.id})">View Question</button>
        <button class="btn btn-ghost btn-xs" style="color:var(--red)" onclick="confirmRemoveWrongAttempt(${q?.id})">Remove</button>
      </div>
    </div>`;
  }).join('');

  wrap.innerHTML = `
    <div class="card-teal" style="margin-bottom:16px">
      <h2>❌ Wrong Attempts</h2>
      <p>${wrongs.length} question${wrongs.length === 1 ? '' : 's'} to revise</p>
    </div>
    ${rows}
    <div style="height:16px"></div>`;
}
window.renderWrongAttempts = renderWrongAttempts;



async function showWrongQ(qid) {
  if (!qid) return showToast('Question not found');
  const [{ data: q }, { data: existingBm }] = await Promise.all([
    db(sb.from('questions').select('*').eq('id', qid).single(), 'Question load failed'),
    db(sb.from('bookmarks').select('id').eq('email', window.currentUser.email).eq('question_id', qid).maybeSingle(), 'Bookmark check failed')
  ]);
  if (!q) return showToast('Question not found');
  const letters = ['A','B','C','D','E','F'];
  const opts = Array.isArray(q.options) ? q.options : JSON.parse(q.options || '[]');
  const optHtml = opts.map((o, i) => `<div style="padding:10px 14px;border-radius:12px;margin-bottom:6px;font-size:14px;border:1.5px solid ${i === q.correct_answer ? 'var(--green)' : 'var(--border)'};background:${i === q.correct_answer ? 'var(--green-light)' : 'var(--surface)'}"><span style="font-weight:700;margin-right:8px">${letters[i]}.</span>${esc(o)}</div>`).join('');
  const wrap = document.getElementById('wrongAttemptsPageWrap');
  wrap.innerHTML = `
    <button class="back-btn" onclick="renderWrongAttempts()">← Back to Wrong Attempts</button>
    <div class="card-elevated" style="margin-bottom:20px">
      <div style="font-size:15px;font-weight:600;line-height:1.6">${esc(q.text)}</div>
      ${q.image_url ? `<img src="${esc(q.image_url)}" style="max-width:100%;border-radius:12px;margin-top:10px" onerror="this.style.display='none'">` : ''}
    </div>
    ${optHtml}
    <button class="btn btn-ghost btn-sm mt-2" id="waExpBtn_${q.id}" onclick="document.getElementById('waExpPanel_${q.id}').style.display='block';this.style.display='none'">📖 Show Explanation</button>
    <div class="explanation-box" id="waExpPanel_${q.id}" style="display:none;margin-top:12px">
      <div class="exp-label">✅ Correct: ${esc(opts[q.correct_answer]) || ''}</div>
      <div class="exp-content" style="margin-top:6px">${q.explanation ? renderMd(q.explanation) : '<span style="color:var(--ink-4)">No explanation yet.</span>'}</div>
      ${q.explanation_image_url ? `<img src="${esc(q.explanation_image_url)}" style="max-width:100%;border-radius:12px;margin-top:10px" onerror="this.style.display='none'">` : ''}
      <button class="btn btn-ghost btn-xs mt-2" onclick="document.getElementById('waExpPanel_${q.id}').style.display='none';document.getElementById('waExpBtn_${q.id}').style.display=''">🙈 Hide Explanation</button>
    </div>
    <div class="btn-row mt-3">
      ${isAIEnabled() ? `<button class="btn btn-ghost" onclick="openAITutor('${escJs(q.text)}','${escJs(q.explanation||'')}')">🤖 Explain with AI</button>` : ''}
      <button class="btn btn-ghost" onclick="openReportModal(${q.id})">🚩 Report</button>
      <button class="btn btn-secondary" onclick="quickBookmarkQuestion(${q.id}, this)">${existingBm ? '🔖 Saved ✓' : '📖 Save'}</button>
    </div>
    <button class="btn btn-ghost mt-2" style="color:var(--red);width:100%" onclick="confirmRemoveWrongAttempt(${q.id})">🗑 Remove from Wrong Attempts</button>
  `;
}
window.showWrongQ = showWrongQ;



function confirmRemoveWrongAttempt(qid) {
  showConfirm('Remove this question from Wrong Attempts?', () => removeWrongAttempt(qid), 'Remove', true);
}
window.confirmRemoveWrongAttempt = confirmRemoveWrongAttempt;



async function removeWrongAttempt(qid) {
  await db(sb.from('wrong_attempts').delete().eq('email', window.currentUser.email).eq('question_id', qid), 'Remove failed');
  showToast('Removed from Wrong Attempts');
  renderWrongAttempts();
}



// ==================== SEARCH ====================
// renderSearch and executeSearch are defined once, further below, with module/difficulty filters.

// ==================== PLANNER ====================
export async function renderPlanner() {
  const wrap = document.getElementById('plannerPageWrap');
  const stats = await getUserStats();
  const goal = parseInt(localStorage.getItem('daily_goal') || '20');
  const todayStr = new Date().toLocaleDateString();
  const todayHistory = (stats.history || []).filter(h => h.date === todayStr);
  const todayQ = todayHistory.reduce((a, h) => a + (h.total || 0), 0);
  const todayPct = Math.min(100, Math.round((todayQ / goal) * 100));

  // Build 30-day activity heatmap
  const historyMap = {};
  for (const h of (stats.history || [])) {
    historyMap[h.date] = (historyMap[h.date] || 0) + (h.total || 0);
  }
  const today = new Date();
  let heatmapHtml = '<div style="display:grid;grid-template-columns:repeat(10,1fr);gap:4px">';
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const ds = d.toLocaleDateString();
    const count = historyMap[ds] || 0;
    const isToday = ds === todayStr;
    const intensity = count === 0 ? 0 : count < 10 ? 1 : count < 25 ? 2 : 3;
    const bg = ['var(--surface-3)', 'var(--gold-200)', 'var(--gold-400)', 'var(--gold-700)'][intensity];
    const border = isToday ? '2px solid var(--gold-600)' : '1px solid var(--border)';
    heatmapHtml += `<div title="${ds}: ${count} questions" style="aspect-ratio:1;border-radius:4px;background:${bg};border:${border};cursor:default"></div>`;
  }
  heatmapHtml += `</div><div style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11px;color:var(--ink-4)">Less <div style="display:flex;gap:3px">${['var(--surface-3)','var(--gold-200)','var(--gold-400)','var(--gold-700)'].map(c=>`<div style="width:12px;height:12px;border-radius:2px;background:${c};border:1px solid var(--border)"></div>`).join('')}</div> More</div>`;

  // 7-day week strip
  const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const weekHtml = `<div style="display:flex;gap:6px;justify-content:space-between">` +
    Array.from({length:7}).map((_,i) => {
      const d = new Date(today);
      d.setDate(today.getDate() - (6 - i));
      const ds = d.toLocaleDateString();
      const count = historyMap[ds] || 0;
      const isToday = ds === todayStr;
      const done = count > 0;
      return `<div style="flex:1;text-align:center">
        <div style="font-size:10px;color:var(--ink-4);margin-bottom:4px">${days[d.getDay()]}</div>
        <div style="width:36px;height:36px;border-radius:50%;background:${done ? 'var(--gold-600)' : 'var(--surface-3)'};border:2px solid ${isToday ? 'var(--gold-400)' : done ? 'var(--gold-600)' : 'var(--border)'};margin:0 auto;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:${done ? 'white' : 'var(--ink-4)'}">
          ${done ? '✓' : isToday ? '·' : ''}
        </div>
        ${count > 0 ? `<div style="font-size:9px;color:var(--gold-600);font-weight:700;margin-top:2px">${count}Q</div>` : ''}
        ${isToday && !done ? '<div style="font-size:9px;color:var(--gold-600);font-weight:700;margin-top:2px">TODAY</div>' : ''}
      </div>`;
    }).join('') + '</div>';

  wrap.innerHTML = `
    <div class="card-teal" style="margin-bottom:16px">
      <h2>📅 Study Planner</h2>
      <p>Stay consistent, future doctor!</p>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-1">Today's Progress</div>
      <div class="flex-between mb-1">
        <span class="text-sm">${todayQ} / ${goal} questions</span>
        <span class="fw-700" style="color:var(--gold-700)">${todayPct}%</span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${todayPct}%"></div></div>
      ${todayPct >= 100 ? '<div class="badge badge-green mt-2">🎉 Daily goal achieved!</div>' : `<div class="text-xs text-muted mt-2">${goal - todayQ} more to go</div>`}
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="flex-between" style="margin-bottom:12px">
        <div><div class="fw-700">🔥 Current Streak</div><div class="text-sm text-muted">${stats.last_practice_date ? 'Last active: ' + stats.last_practice_date : 'Not started yet'}</div></div>
        <div style="font-family:var(--font-display);font-size:40px;font-weight:800;color:var(--gold-700);line-height:1">${stats.streak || 0}<span style="font-size:18px">🔥</span></div>
      </div>
      <div style="font-size:11px;color:var(--ink-4)">Both Attempt and Review sessions count toward your streak.</div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">📆 This Week</div>
      ${weekHtml}
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-3">📊 Last 30 Days</div>
      ${heatmapHtml}
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="fw-700 mb-2">${ICON_TARGET} Daily Goal</div>
      <select id="goalSelect" class="input-field" title="Daily goal" aria-label="Daily goal" onchange="localStorage.setItem('daily_goal',this.value);renderPlanner()">
        ${[10,20,30,50,100].map(n => `<option value="${n}" ${goal === n ? 'selected' : ''}>${n} questions/day</option>`).join('')}
      </select>
    </div>
    <div style="height:16px"></div>`;
}
window.renderPlanner = renderPlanner;

// ==================== STARTUP (overridden in boot script below) ====================
// window.onload is defined at end of file



// ==================== NOTIFICATIONS ====================
export async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (localStorage.getItem('notif_enabled') === 'false') return; // student opted out
  if (Notification.permission === 'default') await Notification.requestPermission();
}



function toggleNotifications(enabled) {
  localStorage.setItem('notif_enabled', enabled ? 'true' : 'false');
  if (enabled) requestNotificationPermission();
  showToast(enabled ? 'Notifications turned on' : 'Notifications turned off');
  renderProfile();
}
window.toggleNotifications = toggleNotifications;



// ==================== DARK MODE ====================
// Dark mode is pure black surfaces + pure white text — the exact mirror of
// light mode (pure white surfaces + pure black text). Gold/amber (the app
// logo color) stays reserved for accents and highlights only (buttons,
// badges, active states, stat numbers) in both modes — it's never used for
// body text or page backgrounds, which is what makes it read as a highlight
// instead of "the app's color". Previously this function only swapped
// surface/ink/border variables, leaving gold-700/800/900 (and the red/amber/
// green status colors) at their light-mode values — those are used as TEXT
// on light-tinted backgrounds (e.g. achievement pills, correct/wrong answer
// rows), so on a forced-black page they'd render as dark, low-contrast text.
// Now every variable that has a light-vs-dark-appropriate version gets
// swapped together, so nothing is left half-migrated. Light mode's "reset"
// doesn't hardcode a second copy of the default colors either — it just
// removes the inline overrides so the CSS :root values (the single source
// of truth) show through. That way the two palettes can never drift out of
// sync again. This never checks the phone's system dark/light setting —
// only the Dark Mode switch in Profile controls this, so it can't silently
// turn on (or fail to turn on) based on a device setting nobody's looking at.
const DARK_MODE_VARS = ['--surface','--surface-2','--surface-3','--ink','--ink-2','--ink-3','--ink-4','--border','--border-2','--overlay-bg','--gold-50','--gold-100','--gold-200','--gold-700','--gold-800','--gold-900','--red','--red-light','--red-border','--amber','--amber-light','--green','--green-light'];


export function applyDarkMode(enabled) {
  const root = document.documentElement.style;
  if (enabled) {
    root.setProperty('--surface', '#000000');
    root.setProperty('--surface-2', '#000000');
    root.setProperty('--surface-3', '#000000');
    root.setProperty('--ink', '#ffffff');
    root.setProperty('--ink-2', '#ffffff');
    root.setProperty('--ink-3', '#ffffff');
    root.setProperty('--ink-4', '#a6a6a6');
    root.setProperty('--border', '#2b2b2b');
    root.setProperty('--border-2', '#3d3d3d');
    root.setProperty('--overlay-bg', 'rgba(0,0,0,.95)');
    // Light-tint gold backgrounds (50/100/200 — subtle tinted surfaces like
    // the explanation box or badges) become dark muted equivalents; the
    // darker golds used as readable TEXT on those surfaces (700/800/900)
    // become light warm gold instead — same background+text pairing,
    // contrast flipped correctly in both directions. Mid-range golds
    // (300-600, icons/borders/solid buttons) are untouched — they already
    // read fine on black. The ~10 hardcoded "hero" gradients (splash,
    // card-teal, primary buttons) also stay untouched on purpose, so they
    // stay a consistent rich gold regardless of mode.
    root.setProperty('--gold-50', '#2b2410');
    root.setProperty('--gold-100', '#332a14');
    root.setProperty('--gold-200', '#5c4a1a');
    root.setProperty('--gold-700', '#e0b030');
    root.setProperty('--gold-800', '#f0c869');
    root.setProperty('--gold-900', '#f7dfa0');
    root.setProperty('--red', '#f0645f');
    root.setProperty('--red-light', '#3a1616');
    root.setProperty('--red-border', '#5c2424');
    root.setProperty('--amber', '#e0a030');
    root.setProperty('--amber-light', '#3a2e10');
    root.setProperty('--green', '#4ade9b');
    root.setProperty('--green-light', '#123024');
    document.documentElement.style.colorScheme = 'dark';
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', '#000000'));
    localStorage.setItem('dark_mode', 'true');
  } else {
    DARK_MODE_VARS.forEach(k => root.removeProperty(k));
    document.documentElement.style.colorScheme = 'light';
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', '#ffffff'));
    localStorage.setItem('dark_mode', 'false');
  }
}



// ==================== SOUND EFFECTS (tiny, generated — no audio files needed) ====================
function toggleSoundEffects(enabled) {
  localStorage.setItem('sound_enabled', enabled ? 'true' : 'false');
  showToast(enabled ? 'Sound effects on' : 'Sound effects off');
  renderProfile();
}
window.toggleSoundEffects = toggleSoundEffects;



function toggleDarkMode() {
  const isDark = localStorage.getItem('dark_mode') === 'true';
  applyDarkMode(!isDark);
  if (typeof renderProfile === 'function') renderProfile();
}
window.toggleDarkMode = toggleDarkMode;



// ==================== SUBSCRIBE / PAYMENT FLOW (STUDENT SIDE) ====================
async function showSubscriptionPlans() {
  let plans = cacheGet('subscription_plans', 1800000);
  if (!plans) {
    const { data } = await db(
      sb.from('subscription_plans').select('*').eq('is_active', true).order('price'),
      'Plans error'
    );
    plans = data;
    if (plans) cacheSet('subscription_plans', plans);
  }
  const currency = await getSetting('currency', 'PKR');
  const payEnabled = await getSetting('payment_enabled', 'false');
  const instructions = await getSetting('payment_instructions', '');

  if (payEnabled !== 'true') {
    showToast('Subscription coming soon!'); return;
  }

  const plansHtml = (plans||[]).map(p => `
    <div class="card ${p.is_featured ? 'card-teal' : ''}" style="margin-bottom:10px;position:relative">
      ${p.is_featured ? '<div style="position:absolute;top:-8px;right:12px"><span class="badge badge-green">⭐ Most Popular</span></div>' : ''}
      <div class="fw-700" style="font-size:18px">${p.name}</div>
      <div style="font-family:var(--font-display);font-size:28px;font-weight:800;margin:8px 0">${p.is_free ? 'FREE' : `${currency} ${p.price}`}<span style="font-size:14px;font-weight:500">/${p.billing_cycle || 'month'}</span></div>
      <div class="text-sm" style="margin-bottom:12px">${(p.features||[]).map(f => `✅ ${f}`).join('<br>')}</div>
      <button class="btn ${p.is_featured ? 'btn-secondary' : 'btn-primary'}" onclick="subscribeToPlan('${p.id}','${p.name}',${p.price},${p.is_free})">${p.is_free ? 'Get Free Access' : 'Subscribe Now'}</button>
    </div>`).join('') || '<p>No plans available yet.</p>';

  // Show in modal-like card
  const wrap = document.getElementById('profilePageWrap');
  wrap.innerHTML = `
    <button class="back-btn" onclick="renderProfile()">← Back</button>
    <div class="card-teal" style="margin-bottom:16px;text-align:center">
      <h2>Upgrade Your Plan</h2>
      <p>Unlock full access to all MCQs and features</p>
    </div>
    ${plansHtml}
    ${instructions ? `<div class="card"><div class="fw-700 mb-1">💳 How to Pay</div><div class="text-sm">${instructions}</div></div>` : ''}`;
}
window.showSubscriptionPlans = showSubscriptionPlans;



async function subscribeToPlan(planId, planName, price, isFree) {
  if (!window.currentUser) return;
  if (isFree || price === 0) {
    await db(sb.from('subscriptions').insert({
      user_email: window.currentUser.email, plan_id: planId, status: 'active',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 36500 * 86400000).toISOString()
    }), 'Subscribe failed');
    showToast('✅ Free plan activated!');
    return;
  }
  const instructions = await getSetting('payment_instructions', 'Contact admin to complete payment.');
  showToast('Submitting request...');
  await db(sb.from('subscriptions').insert({
    user_email: window.currentUser.email, plan_id: planId, status: 'pending',
    created_at: new Date().toISOString()
  }), 'Subscribe failed');
  const pOverlay = document.createElement('div');
  pOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  pOverlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:400px;text-align:center">
      <div style="font-size:32px;margin-bottom:12px">📱</div>
      <div class="fw-700 mb-2">Payment Required</div>
      <div class="fw-600 mb-1" style="color:var(--gold-600)">${planName}</div>
      <div style="font-size:14px;line-height:1.6;color:var(--ink-2);margin-bottom:16px;white-space:pre-line">${instructions}</div>
      <div class="text-xs text-muted mb-3">Your subscription will activate after admin approves your payment.</div>
      <button class="btn btn-primary" onclick="this.closest('[style*=fixed]').remove()">Got it</button>
    </div>`;
  document.body.appendChild(pOverlay);
}
window.subscribeToPlan = subscribeToPlan;
