import { getSetting, getUserStats, isAIEnabled, loadBookmarkedIndexSet, loadYearScreen, logActivity, renderHome, saveUserStats } from './app.js';
import { checkRankCelebration } from './leaderboard.js';
import { _returnToScreen, showScreen } from './navigation.js';
import { SUPABASE_KEY, SUPABASE_URL, db, sb } from './supabase.js';
import { ICON_CHART, ICON_CHECK_CIRCLE, ICON_CLOCK, ICON_TARGET, ICON_X_CIRCLE, closeModal, esc, escJs, openModal, playSound, rateLimited, renderMd, showConfirm, showLoading, showToast } from './utils.js';



// Shown when student returns AFTER timed test clock ran out — submits and shows full results screen
export async function _showTimeExpiredResult() {
  const notice = document.createElement('div');
  notice.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.92);z-index:10012;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(8px)';
  notice.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:28px 24px;width:100%;max-width:380px;text-align:center">
      <div style="font-size:40px;margin-bottom:12px">⏰</div>
      <h3 style="margin-bottom:8px">Time's Up!</h3>
      <p style="font-size:14px;color:var(--ink-3);line-height:1.6;margin-bottom:20px">
        Your allotted time expired while you were away. Your answers have been automatically submitted and your results are ready.
      </p>
      <button class="btn btn-primary" id="_timeUpBtn" disabled style="opacity:.6">Calculating results...</button>
    </div>`;
  document.body.appendChild(notice);
  // Submit + render results screen behind the notice
  await submitTest();
  // Unlock button — pressing it reveals the already-rendered results screen
  const btn = document.getElementById('_timeUpBtn');
  if (btn) {
    btn.textContent = 'View My Results →';
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.onclick = () => notice.remove();
  }
}



export function _showResumeDialog(saved, elapsed) {
  if (document.getElementById('_resumeOverlay')) return; // never stack a second copy of this dialog
  const isAttempt = saved.mode === 'attempt';
  const isPractice = saved.mode === 'practice';
  const isReview = saved.mode === 'browse';
  const answered = (saved.answers || []).filter(a => a !== null).length;
  const total = (saved.questions || []).length;
  const testName = saved.testTitle || saved.paperTitle || saved.moduleName || 'your test';

  let timeInfo = '';
  if (isAttempt && saved.timeLimit) {
    const rem = Math.max(0, saved.timeLimit - elapsed);
    const m = Math.floor(rem / 60), s = rem % 60;
    timeInfo = `⏱ ${m}m ${s.toString().padStart(2,'0')}s remaining`;
  } else {
    const hrsAgo = Math.floor(elapsed / 3600);
    const minsAgo = Math.floor(elapsed / 60);
    timeInfo = hrsAgo >= 1 ? `Left ${hrsAgo}h ago` : `Left ${minsAgo}m ago`;
  }

  const icon = isAttempt ? '⏳' : (isPractice ? '📝' : '📖');
  const title = isAttempt ? 'Unfinished Test' : (isPractice ? 'Unfinished Practice' : 'Continue Review');
  const modeLabel = isAttempt ? (saved.timeLimit ? '⏱ Timed Attempt' : '📝 Attempt') : (isPractice ? '📝 Practice Mode' : '📖 Review Mode');
  const resumeLabel = isAttempt ? '▶ Continue Test' : (isPractice ? '▶ Continue Practice' : '▶ Continue Review');
  const skipLabel = isAttempt ? 'Submit & Exit' : (isPractice ? 'Finish & Exit' : 'Exit Review');
  const notice = (isAttempt && saved.timeLimit)
    ? `<p style="font-size:12px;color:var(--ink-4);margin-top:8px">Timer has been running while you were away.</p>`
    : (isAttempt ? '' : `<p style="font-size:12px;color:var(--ink-4);margin-top:8px">Your ${isPractice ? 'practice' : 'review'} progress is saved for up to ${isPractice ? '2 days' : 'a week'}.</p>`);

  const overlay = document.createElement('div');
  overlay.id = '_resumeOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.88);z-index:10010;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(8px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:28px 24px;width:100%;max-width:380px;text-align:center">
      <div style="font-size:36px;margin-bottom:10px">${icon}</div>
      <h3 style="margin-bottom:6px">${title}</h3>
      <p style="font-size:13px;color:var(--ink-3);margin-bottom:2px">${modeLabel} · <strong>${testName}</strong></p>
      <p style="font-size:13px;color:var(--ink-3);margin-bottom:4px">${answered}/${total} answered · ${timeInfo}</p>
      ${notice}
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:18px">
        <button class="btn btn-primary" onclick="window._doResume()">${resumeLabel}</button>
        <button class="btn btn-secondary" onclick="window._skipResume()">${skipLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  window._resumeSnapshot = saved;

  window._doResume = () => {
    overlay.remove();
    const s = window._resumeSnapshot;
    if (!s) return;
    window.activeTest = { ...s, bookmarked: new Set(s.bookmarked || []), timerInterval: null, submitted: false };
    if (window.activeTest.mode === 'attempt' && window.activeTest.timeLimit) startTimer();
    renderTestScreen();
    showScreen('test');
    showToast(isAttempt ? '▶ Test resumed, timer running' : (isPractice ? '📝 Practice resumed' : '📖 Review resumed'));
  };

  window._skipResume = () => {
    overlay.remove();
    clearPersistedTest();
    if (isAttempt || isPractice) {
      // Finishing here counts whatever was answered — same "at least one
      // answered counts" rule as exiting mid-session, just reached via the
      // boot-time dialog instead. Review never submits/counts, by design.
      window.activeTest = { ...saved, bookmarked: new Set(saved.bookmarked || []), timerInterval: null, submitted: false };
      submitTest();
    } else {
      const sy = localStorage.getItem('lum_year');
      if (sy) { window.selectedYear = JSON.parse(sy); renderHome(); showScreen('home'); }
      else loadYearScreen();
    }
  };
}



export async function startCustomTest(moduleIds, subjectIds, count, timerMinutes, name) {
  showLoading(true, 'Building your test...');
  let query = sb.from('questions').select('id,text,options,correct_answer,explanation,image_url,explanation_image_url,subject_id,module_id').in('module_id', moduleIds);
  if (subjectIds?.length) query = query.in('subject_id', subjectIds);
  const { data: qs } = await db(query, 'Failed to load questions');
  if (!qs?.length) { showLoading(false); showToast('No questions found for this selection.'); return; }

  const shuffled = shuffleArray([...qs]).slice(0, count);
  const mapped = shuffled.map(q => ({
    id: q.id, text: q.text, options: Array.isArray(q.options) ? q.options : JSON.parse(q.options || '[]'),
    answer: q.correct_answer, explanation: q.explanation,
    imageUrl: q.image_url, expImageUrl: q.explanation_image_url,
    subjectId: q.subject_id, moduleId: q.module_id
  }));

  // Build Your Own Test now always behaves like a real Attempt — no instant
  // per-option feedback, review only at the end — regardless of whether a timer
  // was set. isCustom is what keeps it OUT of stats/history/leaderboard and
  // out of Wrong Attempts tracking (both in submitTest()).
  // The timer itself stays optional: set one and it counts down like a normal
  // attempt; leave it blank and it's simply untimed.
  if (window.activeTest?.timerInterval) clearInterval(window.activeTest.timerInterval);
  clearPersistedTest();
  const bookmarked = await loadBookmarkedIndexSet(mapped);
  window.activeTest = {
    questions: mapped, answers: new Array(mapped.length).fill(null),
    explanationShown: new Array(mapped.length).fill(false),
    bookmarked,
    currentIndex: 0, mode: 'attempt', isCustom: true, moduleId: moduleIds[0], moduleName: name || 'Custom Test', subjectId: null, paperId: null, paperTitle: null,
    startTime: Date.now(), timeLimit: timerMinutes > 0 ? timerMinutes * 60 : null,
    timerInterval: null, submitted: false
  };
  showLoading(false);
  if (timerMinutes > 0) startTimer();
  persistActiveTest();
  renderTestScreen();
  showScreen('test');
}



async function startTest(mode, moduleId, moduleName, subjectId, paperId, paperTitle, testId, testTitle) {
  // Remember where the student tapped in from (e.g. a module's paper list) so
  // finishing or exiting the test can return them there instead of always
  // dropping them back at Home.
  const returnScreen = document.querySelector('.screen.active')?.id.replace('screen-', '') || 'home';
  const safeReturnScreen = ['test', 'results', 'review'].includes(returnScreen) ? 'home' : returnScreen;
  showLoading(true, mode === 'browse' ? 'Loading paper for review...' : 'Preparing test...');
  // order('id') so Review mode reliably shows questions in the order they were
  // uploaded — without an explicit order, a database doesn't guarantee any
  // particular row order, so this could otherwise appear to shuffle itself.
  // Attempt/Practice shuffle on top of this anyway, so it doesn't affect them.
  let query = sb.from('questions').select('id,text,options,correct_answer,explanation,image_url,explanation_image_url,subject_id,module_id').order('id', { ascending: true });
  if (paperId) {
    // A past paper's own question set is authoritative and can span several
    // modules/subjects (a real paper isn't tied to one module) — paper_id
    // alone finds every question in it, same principle as testId below.
    query = query.eq('paper_id', paperId);
  } else {
    query = query.eq('module_id', moduleId);
    // A practice test's own question set is authoritative — don't additionally filter by
    // subjectId too, since that could silently drop a question whose subject_id doesn't
    // exactly match (e.g. left unset by mistake), producing fewer questions than the
    // count shown on the test list.
    if (testId) query = query.eq('practice_test_id', testId);
    else if (subjectId) query = query.eq('subject_id', subjectId);
  }
  const { data: qs } = await db(query, 'Failed to load questions');
  if (!qs || qs.length === 0) { showLoading(false); showToast('No questions in this category yet.'); return; }

  // Shuffle for practice AND timed attempts (a fresh order every time you take a test) —
  // "browse" mode (just reading through a paper for reference) keeps original numbering.
  const questions = (mode === 'practice' || mode === 'attempt') ? shuffleArray([...qs]) : qs;
  const mapped = questions.map(q => ({
    id: q.id, text: q.text, options: Array.isArray(q.options) ? q.options : JSON.parse(q.options || '[]'),
    answer: q.correct_answer, explanation: q.explanation,
    imageUrl: q.image_url, expImageUrl: q.explanation_image_url,
    subjectId: q.subject_id, moduleId: q.module_id
  }));

  if (window.activeTest?.timerInterval) clearInterval(window.activeTest.timerInterval);
  clearPersistedTest();
  const bookmarked = await loadBookmarkedIndexSet(mapped);
  window.activeTest = {
    questions: mapped, answers: new Array(mapped.length).fill(null),
    explanationShown: new Array(mapped.length).fill(false),
    bookmarked,
    currentIndex: 0, mode, moduleId, moduleName, subjectId, paperId: paperId || null, paperTitle: paperTitle || null,
    testId: testId || null, testTitle: testTitle || null,
    startTime: Date.now(), timeLimit: mode === 'attempt' ? mapped.length * 90 : null,
    timerInterval: null, submitted: false, returnScreen: safeReturnScreen
  };

  showLoading(false);
  if (mode === 'attempt') { startTimer(); persistActiveTest(); }
  else if (mode === 'practice') { persistActiveTest(); }
  renderTestScreen();
  showScreen('test');
}
window.startTest = startTest;



function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}



function startTimer() {
  if (window.activeTest.timerInterval) clearInterval(window.activeTest.timerInterval);
  window.activeTest.timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - window.activeTest.startTime) / 1000);
    const remaining = window.activeTest.timeLimit - elapsed;
    if (remaining <= 0) { clearInterval(window.activeTest.timerInterval); showToast('⏰ Time up! Submitting your test...'); submitTest(); return; }
    const el = document.getElementById('timerEl');
    if (el) {
      const m = Math.floor(remaining / 60), s = remaining % 60;
      el.textContent = `${m}:${s.toString().padStart(2, '0')}`;
      el.className = 'timer-display' + (remaining < 120 ? ' warn' : '') + (remaining < 30 ? ' danger' : '');
    }
    if (remaining % 10 === 0) persistActiveTest(); // periodic autosave so a refresh/crash never loses the attempt
  }, 1000);
}



// ==================== RESUME (Attempt, Practice, and Review all resumable) ====================
// If a student closes the app / refreshes mid-session, we keep the last known
// state in localStorage so they can pick up exactly where they left off
// instead of starting the whole paper over. For Attempt specifically, this
// never pauses the clock — see startTimer(), which is based on real elapsed
// time — resuming just restores which question they were on and what
// they'd answered so far.
export const RESUME_KEY = 'lum_active_attempt';


export function persistActiveTest() {
  if (!window.activeTest || window.activeTest.submitted) return;
  if (!['attempt', 'practice', 'browse'].includes(window.activeTest.mode)) return;
  try {
    const snapshot = { ...window.activeTest, bookmarked: Array.from(window.activeTest.bookmarked), timerInterval: null };
    localStorage.setItem(RESUME_KEY, JSON.stringify(snapshot));
  } catch (e) { /* storage unavailable — fail silently, not critical */ }
}


export function clearPersistedTest() { localStorage.removeItem(RESUME_KEY); }



function checkResumableTest() {
  const raw = localStorage.getItem(RESUME_KEY);
  if (!raw) return;
  let saved;
  try { saved = JSON.parse(raw); } catch { clearPersistedTest(); return; }
  if (!saved || saved.submitted) { clearPersistedTest(); return; }
  const elapsed = Math.floor((Date.now() - saved.startTime) / 1000);
  if (saved.timeLimit && elapsed >= saved.timeLimit) { clearPersistedTest(); return; }
  // Review has no time pressure, so an old session is kept around much longer
  // (a week) than Practice (2 days) or a timed Attempt (12 hours, since
  // resuming a half-finished timed test days later isn't very meaningful).
  const maxAge = saved.mode === 'browse' ? 7 * 24 * 3600 : (saved.mode === 'practice' ? 48 * 3600 : 12 * 3600);
  if (elapsed > maxAge) { clearPersistedTest(); return; }

  const isReview = saved.mode === 'browse';
  const isPractice = saved.mode === 'practice';
  const icon = isReview ? '📖' : (isPractice ? '📝' : '⏳');
  const title = isReview ? 'Unfinished Review Found' : (isPractice ? 'Unfinished Practice Found' : 'Unfinished Test Found');
  const verb = isReview ? 'reviewing' : (isPractice ? 'practicing' : 'attempting');
  const resumeLabel = isReview ? 'Resume Review' : (isPractice ? 'Resume Practice' : 'Resume Test');
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.85);z-index:10004;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:380px;text-align:center">
      <div style="font-size:30px;margin-bottom:10px">${icon}</div>
      <h3 style="margin-bottom:6px">${title}</h3>
      <p style="margin-bottom:18px">You were ${verb} <strong>${saved.testTitle || saved.paperTitle || saved.moduleName}</strong>. Resume where you left off?</p>
      <div class="btn-row">
        <button class="btn btn-secondary" onclick="discardResumableTest(this)">Discard</button>
        <button class="btn btn-primary" onclick="resumeTest(this)">${resumeLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  window._resumeSnapshot = saved;
}
window.checkResumableTest = checkResumableTest;



function discardResumableTest(btn) {
  clearPersistedTest();
  btn.closest('[style*=fixed]').remove();
}
window.discardResumableTest = discardResumableTest;



function resumeTest(btn) {
  const saved = window._resumeSnapshot;
  btn.closest('[style*=fixed]').remove();
  if (!saved) return;
  window.activeTest = { ...saved, bookmarked: new Set(saved.bookmarked || []), timerInterval: null, submitted: false };
  if (window.activeTest.timeLimit) startTimer(); // untimed tests (e.g. a no-timer custom test) have nothing to count down
  renderTestScreen();
  showScreen('test');
  showToast(window.activeTest.mode === 'browse' ? '📖 Review resumed' : (window.activeTest.mode === 'practice' ? '📝 Practice resumed' : '⏳ Test resumed'));
}
window.resumeTest = resumeTest;



function renderTestScreen() {
  const t = window.activeTest;
  const q = t.questions[t.currentIndex];
  const total = t.questions.length;
  const answered = t.answers.filter(a => a !== null).length;
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const isInstantFeedback = t.mode === 'practice' || t.mode === 'browse'; // reveal correctness as soon as the student taps an option

  // Header mode indicator
  let modeLabelHtml = '';
  if (t.mode === 'attempt' && t.timeLimit) {
    const rem = t.timeLimit - Math.floor((Date.now() - t.startTime) / 1000);
    const m = Math.max(0, Math.floor(rem / 60)), s = Math.max(0, rem % 60);
    modeLabelHtml = `<div class="timer-display" id="timerEl">${m}:${s.toString().padStart(2, '0')}</div>`;
  } else if (t.mode === 'attempt') {
    modeLabelHtml = `<span class="badge badge-teal" style="font-size:12px;padding:6px 14px">📝 No Time Limit</span>`;
  } else if (t.mode === 'browse') {
    modeLabelHtml = `<span class="badge badge-amber" style="font-size:12px;padding:6px 14px">👁 Review Mode</span>`;
  } else {
    modeLabelHtml = `<span class="badge badge-teal" style="font-size:12px;padding:6px 14px">Practice Mode</span>`;
  }

  // Image
  const imgHtml = q.imageUrl ? `<img src="${q.imageUrl}" style="max-width:100%;border-radius:var(--radius-lg);margin-top:12px;display:block" onerror="this.style.display='none'">` : '';

  // Options — neutral until tapped, in BOTH Practice and Browse; tapping one
  // reveals correct/wrong immediately. Browse no longer reveals the answer up
  // front — the student decides when to check, same as Practice.
  const userAns = t.answers[t.currentIndex];
  const revealAnswer = isInstantFeedback && userAns !== null;
  const optHtml = q.options.map((opt, idx) => {
    let cls = 'opt-btn';
    let icon = '';
    if (revealAnswer) {
      if (idx === q.answer) { cls += ' correct'; icon = '✓ '; }
      else if (idx === userAns) { cls += ' wrong'; icon = '✗ '; }
    } else {
      if (idx === userAns) cls += ' selected';
    }
    return `<button class="${cls}" onclick="selectOption(${idx})" ${isInstantFeedback && userAns !== null ? 'disabled' : ''}>
      <span class="opt-letter">${letters[idx]}</span>
      <span>${icon}${esc(opt)}</span>
    </button>`;
  }).join('');

  // Q nav grid — current question highlighted; bookmarked questions stand out next
  // (Bookmark is now the one save/mark action — Flag for Review was removed and
  // folded into it); answered/viewed questions shown after that.
  const navHtml = t.questions.map((_, i) => {
    let cls = 'qnav-btn';
    if (i === t.currentIndex) cls += ' current';
    else if (t.bookmarked.has(i)) cls += ' review';
    else if (t.answers[i] !== null) cls += ' answered';
    return `<button class="${cls}" onclick="jumpToQ(${i})">${i + 1}</button>`;
  }).join('');

  // Explanation stays fully hidden until the student taps "Show Explanation" —
  // in Browse ("👁 Review Mode") that button is available any time, even before
  // picking an option, so it's entirely the student's choice whether to check
  // before or after attempting. In Practice it only appears once they've
  // answered (that's the point of practice — try first, then learn).
  let expHtml = '';
  const canShowExpBox = t.mode === 'browse' || (t.mode === 'practice' && userAns !== null);
  if (canShowExpBox) {
    const revealed = !!t.explanationShown[t.currentIndex];
    if (!revealed) {
      expHtml = `<button class="btn btn-ghost btn-sm" style="margin-top:12px" onclick="toggleExplanationView()">📖 Show Explanation</button>`;
    } else {
      const correct = userAns !== null && userAns === q.answer;
      const headerText = userAns === null
        ? `✅ Correct Answer: ${esc(q.options[q.answer])}`
        : (correct ? '✅ Correct!' : '❌ Incorrect · Correct answer: ' + esc(q.options[q.answer]));
      const expImgHtml = q.expImageUrl ? `<img src="${esc(q.expImageUrl)}" style="max-width:100%;border-radius:var(--radius-md);margin-top:10px" onerror="this.style.display='none'">` : '';
      expHtml = `
        <div class="explanation-box show">
          <div class="exp-label">${headerText}</div>
          <div class="exp-content">${q.explanation ? renderMd(q.explanation) : '<span style="color:var(--ink-4)">No explanation added yet.</span>'}</div>
          ${expImgHtml}
          <div class="btn-row" style="margin-top:8px">
            ${isAIEnabled() ? `<button class="btn btn-ghost btn-xs" onclick="openAITutor('${escJs(q.text)}','${escJs(q.explanation||'')}')">🤖 Explain with AI</button>` : ''}
            <button class="btn btn-ghost btn-xs" onclick="openReportModal(${q.id})">🚩 Report</button>
            <button class="btn btn-ghost btn-xs" onclick="toggleExplanationView()">🙈 Hide Explanation</button>
          </div>
        </div>`;
    }
  }

  const isBookmarked = t.bookmarked.has(t.currentIndex);
  const onLastQ = t.currentIndex === total - 1;

  // Inline next/finish button (changes label only on the last question)
  let primaryBtnHtml;
  if (!onLastQ) {
    primaryBtnHtml = `<button class="btn btn-primary" style="width:auto;padding:11px 20px" onclick="testNext()">Next →</button>`;
  } else if (t.mode === 'attempt') {
    primaryBtnHtml = `<button class="btn btn-primary" style="width:auto;padding:11px 20px" onclick="confirmSubmitTest()">✓ Submit</button>`;
  } else if (t.mode === 'practice') {
    primaryBtnHtml = `<button class="btn btn-primary" style="width:auto;padding:11px 20px" onclick="confirmSubmitTest()">✓ Finish</button>`;
  } else {
    primaryBtnHtml = `<button class="btn btn-primary" style="width:auto;padding:11px 20px" onclick="finishBrowseReview()">✓ Finish</button>`;
  }

  // Always-visible finish row, so a student can end the session at any question, not just the last one
  let finishRowHtml;
  if (t.mode === 'attempt') finishRowHtml = `<button class="btn btn-primary" style="margin-bottom:16px" onclick="confirmSubmitTest()">✓ Submit Test</button>`;
  else if (t.mode === 'practice') finishRowHtml = `<button class="btn btn-secondary" style="margin-bottom:16px" onclick="confirmSubmitTest()">✓ Finish &amp; See Results</button>`;
  else finishRowHtml = `<button class="btn btn-secondary" style="margin-bottom:16px" onclick="finishBrowseReview()">✓ Finish Review</button>`;

  document.getElementById('testPageWrap').innerHTML = `
    <!-- Header -->
    <div style="background:var(--surface);border-bottom:1px solid var(--border);padding:12px 14px;margin:-12px -14px 16px;position:sticky;top:0;z-index:100;display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--ink-4);text-transform:uppercase;letter-spacing:.5px">${t.testTitle || t.paperTitle || t.moduleName}</div>
        <div style="font-size:14px;font-weight:700;margin-top:2px">Q${t.currentIndex + 1} <span style="color:var(--ink-4);font-weight:500">/ ${total}</span> · <span style="color:var(--gold-600)">${answered} ${isInstantFeedback ? 'viewed' : 'answered'}</span></div>
      </div>
      ${modeLabelHtml}
    </div>

    <!-- Progress -->
    <div class="progress-track" style="margin-bottom:16px">
      <div class="progress-fill" style="width:${(answered / total) * 100}%"></div>
    </div>

    <!-- Question -->
    <div class="question-card">
      <div style="font-size:15px;font-weight:600;line-height:1.6;color:var(--ink)">${esc(q.text)}</div>
      ${imgHtml}
    </div>

    <!-- Options -->
    <div id="optionsArea">
      ${optHtml}
    </div>

    ${expHtml}

    <!-- Bookmark — the one save/mark action now (Flag for Review removed) -->
    <button class="btn btn-bookmark ${isBookmarked ? 'active' : ''}" onclick="bookmarkQuestion()" style="margin:16px 0">
      ${isBookmarked ? '🔖 Bookmarked (tap to remove)' : '📖 Bookmark this question'}
    </button>

    <!-- Nav buttons -->
    <div class="flex-between" style="margin-bottom:16px">
      <button class="btn btn-secondary" style="width:auto;padding:11px 20px" onclick="testPrev()" ${t.currentIndex === 0 ? 'disabled' : ''}>← Prev</button>
      <button class="btn btn-danger" style="width:auto;padding:11px 16px" onclick="requestExitTest()">Exit</button>
      ${primaryBtnHtml}
    </div>

    ${finishRowHtml}

    <!-- Q Nav Grid -->
    <div class="card">
      <div style="font-size:12px;font-weight:700;color:var(--ink-4);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">Question Navigator <span style="font-weight:500;text-transform:none">(tap a number to jump)</span></div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
        <span class="qnav-btn answered" style="cursor:default;font-size:10px;width:auto;padding:0 8px">${isInstantFeedback ? 'Viewed' : 'Answered'}</span>
        <span class="qnav-btn review" style="cursor:default;font-size:10px;width:auto;padding:0 8px">🔖 Bookmarked</span>
        <span class="qnav-btn" style="cursor:default;font-size:10px;width:auto;padding:0 8px">${isInstantFeedback ? 'Not viewed' : 'Unanswered'}</span>
      </div>
      <div class="qnav-grid">${navHtml}</div>
    </div>
  `;

  showScreen('test');
}



function selectOption(idx) {
  if (!window.activeTest || window.activeTest.submitted) return;
  const t = window.activeTest;
  const isInstantFeedback = t.mode === 'practice' || t.mode === 'browse';
  if (isInstantFeedback && t.answers[t.currentIndex] !== null) return; // already revealed — locked
  t.answers[t.currentIndex] = idx;
  if (isInstantFeedback) playSound(idx === t.questions[t.currentIndex].answer ? 'correct' : 'wrong');
  else playSound('click');
  if (t.mode === 'attempt' || t.mode === 'practice') persistActiveTest();
  renderTestScreen();
}
window.selectOption = selectOption;



function toggleExplanationView() {
  window.activeTest.explanationShown[window.activeTest.currentIndex] = !window.activeTest.explanationShown[window.activeTest.currentIndex];
  renderTestScreen();
}
window.toggleExplanationView = toggleExplanationView;



function testPrev() { if (window.activeTest.currentIndex > 0) { window.activeTest.currentIndex--; renderTestScreen(); } }
window.testPrev = testPrev;


function testNext() { if (window.activeTest.currentIndex < window.activeTest.questions.length - 1) { window.activeTest.currentIndex++; renderTestScreen(); } }
window.testNext = testNext;


function jumpToQ(i) { window.activeTest.currentIndex = i; renderTestScreen(); }
window.jumpToQ = jumpToQ;



export function requestExitTest() {
  const t = window.activeTest;
  // Nothing active to exit from (or it's already submitted) — this should
  // only ever be reachable from an actual test screen, but if it's somehow
  // triggered elsewhere (e.g. a stale nav-stack entry), just reveal whatever
  // screen is actually current instead of asking to confirm exiting a test
  // that isn't there.
  if (!t || t.submitted) { _returnToScreen(window.navStack[window.navStack.length - 1]); return; }
  const attempted = t?.answers.filter(a => a !== null).length || 0;

  if (t?.mode === 'browse') {
    // Review — nothing to lose (it's saved either way) and no time pressure,
    // so skip the confirmation entirely and just go, exactly where they'll
    // pick back up from when they return.
    persistActiveTest();
    const dest = t.returnScreen || 'home';
    window.activeTest = null;
    _returnToScreen(dest);
    return;
  }

  const msgEl = document.querySelector('#modalExitTest p');
  const btnsEl = document.getElementById('modalExitTestButtons');
  const isAttempt = t?.mode === 'attempt';

  if (attempted > 0) {
    // Answered at least one question — in both Attempt and Practice, give a
    // real choice instead of only ever offering to throw it away. Attempt
    // additionally clarifies that exiting does NOT pause the clock — it
    // never has, since the countdown is based on real elapsed time, not
    // "time spent on this screen".
    msgEl.innerHTML = isAttempt
      ? `You've answered <strong>${attempted}</strong> of ${t.questions.length} questions. <strong>Submit Now</strong> ends the test here and counts it in your stats right away. Exiting instead keeps your answers saved to come back to, but the timer keeps counting down in the background the whole time you're away.`
      : `You've answered <strong>${attempted}</strong> of ${t.questions.length} questions. <strong>Finish Now</strong> ends it here and saves your result. Exiting instead keeps your answers saved so you can pick up right where you left off.`;
    btnsEl.innerHTML = `
      <button class="btn btn-secondary" onclick="closeModal('modalExitTest')">Keep Going</button>
      <button class="btn btn-primary" onclick="submitAndExitTest()">✓ ${isAttempt ? 'Submit Now' : 'Finish Now'}</button>
      <button class="btn btn-danger" onclick="forceExitTest()">${isAttempt ? "Exit (Timer Won't Stop)" : 'Exit (Save for Later)'}</button>`;
  } else {
    msgEl.textContent = "You haven't answered anything yet, so exiting now won't be saved or counted. Exit?";
    btnsEl.innerHTML = `
      <button class="btn btn-secondary" onclick="closeModal('modalExitTest')">Keep Going</button>
      <button class="btn btn-danger" onclick="forceExitTest()">Exit Test</button>`;
  }
  openModal('modalExitTest');
}
window.requestExitTest = requestExitTest;



// Ends the test right where the student is and submits whatever's answered —
// the "count it now instead of leaving it unfinished" choice from the exit
// dialog. Goes straight to submitTest(), skipping the usual "you have
// unanswered questions" re-confirmation, since the exit dialog already made
// clear what this button does.
function submitAndExitTest() {
  closeModal('modalExitTest');
  submitTest();
}
window.submitAndExitTest = submitAndExitTest;



function confirmSubmitTest() {
  const t = window.activeTest;
  const attempted = t.answers.filter(a => a !== null).length;
  const unanswered = t.questions.length - attempted;
  if (attempted === 0) {
    // Nothing to submit — this isn't "submit anyway", it's a hard stop, since
    // a 0-question submission can never be saved or counted (see submitTest).
    showToast('⚠️ Answer at least one question before submitting');
    return;
  }
  if (unanswered > 0) {
    showConfirm(`You have <strong>${unanswered}</strong> unanswered question${unanswered > 1 ? 's' : ''}. Submit anyway?`, submitTest, t.mode === 'attempt' ? 'Submit' : 'Finish', false);
  } else {
    submitTest();
  }
}
window.confirmSubmitTest = confirmSubmitTest;



// "Just viewing" a past paper — no timer, no score saved. Gives a quick informal tally and exits.
async function finishBrowseReview() {
  const t = window.activeTest;
  if (t.timerInterval) clearInterval(t.timerInterval);
  let correct = 0, wrong = 0;
  t.questions.forEach((q, i) => {
    const a = t.answers[i];
    if (a !== null) { if (a === q.answer) correct++; else wrong++; }
  });
  const viewed = correct + wrong;
  showToast(`📖 Review complete. Viewed ${viewed}/${t.questions.length} · ✅ ${correct} right · ❌ ${wrong} wrong`, 4500);
  clearPersistedTest();
  // Update streak for browse mode too — studying is studying
  if (viewed > 0) {
    const stats = await getUserStats();
    const today = new Date().toLocaleDateString();
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString();
    if (stats.last_practice_date !== today) {
      stats.streak = (stats.last_practice_date === yesterday) ? (stats.streak || 0) + 1 : 1;
      stats.last_practice_date = today;
      // Also add to history
      if (!stats.history) stats.history = [];
      stats.history.unshift({ date: today, total: viewed, correct, mode: 'browse' });
      if (stats.history.length > 90) stats.history = stats.history.slice(0, 90);
      saveUserStats(stats);
    }
  }
  const dest = t.returnScreen || 'home';
  window.activeTest = null;
  _returnToScreen(dest);
}
window.finishBrowseReview = finishBrowseReview;



function forceExitTest() {
  const t = window.activeTest;
  if (t?.timerInterval) clearInterval(t.timerInterval);
  // Only stops the on-screen countdown from updating — the clock itself is
  // computed from real elapsed time (see startTimer), so it was never
  // actually pausable in the first place, on purpose.
  const attempted = t?.answers.filter(a => a !== null).length || 0;
  const wasResumable = t && ['attempt', 'practice', 'browse'].includes(t.mode);
  persistActiveTest(); // safely no-ops for modes that don't support resuming
  const dest = t?.returnScreen || 'home';
  window.activeTest = null; closeModal('modalExitTest');
  _returnToScreen(dest);
  if (wasResumable && attempted > 0) {
    showToast(t.mode === 'attempt' ? '💾 Saved to Profile. Timer is still running, resume before time runs out' : '💾 Saved, resume anytime from Home or Profile', 4500);
  }
}
window.forceExitTest = forceExitTest;



async function bookmarkQuestion() {
  const t = window.activeTest;
  const idx = t.currentIndex;
  const q = t.questions[idx];
  if (t.bookmarked.has(idx)) {
    await db(sb.from('bookmarks').delete().eq('email', window.currentUser.email).eq('question_id', q.id), 'Remove bookmark failed');
    t.bookmarked.delete(idx);
    showToast('Bookmark removed');
  } else {
    await db(sb.from('bookmarks').upsert({ email: window.currentUser.email, question_id: q.id, added_at: Date.now(), was_correct: t.answers[idx] === q.answer }, { onConflict: 'email,question_id' }), 'Bookmark save failed');
    t.bookmarked.add(idx);
    showToast('📖 Bookmarked!');
  }
  renderTestScreen();
}
window.bookmarkQuestion = bookmarkQuestion;



// ==================== SUBMIT & RESULTS ====================
// Batched save of every question answered wrong in a just-finished test, so
// Profile → Wrong Attempts always reflects real mistakes without a per-question
// round trip. Best-effort, same as logActivity — never blocks the results screen.
async function saveWrongAttempts(questionIds) {
  const { data: existing } = await db(sb.from('wrong_attempts').select('question_id,wrong_count').eq('email', window.currentUser.email).in('question_id', questionIds), 'Wrong attempts load failed');
  const countMap = {};
  (existing || []).forEach(w => { countMap[w.question_id] = w.wrong_count || 1; });
  const rows = questionIds.map(qid => ({
    email: window.currentUser.email, question_id: qid,
    last_wrong_at: Date.now(), wrong_count: (countMap[qid] || 0) + 1
  }));
  await db(sb.from('wrong_attempts').upsert(rows, { onConflict: 'email,question_id' }), 'Wrong attempts save failed');
}



async function submitTest() {
  if (!window.activeTest || window.activeTest.submitted) return;
  window.activeTest.submitted = true;
  playSound('submit');
  if (window.activeTest.timerInterval) clearInterval(window.activeTest.timerInterval);
  clearPersistedTest();

  let correct = 0, wrong = 0, skipped = 0;
  for (let i = 0; i < window.activeTest.questions.length; i++) {
    const a = window.activeTest.answers[i];
    if (a === null) skipped++;
    else if (a === window.activeTest.questions[i].answer) correct++;
    else wrong++;
  }
  const total = window.activeTest.questions.length;
  const attempted = correct + wrong;
  const percent = total ? Math.round((correct / total) * 100) : 0;        // score: correct out of ALL questions
  const accuracy = attempted ? Math.round((correct / attempted) * 100) : 0; // accuracy: correct out of ATTEMPTED only
  const timeTaken = Math.floor((Date.now() - window.activeTest.startTime) / 1000);
  window.activeTest.timeTaken = timeTaken; // persist so renderResults() can show correct time on restore
  const mins = Math.floor(timeTaken / 60), secs = timeTaken % 60;
  const timeStr = `${mins}m ${secs}s`;

  // Build Your Own Test is excluded from stats/history/leaderboard entirely —
  // it's meant for free practice on a student's own custom question set, not
  // tracked performance. A test where the student answered zero questions is
  // also excluded — otherwise opening a test and immediately exiting counted
  // as a full "attempt" toward stats, ranking, best score, and wrong-answer
  // history. Everything in this block only runs for a real, answered attempt.
  if (!window.activeTest.isCustom && attempted > 0) {
    const stats = await getUserStats();
    stats.total_tests = (stats.total_tests || 0) + 1;
    stats.total_questions = (stats.total_questions || 0) + total;
    stats.total_correct = (stats.total_correct || 0) + correct;
    stats.best_score = Math.max(stats.best_score || 0, percent);

    // Leaderboard eligibility: a student must fully complete (every question
    // answered, nothing skipped) at least one timed Attempt-mode test — a
    // partial attempt or an untimed Practice run doesn't count. Tracked as its
    // own counter rather than scanning history, so checking eligibility for
    // the whole leaderboard stays a single cheap column read.
    if (window.activeTest.mode === 'attempt' && skipped === 0) {
      stats.completed_attempt_tests = (stats.completed_attempt_tests || 0) + 1;
    }

    // Module/subject-level stats — computed per-question so this works correctly
    // whether the test was single-subject practice OR a mixed-module test.
    if (!stats.subject_stats) stats.subject_stats = {};
    const moduleKey = (window.activeTest.moduleId || 'none').toString();
    if (!stats.subject_stats[moduleKey]) stats.subject_stats[moduleKey] = { total: 0, correct: 0 };
    stats.subject_stats[moduleKey].total += total;
    stats.subject_stats[moduleKey].correct += correct;

    for (let i = 0; i < window.activeTest.questions.length; i++) {
      const q = window.activeTest.questions[i];
      if (window.activeTest.answers[i] === null || !q.subjectId) continue; // skipped or no subject tagged
      const subKey = `${q.moduleId || window.activeTest.moduleId}_${q.subjectId}`;
      if (!stats.subject_stats[subKey]) stats.subject_stats[subKey] = { total: 0, correct: 0 };
      stats.subject_stats[subKey].total += 1;
      if (window.activeTest.answers[i] === q.answer) stats.subject_stats[subKey].correct += 1;
    }

    // Past-paper-level stats (best score + attempt count per paper)
    if (window.activeTest.paperId) {
      if (!stats.paper_stats) stats.paper_stats = {};
      const pKey = window.activeTest.paperId.toString();
      const prev = stats.paper_stats[pKey] || { attempts: 0, bestScore: 0 };
      stats.paper_stats[pKey] = { attempts: (prev.attempts || 0) + 1, bestScore: Math.max(prev.bestScore || 0, percent) };
    }

    // Practice-test-level stats (best score + attempt count per test) — same shape as paper_stats above
    if (window.activeTest.testId) {
      if (!stats.test_stats) stats.test_stats = {};
      const tKey = window.activeTest.testId.toString();
      const prev = stats.test_stats[tKey] || { attempts: 0, bestScore: 0 };
      stats.test_stats[tKey] = { attempts: (prev.attempts || 0) + 1, bestScore: Math.max(prev.bestScore || 0, percent) };
    }

    // Streak
    const today = new Date().toDateString();
    const lastDate = stats.last_practice_date;
    if (lastDate !== today) {
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      stats.streak = (lastDate === yesterday) ? (stats.streak || 0) + 1 : 1;
      stats.last_practice_date = today;
    }

    // History
    const sessionType = window.activeTest.paperId ? 'Past Paper' : window.activeTest.testId ? (window.activeTest.subjectId ? 'Subject Test' : 'Module Test') : (window.activeTest.subjectId ? 'Subject Practice' : 'Mixed Practice');
    const history = stats.history || [];
    history.unshift({
      date: new Date().toLocaleDateString(), module: window.activeTest.moduleName,
      label: window.activeTest.testTitle || window.activeTest.paperTitle || window.activeTest.moduleName, type: sessionType,
      percent, accuracy, correct, wrong, skipped, total, timeTaken, questions: window.activeTest.questions.length, mode: window.activeTest.mode
    });
    stats.history = history.slice(0, 60);
    await saveUserStats(stats);

    // Best-effort — don't block the results screen on this, and never let a log
    // failure affect the student's flow. Gives admin a live "someone just tested"
    // feed instead of only the aggregate counters.
    logActivity(`Submitted ${sessionType}: ${percent}% (${correct}/${total})`, { moduleId: window.activeTest.moduleId, paperId: window.activeTest.paperId, testId: window.activeTest.testId });

    // Wrong Attempts — auto-save questions answered incorrectly so students can
    // revisit and clear them later from Profile → Wrong Attempts.
    const wrongIds = [];
    for (let i = 0; i < window.activeTest.questions.length; i++) {
      const a = window.activeTest.answers[i];
      if (a !== null && a !== window.activeTest.questions[i].answer) wrongIds.push(window.activeTest.questions[i].id);
    }
    if (wrongIds.length) saveWrongAttempts(wrongIds);

    // Rank celebration — checked last since it depends on the stats upsert
    // above already being committed. Not awaited: it pops in over the results
    // screen a moment later rather than delaying it.
    checkRankCelebration();
  }

  renderResults();
}



// Render the results screen from the current activeTest — callable both after submitTest() and on restore
export function renderResults() {
  const at = window.activeTest;
  let correct = 0, wrong = 0, skipped = 0;
  for (let i = 0; i < at.questions.length; i++) {
    const a = at.answers[i];
    if (a === null) skipped++;
    else if (a === at.questions[i].answer) correct++;
    else wrong++;
  }
  const total = at.questions.length;
  const attempted = correct + wrong;
  const percent = total ? Math.round((correct / total) * 100) : 0;
  const accuracy = attempted ? Math.round((correct / attempted) * 100) : 0;
  const timeTaken = at.timeTaken != null ? at.timeTaken : Math.floor((Date.now() - at.startTime) / 1000);
  const mins = Math.floor(timeTaken / 60), secs = timeTaken % 60;
  const timeStr = `${mins}m ${secs}s`;

  let tier;
  if (percent >= 85) tier = { emoji: '🏆', title: 'Outstanding!', msg: "Excellent work! You've really mastered this material. Keep up this level of preparation.", color: 'var(--green)' };
  else if (percent >= 70) tier = { emoji: '📈', title: 'Great Job!', msg: "You're performing well. A bit more revision and you'll be at the next level.", color: 'var(--gold-600)' };
  else if (percent >= 50) tier = { emoji: '👍', title: 'Good Effort', msg: "You're on the right track. Go through your mistakes and keep practicing consistently.", color: 'var(--gold-600)' };
  else if (percent >= 35) tier = { emoji: '📖', title: 'Needs Improvement', msg: 'Review the explanations carefully and revise the weaker topics before your next attempt.', color: 'var(--amber)' };
  else tier = { emoji: '💪', title: 'Poor Performance, Needs Improvement', msg: "Don't be discouraged. Go through every explanation and try again. Consistent practice will get you there.", color: 'var(--red)' };

  const headingText = at.mode === 'attempt' ? 'Test Submitted' : 'Practice Complete';
  const subLabel = at.isCustom ? at.moduleName + ' · Custom Test' : (at.testTitle || at.paperTitle || (at.subjectId ? at.moduleName + ' · Subject Practice' : at.moduleName + ' · Mixed Practice'));

  document.getElementById('resultsPageWrap').innerHTML = `
    <div class="card-teal text-center" style="padding:32px 24px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:.7;margin-bottom:6px">${headingText}</div>
      <div style="font-size:52px;margin-bottom:8px">${tier.emoji}</div>
      <div style="font-family:var(--font-display);font-size:48px;font-weight:800;line-height:1">${percent}%</div>
      <div style="font-size:16px;margin-top:4px;opacity:.92;font-weight:700">${tier.title}</div>
      <div style="font-size:13px;margin-top:10px;opacity:.85;line-height:1.5">${tier.msg}</div>
      <div style="font-size:12px;margin-top:10px;opacity:.6">${subLabel}</div>
      ${at.isCustom ? '<div style="font-size:11px;margin-top:8px;opacity:.75">🛠️ Custom test (not counted in your stats or the leaderboard)</div>' : ''}
      ${!at.isCustom && attempted === 0 ? '<div style="font-size:11px;margin-top:8px;opacity:.75">No questions were answered, so this attempt was not saved to your stats or ranking.</div>' : ''}
    </div>

    <div class="stat-grid" style="margin-top:12px">
      <div class="stat-box">
        <div class="stat-val" style="color:var(--green)">${correct}</div>
        <div class="stat-key">${ICON_CHECK_CIRCLE} Correct</div>
      </div>
      <div class="stat-box">
        <div class="stat-val" style="color:var(--red)">${wrong}</div>
        <div class="stat-key">${ICON_X_CIRCLE} Wrong</div>
      </div>
      <div class="stat-box">
        <div class="stat-val" style="color:var(--ink-4)">${skipped}</div>
        <div class="stat-key">Skipped</div>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-box">
        <div class="stat-val" style="color:var(--gold-700)">${accuracy}%</div>
        <div class="stat-key">${ICON_TARGET} Accuracy</div>
      </div>
      <div class="stat-box">
        <div class="stat-val" style="color:var(--gold-700)">${timeStr}</div>
        <div class="stat-key">${ICON_CLOCK} Time Taken</div>
      </div>
      <div class="stat-box">
        <div class="stat-val" style="color:var(--gold-700)">${total}</div>
        <div class="stat-key">${ICON_CHART} Total Qs</div>
      </div>
    </div>

    <button class="btn btn-primary mt-3" onclick="startReview()">🔍 Review Your Test</button>
    ${wrong > 0 ? `<button class="btn btn-secondary mt-2" onclick="startReview(true)">❌ Review Wrong Only (${wrong})</button>` : ''}
    <button class="btn btn-secondary mt-2" onclick="const d=activeTest?.returnScreen||'home';activeTest=null;_returnToScreen(d)">← Done</button>
    ${isAIEnabled() ? `<button class="btn btn-ghost mt-1" onclick="openAITutor('Summarize my performance: ${correct} correct out of ${total} (${percent}% score, ${accuracy}% accuracy) in ${(at.testTitle || at.paperTitle || at.moduleName).replace(/'/g,"\\'")}','Provide tips to improve my weak areas')">🤖 AI Performance Tip</button>` : ''}
  `;
  showScreen('results');
}



// ==================== REVIEW ====================
async function startReview(wrongOnly = false) {
  let questions = window.activeTest.questions, answers = window.activeTest.answers;
  if (wrongOnly) {
    const idxs = questions.map((q, i) => i).filter(i => answers[i] !== questions[i].answer);
    questions = idxs.map(i => questions[i]);
    answers = idxs.map(i => answers[i]);
  }
  const { data: existingBm } = await db(sb.from('bookmarks').select('question_id').eq('email', window.currentUser.email).in('question_id', questions.map(q => q.id)), 'Bookmarks check failed');
  const bookmarked = new Set((existingBm || []).map(b => b.question_id));
  window.reviewState = { questions, answers, currentIndex: 0, explanationShown: false, isCustom: !!window.activeTest.isCustom, bookmarked, label: (window.activeTest.testTitle || window.activeTest.paperTitle || window.activeTest.moduleName) + (wrongOnly ? ' · Wrong Only' : '') };
  renderReview();
  showScreen('review');
}
window.startReview = startReview;



async function toggleReviewBookmark() {
  const rs = window.reviewState;
  const q = rs.questions[rs.currentIndex];
  if (rs.bookmarked.has(q.id)) {
    await db(sb.from('bookmarks').delete().eq('email', window.currentUser.email).eq('question_id', q.id), 'Remove bookmark failed');
    rs.bookmarked.delete(q.id);
    showToast('Bookmark removed');
  } else {
    const wasCorrect = rs.answers[rs.currentIndex] === q.answer;
    await db(sb.from('bookmarks').upsert({ email: window.currentUser.email, question_id: q.id, added_at: Date.now(), was_correct: wasCorrect }, { onConflict: 'email,question_id' }), 'Bookmark save failed');
    rs.bookmarked.add(q.id);
    showToast('📖 Bookmarked!');
  }
  renderReview();
}
window.toggleReviewBookmark = toggleReviewBookmark;



export function renderReview() {
  const rs = window.reviewState;
  const q = rs.questions[rs.currentIndex];
  const userAns = rs.answers[rs.currentIndex];
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const imgHtml = q.imageUrl ? `<img src="${esc(q.imageUrl)}" style="max-width:100%;border-radius:var(--radius-lg);margin-top:10px" onerror="this.style.display='none'">` : '';
  const expImgHtml = q.expImageUrl ? `<img src="${esc(q.expImageUrl)}" style="max-width:100%;border-radius:var(--radius-md);margin-top:10px" onerror="this.style.display='none'">` : '';

  const optHtml = q.options.map((opt, idx) => {
    let cls = 'opt-btn';
    if (idx === q.answer) cls += ' correct';
    else if (idx === userAns && userAns !== q.answer) cls += ' wrong';
    return `<button class="${cls}" disabled>
      <span class="opt-letter">${letters[idx]}</span>
      <span>${esc(opt)}</span>
    </button>`;
  }).join('');

  const navHtml = rs.questions.map((_, i) => {
    const a = rs.answers[i];
    let cls = 'qnav-btn';
    if (i === rs.currentIndex) cls += ' current';
    else if (a === null) cls += '';
    else if (a === rs.questions[i].answer) cls += ' answered';
    else cls += ' review';
    return `<button class="${cls}" onclick="reviewJump(${i})">${i + 1}</button>`;
  }).join('');

  document.getElementById('reviewPageWrap').innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back to Results</button>
    <div class="flex-between" style="margin-bottom:12px">
      <div><span class="badge badge-teal">Reviewing: ${rs.label}</span></div>
      <div style="font-size:14px;font-weight:700">Q${rs.currentIndex + 1} / ${rs.questions.length}</div>
    </div>

    <div class="card-elevated" style="margin-bottom:14px">
      <div style="font-size:15px;font-weight:600;line-height:1.6">${esc(q.text)}</div>
      ${imgHtml}
    </div>

    ${optHtml}

    ${userAns === null ? '<div class="badge badge-amber" style="margin-bottom:12px">⏭ This question was skipped</div>' : (userAns === q.answer ? '<div class="badge badge-green" style="margin-bottom:12px">✅ You answered correctly</div>' : '<div class="badge badge-red" style="margin-bottom:12px">❌ You answered incorrectly</div>')}

    <button class="btn btn-bookmark ${rs.bookmarked.has(q.id) ? 'active' : ''}" onclick="toggleReviewBookmark()" style="margin-bottom:14px">
      ${rs.bookmarked.has(q.id) ? '🔖 Bookmarked (tap to remove)' : '📖 Bookmark this question'}
    </button>

    ${rs.explanationShown ? `
    <div class="explanation-box show">
      <div class="exp-label">✅ Correct Answer: ${esc(q.options[q.answer])}</div>
      <div class="exp-content">${q.explanation ? renderMd(q.explanation) : '<span style="color:var(--ink-4)">No explanation yet.</span>'}</div>
      ${expImgHtml}
      <div class="btn-row" style="margin-top:10px">
        ${isAIEnabled() ? `<button class="btn btn-ghost btn-sm" onclick="openAITutor('${escJs(q.text)}','${escJs(q.explanation||'')}')">🤖 Explain with AI</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="openReportModal(${q.id})">🚩 Report Question</button>
        <button class="btn btn-ghost btn-sm" onclick="toggleReviewExplanation()">🙈 Hide Explanation</button>
      </div>
    </div>
    ` : `<button class="btn btn-ghost btn-sm" onclick="toggleReviewExplanation()">📖 Show Explanation</button>`}

    <div class="flex-between" style="margin:16px 0">
      <button class="btn btn-secondary" style="width:auto" onclick="reviewPrev()" ${rs.currentIndex === 0 ? 'disabled' : ''}>← Prev</button>
      <button class="btn btn-primary" style="width:auto" onclick="${rs.currentIndex < rs.questions.length - 1 ? 'reviewNext()' : "showScreen('results')"}">${rs.currentIndex < rs.questions.length - 1 ? 'Next →' : 'Finish'}</button>
    </div>

    <div class="card">
      <div style="font-size:12px;font-weight:700;color:var(--ink-4);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">Jump to Question</div>
      <div class="qnav-grid">${navHtml}</div>
    </div>
  `;
}



function reviewPrev() { if (window.reviewState.currentIndex > 0) { window.reviewState.currentIndex--; window.reviewState.explanationShown = false; renderReview(); } }
window.reviewPrev = reviewPrev;


function reviewNext() { if (window.reviewState.currentIndex < window.reviewState.questions.length - 1) { window.reviewState.currentIndex++; window.reviewState.explanationShown = false; renderReview(); } }
window.reviewNext = reviewNext;


function reviewJump(i) { window.reviewState.currentIndex = i; window.reviewState.explanationShown = false; renderReview(); }
window.reviewJump = reviewJump;


function toggleReviewExplanation() { window.reviewState.explanationShown = !window.reviewState.explanationShown; renderReview(); }
window.toggleReviewExplanation = toggleReviewExplanation;



// ==================== REPORT A QUESTION / GENERAL FEEDBACK ====================
function openReportModal(questionId) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10005;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:420px">
      <div class="fw-700 mb-1">🚩 Report this Question</div>
      <p class="text-sm text-muted mb-3">Wrong answer? Confusing wording? Bad image? Let us know and the admin will review it.</p>
      <textarea id="_rpt_msg" class="input-field" rows="4" placeholder="Describe the issue..." maxlength="2000" style="resize:vertical"></textarea>
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="submitReport(this,${questionId})">Send Report</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.openReportModal = openReportModal;



async function submitReport(btn, questionId) {
  const overlay = btn.closest('[style*="fixed"]');
  const card = overlay.querySelector('div');
  const textarea = overlay.querySelector('#_rpt_msg');
  const message = textarea.value.trim();
  if (!message) return showToast('Please describe the issue first');
  if (message.length > 2000) return showToast('That message is too long (max 2000 characters).');
  const rl = rateLimited('submit_report', 5, 15 * 60 * 1000);
  if (!rl.allowed) return showToast(`Too many reports sent. Try again in ${Math.ceil(rl.waitSec / 60)} min.`);
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending...';
  const { error } = await db(sb.from('reports_feedback').insert({
    type: questionId ? 'question_report' : 'feedback',
    question_id: questionId || null,
    user_email: window.currentUser.email,
    user_name: window.currentUser.name,
    message
  }), 'Report failed');
  if (error) { btn.disabled = false; btn.textContent = originalLabel; return; }
  // Wipe the written text and show a clear "Sent" state in place of the form,
  // instead of silently destroying the modal — makes it obvious it went through.
  card.innerHTML = `
    <div style="text-align:center;padding:8px 0">
      <div style="font-size:40px;margin-bottom:8px">✅</div>
      <div class="fw-700 mb-1">Sent!</div>
      <p class="text-sm text-muted">The admin will review this and may reply in your Profile → My Reports.</p>
    </div>`;
  setTimeout(() => overlay.remove(), 1600);
}
window.submitReport = submitReport;



function openAITutor(questionText, explanation) {
  if (!isAIEnabled()) return showToast('AI Tutor is currently turned off by the admin.');
  window.currentAIContext = questionText ? { questionText, explanation } : null;
  window.aiConversation = [];
  document.getElementById('aiChatHistory').innerHTML = '';
  openModal('modalAI');
  if (!questionText) {
    // Opened generally (not tied to a specific MCQ) — just greet, let the student type their own question
    appendAIMsg('assistant', "Hi! I'm your AI tutor. Ask me anything about your subjects: anatomy, physiology, pharmacology, or any topic you're stuck on.");
    return;
  }
  const userMsg = explanation
    ? `Explain this MCQ for a 2nd year MBBS student:\n\nQuestion: ${questionText}\n\nOfficial explanation: ${explanation}\n\nGive a clear, concise explanation in simple language.`
    : `Explain this MCQ for a 2nd year MBBS student:\n\nQuestion: ${questionText}\n\nGive a clear, concise explanation.`;
  callAI(userMsg, true);
}
window.openAITutor = openAITutor;



async function sendAIMsg() {
  const input = document.getElementById('aiUserInput');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  const fullMsg = window.currentAIContext
    ? `Context - MCQ: "${window.currentAIContext.questionText}". ${window.currentAIContext.explanation ? 'Official explanation: ' + window.currentAIContext.explanation + '.' : ''}\n\nStudent asks: ${msg}`
    : msg;
  appendAIMsg('user', msg);
  callAI(fullMsg, false);
}
window.sendAIMsg = sendAIMsg;



function appendAIMsg(role, text) {
  const container = document.getElementById('aiChatHistory');
  const div = document.createElement('div');
  div.style.cssText = `padding:12px 14px;border-radius:var(--radius-lg);font-size:14px;line-height:1.6;max-width:90%;${role === 'user' ? 'background:var(--gold-600);color:white;align-self:flex-end;margin-left:auto' : 'background:var(--surface-3);border:1px solid var(--border);color:var(--ink)'}`;
  div.innerHTML = renderMd(text);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}
window.appendAIMsg = appendAIMsg;



// ==================== AI TUTOR (SECURE — routed through Edge Function) ====================
// SECURITY FIX: The AI API key used to be read directly in this browser file via
// getSetting('ai_api_key') and sent straight to DeepSeek/OpenAI/Gemini from the
// student's own browser. That meant ANY student could open DevTools → Network tab
// and steal your AI API key (or even just type getSetting('ai_api_key') in the
// console). The key now lives ONLY inside the Supabase Edge Function "ai-proxy",
// read there with the service_role key — it never reaches a browser again.
async function callAIProxy(messages) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY
      },
      body: JSON.stringify({ messages })
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, text: data?.text || data?.error || `HTTP ${res.status}` };
    return data; // { ok, text }
  } catch (e) {
    return { ok: false, text: 'Network error reaching AI service.' };
  }
}



// Single-shot helper used by "Test Connection" in Admin Settings (and reusable elsewhere)
export async function callAIRaw(prompt) {
  const sysPrompt = getSetting('ai_system_prompt', 'You are a helpful MBBS tutor.');
  return callAIProxy([{ role: 'system', content: sysPrompt }, { role: 'user', content: prompt }]);
}



async function callAI(userPrompt, showThinking = false) {
  if (showThinking) {
    const thinkDiv = document.createElement('div');
    thinkDiv.id = 'aiThinking';
    thinkDiv.style.cssText = 'padding:12px 14px;border-radius:var(--radius-lg);font-size:14px;background:var(--surface-3);border:1px solid var(--border);color:var(--ink-4);display:flex;align-items:center;gap:8px';
    thinkDiv.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px"></div>AI is thinking...';
    document.getElementById('aiChatHistory').appendChild(thinkDiv);
    document.getElementById('aiChatHistory').scrollTop = document.getElementById('aiChatHistory').scrollHeight;
  }

  if (!isAIEnabled()) {
    document.getElementById('aiThinking')?.remove();
    appendAIMsg('ai', '⚠️ AI Tutor is currently turned off by the admin.');
    return;
  }

  window.aiConversation.push({ role: 'user', content: userPrompt });
  const sysPrompt = getSetting('ai_system_prompt', 'You are an expert MBBS tutor for Pakistani medical students. Be concise, accurate, and encouraging.');
  const result = await callAIProxy([{ role: 'system', content: sysPrompt }, ...window.aiConversation]);
  document.getElementById('aiThinking')?.remove();
  if (result.ok && result.text) {
    window.aiConversation.push({ role: 'assistant', content: result.text });
    appendAIMsg('ai', result.text);
  } else {
    appendAIMsg('ai', `⚠️ ${result.text || 'AI Tutor is not configured yet. Please ask your admin to set up the AI key in Settings → AI Settings.'}`);
    window.aiConversation.pop();
  }
}



async function quickViewQuestion(id) {
  const [{ data: q }, { data: existingBm }] = await Promise.all([
    db(sb.from('questions').select('*').eq('id', id).single(), 'Load failed'),
    db(sb.from('bookmarks').select('id').eq('email', window.currentUser.email).eq('question_id', id).maybeSingle(), 'Bookmark check failed')
  ]);
  if (!q) return;
  const letters = ['A','B','C','D','E','F'];
  const opts = (Array.isArray(q.options) ? q.options : JSON.parse(q.options||'[]'))
    .map((o,i) => `<div style="padding:8px 12px;border-radius:var(--radius-lg);margin-bottom:6px;background:${i===q.correct_answer?'var(--green-light)':'var(--surface-3)'};border:1px solid ${i===q.correct_answer?'var(--green)':'var(--border)'}"><strong>${letters[i]}.</strong> ${esc(o)}</div>`).join('');

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:500px;max-height:85vh;overflow-y:auto">
      <div class="flex-between mb-3">
        <span class="badge badge-teal">${esc(q.difficulty)||'medium'}</span>
        <button onclick="this.closest('[style]').remove()" class="modal-close" title="Close">✕</button>
      </div>
      <div style="font-size:15px;font-weight:600;line-height:1.6;margin-bottom:14px">${esc(q.text)}</div>
      ${q.image_url ? `<img src="${esc(q.image_url)}" style="max-width:100%;border-radius:var(--radius-lg);margin-bottom:12px">` : ''}
      ${opts}
      ${q.explanation ? `<button class="btn btn-ghost btn-sm mt-3" id="qvExpBtn_${q.id}" onclick="document.getElementById('qvExpPanel_${q.id}').style.display='block';this.style.display='none'">📖 Show Explanation</button>
      <div class="explanation-box" id="qvExpPanel_${q.id}" style="display:none;margin-top:12px">
        <div class="exp-label">📖 Explanation</div>
        <div class="exp-content">${renderMd(q.explanation)}</div>
        <button class="btn btn-ghost btn-xs mt-2" onclick="document.getElementById('qvExpPanel_${q.id}').style.display='none';document.getElementById('qvExpBtn_${q.id}').style.display=''">🙈 Hide Explanation</button>
      </div>` : ''}
      <div class="btn-row mt-3">
        <button class="btn btn-secondary btn-sm" onclick="quickBookmarkQuestion(${q.id}, this)">${existingBm ? '🔖 Saved ✓' : '📖 Save'}</button>
        ${isAIEnabled() ? `<button class="btn btn-ghost btn-sm" onclick="openAITutor('${escJs(q.text||'')}','${escJs(q.explanation||'')}')">🤖 Ask AI</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="openReportModal(${q.id})">🚩 Report</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
}
window.quickViewQuestion = quickViewQuestion;



// Quick View's own bookmark toggle — bookmarkQuestion() (used on the test screen)
// reads activeTest.currentIndex, which doesn't exist here since Quick View can be
// opened with no test running (e.g. from Search), so it needs its own version.
async function quickBookmarkQuestion(id, btnEl) {
  const { data: existing } = await db(sb.from('bookmarks').select('id').eq('email', window.currentUser.email).eq('question_id', id).maybeSingle(), 'Bookmark check failed');
  if (existing) {
    await db(sb.from('bookmarks').delete().eq('id', existing.id), 'Remove bookmark failed');
    if (btnEl) btnEl.textContent = '📖 Save';
    showToast('Bookmark removed');
  } else {
    await db(sb.from('bookmarks').upsert({ email: window.currentUser.email, question_id: id, added_at: Date.now() }, { onConflict: 'email,question_id' }), 'Bookmark save failed');
    if (btnEl) btnEl.textContent = '🔖 Saved ✓';
    showToast('📖 Bookmarked!');
  }
}
window.quickBookmarkQuestion = quickBookmarkQuestion;
