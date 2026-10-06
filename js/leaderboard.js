import { db, sb } from './supabase.js';
import { esc, openModal, renderAvatar, showToast, skeletonList } from './utils.js';



// ==================== LEADERBOARD ====================
// Shared by renderRanking() and the post-test rank-change celebration, so both
// use the exact same cohort/sort logic and never disagree on someone's rank.
// A student appears on the leaderboard once they have ATTEMPTED at least this many questions in Attempt mode.
// Skipped questions do not count toward it — but when accuracy is measured they count as wrong.
export const MIN_ATTEMPTED_QUESTIONS = 200;

// Both lookups are paged/chunked: one giant ".in('email', [thousands of addresses])" makes the request URL too long
// for the server once the app has a few hundred students, which would silently blank the whole leaderboard.
async function _fetchAllUsers(year) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let query = sb.from('users').select('email,name,gender,college,show_on_leaderboard,year_of_study').range(from, from + 999);
    if (year) query = query.eq('year_of_study', year);
    const { data, error } = await db(query, 'Leaderboard error');
    if (error || !data) return error ? null : out;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function _fetchStatsFor(emails) {
  const out = [];
  let cols = 'email,attempt_correct,attempt_questions,attempt_answered,total_tests';
  for (let i = 0; i < emails.length; i += 150) {
    const chunk = emails.slice(i, i + 150);
    let res = await sb.from('user_stats').select(cols).in('email', chunk);
    if (res.error && cols.includes('attempt_answered')) {
      // attempt_answered not migrated yet — fall back so the leaderboard still loads (it then counts skipped too)
      cols = 'email,attempt_correct,attempt_questions,total_tests';
      res = await sb.from('user_stats').select(cols).in('email', chunk);
    }
    if (res.error && cols.includes('attempt_questions')) {
      // the attempt-mode columns aren't migrated at all yet: nobody can qualify, but the screen still opens normally
      cols = 'email,total_tests';
      res = await sb.from('user_stats').select(cols).in('email', chunk);
    }
    if (res.error) { await db(Promise.resolve(res), 'Stats error'); return null; }
    out.push(...(res.data || []));
  }
  return out;
}

// Shared by renderRanking(), the post-test rank celebration AND the Home rank badge (getRankInfo in app.js), so
// everything always shows the same rank.
export async function computeLeaderboardCohort(year) {
  const users = await _fetchAllUsers(year);
  if (!users) return { combined: [], myRank: 0, me: null, myAttempted: 0 };
  const stats = await _fetchStatsFor(users.map(u => u.email));
  if (!stats) return { combined: [], myRank: 0, me: null, myAttempted: 0 };
  // Ranking is purely on Attempt-mode performance — practice/review answers never factor in.
  //   • To qualify: at least MIN_ATTEMPTED_QUESTIONS questions ATTEMPTED (answered) in Attempt mode, cumulative across
  //     any mix of practice tests, Build Your Own Test and past papers. Skipped questions do not count here.
  //   • Ranked by: accuracy = correct ÷ ALL questions in those attempts, so a skipped question counts as wrong.
  //   attempt_answered is the running count of attempted questions. Rows from before it existed (null / 0) fall back
  //   to attempt_questions, which is what quiz.js also starts from, so nobody loses progress.
  const byEmail = new Map(stats.map(s => [s.email, s]));
  const everyone = users.map(u => {
    const s = byEmail.get(u.email) || {};
    const attemptQ = s.attempt_questions || 0;
    const attempted = (s.attempt_answered || 0) > 0 ? s.attempt_answered : attemptQ;
    const acc = attemptQ ? Math.round(((s.attempt_correct || 0) / attemptQ) * 100) : 0;
    return { ...u, acc, total_tests: s.total_tests || 0, attempt_questions: attemptQ, attempted };
  });
  const combined = everyone
    .filter(u => u.attempted >= MIN_ATTEMPTED_QUESTIONS && u.email !== 'lumhsianpro@gmail.com')
    .sort((a, b) => b.acc - a.acc || b.attempted - a.attempted);
  const myEmail = window.currentUser.email;
  const myRank = combined.findIndex(u => u.email === myEmail) + 1;
  const me = combined.find(u => u.email === myEmail) || null;
  const mine = everyone.find(u => u.email === myEmail);
  return { combined, myRank, me, myAttempted: mine ? mine.attempted : 0 };
}



// Pre-fills the toggle to match the student's actual current setting before
// showing the modal — previously the checkbox always opened unchecked
// regardless of the real saved value.
function openPrivacyModal() {
  const cb = document.getElementById('privLeaderboard');
  if (cb) cb.checked = !!window.currentUser.show_on_leaderboard;
  openModal('modalPrivacy');
}
window.openPrivacyModal = openPrivacyModal;



export async function renderRanking() {
  const wrap = document.getElementById('rankingPageWrap');
  wrap.innerHTML = `${skeletonList(4)}`;
  const myYear = window.currentUser?.year_of_study || null;
  const { combined, myRank, me, myAttempted } = await computeLeaderboardCohort(myYear);
  const top10 = combined.slice(0, 10);
  const rankMedals = ['🥇','🥈','🥉'];

  // Anonymous entries get a neutral placeholder, not initials — showing
  // initials would partly defeat the point of choosing to stay anonymous.
  const rankAvatarHtml = (u, size) => u.show_on_leaderboard
    ? renderAvatar(u.name, size)
    : `<div style="width:${size}px;height:${size}px;min-width:${size}px;border-radius:50%;background:var(--surface-3);border:2px solid var(--border-2);color:var(--ink-4);display:flex;align-items:center;justify-content:center;font-size:${Math.round(size*0.45)}px">?</div>`;

  wrap.innerHTML = `
    <div style="background:linear-gradient(135deg,#7a5c00,#c9980a);border-radius:var(--radius-xl);padding:24px;margin-bottom:12px;color:white;text-align:center;position:relative">
      <button onclick="openPrivacyModal()" title="Choose whether your name is shown on the leaderboard" style="position:absolute;top:14px;right:14px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);color:white;border-radius:999px;padding:7px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:4px">
        ${window.currentUser.show_on_leaderboard ? '👁️ Visible' : '🎭 Anonymous'}
      </button>
      <div style="font-size:36px;margin-bottom:8px">🏆</div>
      <div style="font-family:var(--font-display);font-size:22px;font-weight:800">Top Rankers</div>
      <div style="font-size:13px;opacity:.7;margin-top:4px">${myYear ? `${myYear} · ` : ''}${combined.length} students · Ranked by accuracy</div>
    </div>
    <div class="text-xs text-muted" style="text-align:center;margin-bottom:16px;line-height:1.5">🔒 To appear here, attempt at least ${MIN_ATTEMPTED_QUESTIONS} questions in Attempt mode (skipped ones don't count) — any mix of practice tests, Build Your Own Test, or past papers. Ranking is by accuracy, and skipped questions count as wrong.</div>

    ${me ? `<div style="background:var(--gold-50);border:2px solid var(--gold-400);border-radius:var(--radius-lg);padding:16px;margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--gold-600);margin-bottom:8px">Your Position</div>
      <div class="flex-between">
        <div class="flex" style="gap:10px">
          ${renderAvatar(me.name, 40)}
          <div>
            <div class="fw-700">Dr. ${esc(me.name)}</div>
            <div class="text-xs text-muted">${esc(me.college)||''} · ${me.attempted} attempted</div>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:22px;font-weight:800;color:var(--gold-700)">${me.acc}%</div>
          <div class="text-xs text-muted">Rank #${myRank}</div>
        </div>
      </div>
    </div>` : myYear ? `<div class="card" style="margin-bottom:16px;text-align:center"><div class="fw-700" style="font-size:18px">${myAttempted} / ${MIN_ATTEMPTED_QUESTIONS} attempted</div><div style="height:8px;background:var(--border);border-radius:99px;overflow:hidden;margin:10px 0"><div style="height:100%;width:${Math.min(100, Math.round(myAttempted / MIN_ATTEMPTED_QUESTIONS * 100))}%;background:var(--gold-500,#c9980a)"></div></div><p class="text-sm">Attempt ${Math.max(0, MIN_ATTEMPTED_QUESTIONS - myAttempted)} more questions in Attempt mode to appear on the leaderboard. Skipped questions don't count.</p></div>` : `<div class="card" style="margin-bottom:16px;text-align:center"><p>Set your year in Profile to see your ranking among peers.</p></div>`}

    <div class="section-label">Top 10 · ${myYear || 'All Students'}</div>
    ${top10.map((u, i) => {
      const isMe = u.email === window.currentUser.email;
      const showName = u.show_on_leaderboard;
      return `<div class="lb-item" style="${isMe ? 'border-color:var(--gold-400);background:var(--gold-50);' : ''}${i < 3 ? 'border-left:3px solid '+(i===0?'#f59e0b':i===1?'#9ca3af':'#b45309')+';' : ''}">
        <div style="width:36px;text-align:center;font-size:${i < 3 ? '22px' : '15px'};font-weight:800;color:${i===0?'#f59e0b':i===1?'#9ca3af':i===2?'#b45309':'var(--ink-4)'}">
          ${i < 3 ? rankMedals[i] : (i+1)}
        </div>
        <div style="margin:0 4px">${rankAvatarHtml(u, 36)}</div>
        <div style="flex:1;min-width:0">
          <div class="fw-700 text-sm">${showName ? 'Dr. '+esc(u.name) : 'Anonymous 🎭'}${isMe ? ' · You' : ''}</div>
          <div class="text-xs text-muted">${esc(u.college)||'Unknown College'} · ${u.attempted} Qs</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="fw-700" style="color:var(--gold-700);font-size:18px">${u.acc}%</div>
          <div class="text-xs text-muted">accuracy</div>
        </div>
      </div>`;
    }).join('')}
    ${combined.length === 0 ? '<div class="card text-center"><p>No ranked students in your year yet. Be the first!</p></div>' : ''}
    <div style="height:16px"></div>`;
}



// Synthesizes a short ascending chime with the Web Audio API — no audio file
// needed, keeps this a single HTML file. Fails silently on browsers that
// block audio without a prior user gesture; the celebration still shows.
function playAchievementSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.11;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
  } catch (e) { /* Web Audio unavailable — not critical, skip quietly */ }
}



// Checks whether this test's result improved the student's rank enough to be
// worth celebrating (newly in the top 10, or moved up within it), compared to
// the last rank we know they saw. Stored in localStorage rather than a new DB
// column — losing this on a fresh device just means a harmless repeat
// celebration, not a real bug.
export async function checkRankCelebration() {
  if (!window.currentUser?.year_of_study) return;
  const { myRank } = await computeLeaderboardCohort(window.currentUser.year_of_study);
  if (!myRank || myRank > 10) return;
  const key = 'lum_last_rank_' + window.currentUser.email;
  const prevRank = parseInt(localStorage.getItem(key) || '0', 10);
  const improved = !prevRank || prevRank > 10 || myRank < prevRank;
  localStorage.setItem(key, String(myRank));
  if (improved) showRankCelebration(myRank);
}



function showRankCelebration(rank) {
  playAchievementSound();
  const overlay = document.createElement('div');
  overlay.id = 'rankCelebrationOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,10,20,.85);z-index:10005;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(8px);animation:fadeInUp .3s ease-out';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:32px 24px;width:100%;max-width:380px;text-align:center">
      <div style="font-size:52px;margin-bottom:8px">🏆</div>
      <div style="font-family:var(--font-display);font-size:20px;font-weight:800;color:var(--ink)">Congratulations!</div>
      <div style="font-size:15px;color:var(--ink-2);margin-top:8px;line-height:1.5">You're now ranked <strong style="color:var(--gold-700)">#${rank}</strong> on the leaderboard.</div>
      <div style="height:1px;background:var(--border);margin:20px 0"></div>
      <div style="font-size:13px;color:var(--ink-3);margin-bottom:14px">Would you like other students to see your name, or stay anonymous?</div>
      <div class="btn-row" style="justify-content:center">
        <button class="btn btn-primary" style="flex:1" onclick="setLeaderboardVisibility(true)">Show My Name</button>
        <button class="btn btn-secondary" style="flex:1" onclick="setLeaderboardVisibility(false)">Stay Anonymous</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}



async function setLeaderboardVisibility(val) {
  const { error } = await db(sb.from('users').update({ show_on_leaderboard: val }).eq('email', window.currentUser.email), 'Privacy save failed');
  if (error) return; // db() already showed the specific error — leave the dialog open so they can retry
  window.currentUser.show_on_leaderboard = val;
  document.getElementById('rankCelebrationOverlay')?.remove();
  showToast(val ? '👁️ Your name is now visible on the leaderboard' : '🎭 You\'ll stay anonymous on the leaderboard');
}
window.setLeaderboardVisibility = setLeaderboardVisibility;
