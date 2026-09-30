const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Use isolated DB per run
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volunteer-app-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const { initDatabase } = require('../../src/config/database');
initDatabase();

const dal = require('../../src/db/dal');
const publicService = require('../../src/services/publicService');

async function run() {
  // Schedule event setup
  const evRes = dal.admin.createEvent('Schedule Event', 'Test event', '2024-01-01 10:00', '2024-01-01 14:00', 'schedule');
  const eventId = evRes.lastInsertRowid;
  const stationId = dal.admin.createStation(eventId, 'Check-in', '', '').lastInsertRowid;
  const blockEarly = dal.admin.createTimeBlock(stationId, '2024-01-01 10:00', '2024-01-01 11:00', 10).lastInsertRowid;
  const blockOverlap = dal.admin.createTimeBlock(stationId, '2024-01-01 10:30', '2024-01-01 11:30', 10).lastInsertRowid;
  const blockLater = dal.admin.createTimeBlock(stationId, '2024-01-01 11:30', '2024-01-01 12:00', 10).lastInsertRowid;

  // Happy path: same participant on two non-overlapping blocks
  await publicService.processVolunteerSignup({
    eventId,
    registrant: { name: 'Alice', email: 'alice@example.com', phone: '5551234567' },
    participants: ['Alice', 'Bob'],
    scheduleAssignments: [
      { blockId: blockEarly, participantIndex: 0 },
      { blockId: blockLater, participantIndex: 0 },
      { blockId: blockOverlap, participantIndex: 1 }
    ]
  });

  // Overlap rejection for same participant
  let overlapError = null;
  try {
    await publicService.processVolunteerSignup({
      eventId,
      registrant: { name: 'Carl', email: 'carl@example.com', phone: '5551234567' },
      participants: ['Carl'],
      scheduleAssignments: [
        { blockId: blockEarly, participantIndex: 0 },
        { blockId: blockOverlap, participantIndex: 0 }
      ]
    });
  } catch (err) {
    overlapError = err;
  }
  assert(overlapError, 'Expected overlap error');
  assert.strictEqual(overlapError.status, 400);

  // Same block different participants allowed
  await publicService.processVolunteerSignup({
    eventId,
    registrant: { name: 'Dana', email: 'dana@example.com', phone: '5551234567' },
    participants: ['Dana', 'Eli'],
    scheduleAssignments: [
      { blockId: blockEarly, participantIndex: 0 },
      { blockId: blockEarly, participantIndex: 1 }
    ]
  });

  // Potluck event
  const potRes = dal.admin.createEvent('Potluck', 'Food', '2024-02-01 10:00', '2024-02-01 12:00', 'potluck');
  const potEventId = potRes.lastInsertRowid;
  const potStation = dal.admin.createStation(potEventId, 'Mains', '', '').lastInsertRowid;
  const dishA = dal.admin.createTimeBlock(potStation, '2024-02-01 10:00', '2024-02-01 10:00', 5).lastInsertRowid;
  const dishB = dal.admin.createTimeBlock(potStation, '2024-02-01 10:00', '2024-02-01 10:00', 5).lastInsertRowid;

  const potSignup = await publicService.processVolunteerSignup({
    eventId: potEventId,
    registrant: { name: 'Finn', email: 'finn@example.com', phone: '5551234567' },
    participants: ['Finn', 'Gail'],
    potluckAssignments: [
      { itemId: dishA, participantIndex: 0, dishName: 'Lasagna' },
      { itemId: dishB, participantIndex: 1, dishName: 'Salad' }
    ]
  });

  // Manage link rename collision + merge
  const manageCtx = publicService.getManageContext(potSignup.token);
  const p1 = manageCtx.participants[0].participant_id;
  const p2 = manageCtx.participants[1].participant_id;

  let collision = null;
  try {
    await publicService.renameParticipant(potSignup.token, p1, manageCtx.participants[1].participant_name);
  } catch (err) {
    collision = err;
  }
  assert(collision, 'Expected rename collision');
  assert.strictEqual(collision.status, 409);

  await publicService.mergeParticipants(potSignup.token, p2, p1);
  const afterMerge = publicService.getManageContext(potSignup.token);
  assert.strictEqual(afterMerge.participants.length, 1, 'Merge should remove source participant');

  console.log('publicService tests passed');
}

run()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
