import { timeAgo } from './admin.js';
import { APP_VERSION, _isStandalone, getRankInfo, getSetting, getUserStats, isAIEnabled, renderHome } from './app.js';
import { logout, populateCollegeSelect } from './auth.js';
import { showScreen } from './navigation.js';
import { checkExpiredAttemptOnRender, getResumableSnapshot, sendStudentMessage } from './quiz.js';
import { db, sb } from './supabase.js';
import { ICON_BOOK, ICON_BUILDING, ICON_MEDAL, ICON_TARGET, cacheGet, cacheSet, closeModal, esc, escJs, normalizePhone, rateLimited, renderAvatar, renderMd, showConfirm, showLoading, showToast, skeletonList } from './utils.js';



// ==================== SUPPORT / DONATIONS ====================
// Opened from the 💛 Support Us button on Home (when the admin turns Donations on) and from Profile → Support Us.
// Layout, top to bottom: the admin's message · the admin's picture (only if one was uploaded) · live campaigns (only
// if any) · payment details · a "let us know" button. Every value sits on its OWN full-width line with a Copy button
// under it — never in a squeezed side-by-side row (that is what stacked account numbers one digit per line).
// Back always returns to wherever it was opened from.
function _splitPayment(value) {
  const m = /^\s*([+\d][\d\s\-+()]{6,}?)\s*\((.+)\)\s*$/.exec(value || '');   // "0300-1234567 (Account Title)"
  return m ? { main: m[1].trim(), sub: m[2].trim() } : { main: String(value || '').trim(), sub: '' };
}

function _payCardHtml(icon, label, value) {
  if (!value) return '';
  const { main, sub } = _splitPayment(value);
  const copyText = sub ? main : value;           // an account number is what people copy; bank details are copied whole
  return `<div class="card" style="margin-bottom:10px;padding:14px 16px">
    <div class="text-xs text-muted" style="margin-bottom:6px">${icon} ${esc(label)}</div>
    <div style="font-size:${sub ? 20 : 15}px;font-weight:800;line-height:1.45;letter-spacing:${sub ? '.4px' : '0'};white-space:pre-line;overflow-wrap:anywhere">${esc(main)}</div>
    ${sub ? `<div class="text-sm text-muted" style="margin-top:2px;overflow-wrap:anywhere">${esc(sub)}</div>` : ''}
    <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:12px" onclick="navigator.clipboard?.writeText('${escJs(copyText)}');showToast('Copied ✓')">📋 Copy ${sub ? 'number' : 'details'}</button>
  </div>`;
}

async function showDonationPage() {
  if (getSetting('donation_enabled', 'false') !== 'true') { showToast('Support is not available right now.'); return; }
  showScreen('support');
  const wrap = document.getElementById('supportPageWrap');
  if (!wrap) return;
  wrap.innerHTML = `<button class="back-btn" onclick="goBack()">← Back</button>${skeletonList(2, false)}`;
  const { data: campaigns } = await db(sb.from('donation_campaigns').select('*').eq('is_active', true).order('created_at', { ascending: false }), 'Donation error');
  const jazzcash = getSetting('donation_jazzcash', '');
  const easypaisa = getSetting('donation_easypaisa', '');
  const bank = getSetting('donation_bank', '');
  const imageUrl = getSetting('donation_image_url', '');
  const message = getSetting('donation_message', 'Help us keep this app free and growing for every student. Any contribution helps!');

  const campaignHtml = (campaigns || []).map(c => `
    <div class="card" style="margin-bottom:14px;overflow:hidden;padding:0">
      ${c.image_url ? `<img src="${esc(c.image_url)}" style="width:100%;max-height:170px;object-fit:cover;display:block" onerror="this.style.display='none'">` : ''}
      <div style="padding:14px 16px">
        <div class="fw-700" style="font-size:16px">${esc(c.title)}</div>
        ${c.description ? `<p class="text-sm text-muted" style="margin-top:4px">${esc(c.description)}</p>` : ''}
        ${c.purpose ? `<div class="text-xs mt-2" style="color:var(--gold-700)">🎯 ${esc(c.purpose)}</div>` : ''}
        ${c.donation_link ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
          <div class="fw-700" style="overflow-wrap:anywhere;white-space:pre-line">${esc(c.donation_link)}</div>
          <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:10px" onclick="navigator.clipboard?.writeText('${escJs(c.donation_link)}');showToast('Copied ✓')">📋 Copy</button>
        </div>` : ''}
      </div>
    </div>`).join('');

  const hasMethods = !!(jazzcash || easypaisa || bank);
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back</button>
    <div class="card-teal" style="margin-bottom:16px;text-align:center">
      <div style="font-size:38px;margin-bottom:6px">💛</div>
      <h2 style="margin-bottom:8px">Support LUMHSian</h2>
      <p style="line-height:1.6;white-space:pre-line">${esc(message)}</p>
    </div>
    ${imageUrl ? `<img src="${esc(imageUrl)}" alt="" style="width:100%;border-radius:var(--radius-lg);margin-bottom:16px;display:block" onerror="this.style.display='none'">` : ''}
    ${campaignHtml}
    ${hasMethods ? `<div class="section-label">Payment details</div>${_payCardHtml('📱', 'JazzCash', jazzcash)}${_payCardHtml('📱', 'Easypaisa', easypaisa)}${_payCardHtml('🏦', 'Bank Account', bank)}` : ''}
    ${!hasMethods && !campaigns?.length ? '<div class="card text-center"><p class="text-muted">Payment details coming soon.</p></div>' : ''}
    <button class="btn btn-primary mt-2" style="width:100%" onclick="openFeedbackModal('support')">💬 Donated? Let us know</button>
    <div style="height:20px"></div>`;
}
window.showDonationPage = showDonationPage;



// Opened from Profile → My Reports ("Send New Feedback") and from the Support page ("Donated? Let us know").
// It is about the APP — what students think of it — not a bug form (broken questions are reported with the 🚩 button
// on the question itself), so the wording changes with where it was opened from.
function openFeedbackModal(context) {
  const fromSupport = context === 'support';
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10005;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:420px">
      <div class="fw-700 mb-1">${fromSupport ? '💛 Thank you for supporting us' : '💬 Tell us about the app'}</div>
      <p class="text-sm text-muted mb-3">${fromSupport
        ? 'Tell us how LUMHSian is working for you, and what we could do better. If you donated, add your name and transaction ID so we can thank you personally.'
        : 'How is the app working for you? Share what you like, what is missing, or what could be better.'}</p>
      <textarea id="_rpt_msg" class="input-field" rows="4" placeholder="${fromSupport ? 'Your thoughts on the app (and donation details, if any)…' : 'Write your feedback about the app…'}" maxlength="2000" style="resize:vertical"></textarea>
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="submitReport(this,null,'${fromSupport ? 'support' : ''}')">Send</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.openFeedbackModal = openFeedbackModal;



// ==================== INBOX (chat with the admin) ====================
// One conversation per student: messages from the admin (with an optional photo), replies to the student's reports, and
// the student's own messages/reports. Deleting is direct (no confirmation dialog). Sending is optimistic: the bubble
// appears at once and goes out in the background, with a Retry if it fails.
const INBOX_HIDDEN_KEY = 'lum_inbox_hidden';
function _inboxHidden() { try { return new Set(JSON.parse(localStorage.getItem(INBOX_HIDDEN_KEY) || '[]')); } catch { return new Set(); } }
function _inboxHide(id) {
  const s = _inboxHidden(); s.add(String(id));
  localStorage.setItem(INBOX_HIDDEN_KEY, JSON.stringify([...s].slice(-500)));
}

// The merged, time-ordered conversation for one student: real inbox rows plus older reports / replies that were sent
// before the inbox existed (those show up read-only-ish: deleting them just hides them on this device).
export async function loadInboxThread(email, { limit = 200 } = {}) {
  const [inboxRes, repRes] = await Promise.all([
    sb.from('inbox_messages').select('*').eq('user_email', email).order('created_at', { ascending: false }).limit(limit),
    sb.from('reports_feedback').select('id,type,question_id,message,admin_reply,replied_at,created_at').eq('user_email', email).order('created_at', { ascending: false }).limit(60)
  ]);
  const tableOk = !inboxRes.error;
  const rows = (inboxRes.data || []).slice().reverse();
  const has = (sender, refId, kind) => rows.some(m => m.ref_id === refId && m.sender === sender && (!kind || m.kind === kind));
  const hidden = _inboxHidden();
  const legacy = [];
  for (const r of (repRes.data || [])) {
    if (!has('student', r.id)) legacy.push({ id: 'r' + r.id, legacy: true, sender: 'student', kind: r.type === 'question_report' ? 'report' : 'message', body: r.message, created_at: r.created_at });
    if (r.admin_reply && !has('admin', r.id, 'reply')) legacy.push({ id: 'rr' + r.id, legacy: true, sender: 'admin', kind: 'reply', body: r.admin_reply, quote: (r.message || '').slice(0, 120), created_at: r.replied_at || r.created_at });
  }
  const messages = [...rows, ...legacy.filter(m => !hidden.has(m.id))].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return { messages, tableOk };
}

function _ibDay(d) {
  const now = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

// who: 'student' = the viewer's own messages sit on the right (student view); 'admin' = the admin's messages do (admin sheet)
export function inboxBubbleHtml(m, viewer, delFn, retryFn) {
  const mine = m.sender === viewer;
  const time = new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const tag = m.kind === 'report' ? '<div class="ib-tag">🚩 Question report</div>' : (m.kind === 'reply' ? '<div class="ib-tag">📬 Reply to a report</div>' : '');
  const quote = m.quote ? `<div class="ib-quote">${esc(m.quote)}${m.quote.length >= 120 ? '…' : ''}</div>` : '';
  const src = m.image_url || m._previewUrl;
  const img = src ? `<img class="ib-img" src="${esc(src)}" alt="" loading="lazy" onclick="inboxViewImage('${escJs(src)}')" onerror="this.style.display='none'">` : '';
  const body = m.body ? `<div class="ib-text">${renderMd(m.body)}</div>` : '';
  const state = m._state === 'sending' ? '<span class="ib-state">Sending…</span>'
    : m._state === 'failed' ? `<button class="ib-retry" onclick="${retryFn}('${m.id}')">⚠️ Not sent · Retry</button>` : '';
  return `<div class="ib-row ${mine ? 'ib-me' : 'ib-other'}" id="ib_${m.id}">
    <div class="ib-bubble">${tag}${quote}${img}${body}
      <div class="ib-meta"><span>${time}</span>${state}<button class="ib-del" title="Delete" aria-label="Delete message" onclick="${delFn}('${m.id}')">🗑</button></div>
    </div></div>`;
}

export function inboxThreadHtml(messages, viewer, delFn, retryFn, emptyHtml) {
  if (!messages.length) return emptyHtml;
  let last = '', html = '';
  for (const m of messages) {
    const day = _ibDay(new Date(m.created_at));
    if (day !== last) { html += `<div class="ib-day">${day}</div>`; last = day; }
    html += inboxBubbleHtml(m, viewer, delFn, retryFn);
  }
  return html;
}

function _ibDraw(scroll) {
  const S = window._inbox;
  const el = document.getElementById('ibThread');
  if (!S || !el) return;
  el.innerHTML = inboxThreadHtml(S.messages, 'student', 'inboxDelete', 'inboxRetry',
    `<div class="ib-empty"><div style="font-size:40px">✉️</div><div class="fw-700" style="margin-top:6px">No messages yet</div><p class="text-sm" style="margin-top:4px">Messages and report replies from the admin appear here. You can write to the admin below.</p></div>`);
  if (scroll) window.scrollTo(0, document.body.scrollHeight);
}

// Opened from Profile and from the bell (a new message notification lands here)
export async function openInbox() {
  showScreen('inbox');
  await renderInbox();
}
window.openInbox = openInbox;
window.openMyReports = openInbox;   // older entry point

export async function renderInbox() {
  const wrap = document.getElementById('inboxPageWrap');
  if (!wrap) return;
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back</button>
    <div class="card-teal" style="margin:10px 0 6px"><h2>✉️ Inbox</h2><p>Messages and replies from the admin</p></div>
    <div class="ib-thread" id="ibThread">${skeletonList(2, false)}</div>
    <div class="ib-composer">
      <textarea id="ibInput" rows="1" maxlength="2000" placeholder="Write to the admin…" oninput="inboxGrow(this)"></textarea>
      <button class="ib-send" id="ibSend" aria-label="Send" onclick="inboxSend()">➤</button>
    </div>`;
  const { messages, tableOk } = await loadInboxThread(window.currentUser.email);
  window._inbox = { messages, tableOk };
  _ibDraw(true);
  _ibSeen();
  clearInterval(window._ibTimer);
  window._ibTimer = setInterval(_ibPoll, 8000);
}
window.renderInbox = renderInbox;

// Opening the inbox counts as reading: remember the newest admin message id so the bell and Profile badge clear
function _ibSeen() {
  const S = window._inbox;
  if (!S) return;
  const top = Math.max(0, ...S.messages.filter(m => m.sender === 'admin' && typeof m.id === 'number').map(m => m.id));
  if (top > (window._inboxSeenId ? window._inboxSeenId() : 0)) localStorage.setItem('lum_inbox_seen_id', String(top));
  window._inboxUnread = 0;
  if (typeof window.checkNewNotifications === 'function') window.checkNewNotifications();
}

async function _ibPoll() {
  if (document.querySelector('.screen.active')?.id !== 'screen-inbox') { clearInterval(window._ibTimer); return; }
  const S = window._inbox;
  if (!S || !S.tableOk) return;
  const maxId = Math.max(0, ...S.messages.filter(m => typeof m.id === 'number').map(m => m.id));
  const { data } = await sb.from('inbox_messages').select('*').eq('user_email', window.currentUser.email).eq('sender', 'admin').gt('id', maxId).order('id');
  const known = new Set(S.messages.map(m => String(m.id)));
  const fresh = (data || []).filter(m => !known.has(String(m.id)));
  if (!fresh.length) return;
  S.messages.push(...fresh);
  _ibDraw(true);
  _ibSeen();
}
window._ibPoll = _ibPoll;

function inboxGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 110) + 'px'; }
window.inboxGrow = inboxGrow;

async function _ibDeliver(tmp) {
  tmp._state = 'sending';
  const res = await sendStudentMessage({ type: 'feedback', message: tmp.body });
  if (res.ok) { if (res.inboxId) tmp.id = res.inboxId; tmp._state = null; }
  else { tmp._state = 'failed'; showToast('⚠️ Message not sent. Tap Retry'); }
  _ibDraw(false);
}

function inboxSend() {
  const input = document.getElementById('ibInput');
  const S = window._inbox;
  if (!input || !S) return;
  const text = input.value.trim();
  if (!text) return;
  const rl = rateLimited('inbox_send', 20, 15 * 60 * 1000);
  if (!rl.allowed) return showToast(`Too many messages. Try again in ${Math.ceil(rl.waitSec / 60)} min.`);
  const tmp = { id: 'tmp' + Date.now(), sender: 'student', kind: 'message', body: text, created_at: new Date().toISOString(), _state: 'sending' };
  S.messages.push(tmp);
  input.value = ''; inboxGrow(input);
  _ibDraw(true);
  _ibDeliver(tmp);   // not awaited: the app stays responsive while it sends
}
window.inboxSend = inboxSend;

function inboxRetry(id) {
  const m = window._inbox?.messages.find(x => String(x.id) === String(id));
  if (!m) return;
  m._state = 'sending'; _ibDraw(false);
  _ibDeliver(m);
}
window.inboxRetry = inboxRetry;

function inboxDelete(id) {
  const S = window._inbox;
  if (!S) return;
  const m = S.messages.find(x => String(x.id) === String(id));
  if (!m) return;
  S.messages = S.messages.filter(x => x !== m);
  _ibDraw(false);                                   // gone straight away
  showToast('Message deleted');
  if (m.legacy) { _inboxHide(m.id); return; }       // pre-inbox report/reply: hidden on this device
  if (typeof m.id !== 'number') return;             // never reached the server
  sb.from('inbox_messages').delete().eq('id', m.id).eq('user_email', window.currentUser.email).then(({ error }) => {
    if (error) { showToast('Could not delete. Check your connection'); renderInbox(); }
  });
}
window.inboxDelete = inboxDelete;

function inboxViewImage(url) {
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:10020;display:flex;align-items:center;justify-content:center;padding:12px;cursor:zoom-out';
  o.innerHTML = `<img src="${esc(url)}" alt="" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:8px">`;
  o.onclick = () => o.remove();
  document.body.appendChild(o);
}
window.inboxViewImage = inboxViewImage;






export async function renderStats() {
  const wrap = document.getElementById('statsPageWrap');
  wrap.innerHTML = `${skeletonList(4)}`;
  const stats = await getUserStats(true);
  const history = stats.history || [];
  // Accuracy = correct ÷ ALL questions in graded tests, so a skipped question counts as wrong there. Skipped and
  // Incorrect are still shown as two separate numbers.
  const acc = stats.total_questions ? Math.round((stats.total_correct / stats.total_questions) * 100) : 0;
  const histSkipped = history.filter(h => h.mode !== 'browse').reduce((a, h) => a + (h.skipped || 0), 0);
  const skipped = Math.min(stats.total_questions || 0, Math.max(stats.total_skipped || 0, histSkipped));
  const attemptedQ = Math.max(0, (stats.total_questions || 0) - skipped);
  const incorrect = Math.max(0, attemptedQ - (stats.total_correct || 0));
  const scored = history.filter(h => typeof h.percent === 'number');   // Review sessions have no score

  // Performance by type
  const byType = {};
  for (const h of scored) {
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
  const histHtml = history.slice(0, 15).map(h => typeof h.percent !== 'number' ? `
    <div class="flex-between" style="padding:10px 0;border-bottom:1px solid var(--border)">
      <div>
        <div class="fw-600 text-sm">${esc(h.label || h.module || 'Review session')}</div>
        <div class="text-xs text-muted">${h.date} · Review</div>
      </div>
      <div style="text-align:right">
        <div class="fw-700" style="font-size:14px">${h.total || 0} reviewed</div>
        <div class="text-xs text-muted">${h.correct || 0} right</div>
      </div>
    </div>` : `
    <div class="flex-between" style="padding:10px 0;border-bottom:1px solid var(--border)">
      <div>
        <div class="fw-600 text-sm">${esc(h.module || '')}</div>
        <div class="text-xs text-muted">${h.date} · ${h.type}</div>
      </div>
      <div style="text-align:right">
        <div class="fw-700" style="color:${h.percent >= 60 ? 'var(--green)' : 'var(--red)'};font-size:15px">${h.percent}%</div>
        <div class="text-xs text-muted">${h.correct}/${h.total}${h.skipped != null ? ` · ${h.wrong || 0} wrong · ${h.skipped} skipped` : ''}</div>
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
    { id: 'century', icon: '💯', label: 'Century Club', desc: '100+ questions answered', earned: attemptedQ >= 100 },
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
        <div class="stat-val">${incorrect}</div>
        <div class="stat-key">Incorrect</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${skipped}</div>
        <div class="stat-key">Skipped</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${attemptedQ}</div>
        <div class="stat-key">Attempted</div>
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

    ${scored.length >= 3 ? `
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
  if (scored.length >= 3) {
    const canvas = document.getElementById('perfCanvas');
    if (canvas) {
      canvas.width = canvas.parentElement.offsetWidth - 40;
      const ctx = canvas.getContext('2d');
      const data = scored.slice(0, 10).reverse().map(h => h.percent);
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
  window.goBack?.();
}
// Called from an inline onclick, so it must live on window — without this the Back button on the Privacy Policy /
// Terms / About pages opened from the login screen threw "not defined" and did nothing.
window._closeLegalPage = _closeLegalPage;



async function showAboutPage(standalone = false) {
  const wrap = document.getElementById(standalone ? 'legalPageWrap' : 'profilePageWrap');
  if (standalone) {
    if (!window.navStack.length) {
      window.navStack.push('splash');
      try { window.history.replaceState({ screen: 'splash' }, ''); } catch (e) {}
    }
    showScreen('legalpage');
  }
  else window._profileSubPage = 'about';
  wrap.innerHTML = `<button class="back-btn" onclick="goBack()">← Back</button><div class="spinner" style="margin:30px auto"></div>`;
  // Silent fetch — if the about_cards table hasn't been created yet, just show none, no error toast.
  let aboutCards = [];
  try {
    const r = await sb.from('about_cards').select('*').eq('is_active', true).order('created_at', { ascending: true });
    if (!r.error && r.data) aboutCards = r.data;
  } catch (e) { /* table not set up yet — that's fine */ }

  const appName = getSetting('app_name', 'LUMHSian');
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back</button>
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
        <div><div class="fw-700 text-sm">Bookmarks & Wrong Questions</div><div class="text-xs text-muted" style="line-height:1.5">Save tough questions and revisit everything you have gotten wrong until it sticks</div></div>
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
  if (standalone) {
    if (!window.navStack.length) {
      window.navStack.push('splash');
      try { window.history.replaceState({ screen: 'splash' }, ''); } catch (e) {}
    }
    showScreen('legalpage');
  }
  else window._profileSubPage = 'privacy';
  const appName = getSetting('app_name', 'LUMHSian');
  const contactEmail = getSetting('contact_email', 'lumhsianpro@gmail.com');
  const externalUrl = getSetting('privacy_policy_url', '');
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back</button>
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
  if (standalone) {
    if (!window.navStack.length) {
      window.navStack.push('splash');
      try { window.history.replaceState({ screen: 'splash' }, ''); } catch (e) {}
    }
    showScreen('legalpage');
  }
  else window._profileSubPage = 'terms';
  const appName = getSetting('app_name', 'LUMHSian');
  const contactEmail = getSetting('contact_email', 'lumhsianpro@gmail.com');
  const externalUrl = getSetting('tos_url', '');
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back</button>
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
  window._profileSubPage = null;
  checkExpiredAttemptOnRender();
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
        ${rankInfo.rank ? `<span class="achievement-pill">🏆 Rank #${rankInfo.rank}</span>` : ''}
        <span class="achievement-pill">${isFemale ? '👩‍⚕️ Female' : '👨‍⚕️ Male'}</span>
      </div>
    </div>

    ${(() => {
      const saved = getResumableSnapshot();
      // Only a skipped/backgrounded Attempt belongs here, and only while its
      // timer genuinely still has time left — a paused Review or Practice
      // session is intentionally never shown on Profile at all; those only
      // ever appear as a small note directly on their own test's card (see
      // _resumeRowHtml in app.js).
      if (!saved || saved.mode !== 'attempt') return '';
      const elapsed = Math.floor((Date.now() - saved.startTime) / 1000);
      const remaining = (saved.timeLimit || 0) - elapsed;
      if (remaining <= 0) return '';
      const name = saved.testTitle || saved.paperTitle || saved.moduleName || 'a test';
      const mins = Math.floor(remaining / 60), secs = remaining % 60;
      return `
    <div class="card" style="margin-bottom:12px;background:var(--gold-50);border-color:var(--gold-300);display:flex;align-items:center;justify-content:space-between;gap:10px" onclick="checkResumableTest()">
      <div style="display:flex;align-items:center;gap:10px;min-width:0"><span style="font-size:20px;flex-shrink:0">⏳</span><div style="min-width:0"><div class="fw-700 text-sm">Unfinished test — ${mins}m ${secs}s left</div><div class="text-xs text-muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</div></div></div>
      <button class="btn btn-secondary btn-xs" style="width:auto;flex-shrink:0" onclick="event.stopPropagation();checkResumableTest()">▶ Resume</button>
    </div>`;
    })()}

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
      <div class="list-item-left"><div class="list-item-icon">❌</div><div><div class="list-item-title">Wrong Questions</div><div class="list-item-sub">Sorted by module, subject & test</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>
    <div class="list-item" onclick="openSavedTests()">
      <div class="list-item-left"><div class="list-item-icon">📁</div><div><div class="list-item-title">Saved Tests</div><div class="list-item-sub">Your Make Your Own tests</div></div></div>
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
    <div class="list-item" onclick="openInbox()">
      <div class="list-item-left"><div class="list-item-icon">✉️</div><div><div class="list-item-title">Inbox</div><div class="list-item-sub">Messages from admin, report replies</div></div></div>
      <div style="display:flex;align-items:center;gap:8px">${(window._inboxUnread || 0) > 0 ? `<span class="badge badge-red">${window._inboxUnread}</span>` : ''}<span style="color:var(--ink-4)">›</span></div>
    </div>
    ${getSetting('payment_enabled','false') === 'true' ? `
    <div class="list-item" onclick="showSubscriptionPlans()">
      <div class="list-item-left"><div class="list-item-icon">💎</div><div><div class="list-item-title">View Plans</div><div class="list-item-sub">Upgrade for full access</div></div></div>
      <span style="color:var(--ink-4)">›</span>
    </div>` : ''}
    ${getSetting('donation_enabled','false') === 'true' ? `
    <div class="list-item" onclick="showDonationPage()">
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
      <div class="text-xs text-muted mb-3">Select your college / university. Choose Others if it isn't listed</div>
      <select id="_ec_coll" class="input-field" title="College / University" aria-label="College / University"><option value="">Loading…</option></select>
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="saveCollege(this)">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  populateCollegeSelect('_ec_coll', window.currentUser.college || '');
}

async function saveCollege(btn) {
  const college = document.getElementById('_ec_coll').value;
  if (!college) return showToast('Please select your college');
  const overlay = btn.closest('[style*=fixed]');
  const prev = window.currentUser.college;
  window.currentUser.college = college;          // optimistic: the profile updates at once, the save runs behind it
  overlay.remove();
  renderProfile();
  showToast('College saved ✓');
  const { error } = await db(sb.from('users').update({ college }).eq('email', window.currentUser.email), 'Could not save college');
  if (error) { window.currentUser.college = prev; renderProfile(); }
}
window.saveCollege = saveCollege;
window.editCollege = editCollege;



function editPhone() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:400px">
      <div class="fw-700 mb-1">📱 ${window.currentUser.phone ? 'Edit' : 'Add'} Phone Number</div>
      <div class="text-xs text-muted mb-3">Enter a valid mobile number, e.g. 03XX-XXXXXXX</div>
      <input id="_ep_phone" class="input-field" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="03XX-XXXXXXX" value="${esc(window.currentUser.phone || '')}">
      <div id="_ep_err" class="text-xs" style="color:var(--red);margin-top:6px;display:none"></div>
      <div class="btn-row mt-3">
        <button class="btn btn-ghost" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="savePhone(this)">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

async function savePhone(btn) {
  const input = document.getElementById('_ep_phone');
  const err = document.getElementById('_ep_err');
  const phone = normalizePhone(input.value);      // only a real phone number gets through; it is stored in a clean form
  if (!phone) {
    err.textContent = 'Please enter a valid phone number, e.g. 03XX-XXXXXXX';
    err.style.display = 'block';
    return;
  }
  const overlay = btn.closest('[style*=fixed]');
  const prev = window.currentUser.phone;
  window.currentUser.phone = phone;               // optimistic: the profile updates at once, the save runs behind it
  overlay.remove();
  renderProfile();
  showToast('Phone number saved ✓');
  const { error } = await db(sb.from('users').update({ phone }).eq('email', window.currentUser.email), 'Could not save phone number');
  if (error) { window.currentUser.phone = prev; renderProfile(); }
}
window.savePhone = savePhone;
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



// ==================== SAVED-QUESTION FOLDERS (Bookmarks + Wrong Questions) ====================
// Bookmarks and Wrong Questions share ONE folder browser, so both are classified the same way and never mixed:
//   Module → Subject → Practice Test → questions        (Make Your Own Test questions sit under their original test)
//   Past Papers → Paper → questions
// What lands in each:
//   • Wrong Questions — only questions ATTEMPTED and answered wrong in an Attempt/Practice. Skipped ones never are,
//     and Review mode never saves anything.
//   • Bookmarks — whatever the student saved with the Bookmark button.
// Opening a question from either list starts it un-ticked: the student picks an option themselves, and "Show
// Explanation" is available straight away without ticking anything.
// The folder being viewed lives in window._qf[kind].path (loaded data in .data) so Back, Remove and "View Question"
// always return to the same folder.
const WA_BATCH = 150;
const QF = {
  wrong: { wrapId: 'wrongAttemptsPageWrap', icon: '❌', title: 'Wrong Questions', noun: 'Wrong attempt questions', badge: 'badge-red',
    blurb: 'you attempted and got wrong', singular: 'wrong question', emptyIcon: '✅', emptyTitle: 'No Wrong Questions',
    emptyText: 'Questions you answer incorrectly in an Attempt are saved here, sorted by module, subject and test, so you can revise them. Skipped questions and Review mode are never saved.' },
  bm: { wrapId: 'bookmarksPageWrap', icon: '📖', title: 'Bookmarks', noun: 'Bookmarked questions', badge: 'badge-teal',
    blurb: 'you saved', singular: 'bookmarked question', emptyIcon: '📖', emptyTitle: 'No Bookmarks Yet',
    emptyText: 'Tap the Bookmark button during a test to save questions here. They are sorted by module, subject and test.' }
};
window._qf = window._qf || { wrong: { data: null, path: '' }, bm: { data: null, path: '' } };

async function _qfLoad(kind) {
  const email = window.currentUser.email;
  const { data: rows0 } = kind === 'wrong'
    ? await db(sb.from('wrong_attempts').select('question_id,wrong_count,last_wrong_at').eq('email', email).order('last_wrong_at', { ascending: false }), 'Wrong questions load failed')
    : await db(sb.from('bookmarks').select('*').eq('email', email).order('added_at', { ascending: false }), 'Bookmarks load failed');
  const rows = rows0 || [];
  const data = { items: [], modules: {}, subjects: {}, tests: {}, papers: {} };
  if (!rows.length) return data;

  // Plain selects + separate lookups (not embedded joins) so a missing relationship can never blank the whole screen
  const qMap = {};
  const ids = rows.map(r => r.question_id);
  for (let i = 0; i < ids.length; i += WA_BATCH) {
    const { data: qs } = await db(sb.from('questions').select('id,text,module_id,subject_id,paper_id,practice_test_id').in('id', ids.slice(i, i + WA_BATCH)), 'Questions load failed');
    for (const q of (qs || [])) qMap[q.id] = q;
  }
  const uniq = arr => [...new Set(arr.filter(Boolean))];
  const qList = Object.values(qMap);
  const testIds = uniq(qList.map(q => q.practice_test_id));
  const paperIds = uniq(qList.map(q => q.paper_id));
  const [tRes, pRes] = await Promise.all([
    testIds.length ? db(sb.from('practice_tests').select('id,title,module_id,subject_id').in('id', testIds), 'Tests load failed') : Promise.resolve({ data: [] }),
    paperIds.length ? db(sb.from('past_papers').select('*').in('id', paperIds), 'Papers load failed') : Promise.resolve({ data: [] })
  ]);
  for (const t of (tRes.data || [])) data.tests[t.id] = t;
  for (const p of (pRes.data || [])) data.papers[p.id] = p;

  const modIds = uniq([...qList.map(q => q.module_id), ...Object.values(data.tests).map(t => t.module_id)]);
  const subIds = uniq([...qList.map(q => q.subject_id), ...Object.values(data.tests).map(t => t.subject_id)]);
  const [mRes, sRes] = await Promise.all([
    modIds.length ? db(sb.from('modules').select('id,name').in('id', modIds), 'Modules load failed') : Promise.resolve({ data: [] }),
    subIds.length ? db(sb.from('subjects').select('id,name').in('id', subIds), 'Subjects load failed') : Promise.resolve({ data: [] })
  ]);
  for (const m of (mRes.data || [])) data.modules[m.id] = m;
  for (const s of (sRes.data || [])) data.subjects[s.id] = s;

  for (const r of rows) {
    const q = qMap[r.question_id];
    if (!q) continue; // the admin deleted this question
    const item = { qid: q.id, text: q.text || '', count: r.wrong_count || 1, status: r.was_correct };
    if (q.paper_id && data.papers[q.paper_id]) {
      item.paperId = q.paper_id;
    } else {
      // A practice test row is the authority on where its questions live (a question's own module/subject can drift)
      const t = q.practice_test_id ? data.tests[q.practice_test_id] : null;
      item.moduleId = (t ? t.module_id : q.module_id) || 0;
      item.subjectId = (t ? t.subject_id : q.subject_id) || 0;
      item.testId = t ? t.id : 0;
    }
    data.items.push(item);
  }
  return data;
}

// Folder paths: '' (root) · 'M12' · 'M12/S5' · 'M12/S5/T9' (questions) · 'PP' (papers) · 'PP/P7' (questions)
function _qfParse(path) {
  const o = { papers: false };
  for (const part of String(path || '').split('/').filter(Boolean)) {
    const m = /^(PP|M|S|T|P)(\d*)$/.exec(part);
    if (!m) continue;
    if (m[1] === 'PP') o.papers = true;
    else o[m[1]] = parseInt(m[2] || '0', 10) || 0;
  }
  return o;
}

function _qfItemsFor(D, P) {
  return D.items.filter(it => {
    if (P.papers) return !!it.paperId && (!('P' in P) || it.paperId === P.P);
    if (it.paperId) return false;
    if ('M' in P && it.moduleId !== P.M) return false;
    if ('S' in P && it.subjectId !== P.S) return false;
    if ('T' in P && it.testId !== P.T) return false;
    return true;
  });
}

function _qfGroup(items, keyFn) {
  const map = new Map();
  for (const it of items) { const k = keyFn(it); map.set(k, (map.get(k) || 0) + 1); }
  return [...map.entries()].map(([id, count]) => ({ id, count }));
}

function _qfFolder(kind, icon, name, sub, count, path) {
  return `<div class="card" style="display:flex;align-items:center;gap:12px;padding:13px 14px;margin-bottom:8px;cursor:pointer" onclick="qfOpen('${kind}','${path}')">
    <div style="font-size:22px;width:30px;text-align:center;flex-shrink:0">${icon}</div>
    <div style="flex:1;min-width:0">
      <div class="fw-700 text-sm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
      <div class="text-xs text-muted">${esc(sub)}</div>
    </div>
    <span class="badge ${QF[kind].badge}">${count}</span>
    <span style="color:var(--ink-4);font-size:18px">›</span>
  </div>`;
}

function _qfQuestionCards(kind, items) {
  return items.map(it => {
    const extra = kind === 'wrong'
      ? (it.count > 1 ? ` <span class="badge badge-red">Missed ${it.count}×</span>` : '')
      : (it.status === false ? ' <span class="badge badge-red">Was wrong</span>' : it.status === true ? ' <span class="badge badge-green">Was correct</span>' : '');
    const txt = it.text.length > 120 ? esc(it.text.substring(0, 120)) + '...' : esc(it.text);
    return `<div class="card" style="margin-bottom:8px">
      <div style="font-size:14px;font-weight:600;line-height:1.5;margin-bottom:10px">${txt || 'Question'}${extra}</div>
      <div class="btn-row">
        <button class="btn btn-secondary btn-xs" onclick="qfView('${kind}',${it.qid})">View Question</button>
        <button class="btn btn-ghost btn-xs" style="color:var(--red)" onclick="qfRemove('${kind}',${it.qid})">Remove</button>
      </div>
    </div>`;
  }).join('');
}

function qfOpen(kind, path) {
  const cfg = QF[kind];
  const S = window._qf[kind];
  const D = S && S.data;
  const wrap = document.getElementById(cfg.wrapId);
  if (!D || !wrap) return kind === 'wrong' ? renderWrongAttempts() : renderBookmarks();

  // If a folder just emptied (its last question was removed), climb to the nearest folder that still has questions
  let cur = path || '';
  while (cur && !_qfItemsFor(D, _qfParse(cur)).length) cur = cur.split('/').slice(0, -1).join('/');
  S.path = cur;
  const P = _qfParse(cur);
  // the root lists everything (module folders AND the Past Papers folder); deeper folders filter by their own path
  const items = cur ? _qfItemsFor(D, P) : D.items.slice();
  const modName = id => id ? (D.modules[id]?.name || 'Module') : 'Other questions';
  const subName = id => id ? (D.subjects[id]?.name || 'Subject') : 'Whole module';
  const testName = id => id ? (D.tests[id]?.title || 'Practice test') : 'Other questions';
  const back = label => `<button class="back-btn" onclick="goBack()">← ${esc(label)}</button>`;
  const header = (title, crumb, n) => `<div class="card-teal" style="margin-bottom:14px">
      <h2 style="margin-bottom:2px">${esc(title)}</h2>
      ${crumb ? `<div class="text-xs" style="opacity:.85;margin-bottom:2px">${esc(crumb)}</div>` : ''}
      <p>${cfg.noun} · ${n}</p>
    </div>`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const byName = (nameFn) => (a, b) => nameFn(a.id).localeCompare(nameFn(b.id));
  let html = '';

  if (!cur) {
    if (!items.length) {
      wrap.innerHTML = `${back('Back')}<div class="card text-center" style="padding:40px 20px">
        <div style="font-size:48px">${cfg.emptyIcon}</div>
        <h3 style="margin-top:12px">${cfg.emptyTitle}</h3>
        <p class="mt-2">${cfg.emptyText}</p>
      </div>`;
      return;
    }
    const moduleItems = items.filter(i => !i.paperId);
    const paperItems = items.filter(i => i.paperId);
    html = back('Back') + `<div class="card-teal" style="margin-bottom:14px">
        <h2>${cfg.icon} ${cfg.title}</h2>
        <p>${plural(items.length, 'question')} ${cfg.blurb}</p>
      </div>`;
    const mods = _qfGroup(moduleItems, i => i.moduleId).sort(byName(modName));
    if (mods.length) html += `<div class="section-label">Modules</div>` + mods.map(m => {
      const subCount = new Set(moduleItems.filter(i => i.moduleId === m.id).map(i => i.subjectId)).size;
      return _qfFolder(kind, '📚', modName(m.id), plural(m.count, cfg.singular) + (m.id ? ` · ${plural(subCount, 'subject')}` : ''), m.count, 'M' + m.id);
    }).join('');
    if (paperItems.length) {
      const nPapers = new Set(paperItems.map(i => i.paperId)).size;
      html += `<div class="section-label">Past Papers</div>` + _qfFolder(kind, '📜', 'Past Papers', `${plural(paperItems.length, cfg.singular)} · ${plural(nPapers, 'paper')}`, paperItems.length, 'PP');
    }
  } else if (P.papers && !('P' in P)) {
    const papers = _qfGroup(items, i => i.paperId).sort((a, b) => (D.papers[a.id]?.title || '').localeCompare(D.papers[b.id]?.title || ''));
    html = back(cfg.title) + header('Past Papers', '', items.length)
      + papers.map(p => _qfFolder(kind, '📄', D.papers[p.id]?.title || 'Paper', plural(p.count, cfg.singular), p.count, 'PP/P' + p.id)).join('');
  } else if (P.papers) {
    html = back('Past Papers') + header(D.papers[P.P]?.title || 'Paper', 'Past Papers', items.length) + _qfQuestionCards(kind, items);
  } else if (!('S' in P)) {
    const subs = _qfGroup(items, i => i.subjectId).sort(byName(subName));
    html = back(cfg.title) + header(modName(P.M), '', items.length)
      + subs.map(s => {
        const nTests = new Set(items.filter(i => i.subjectId === s.id).map(i => i.testId)).size;
        return _qfFolder(kind, '🧪', subName(s.id), `${plural(s.count, cfg.singular)} · ${plural(nTests, 'test')}`, s.count, `M${P.M}/S${s.id}`);
      }).join('');
  } else if (!('T' in P)) {
    const tests = _qfGroup(items, i => i.testId).sort(byName(testName));
    html = back(modName(P.M)) + header(subName(P.S), modName(P.M), items.length)
      + tests.map(t => _qfFolder(kind, '📝', testName(t.id), plural(t.count, cfg.singular), t.count, `M${P.M}/S${P.S}/T${t.id}`)).join('');
  } else {
    html = back(subName(P.S)) + header(testName(P.T), `${modName(P.M)} › ${subName(P.S)}`, items.length) + _qfQuestionCards(kind, items);
  }
  wrap.innerHTML = html + '<div style="height:16px"></div>';
  window.scrollTo(0, 0);
}
window.qfOpen = qfOpen;
window.waOpen = (path) => qfOpen('wrong', path);
window.bmOpen = (path) => qfOpen('bm', path);



async function _qfRoot(kind) {
  const wrap = document.getElementById(QF[kind].wrapId);
  if (!wrap) return;
  wrap.innerHTML = `<button class="back-btn" onclick="goBack()">← Back</button>${skeletonList(3)}`;
  window._qf[kind] = { data: await _qfLoad(kind), path: '' };
  qfOpen(kind, '');
}

export async function renderBookmarks() { return _qfRoot('bm'); }
window.renderBookmarks = renderBookmarks;

export async function renderWrongAttempts() { return _qfRoot('wrong'); }
window.renderWrongAttempts = renderWrongAttempts;



// ---------- one question, opened from a Bookmarks / Wrong Questions folder ----------
// Nothing is pre-marked: the options start neutral, the student ticks one and only then sees right/wrong. "Show
// Explanation" is there from the start and works whether or not an option was ticked.
async function qfView(kind, qid) {
  if (!qid) return showToast('Question not found');
  const [{ data: q }, { data: existingBm }] = await Promise.all([
    db(sb.from('questions').select('*').eq('id', qid).single(), 'Question load failed'),
    db(sb.from('bookmarks').select('id').eq('email', window.currentUser.email).eq('question_id', qid).maybeSingle(), 'Bookmark check failed')
  ]);
  if (!q) return showToast('Question not found');
  const opts = Array.isArray(q.options) ? q.options : JSON.parse(q.options || '[]');
  window._qp = { kind, q, opts, picked: null, showExp: false, bookmarked: !!existingBm };
  _qpDraw();
  window.scrollTo(0, 0);
}
window.qfView = qfView;
window.showWrongQ = (qid) => qfView('wrong', qid);
window.showBookmarkedQ = (qid) => qfView('bm', qid);

function _qpDraw() {
  const s = window._qp;
  if (!s) return;
  const { kind, q, opts, picked, showExp } = s;
  const wrap = document.getElementById(QF[kind].wrapId);
  if (!wrap) return;
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const answered = picked !== null;
  const optHtml = opts.map((o, i) => {
    let cls = 'opt-btn', icon = '';
    if (answered) {
      if (i === q.correct_answer) { cls += ' correct'; icon = '✓ '; }
      else if (i === picked) { cls += ' wrong'; icon = '✗ '; }
    }
    return `<button class="${cls}" onclick="qpPick(${i})" ${answered ? 'disabled' : ''}>
      <span class="opt-letter">${letters[i]}</span>
      <span>${icon}${esc(o)}</span>
    </button>`;
  }).join('');
  const verdict = !answered
    ? '<div class="text-xs text-muted" style="margin:2px 2px 10px">Tap an option to check your answer</div>'
    : picked === q.correct_answer
      ? '<div class="fw-700" style="color:var(--green);margin:2px 2px 10px">✅ Correct!</div>'
      : `<div class="fw-700" style="color:var(--red);margin:2px 2px 10px">❌ Not quite. The correct answer is ${letters[q.correct_answer]}.</div>`;
  const parentPath = window._qf[kind].path || '';
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back</button>
    <div class="card-elevated" style="margin-bottom:16px">
      <div style="font-size:15px;font-weight:600;line-height:1.6">${esc(q.text)}</div>
      ${q.image_url ? `<img src="${esc(q.image_url)}" style="max-width:100%;border-radius:12px;margin-top:10px" onerror="this.style.display='none'">` : ''}
    </div>
    ${optHtml}
    ${verdict}
    <div class="btn-row">
      <button class="btn btn-ghost btn-sm" onclick="qpToggleExp()">${showExp ? '🙈 Hide Explanation' : '📖 Show Explanation'}</button>
      ${answered ? '<button class="btn btn-ghost btn-sm" onclick="qpRetry()">↺ Try again</button>' : ''}
    </div>
    ${showExp ? `<div class="explanation-box show" style="margin-top:12px">
      <div class="exp-label">✅ Correct: ${esc(opts[q.correct_answer]) || ''}</div>
      <div class="exp-content" style="margin-top:6px">${q.explanation ? renderMd(q.explanation) : '<span style="color:var(--ink-4)">No explanation yet.</span>'}</div>
      ${q.explanation_image_url ? `<img src="${esc(q.explanation_image_url)}" style="max-width:100%;border-radius:12px;margin-top:10px" onerror="this.style.display='none'">` : ''}
    </div>` : ''}
    <div class="btn-row mt-3">
      ${isAIEnabled() ? `<button class="btn btn-ghost" onclick="openAITutor('${escJs(q.text)}','${escJs(q.explanation || '')}')">🤖 Explain with AI</button>` : ''}
      <button class="btn btn-ghost" onclick="openReportModal(${q.id})">🚩 Report</button>
      ${kind === 'wrong' ? `<button class="btn btn-secondary" onclick="qpToggleBookmark()">${s.bookmarked ? '🔖 Saved ✓' : '📖 Save'}</button>` : ''}
    </div>
    <button class="btn btn-ghost mt-2" style="color:var(--red);width:100%" onclick="qfRemove('${kind}',${q.id})">🗑 ${kind === 'wrong' ? 'Remove from Wrong Questions' : 'Remove Bookmark'}</button>
  `;
}

function qpPick(i) {
  const s = window._qp;
  if (!s || s.picked !== null) return;
  s.picked = i;
  _qpDraw();
}
window.qpPick = qpPick;

function qpRetry() { if (window._qp) { window._qp.picked = null; _qpDraw(); } }
window.qpRetry = qpRetry;

function qpToggleExp() { if (window._qp) { window._qp.showExp = !window._qp.showExp; _qpDraw(); } }
window.qpToggleExp = qpToggleExp;

async function qpToggleBookmark() {
  const s = window._qp;
  if (!s) return;
  const email = window.currentUser.email;
  if (s.bookmarked) {
    await db(sb.from('bookmarks').delete().eq('email', email).eq('question_id', s.q.id), 'Remove bookmark failed');
    s.bookmarked = false;
    showToast('Bookmark removed');
  } else {
    await db(sb.from('bookmarks').upsert({ email, question_id: s.q.id, added_at: Date.now() }, { onConflict: 'email,question_id' }), 'Bookmark save failed');
    s.bookmarked = true;
    showToast('📖 Bookmarked!');
  }
  window._qf.bm = { data: null, path: '' };   // the Bookmarks list reloads next time it is opened
  _qpDraw();
}
window.qpToggleBookmark = qpToggleBookmark;



function qfRemove(kind, qid) {
  showConfirm(kind === 'wrong' ? 'Remove this question from Wrong Questions?' : 'Remove this question from your bookmarks?', async () => {
    if (kind === 'wrong') await db(sb.from('wrong_attempts').delete().eq('email', window.currentUser.email).eq('question_id', qid), 'Remove failed');
    else await db(sb.from('bookmarks').delete().eq('email', window.currentUser.email).eq('question_id', qid), 'Remove failed');
    showToast(kind === 'wrong' ? 'Removed from Wrong Questions' : 'Bookmark removed');
    const S = window._qf[kind];
    if (S && S.data) {
      S.data.items = S.data.items.filter(i => i.qid !== qid);
      qfOpen(kind, S.path || '');   // stays in the same folder (or the nearest one that still has questions)
    } else {
      (kind === 'wrong' ? renderWrongAttempts : renderBookmarks)();
    }
  }, 'Remove', true);
}
window.qfRemove = qfRemove;
window.confirmRemoveWrongAttempt = (qid) => qfRemove('wrong', qid);
window.confirmRemoveBookmark = (qid) => qfRemove('bm', qid);



// ==================== SEARCH ====================
// renderSearch and executeSearch are defined once, further below, with module/difficulty filters.

// ==================== PLANNER ====================
// Questions actually attempted in one logged session (skipped ones are not "done")
const _attemptedOf = h => Math.max(0, (h.total || 0) - (h.skipped || 0));

export async function renderPlanner() {
  const wrap = document.getElementById('plannerPageWrap');
  const stats = await getUserStats();
  const goal = parseInt(localStorage.getItem('daily_goal') || '20');
  const todayStr = new Date().toLocaleDateString();
  const todayHistory = (stats.history || []).filter(h => h.date === todayStr);
  const todayQ = todayHistory.reduce((a, h) => a + _attemptedOf(h), 0);
  const todayPct = Math.min(100, Math.round((todayQ / goal) * 100));

  // Build 30-day activity heatmap
  const historyMap = {};
  for (const h of (stats.history || [])) {
    historyMap[h.date] = (historyMap[h.date] || 0) + _attemptedOf(h);
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
    <button class="back-btn" onclick="goBack()">← Back</button>
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
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', '#c9980a'));
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
  window._profileSubPage = 'subscription';
  wrap.innerHTML = `
    <button class="back-btn" onclick="goBack()">← Back</button>
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
