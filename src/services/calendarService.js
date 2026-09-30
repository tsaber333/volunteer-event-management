// Calendar entries for a registration's sign-ups: an .ics file (Apple,
// Outlook, Google import) and per-entry Google Calendar links.
//
// Slot times are stored as local wall-clock text ("YYYY-MM-DD HH:mm") in the
// organisation's time zone, while the server may run in UTC, so every entry is
// converted to UTC using APP_TIMEZONE (an IANA name such as America/Vancouver).

const { fmtRange } = require('../views/helpers');

const DEFAULT_TIME_ZONE = 'America/Vancouver';
const TIME_ZONE = (() => {
  const tz = process.env.APP_TIMEZONE || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch (_) {
    console.warn(`[calendar] Unknown APP_TIMEZONE "${tz}"; using ${DEFAULT_TIME_ZONE}.`);
    return DEFAULT_TIME_ZONE;
  }
})();

const APP_BASE_URL = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const UID_HOST = (() => {
  try { return new URL(APP_BASE_URL).hostname || 'volunteer-signups'; } catch (_) { return 'volunteer-signups'; }
})();

const offsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

function zoneOffsetMs(date) {
  const p = {};
  offsetFormatter.formatToParts(date).forEach(part => { p[part.type] = part.value; });
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

// "2026-12-04 12:00" in TIME_ZONE -> Date (UTC instant).
function localToUtc(localText) {
  const m = String(localText || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let guess = wall;
  // Two passes settle the offset across DST changes.
  for (let i = 0; i < 2; i += 1) guess = wall - zoneOffsetMs(new Date(guess));
  return new Date(guess);
}

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// "2026-12-24" -> "20261225" (all-day DTEND is exclusive).
function nextDay(isoDay) {
  const [y, m, d] = isoDay.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * One entry per time slot (people sharing a slot are listed together); Food
 * Prep events get a single entry for the event with everyone's dishes.
 * `participants` is the grouped shape used by the confirmation email.
 */
function buildEntries({ event, participants, registrationId, manageUrl }) {
  if (!event) return [];
  const isPotluck = String(event.signup_mode || '').toLowerCase() === 'potluck';
  const eventUrl = `${APP_BASE_URL}/events/${event.event_id}`;
  const footer = [];
  if (manageUrl) footer.push(`See or change your sign-up: ${manageUrl}`);
  footer.push(`Event page: ${eventUrl}`);
  const uidBase = `reg${registrationId || 'x'}-ev${event.event_id}`;

  if (isPotluck) {
    const lines = [];
    (participants || []).forEach(p => (p.potluck || []).forEach(a => {
      const what = a.title || a.station_name || 'Item';
      lines.push(`${p.participant_name}: ${what}${a.dish_name ? ` (${a.dish_name})` : ''}`);
    }));
    const start = localToUtc(event.date_start);
    const end = localToUtc(event.date_end);
    if (!lines.length || !start || !end || end <= start) return [];
    // Multi-day windows become an all-day banner rather than a days-long block.
    const startDay = String(event.date_start).slice(0, 10);
    const endDay = String(event.date_end).slice(0, 10);
    const allDay = startDay !== endDay
      ? { startDate: startDay.replace(/-/g, ''), endDate: nextDay(endDay) }
      : null;
    const when = fmtRange(event.date_start, event.date_end);
    return [{
      key: 'food-prep',
      blockId: null,
      title: `Food Prep: ${event.name}`,
      start,
      end,
      allDay,
      localStart: event.date_start,
      localEnd: event.date_end,
      description: [...(when ? [`When: ${when}`, ''] : []), 'What your group is bringing:', ...lines, '', ...footer].join('\n'),
      url: manageUrl || eventUrl,
      uid: `${uidBase}-foodprep@${UID_HOST}`
    }];
  }

  const byBlock = new Map();
  (participants || []).forEach(p => (p.schedule || []).forEach(a => {
    const blockId = Number(a.time_block_id);
    if (!byBlock.has(blockId)) byBlock.set(blockId, { a, names: [] });
    byBlock.get(blockId).names.push(p.participant_name);
  }));
  return Array.from(byBlock.entries())
    .map(([blockId, { a, names }]) => ({
      key: `block-${blockId}`,
      blockId,
      title: `${a.station_name || 'Volunteering'} — ${event.name}`,
      start: localToUtc(a.start_time),
      end: localToUtc(a.end_time),
      localStart: a.start_time,
      localEnd: a.end_time,
      description: [`Volunteering: ${names.join(', ')}`, '', ...footer].join('\n'),
      url: manageUrl || eventUrl,
      uid: `${uidBase}-block${blockId}@${UID_HOST}`
    }))
    .filter(e => e.start && e.end && e.end > e.start)
    .sort((x, y) => x.start - y.start);
}

function escapeText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

// RFC 5545: lines longer than 75 octets are folded with CRLF + space.
function foldLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out = [];
  let current = '';
  for (const ch of line) {
    const limit = out.length ? 74 : 75;
    if (Buffer.byteLength(current + ch, 'utf8') > limit) {
      out.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.join('\r\n ');
}

function toIcs(entries, { calendarName, orgName } = {}) {
  const now = utcStamp(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${escapeText(orgName || 'Volunteer Sign-ups')}//Volunteer Sign-ups//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH'
  ];
  if (calendarName) lines.push(`X-WR-CALNAME:${escapeText(calendarName)}`);
  entries.forEach(e => {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${now}`,
      e.allDay ? `DTSTART;VALUE=DATE:${e.allDay.startDate}` : `DTSTART:${utcStamp(e.start)}`,
      e.allDay ? `DTEND;VALUE=DATE:${e.allDay.endDate}` : `DTEND:${utcStamp(e.end)}`,
      `SUMMARY:${escapeText(e.title)}`,
      `DESCRIPTION:${escapeText(e.description)}`
    );
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

function googleUrl(entry) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: entry.title,
    dates: entry.allDay
      ? `${entry.allDay.startDate}/${entry.allDay.endDate}`
      : `${utcStamp(entry.start)}/${utcStamp(entry.end)}`,
    details: entry.description
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function icsFilename(event) {
  const slug = String((event && event.name) || 'signup')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'signup'}.ics`;
}

// Data for the "Add to calendar" links on the thank-you and manage pages.
function buildCalendarLinks({ event, participants, registrationId, manageUrl, token, formatRange }) {
  const entries = buildEntries({ event, participants, registrationId, manageUrl });
  if (!entries.length || !token) return null;
  const icsBase = `/manage/${encodeURIComponent(token)}/calendar.ics`;
  return {
    icsUrl: icsBase,
    entries: entries.map(e => ({
      title: e.blockId ? e.title.replace(` — ${event.name}`, '') : e.title,
      when: typeof formatRange === 'function' ? formatRange(e.localStart, e.localEnd) : '',
      googleUrl: googleUrl(e),
      icsUrl: e.blockId ? `${icsBase}?block=${e.blockId}` : icsBase
    }))
  };
}

module.exports = {
  TIME_ZONE,
  localToUtc,
  buildEntries,
  toIcs,
  googleUrl,
  icsFilename,
  buildCalendarLinks
};
