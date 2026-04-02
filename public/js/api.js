// Lightweight fetch wrapper — on error, parses response body for error/message when possible
async function handleResponse(res, path) {
  if (res.ok) return res.json();
  const text = await res.text();
  let msg = `API ${res.status}: ${path}`;
  try {
    const body = JSON.parse(text);
    if (body && (body.error || body.message)) msg = String(body.error || body.message);
  } catch (_) {
    if (text && text.length < 200) msg = text;
  }
  throw new Error(msg);
}

const api = {
  async get(path, params = {}) {
    const qs = Object.keys(params).length
      ? '?' + new URLSearchParams(params) : '';
    const res = await fetch(path + qs);
    return handleResponse(res, path);
  },
  async post(path, body = {}) {
    const res = await fetch(path, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    return handleResponse(res, path);
  },
  async put(path, body = {}) {
    const res = await fetch(path, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    return handleResponse(res, path);
  },
  async del(path) {
    const res = await fetch(path, { method: 'DELETE' });
    return handleResponse(res, path);
  },
};

// ISK formatter
function fmtISK(n, decimals = 1) {
  if (n == null) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(decimals) + 'T';
  if (abs >= 1e9)  return sign + (abs / 1e9).toFixed(decimals)  + 'B';
  if (abs >= 1e6)  return sign + (abs / 1e6).toFixed(decimals)  + 'M';
  if (abs >= 1e3)  return sign + (abs / 1e3).toFixed(decimals)  + 'K';
  return sign + abs.toFixed(0);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const loc = (typeof window !== 'undefined' && window.__dateFormat === 'us') ? 'en-US' : 'en-GB';
  const opts = loc === 'en-US'
    ? { month: '2-digit', day: '2-digit', year: 'numeric' }
    : { day: '2-digit', month: 'short', year: 'numeric' };
  return new Date(iso).toLocaleDateString(loc, opts);
}

function fmtDateShort(iso) {
  if (!iso) return '—';
  const loc = (typeof window !== 'undefined' && window.__dateFormat === 'us') ? 'en-US' : 'en-GB';
  const opts = loc === 'en-US'
    ? { month: '2-digit', day: '2-digit' }
    : { day: '2-digit', month: 'short' };
  return new Date(iso).toLocaleDateString(loc, opts);
}

function fuelClass(days) {
  if (days == null) return 'dim';
  if (days < 14) return 'red';
  if (days < 30) return 'gold';
  return 'green';
}

function fuelBarClass(days) {
  if (days == null) return 'bar-grey';
  if (days < 14) return 'bar-red';
  if (days < 30) return 'bar-orange';
  return 'bar-green';
}

function barPct(days, max = 90) {
  if (days == null) return 0;
  return Math.min(100, (days / max) * 100).toFixed(1);
}

function fmtNum(n) {
  if (n == null) return '—';
  return Math.round(n).toLocaleString('en-US');
}

// XSS-safe HTML escape — use whenever inserting external/user data into innerHTML
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Global toast — use instead of alert() for success/error. type: 'success' | 'error' | 'info'
function toast(message, type) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast toast-' + (type === 'success' || type === 'error' ? type : 'info');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(function () { if (el.parentNode) el.remove(); }, 4500);
}
