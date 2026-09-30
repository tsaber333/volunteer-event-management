const assert = require('assert');

process.env.APP_TIMEZONE = 'America/Vancouver';
process.env.APP_BASE_URL = 'https://volunteer.example.org';
const calendar = require('../../src/services/calendarService');

// B.C. was UTC−8 in winter until March 2026, then stays on UTC−7 year-round
// (no fall-back on 2026-11-01), whatever time-zone data this Node build has.
const utc = local => calendar.localToUtc(local).toISOString();
assert.strictEqual(utc('2026-02-01 09:00'), '2026-02-01T17:00:00.000Z');
assert.strictEqual(utc('2026-03-08 03:30'), '2026-03-08T10:30:00.000Z');
assert.strictEqual(utc('2026-07-01 09:00'), '2026-07-01T16:00:00.000Z');
assert.strictEqual(utc('2026-11-01 01:30'), '2026-11-01T08:30:00.000Z');
assert.strictEqual(utc('2026-11-01 09:00'), '2026-11-01T16:00:00.000Z');
assert.strictEqual(utc('2026-12-24 09:00'), '2026-12-24T16:00:00.000Z');
assert.strictEqual(utc('2027-01-15 09:00'), '2027-01-15T16:00:00.000Z');
assert.strictEqual(utc('2027-07-01 09:00'), '2027-07-01T16:00:00.000Z');
assert.strictEqual(calendar.localToUtc('not a date'), null);

const event = { event_id: 7, name: 'Serve Day, Fall', signup_mode: 'schedule' };
const participants = [
  { participant_name: 'Ann', schedule: [{ time_block_id: 2, station_name: 'Kitchen', start_time: '2026-12-04 12:00', end_time: '2026-12-04 13:00' }] },
  { participant_name: 'Bo', schedule: [
    { time_block_id: 2, station_name: 'Kitchen', start_time: '2026-12-04 12:00', end_time: '2026-12-04 13:00' },
    { time_block_id: 1, station_name: 'Greeters', start_time: '2026-12-04 09:00', end_time: '2026-12-04 10:00' }
  ] }
];
const entries = calendar.buildEntries({ event, participants, registrationId: 5, manageUrl: 'https://volunteer.example.org/manage/abc' });

// One entry per slot, earliest first, with everyone in that slot named.
assert.deepStrictEqual(entries.map(e => e.blockId), [1, 2]);
assert.ok(entries[1].description.startsWith('Volunteering: Ann, Bo'));
assert.strictEqual(entries[0].uid, 'reg5-ev7-block1@volunteer.example.org');

const ics = calendar.toIcs(entries, { calendarName: event.name, orgName: 'Test Church' });
assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
assert.ok(ics.includes('DTSTART:20261204T160000Z'));
assert.ok(ics.includes('SUMMARY:Greeters — Serve Day\\, Fall'), 'commas are escaped');
ics.split('\r\n').forEach(line => {
  assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line too long: ${line}`);
});

const google = new URL(calendar.googleUrl(entries[0]));
assert.strictEqual(google.searchParams.get('dates'), '20261204T160000Z/20261204T170000Z');

// Multi-day Food Prep windows become one all-day entry (end date exclusive).
const potluck = { event_id: 8, name: 'Christmas Food Prep', signup_mode: 'potluck', date_start: '2026-12-14 09:00', date_end: '2026-12-24 12:00' };
const [prep] = calendar.buildEntries({
  event: potluck,
  participants: [{ participant_name: 'Cy', potluck: [{ title: 'Pies', dish_name: 'Apple pie' }] }],
  registrationId: 9
});
assert.deepStrictEqual(prep.allDay, { startDate: '20261214', endDate: '20261225' });
assert.ok(prep.description.includes('Cy: Pies (Apple pie)'));
assert.ok(calendar.toIcs([prep]).includes('DTEND;VALUE=DATE:20261225'));

assert.strictEqual(calendar.icsFilename({ name: 'Serve Day, Fall!' }), 'serve-day-fall.ics');

console.log('calendarService tests passed');
