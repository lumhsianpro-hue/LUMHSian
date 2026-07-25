

// ==================== SECURITY: OUTPUT ESCAPING (XSS PREVENTION) ====================
// SECURITY FIX: student names, comments, question text, announcements, phone
// numbers, etc. are all free text stored in the database, and dozens of places
// in this file were writing that text straight into innerHTML. That means
// anyone who can get text into a row — a student renaming themselves, posting
// a comment, submitting feedback — could run JavaScript in every other
// viewer's browser (stored XSS), including the admin's, which is enough to
// steal a Supabase session and act as that person. Always wrap untrusted text
// in esc()/escNl()/escJs() (never raw) before putting it in a template
// literal that becomes innerHTML.
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


// Same as esc(), but turns real newlines into <br> AFTER escaping, so
// multi-line text (explanations, comments) keeps its line breaks without
// ever letting actual HTML through.
function escNl(value) {
  return esc(value).replace(/\n/g, '<br>');
}


// Explanations bulk-uploaded from AI chat exports, and AI Tutor replies, come
// back in markdown (**bold**, - bullet lists, --- dividers, etc.) — showing
// that as plain/escaped text meant students saw literal asterisks, dashes,
// and underscores instead of actual formatting, which is exactly what made
// it read as raw, unpolished AI output. This escapes first (same as esc()),
// then only ever adds back a small fixed set of safe tags, so it's no less
// safe than escNl() while actually rendering the formatting.
export function renderMd(value) {
  if (value === null || value === undefined || value === '') return '';
  let html = esc(String(value));
  html = html.replace(/```([\s\S]+?)```/g, (m, code) => `<pre style="background:var(--surface-3);border-radius:8px;padding:10px;overflow-x:auto;white-space:pre-wrap;font-size:.9em;margin:6px 0">${code.trim()}</pre>`);
  html = html.replace(/`([^`]+?)`/g, '<code style="background:var(--surface-3);padding:1px 5px;border-radius:4px;font-size:.9em">$1</code>');
  html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong class="md-strong">$1</strong>');
  html = html.replace(/__([^_]+?)__/g, '<strong class="md-strong">$1</strong>');
  html = html.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
  html = html.replace(/(^|[^\w])_([^_]+?)_(?!\w)/g, '$1<em>$2</em>');
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<span class="md-heading">$1</span>');
  html = html.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, ''); // horizontal-rule lines — just dropped, not shown as a line
  html = html.replace(/(?:^[ \t]*[-*][ \t]+.+$\n?)+/gm, block => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*[-*][ \t]+/, '')}</li>`).join('');
    return `<ul class="md-list">${items}</ul>`;
  });
  html = html.replace(/(?:^[ \t]*\d+\.[ \t]+.+$\n?)+/gm, block => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*\d+\.[ \t]+/, '')}</li>`).join('');
    return `<ol class="md-list">${items}</ol>`;
  });
  html = html.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
  return html;
}


// For text dropped into a single-quoted JS string *inside* an HTML attribute,
// e.g. onclick="foo('${escJs(text)}')". Escaping HTML entities first means
// the value can no longer contain a raw quote, angle bracket, or ampersand —
// so it can't break out of the attribute OR the JS string it sits inside.
export function escJs(value) {
  return esc(value).replace(/\n/g, ' ');
}
window.escJs = escJs;



// Small inline icon set (stroke-based, currentColor so it always matches
// whatever text color surrounds it) used in place of decorative emoji like
// 🎯/🚀/💡 in student-facing screens — same idea as the icons any real app
// uses, just drawn by hand since this file can't import an icon package.
export const ICON_TARGET = '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:-0.125em"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></svg>';


export const ICON_MEDAL = '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:-0.125em"><circle cx="12" cy="8.5" r="5.5"/><path d="M8.9 13.5 7 22l5-3 5 3-1.9-8.5"/></svg>';


const ICON_TIP = '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:-0.125em"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.5.4.8 1 .8 1.7v.6h6.4v-.6c0-.7.3-1.3.8-1.7A7 7 0 0 0 12 2Z"/></svg>';


// ==================== ICON LIBRARY (replaces emoji in the highest-visibility screens) ====================
// Same style throughout: 24x24 line icons, currentColor, 1em sizing so they inherit
// whatever text color/size surround them — same pattern as ICON_TARGET/MEDAL/TIP above.
function _icon(paths, extra = '') { return `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-0.125em;flex-shrink:0">${paths}</svg>${extra}`; }


export const ICON_BOOK = _icon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>');


export const ICON_BOOKMARK = _icon('<path d="M6 3h12v18l-6-4-6 4V3Z"/>');


export const ICON_X_CIRCLE = _icon('<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>');


export const ICON_CALENDAR = _icon('<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M16 2.5v4M8 2.5v4M3 9.5h18"/>');


export const ICON_ROBOT = _icon('<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M9 3.5h6M8 13v2M16 13v2"/><path d="M2 13v3M22 13v3"/>');


export const ICON_BELL = _icon('<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10 20a2 2 0 0 0 4 0"/>');


export const ICON_FIRE = _icon('<path d="M12 2s-6 5.5-6 10.5A6 6 0 0 0 18 12.5C18 9 15.5 7 15.5 7c.3 2-1 3-1 3C15 6 12 2 12 2Z"/>');


const ICON_TROPHY = _icon('<path d="M8 4h8v6a4 4 0 0 1-8 0V4Z"/><path d="M8 5H4v2a4 4 0 0 0 4 4M16 5h4v2a4 4 0 0 1-4 4"/><path d="M10 18h4M12 14v4M9 21h6"/>');


const ICON_GLOBE = _icon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z"/>');


export const ICON_CHART = _icon('<path d="M4 20V10M12 20V4M20 20v-7"/><path d="M2 20h20"/>');


const ICON_SEARCH = _icon('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>');


export const ICON_STETHOSCOPE = _icon('<path d="M6 3v6a4 4 0 0 0 8 0V3"/><path d="M6 3H4.5M14 3h1.5"/><path d="M18 10v2a6 6 0 0 1-12 0v-2"/><circle cx="19" cy="9" r="2"/>');


const ICON_EYE = _icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>');


export const ICON_EDIT = _icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/>');


export const ICON_CLOCK = _icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>');


export const ICON_LOCK = _icon('<rect x="4.5" y="11" width="15" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>');


const ICON_FLAG = _icon('<path d="M5 3v18"/><path d="M5 4h13l-3 4.5L18 13H5"/>');


export const ICON_CHECK_CIRCLE = _icon('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9"/>');


const ICON_GRAD_CAP = _icon('<path d="M2 9.5 12 5l10 4.5-10 4.5-10-4.5Z"/><path d="M6 12v5c0 1 2.7 2.5 6 2.5s6-1.5 6-2.5v-5M21 9.5V16"/>');


export const ICON_BUILDING = _icon('<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 8h1M14 8h1M9 12h1M14 12h1M9 16h1M14 16h1"/>');


const ICON_ANNOUNCE = _icon('<path d="M4 10v4a1 1 0 0 0 1 1h2l5 4V5l-5 4H5a1 1 0 0 0-1 1Z"/><path d="M17 9a4 4 0 0 1 0 6"/>');


const ICON_IMAGE = _icon('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m4 18 5-5 4 4 3-3 4 4"/>');


const ICON_UPLOAD = _icon('<path d="M12 15V4M8 8l4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>');


const ICON_SUN = _icon('<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>');


const ICON_MOON = _icon('<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>');


const ICON_CHECK_SM = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>';


// Small "done" badge for the corner of a test/paper's icon (like UWorld's completed
// checkmark), plus a compact summary line — both only shown once a test has been
// attempted at least once (test_stats/paper_stats are only ever written from a real,
// answered Attempt — see submitTest()'s `attempted > 0` guard).
export function attemptBadgeHtml(s) { return s ? `<span class="attempted-check">${ICON_CHECK_SM}</span>` : ''; }


export function attemptLineHtml(s) { return s ? `<div class="attempted-line">${ICON_CHECK_SM} Attempted · ${s.bestScore}% best${s.attempts > 1 ? ` · ${s.attempts}×` : ''}</div>` : ''; }



// Initials-in-a-circle avatar — the same pattern Gmail/Slack/LinkedIn use when
// there's no profile photo — in place of the king/queen/doctor emoji that were
// standing in for student avatars. Color is derived from the name itself so
// the same student always gets the same color without storing anything extra.
const AVATAR_COLORS = ['#7a5c00','#b45f05','#8a6600','#a35604','#6b5828','#916e05'];


function avatarColorFor(name) {
  let hash = 0;
  const s = name || '?';
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}


export function renderAvatar(name, size = 40) {
  const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
  const initials = (parts.length >= 2 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2)).toUpperCase();
  return `<div style="width:${size}px;height:${size}px;min-width:${size}px;border-radius:50%;background:${avatarColorFor(name)};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:${Math.round(size*0.38)}px;font-family:var(--font-display)">${esc(initials)}</div>`;
}



// Reuses the .skel-card/.skeleton classes already built for the Modules
// screen, so every list screen gets the same "shapes of content" loading
// feel instead of a plain spinner — extended here to Bookmarks, Wrong
// Attempts, Ranking, Profile, and My Reports.
export function skeletonList(count = 4, withHeader = true) {
  return `
    ${withHeader ? `<div class="skel-card"><div class="skeleton" style="height:22px;width:50%;margin-bottom:8px"></div><div class="skeleton" style="height:13px;width:70%"></div></div>` : ''}
    ${Array(count).fill(0).map(() => `<div class="skel-card" style="display:flex;gap:12px;align-items:center"><div class="skeleton" style="width:44px;height:44px;border-radius:50%;flex-shrink:0"></div><div style="flex:1"><div class="skeleton" style="height:15px;margin-bottom:6px;width:65%"></div><div class="skeleton" style="height:12px;width:40%"></div></div></div>`).join('')}`;
}



// ==================== SECURITY: SOFT CLIENT-SIDE RATE LIMITING ====================
// SECURITY FIX: throttles repeated attempts at an action (sign-in, posting a
// comment, submitting a report) from this browser. This is real protection
// against a runaway retry loop or a casual script hammering these actions, but
// it is NOT the actual security boundary — someone can always clear
// localStorage and start over. The real, unbypassable limits for sign-in
// attempts live server-side in Supabase: Dashboard → Authentication → Rate
// Limits (and Google's own sign-in throttling, which we don't control at all).
// This function is defense-in-depth on top of that, not a replacement for it.
export function rateLimited(key, maxAttempts, windowMs) {
  const storeKey = `rl_${key}`;
  let attempts = [];
  try { attempts = JSON.parse(localStorage.getItem(storeKey) || '[]'); } catch (e) { attempts = []; }
  const now = Date.now();
  attempts = attempts.filter(t => now - t < windowMs);
  if (attempts.length >= maxAttempts) {
    const waitSec = Math.ceil((windowMs - (now - attempts[0])) / 1000);
    return { allowed: false, waitSec };
  }
  attempts.push(now);
  try { localStorage.setItem(storeKey, JSON.stringify(attempts)); } catch (e) { /* ignore quota errors */ }
  return { allowed: true };
}



// ==================== UTILS ====================
export function showToast(msg, dur = 3000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), dur);
}
window.showToast = showToast;



export function showLoading(v, msg = 'Loading...') {
  const ol = document.getElementById('loadingOverlay');
  if (v) {
    // Delay showing spinner by 200ms — fast operations won't flash a spinner at all
    clearTimeout(window._loadingTimer);
    window._loadingTimer = setTimeout(() => {
      ol.querySelector('.loading-text').textContent = msg;
      ol.classList.add('show');
    }, 200);
  } else {
    clearTimeout(window._loadingTimer);
    ol.classList.remove('show');
  }
}



// ==================== LOCAL CACHE (localStorage) ====================
// Generic TTL cache for static/slow-changing reference data — colleges,
// years, announcements, app settings, feature flags, subscription plans.
// Backed by localStorage (not just a window variable) so it survives page
// reloads too, not only repeat calls within one session — a fresh app
// launch can skip the network round trip entirely while the cache is
// still fresh, which is where most redundant API calls were coming from.
// Fails silently (private browsing / storage full / corrupted entry) and
// just falls back to a normal network fetch, so caching can never be the
// reason a screen fails to load.
const CACHE_PREFIX = 'lum_cache_';


export function cacheGet(key, ttlMs) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { v, t } = JSON.parse(raw);
    if (typeof t !== 'number' || Date.now() - t > ttlMs) return null;
    return v;
  } catch (e) { return null; }
}


export function cacheSet(key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ v: value, t: Date.now() }));
  } catch (e) { console.warn('cacheSet failed', key, e); }
}


export function cacheClear(key) {
  try { localStorage.removeItem(CACHE_PREFIX + key); } catch (e) {}
}
window.cacheClear = cacheClear;



// Delays running `fn` until `ms` have passed with no further calls — used to
// stop rapid-fire input (search boxes, autosave) from firing an API call on
// every keystroke.
export function _debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}



export function openModal(id) { document.getElementById(id).classList.add('show'); }
window.openModal = openModal;


export function closeModal(id) { document.getElementById(id).classList.remove('show'); }
window.closeModal = closeModal;




// ==================== CUSTOM CONFIRM DIALOG ====================
export function showConfirm(message, onConfirm, confirmLabel = 'Confirm', danger = true) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(23,23,23,.8);z-index:10003;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:var(--radius-xl);padding:24px;width:100%;max-width:360px;text-align:center">
      <div style="font-size:22px;margin-bottom:12px">⚠️</div>
      <div style="font-size:15px;font-weight:600;line-height:1.5;margin-bottom:20px">${message}</div>
      <div class="btn-row" style="justify-content:center">
        <button class="btn btn-ghost" style="flex:1" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        <button class="btn ${danger?'btn-danger':'btn-primary'}" style="flex:1" id="_confirmBtn">${confirmLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#_confirmBtn').onclick = () => { overlay.remove(); onConfirm(); };
}



let _audioCtx = null;


function _getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // Mobile Chrome/Safari create every AudioContext in a "suspended" state and
  // only let it start running as part of a genuine user gesture. Without this
  // resume() call the context stays suspended forever and every sound plays
  // silently with no error — which is exactly why toggling Sound Effects on
  // produced no audio at all.
  if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
  return _audioCtx;
}


// Unlock audio on the very first tap anywhere in the app (before the student
// ever reaches a screen that plays a sound), so playSound() is never the
// first thing asking the browser for permission.
function _unlockAudioOnce() {
  try { _getAudioCtx(); } catch (e) {}
  document.removeEventListener('pointerdown', _unlockAudioOnce);
  document.removeEventListener('touchstart', _unlockAudioOnce);
  document.removeEventListener('click', _unlockAudioOnce);
}


document.addEventListener('pointerdown', _unlockAudioOnce, { once: true, passive: true });


document.addEventListener('touchstart', _unlockAudioOnce, { once: true, passive: true });


document.addEventListener('click', _unlockAudioOnce, { once: true, passive: true });



export function playSound(type) {
  if (localStorage.getItem('sound_enabled') === 'false') return;
  try {
    const ctx = _getAudioCtx();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    const presets = {
      click:   { freq: 600,  dur: 0.05, vol: 0.04, type: 'sine' },
      correct: { freq: 880,  dur: 0.15, vol: 0.06, type: 'sine' },
      wrong:   { freq: 220,  dur: 0.18, vol: 0.06, type: 'sine' },
      submit:  { freq: 660,  dur: 0.25, vol: 0.05, type: 'triangle' }
    };
    const p = presets[type] || presets.click;
    o.type = p.type; o.frequency.value = p.freq;
    g.gain.value = p.vol;
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + p.dur);
    o.stop(ctx.currentTime + p.dur + 0.02);
    if (type === 'correct') {
      const o2 = ctx.createOscillator(), g2 = ctx.createGain();
      o2.connect(g2); g2.connect(ctx.destination);
      o2.type = 'sine'; o2.frequency.value = 1180;
      g2.gain.value = 0.05;
      o2.start(ctx.currentTime + 0.08);
      g2.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
      o2.stop(ctx.currentTime + 0.24);
    }
  } catch (e) { /* audio not available — fail silently */ }
}
