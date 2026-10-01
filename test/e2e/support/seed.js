// Builds the fixture events for the browser tests. Dates are relative to
// today so the events always count as upcoming. Returns the ids the specs use.
const dal = require('../../../src/db/dal');
const publicService = require('../../../src/services/publicService');

function at(daysAhead, hhmm) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`;
}

function createEvent({ name, mode = 'schedule', start, end, allowOverlap = false }) {
  const id = Number(dal.admin.createEvent(name, `${name} (test event)`, start, end, mode).lastInsertRowid);
  if (allowOverlap) dal.admin.updateEvent(id, { allow_overlap: true });
  dal.admin.setEventPublish(id, 'published');
  return id;
}

function station(eventId, name) {
  return Number(dal.admin.createStation(eventId, name, '', '').lastInsertRowid);
}

function block(stationId, start, end, capacity) {
  return Number(dal.admin.createTimeBlock(stationId, start, end, capacity).lastInsertRowid);
}

function item(stationId, when, title, capacity) {
  const id = block(stationId, when, when, capacity);
  dal.admin.updateTimeBlock(id, { title });
  return id;
}

async function seed() {
  const day = 21;
  const ids = { events: {}, blocks: {} };

  // Main schedule event: overlapping slots are not allowed.
  const serve = createEvent({ name: 'Serve Day', start: at(day, '08:00'), end: at(day, '12:00') });
  const greeters = station(serve, 'Greeters');
  const kitchen = station(serve, 'Kitchen');
  const setup = station(serve, 'Setup');
  ids.events.serve = serve;
  ids.blocks.greeters9 = block(greeters, at(day, '09:00'), at(day, '10:00'), 20);
  ids.blocks.greeters10 = block(greeters, at(day, '10:00'), at(day, '11:00'), 20);
  ids.blocks.kitchen930 = block(kitchen, at(day, '09:30'), at(day, '10:30'), 20);
  ids.blocks.setup8 = block(setup, at(day, '08:00'), at(day, '09:00'), 20);

  // Same shape, but people may hold overlapping slots.
  const flexible = createEvent({ name: 'Flexible Day', start: at(day + 1, '08:00'), end: at(day + 1, '12:00'), allowOverlap: true });
  ids.events.flexible = flexible;
  ids.blocks.parking9 = block(station(flexible, 'Parking'), at(day + 1, '09:00'), at(day + 1, '10:00'), 10);
  ids.blocks.coffee930 = block(station(flexible, 'Coffee'), at(day + 1, '09:30'), at(day + 1, '10:30'), 10);

  const potluck = createEvent({ name: 'Potluck Lunch', mode: 'potluck', start: at(day + 2, '11:00'), end: at(day + 2, '14:00') });
  const mains = station(potluck, 'Mains');
  ids.events.potluck = potluck;
  ids.blocks.casserole = item(mains, at(day + 2, '11:00'), 'Casserole', 10);
  ids.blocks.salad = item(station(potluck, 'Salads'), at(day + 2, '11:00'), 'Green salad', 10);

  // Only read by the events-list spec, so its counts never change.
  const counts = createEvent({ name: 'Counts Check', start: at(day + 3, '09:00'), end: at(day + 3, '11:00') });
  ids.events.counts = counts;
  const countsStation = station(counts, 'Ushers');
  ids.blocks.counts9 = block(countsStation, at(day + 3, '09:00'), at(day + 3, '10:00'), 3);
  ids.blocks.counts10 = block(countsStation, at(day + 3, '10:00'), at(day + 3, '11:00'), 2);

  const filled = createEvent({ name: 'All Filled', start: at(day + 4, '09:00'), end: at(day + 4, '10:00') });
  ids.events.filled = filled;
  ids.blocks.filled9 = block(station(filled, 'Doors'), at(day + 4, '09:00'), at(day + 4, '10:00'), 1);

  // Long two-day event (22 slots): starts by day, with full spots hidden.
  const big = createEvent({ name: 'Big Weekend', start: at(day + 5, '09:00'), end: at(day + 6, '16:00') });
  ids.events.big = big;
  ids.blocks.bigParking = block(station(big, 'Parking Lead'), at(day + 5, '09:00'), at(day + 5, '12:00'), 1);
  const ushers = station(big, 'Ushers');
  const cafe = station(big, 'Cafe');
  [day + 5, day + 6].forEach((d, i) => {
    ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00'].forEach(t => {
      const end = `${String(Number(t.slice(0, 2)) + 1).padStart(2, '0')}:00`;
      const id = block(ushers, at(d, t), at(d, end), 3);
      if (i === 1 && t === '10:00') ids.blocks.bigUshersDay2 = id;
    });
    ['10:00', '11:00', '12:00', '13:00'].forEach(t => {
      block(cafe, at(d, t), at(d, `${String(Number(t.slice(0, 2)) + 1).padStart(2, '0')}:00`), 2);
    });
  });
  ids.blocks.bigSound = block(station(big, 'Sound'), at(day + 6, '13:00'), at(day + 6, '14:00'), 1);

  await publicService.processVolunteerSignup({
    eventId: big,
    registrant: { name: 'Seed Person', email: 'seed-big@example.test', phone: '' },
    participants: ['Seed Person'],
    scheduleAssignments: [{ blockId: ids.blocks.bigParking, participantIndex: 0 }]
  });
  await publicService.processVolunteerSignup({
    eventId: counts,
    registrant: { name: 'Seed Person', email: 'seed-counts@example.test', phone: '' },
    participants: ['Seed Person'],
    scheduleAssignments: [{ blockId: ids.blocks.counts9, participantIndex: 0 }]
  });
  await publicService.processVolunteerSignup({
    eventId: filled,
    registrant: { name: 'Seed Person', email: 'seed-filled@example.test', phone: '' },
    participants: ['Seed Person'],
    scheduleAssignments: [{ blockId: ids.blocks.filled9, participantIndex: 0 }]
  });

  return ids;
}

module.exports = { seed };
