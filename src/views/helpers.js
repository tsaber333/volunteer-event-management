// Small view helpers for formatting dates and rich text used by EJS templates.
// Keep pure JS and minimal dependencies so templates remain fast and safe.

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseToDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  // ISO-like
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(.\d+)?Z?$/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d)) return d;
  }
  // Local canonical: YYYY-MM-DD HH:mm
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})/);
  if (m) {
    const [_, Y, Mo, D, H, Mi] = m;
    return new Date(+Y, +Mo - 1, +D, +H, +Mi);
  }
  // Fallback: try Date parse
  const d = new Date(str);
  return isNaN(d) ? null : d;
}

function fmt12(txt) {
  const dt = parseToDate(txt);
  if (!dt) return String(txt || '');
  const opts = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' };
  return dt.toLocaleString(undefined, opts);
}

function canonicalLocal(txt) {
  const dt = parseToDate(txt);
  if (!dt) return String(txt || '');
  const Y = dt.getFullYear();
  const M = String(dt.getMonth() + 1).padStart(2, '0');
  const D = String(dt.getDate()).padStart(2, '0');
  const h = String(dt.getHours()).padStart(2, '0');
  const mi = String(dt.getMinutes()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${mi}`;
}

function fmtRange(startTxt, endTxt) {
  const s = parseToDate(startTxt);
  const e = parseToDate(endTxt);
  if (!s || !e) {
    return `${fmt12(startTxt)} – ${fmt12(endTxt)}`;
  }
  const sameDay = s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth() && s.getDate() === e.getDate();
  if (sameDay) {
    const date = s.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const st = s.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const et = e.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${date} • ${st} – ${et}`;
  }
  return `${fmt12(startTxt)} – ${fmt12(endTxt)}`;
}

// "Wed, Dec 23" for day headings and jump links.
function fmtDay(txt) {
  const dt = parseToDate(txt);
  if (!dt) return '';
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// "3:30 PM – 5:00 PM" when both ends fall on the same day, else ''.
function fmtTimeRange(startTxt, endTxt) {
  const s = parseToDate(startTxt);
  const e = parseToDate(endTxt);
  if (!s || !e || s.toDateString() !== e.toDateString()) return '';
  const opts = { hour: 'numeric', minute: '2-digit' };
  return `${s.toLocaleTimeString(undefined, opts)} – ${e.toLocaleTimeString(undefined, opts)}`;
}

/**
 * Render a safe, lightweight rich-text fragment from plain text input.
 * Supports:
 *   - Paragraphs (blank line separated)
 *   - Bullet lists (lines starting with "-" or "*")
 *   - Line breaks within paragraphs
 *   - **bold** and *italic* inline markup
 *
 * All HTML is escaped first so users cannot inject arbitrary tags; we only
 * emit a small set of known-safe elements.
 */
function renderRichText(input) {
  if (!input) return '';
  const text = String(input || '').replace(/\r\n/g, '\n');

  function applyInlineMarkup(str) {
    let s = escapeHtml(str);
    // Bold: **text**
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic: *text*
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    return s;
  }

  const lines = text.split('\n');
  const out = [];
  let buf = [];
  let inList = false;

  function flushParagraph() {
    if (!buf.length) return;
    const content = buf.join('<br>');
    out.push(`<p>${content}</p>`);
    buf = [];
  }

  function closeList() {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  }

  lines.forEach(rawLine => {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      closeList();
      return;
    }

    const m = line.match(/^[-*]\s+(.*)$/);
    if (m) {
      const itemText = applyInlineMarkup(m[1]);
      if (!inList) {
        flushParagraph();
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${itemText}</li>`);
    } else {
      closeList();
      buf.push(applyInlineMarkup(line));
    }
  });

  flushParagraph();
  closeList();
  return out.join('');
}

/**
 * Serialise data for a <script type="application/json"> block. Escapes "<" so
 * user-entered text can never close the script tag early.
 */
function jsonForScript(value) {
  return JSON.stringify(value == null ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

module.exports = { fmt12, canonicalLocal, fmtRange, fmtDay, fmtTimeRange, renderRichText, escapeHtml, jsonForScript };
