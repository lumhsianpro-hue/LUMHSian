import { db, sb } from './supabase.js';
import { esc, openModal, renderAvatar, showToast, skeletonList } from './utils.js';



// ==================== LEADERBOARD ====================
// Shared by renderRanking() and the post-test rank-change celebration, so both
// use the exact same cohort/sort logic and never disagree on someone's rank.
async function computeLeaderboardCohort(year) {
  let query = sb.from('users').select('email,name,gender,college,show_on_leaderboard,year_of_study');
  if (year) query = query.eq('year_of_study', year);
  const { data: users } = await db(query, 'Leaderboard error');
  if (!users) return { combined: [], myRank: 0, me: null };
  const emails = users.map(u => u.email);
  const { data: stats } = await db(sb.from('user_stats').select('email,attempt_correct,attempt_questions,total_tests').in('email', emails), 'Stats error');
  // Ranking is purely on Attempt-mode performance — practice/review answers
  // never factor in, since those aren't a single committed, graded pass the
  // way a real Attempt is. A student needs at least 100 questions answered
  // in Attempt mode (cumulative — any mix of practice tests, Build Your Own
  // Test, or past papers, not necessarily from one single test) before they
  // qualify at all; past that threshold, ranking is by their attempt-mode
  // accuracy, and every additional Attempt afterward keeps shifting that
  // accuracy (and so their rank) as it comes in.
  const MIN_QUESTIONS = 100;
  const combined = users.map(u => {
    const s = stats?.find(ss => ss.email === u.email) || {};
    const attemptQ = s.attempt_questions || 0;
    const acc = attemptQ ? Math.round((s.attempt_correct / attemptQ) * 100) : 0;
    return { ...u, acc, total_tests: s.total_tests || 0, attempt_questions: attemptQ };
  }).filter(u => u.attempt_questions >= MIN_QUESTIONS && u.email !== 'lumhsianpro@gmail.com').sort((a, b) => b.acc - a.acc || b.attempt_questions - a.attempt_questions);
  const myRank = combined.findIndex(u => u.email === window.currentUser.email) + 1;
  const me = combined.find(u => u.email === window.currentUser.email);
  return { combined, myRank, me };
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
  const { combined, myRank, me } = await computeLeaderboardCohort(myYear);
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
    <div class="text-xs text-muted" style="text-align:center;margin-bottom:16px;line-height:1.5">🔒 To appear here, answer at least 100 questions in Attempt mode — any mix of practice tests, Build Your Own Test, or past papers. Ranked by your accuracy on those.</div>

    ${me ? `<div style="background:var(--gold-50);border:2px solid var(--gold-400);border-radius:var(--radius-lg);padding:16px;margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--gold-600);margin-bottom:8px">Your Position</div>
      <div class="flex-between">
        <div class="flex" style="gap:10px">
          ${renderAvatar(me.name, 40)}
          <div>
            <div class="fw-700">Dr. ${esc(me.name)}</div>
            <div class="text-xs text-muted">${esc(me.college)||''} · ${me.attempt_questions} questions</div>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:22px;font-weight:800;color:var(--gold-700)">${me.acc}%</div>
          <div class="text-xs text-muted">Rank #${myRank}</div>
        </div>
      </div>
    </div>` : myYear ? `<div class="card" style="margin-bottom:16px;text-align:center"><p>Answer at least 100 questions in Attempt mode (practice tests, Build Your Own Test, or past papers) to appear on the leaderboard!</p></div>` : `<div class="card" style="margin-bottom:16px;text-align:center"><p>Set your year in Profile to see your ranking among peers.</p></div>`}

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
          <div class="text-xs text-muted">${esc(u.college)||'Unknown College'} · ${u.attempt_questions} Qs</div>
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
