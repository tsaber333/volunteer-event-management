// src/db/dal.js
// Centralised wrapper around the SQLite layer. Grouped into `admin` and
// `public` namespaces so higher tiers never have to write SQL directly.
const { db } = require('../config/database');
const createError = require('http-errors');
const crypto = require('crypto');

// Enforce referential integrity at the SQLite level.
try { db.exec('PRAGMA foreign_keys = ON;'); } catch (_) {}

// Lightweight, idempotent schema migrations to keep SQLite aligned.
// Ensure publish columns exist (idempotent)
try {
  db.prepare(`ALTER TABLE events ADD COLUMN is_published INTEGER NOT NULL DEFAULT 0`).run();
} catch (_) { /* already exists */ }
try {
  db.prepare(`ALTER TABLE events ADD COLUMN publish_state TEXT NOT NULL DEFAULT 'draft'`).run();
  // Backfill publish_state based on legacy is_published
  try { db.prepare(`UPDATE events SET publish_state = 'published' WHERE COALESCE(is_published,0) = 1`).run(); } catch (_) {}
} catch (_) { /* already exists */ }
// Event sign-up mode: 'schedule' (stations + time slots) or 'potluck' (categories + items)
try {
  db.prepare(`ALTER TABLE events ADD COLUMN signup_mode TEXT NOT NULL DEFAULT 'schedule'`).run();
} catch (_) { /* already exists */ }
// When 1, one participant may hold time slots that overlap (schedule events only).
try {
  db.prepare(`ALTER TABLE events ADD COLUMN allow_overlap INTEGER NOT NULL DEFAULT 0`).run();
} catch (_) { /* already exists */ }
// Ensure station order column exists so admins can persist manual ordering
try {
  db.prepare(`ALTER TABLE stations ADD COLUMN station_order INTEGER NOT NULL DEFAULT 0`).run();
} catch (_) { /* already exists */ }
// Ensure new station description fields exist
try {
  db.prepare(`ALTER TABLE stations ADD COLUMN description_overview TEXT`).run();
} catch (_) { /* already exists */ }
try {
  db.prepare(`ALTER TABLE stations ADD COLUMN description_tasks TEXT`).run();
} catch (_) { /* already exists */ }
// Optional label for non-time-based signups (potluck items)
try {
  db.prepare(`ALTER TABLE time_blocks ADD COLUMN title TEXT`).run();
} catch (_) { /* already exists */ }
// Optional serving size range for potluck items
try {
  db.prepare(`ALTER TABLE time_blocks ADD COLUMN servings_min INTEGER`).run();
} catch (_) { /* already exists */ }
try {
  db.prepare(`ALTER TABLE time_blocks ADD COLUMN servings_max INTEGER`).run();
} catch (_) { /* already exists */ }

// Manual ordering for items (potluck time_blocks)
try {
  db.prepare(`ALTER TABLE time_blocks ADD COLUMN item_order INTEGER NOT NULL DEFAULT 0`).run();
} catch (_) { /* already exists */ }

try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS volunteer_tokens (
      token TEXT PRIMARY KEY,
      volunteer_id INTEGER NOT NULL,
      event_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      FOREIGN KEY (volunteer_id) REFERENCES volunteers(volunteer_id) ON DELETE CASCADE,
      FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_volunteer_tokens_volunteer ON volunteer_tokens(volunteer_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_volunteer_tokens_event ON volunteer_tokens(event_id)`).run();
} catch (_) { /* already exists */ }

// Group registration tables (multi-participant)
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS registrations (
      registration_id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL,
      registrant_name TEXT NOT NULL,
      registrant_email TEXT NOT NULL,
      registrant_phone TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      manage_token_hash TEXT,
      manage_token_expires_at TEXT,
      email_opt_in INTEGER NOT NULL DEFAULT 1,
      email_opted_out_at TEXT,
      email_opt_out_reason TEXT,
      FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_registrations_event ON registrations(event_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_registrations_token ON registrations(manage_token_hash)`).run();
} catch (_) { /* already exists */ }

try { db.prepare(`ALTER TABLE registrations ADD COLUMN manage_token_hash TEXT`).run(); } catch (_) {}
try { db.prepare(`ALTER TABLE registrations ADD COLUMN manage_token_expires_at TEXT`).run(); } catch (_) {}
try { db.prepare(`ALTER TABLE registrations ADD COLUMN email_opt_in INTEGER NOT NULL DEFAULT 1`).run(); } catch (_) {}
try { db.prepare(`ALTER TABLE registrations ADD COLUMN email_opted_out_at TEXT`).run(); } catch (_) {}
try { db.prepare(`ALTER TABLE registrations ADD COLUMN email_opt_out_reason TEXT`).run(); } catch (_) {}

try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS participants (
      participant_id INTEGER PRIMARY KEY,
      registration_id INTEGER NOT NULL,
      participant_name TEXT NOT NULL,
      FOREIGN KEY (registration_id) REFERENCES registrations(registration_id) ON DELETE CASCADE
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_participants_registration ON participants(registration_id)`).run();
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_participants_reg_name ON participants(registration_id, participant_name COLLATE NOCASE)`).run();
} catch (_) { /* already exists */ }

try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS schedule_assignments (
      assignment_id INTEGER PRIMARY KEY,
      participant_id INTEGER NOT NULL,
      time_block_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES participants(participant_id) ON DELETE CASCADE,
      FOREIGN KEY (time_block_id) REFERENCES time_blocks(block_id) ON DELETE CASCADE
    )
  `).run();
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_schedule_assignments_unique ON schedule_assignments(participant_id, time_block_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_schedule_assignments_block ON schedule_assignments(time_block_id)`).run();
} catch (_) { /* already exists */ }

try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS potluck_assignments (
      assignment_id INTEGER PRIMARY KEY,
      participant_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      dish_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (participant_id) REFERENCES participants(participant_id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES time_blocks(block_id) ON DELETE CASCADE
    )
  `).run();
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_potluck_assignments_unique ON potluck_assignments(participant_id, item_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_potluck_assignments_item ON potluck_assignments(item_id)`).run();
} catch (_) { /* already exists */ }

// Optional notes on reservations (e.g., potluck dish names)
try {
  db.prepare(`ALTER TABLE reservations ADD COLUMN note TEXT`).run();
} catch (_) { /* already exists */ }

// Track email consent/unsubscribe state for CASL compliance
try {
  db.prepare(`ALTER TABLE volunteers ADD COLUMN email_opt_in INTEGER NOT NULL DEFAULT 1`).run();
} catch (_) { /* already exists */ }
try {
  db.prepare(`ALTER TABLE volunteers ADD COLUMN email_opted_out_at TEXT`).run();
} catch (_) { /* already exists */ }
try {
  db.prepare(`ALTER TABLE volunteers ADD COLUMN email_opt_out_reason TEXT`).run();
} catch (_) { /* already exists */ }

/**
 * Convert the better-sqlite3 metadata into a simpler object that callers can
 * rely on. This keeps service code tidy and testable.
 */
function mapRun(res) {
  return { changes: res.changes, lastInsertRowid: res.lastInsertRowid };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function cleanupExpiredTokens() {
  try {
    db.prepare(`DELETE FROM volunteer_tokens WHERE expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')`).run();
  } catch (_) { /* best effort */ }
}

function migrateLegacyReservationsToRegistrations() {
  try {
    const regCountRow = db.prepare(`SELECT COUNT(*) AS c FROM registrations`).get();
    const schedCountRow = db.prepare(`SELECT COUNT(*) AS c FROM schedule_assignments`).get();
    const potCountRow = db.prepare(`SELECT COUNT(*) AS c FROM potluck_assignments`).get();
    const legacyCountRow = db.prepare(`SELECT COUNT(*) AS c FROM reservations`).get();
    const regCount = (regCountRow && regCountRow.c) || 0;
    const schedCount = (schedCountRow && schedCountRow.c) || 0;
    const potCount = (potCountRow && potCountRow.c) || 0;
    const legacyCount = (legacyCountRow && legacyCountRow.c) || 0;
    if ((regCount > 0 || schedCount > 0 || potCount > 0) || legacyCount === 0) {
      return;
    }

    const eventModes = new Map();
    db.prepare(`SELECT event_id, COALESCE(signup_mode, 'schedule') AS signup_mode FROM events`).all()
      .forEach(row => eventModes.set(row.event_id, row.signup_mode || 'schedule'));

    const tokens = db.prepare(`
      SELECT volunteer_id, event_id, token, expires_at, created_at
      FROM volunteer_tokens
      ORDER BY datetime(created_at) DESC
    `).all();
    const tokenMap = new Map();
    tokens.forEach(t => {
      const key = `${t.volunteer_id}:${t.event_id}`;
      if (!tokenMap.has(key)) tokenMap.set(key, t);
    });

    const legacyRows = db.prepare(`
      SELECT
        r.reservation_id,
        r.block_id,
        r.note,
        v.volunteer_id,
        v.name AS volunteer_name,
        v.email AS volunteer_email,
        v.phone_number,
        COALESCE(v.email_opt_in, 1) AS email_opt_in,
        v.email_opted_out_at,
        v.email_opt_out_reason,
        s.event_id
      FROM reservations r
      JOIN volunteers v ON v.volunteer_id = r.volunteer_id
      JOIN time_blocks tb ON tb.block_id = r.block_id
      JOIN stations s ON s.station_id = tb.station_id
    `).all();

    if (!legacyRows.length) return;

    const tx = db.transaction((rows) => {
      const regMap = new Map(); // `${volunteerId}:${eventId}` -> registration_id
      const participantMap = new Map(); // registration_id -> participant_id
      rows.forEach(row => {
        const regKey = `${row.volunteer_id}:${row.event_id}`;
        let registrationId = regMap.get(regKey);
        if (!registrationId) {
          const tokenRow = tokenMap.get(regKey);
          const res = db.prepare(`
            INSERT INTO registrations (
              event_id, registrant_name, registrant_email, registrant_phone,
              created_at, manage_token_hash, manage_token_expires_at,
              email_opt_in, email_opted_out_at, email_opt_out_reason
            )
            VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)
          `).run(
            row.event_id,
            row.volunteer_name || row.volunteer_email || 'Volunteer',
            row.volunteer_email || `legacy-${row.volunteer_id || 'unknown'}@example.com`,
            row.phone_number || null,
            tokenRow ? tokenRow.token : null,
            tokenRow ? tokenRow.expires_at : null,
            row.email_opt_in != null ? row.email_opt_in : 1,
            row.email_opted_out_at || null,
            row.email_opt_out_reason || null
          );
          registrationId = res.lastInsertRowid;
          regMap.set(regKey, registrationId);
        }

        let participantId = participantMap.get(registrationId);
        if (!participantId) {
          const partRes = db.prepare(`
            INSERT INTO participants (registration_id, participant_name)
            VALUES (?, ?)
          `).run(registrationId, row.volunteer_name || row.volunteer_email || 'Participant');
          participantId = partRes.lastInsertRowid;
          participantMap.set(registrationId, participantId);
        }

        const mode = (eventModes.get(row.event_id) || 'schedule').toLowerCase();
        if (mode === 'potluck') {
          db.prepare(`
            INSERT OR IGNORE INTO potluck_assignments (participant_id, item_id, dish_name)
            VALUES (?, ?, ?)
          `).run(participantId, row.block_id, (row.note && row.note.trim()) ? row.note.trim() : null);
        } else {
          db.prepare(`
            INSERT OR IGNORE INTO schedule_assignments (participant_id, time_block_id)
            VALUES (?, ?)
          `).run(participantId, row.block_id);
        }
      });
    });

    tx(legacyRows);
  } catch (err) {
    console.warn('[DAL] Legacy reservation migration skipped due to error:', err && err.message);
  }
}

migrateLegacyReservationsToRegistrations();

// ---------- Admin DAL ----------
const admin = {
  // List every event for the admin dashboard, including publish state.
  getAllEvents: () => {
    return db.prepare(`
      SELECT event_id, name, description, date_start, date_end,
             COALESCE(is_published, 0) AS is_published,
             COALESCE(publish_state, CASE WHEN COALESCE(is_published,0)=1 THEN 'published' ELSE 'draft' END) AS publish_state,
             COALESCE(signup_mode, 'schedule') AS signup_mode
      FROM events
      ORDER BY datetime(date_start) DESC
    `).all();
  },

  // Expand a single event record with any stations/time blocks that belong to it.
  getEventById: (id) => {
    return db.prepare(`
      SELECT
        e.event_id, e.name, e.description, e.date_start, e.date_end,
        COALESCE(e.signup_mode, 'schedule') AS signup_mode,
        COALESCE(e.allow_overlap, 0) AS allow_overlap,
        COALESCE(e.is_published, 0) AS is_published,
        COALESCE(e.publish_state, CASE WHEN COALESCE(e.is_published,0)=1 THEN 'published' ELSE 'draft' END) AS publish_state,
        s.station_id,
        s.name AS station_name,
        s.description AS station_description,
        s.description_overview AS station_description_overview,
        s.description_tasks AS station_description_tasks,
        tb.block_id, tb.start_time, tb.end_time, tb.capacity_needed, tb.title, tb.servings_min, tb.servings_max, tb.item_order,
        COALESCE(
          CASE WHEN COALESCE(e.signup_mode, 'schedule') = 'potluck' THEN rpot.cnt ELSE rsched.cnt END,
          0
        ) AS reserved_count,
        CASE
          WHEN COALESCE(e.signup_mode, 'schedule') = 'potluck'
            THEN CASE WHEN COALESCE(rpot.cnt, 0) >= tb.capacity_needed THEN 1 ELSE 0 END
          ELSE CASE WHEN COALESCE(rsched.cnt, 0) >= tb.capacity_needed THEN 1 ELSE 0 END
        END AS is_full,
        COALESCE(rn.notes_csv, '') AS notes_csv,
        COALESCE(rn.notes_with_names_csv, '') AS notes_with_names_csv
      FROM events e
      LEFT JOIN stations s ON s.event_id = e.event_id
      LEFT JOIN time_blocks tb ON tb.station_id = s.station_id
      LEFT JOIN (
        SELECT time_block_id AS block_id, COUNT(*) AS cnt
        FROM schedule_assignments
        GROUP BY time_block_id
      ) rsched ON rsched.block_id = tb.block_id
      LEFT JOIN (
        SELECT item_id AS block_id, COUNT(*) AS cnt
        FROM potluck_assignments
        GROUP BY item_id
      ) rpot ON rpot.block_id = tb.block_id
      LEFT JOIN (
        SELECT pa.item_id AS block_id,
               GROUP_CONCAT(TRIM(pa.dish_name), '||') AS notes_csv,
               GROUP_CONCAT(TRIM(pa.dish_name) || '::' || TRIM(p.participant_name), '||') AS notes_with_names_csv
        FROM potluck_assignments pa
        JOIN participants p ON p.participant_id = pa.participant_id
        WHERE pa.dish_name IS NOT NULL AND TRIM(pa.dish_name) <> ''
        GROUP BY pa.item_id
      ) rn ON rn.block_id = tb.block_id
      WHERE e.event_id = ?
      -- Prefer explicit station_order when present; for potluck use item_order, otherwise chronological.
      ORDER BY
        COALESCE(s.station_order, 0),
        CASE
          WHEN COALESCE(e.signup_mode, 'schedule') = 'potluck'
            THEN COALESCE(tb.item_order, 0)
          ELSE datetime(tb.start_time)
        END,
        tb.block_id ASC
    `).all(id);
  },

  // Fetch one station alongside its blocks for edit forms and API responses.
  getStationWithBlocks: (id) => {
    return db.prepare(`
      SELECT
        s.station_id,
        s.event_id,
        s.name AS station_name,
        s.description AS station_description,
        s.description_overview AS station_description_overview,
        s.description_tasks AS station_description_tasks,
        tb.block_id, tb.start_time, tb.end_time, tb.capacity_needed, tb.title, tb.servings_min, tb.servings_max, tb.item_order,
        COALESCE(
          CASE WHEN COALESCE(e.signup_mode, 'schedule') = 'potluck' THEN rpot.cnt ELSE rsched.cnt END,
          0
        ) AS reserved_count,
        CASE
          WHEN COALESCE(e.signup_mode, 'schedule') = 'potluck'
            THEN CASE WHEN COALESCE(rpot.cnt, 0) >= tb.capacity_needed THEN 1 ELSE 0 END
          ELSE CASE WHEN COALESCE(rsched.cnt, 0) >= tb.capacity_needed THEN 1 ELSE 0 END
        END AS is_full
      FROM stations s
      JOIN events e ON e.event_id = s.event_id
      LEFT JOIN time_blocks tb ON tb.station_id = s.station_id
      LEFT JOIN (
        SELECT time_block_id AS block_id, COUNT(*) AS cnt
        FROM schedule_assignments
        GROUP BY time_block_id
      ) rsched ON rsched.block_id = tb.block_id
      LEFT JOIN (
        SELECT item_id AS block_id, COUNT(*) AS cnt
        FROM potluck_assignments
        GROUP BY item_id
      ) rpot ON rpot.block_id = tb.block_id
      WHERE s.station_id = ?
      ORDER BY datetime(tb.start_time) ASC
    `).all(id);
  },

  // Pull back every reservation for an event so the admin UI can display rosters.
  getEventReservations: (eventId) => {
    const modeRow = db.prepare(`SELECT COALESCE(signup_mode, 'schedule') AS signup_mode FROM events WHERE event_id = ?`).get(eventId);
    const isPotluck = modeRow && String(modeRow.signup_mode).toLowerCase() === 'potluck';
    if (isPotluck) {
      return db.prepare(`
        SELECT
          pa.assignment_id AS reservation_id,
        pa.item_id AS block_id,
        p.participant_id AS volunteer_id,
        p.participant_name AS volunteer_name,
        r.registration_id,
        r.registrant_name,
        r.registrant_email AS volunteer_email,
        r.registrant_email AS registrant_email,
        r.registrant_phone AS volunteer_phone,
        pa.created_at AS reservation_date,
        pa.dish_name AS reservation_note
      FROM potluck_assignments pa
      JOIN participants p ON p.participant_id = pa.participant_id
      JOIN registrations r ON r.registration_id = p.registration_id
        JOIN time_blocks tb ON tb.block_id = pa.item_id
        JOIN stations s ON s.station_id = tb.station_id
        WHERE s.event_id = ?
        ORDER BY datetime(pa.created_at) ASC
      `).all(eventId);
    }
    return db.prepare(`
      SELECT
        sa.assignment_id AS reservation_id,
        sa.time_block_id AS block_id,
        p.participant_id AS volunteer_id,
        p.participant_name AS volunteer_name,
        r.registration_id,
        r.registrant_name,
        r.registrant_email AS volunteer_email,
        r.registrant_email AS registrant_email,
        r.registrant_phone AS volunteer_phone,
        sa.created_at AS reservation_date,
        NULL AS reservation_note
      FROM schedule_assignments sa
      JOIN participants p ON p.participant_id = sa.participant_id
      JOIN registrations r ON r.registration_id = p.registration_id
      JOIN time_blocks tb ON tb.block_id = sa.time_block_id
      JOIN stations s ON s.station_id = tb.station_id
      WHERE s.event_id = ?
      ORDER BY datetime(tb.start_time) ASC, datetime(sa.created_at) ASC
    `).all(eventId);
  },

  // Read a reservation plus volunteer record for edit/move flows.
  getReservationById: (reservationId) => {
    const sched = db.prepare(`
      SELECT
        sa.assignment_id AS reservation_id,
        sa.time_block_id AS block_id,
        p.participant_id AS volunteer_id,
        p.participant_name AS volunteer_name,
        r.registration_id,
        r.registrant_email AS volunteer_email,
        r.registrant_phone AS volunteer_phone,
        tb.station_id,
        tb.start_time,
        tb.end_time,
        tb.capacity_needed,
        NULL AS reservation_note,
        'schedule' AS assignment_type
      FROM schedule_assignments sa
      JOIN participants p ON p.participant_id = sa.participant_id
      JOIN registrations r ON r.registration_id = p.registration_id
      JOIN time_blocks tb ON tb.block_id = sa.time_block_id
      WHERE sa.assignment_id = ?
    `).get(reservationId);
    if (sched) return sched;
    return db.prepare(`
      SELECT
        pa.assignment_id AS reservation_id,
        pa.item_id AS block_id,
        p.participant_id AS volunteer_id,
        p.participant_name AS volunteer_name,
        r.registration_id,
        r.registrant_email AS volunteer_email,
        r.registrant_phone AS volunteer_phone,
        tb.station_id,
        tb.start_time,
        tb.end_time,
        tb.capacity_needed,
        pa.dish_name AS reservation_note,
        'potluck' AS assignment_type
      FROM potluck_assignments pa
      JOIN participants p ON p.participant_id = pa.participant_id
      JOIN registrations r ON r.registration_id = p.registration_id
      JOIN time_blocks tb ON tb.block_id = pa.item_id
      WHERE pa.assignment_id = ?
    `).get(reservationId);
  },

  // Update the volunteer table when admins change contact details.
  updateVolunteer: (volunteerId, name, email, phone) => {
    try {
      const res = db.prepare(`
        UPDATE volunteers
        SET name = ?, email = ?, phone_number = ?
        WHERE volunteer_id = ?
      `).run(name, email, phone, volunteerId);
      return mapRun(res);
    } catch (e) {
      throw createError(500, 'DB error updating volunteer: ' + e.message);
    }
  },

  // Update participant name and optionally update registrant contact details.
  updateParticipantContact: (participantId, name, registrant) => {
    const tx = db.transaction((pid, n, reg) => {
      const row = db.prepare(`SELECT registration_id FROM participants WHERE participant_id = ?`).get(pid);
      if (!row) throw createError(404, 'Participant not found.');
      db.prepare(`UPDATE participants SET participant_name = ? WHERE participant_id = ?`).run(n, pid);
      if (reg && (reg.name || reg.email || reg.phone !== undefined)) {
        db.prepare(`
          UPDATE registrations
          SET registrant_name = COALESCE(?, registrant_name),
              registrant_email = COALESCE(?, registrant_email),
              registrant_phone = COALESCE(?, registrant_phone)
          WHERE registration_id = ?
        `).run(reg.name, reg.email, reg.phone || null, row.registration_id);
      }
      return true;
    });
    return tx(participantId, name, registrant);
  },

  // Update the note associated with a reservation (potluck dish names).
  updateReservationNote: (reservationId, note) => {
    try {
      const cleaned = (note == null || note === '') ? null : note;
      const resPotluck = db.prepare(`
        UPDATE potluck_assignments
        SET dish_name = ?
        WHERE assignment_id = ?
      `).run(cleaned, reservationId);
      if (resPotluck.changes > 0) return mapRun(resPotluck);
      const resSched = db.prepare(`
        UPDATE schedule_assignments
        SET /* no-op to keep API parity */ time_block_id = time_block_id
        WHERE assignment_id = ?
      `).run(reservationId);
      return mapRun(resSched);
    } catch (e) {
      throw createError(500, 'DB error updating reservation note: ' + e.message);
    }
  },

  // Remove a volunteer reservation from a time block.
  deleteReservation: (reservationId) => {
    try {
      const res = db.prepare(`DELETE FROM schedule_assignments WHERE assignment_id = ?`).run(reservationId);
      if (res.changes > 0) return mapRun(res);
      const res2 = db.prepare(`DELETE FROM potluck_assignments WHERE assignment_id = ?`).run(reservationId);
      return mapRun(res);
    } catch (e) {
      throw createError(500, 'DB error deleting reservation: ' + e.message);
    }
  },

  // Atomically move a reservation to a new block while enforcing capacity & duplicate rules.
  moveReservation: (reservationId, newBlockId) => {
    const tx = db.transaction((rid, blockId) => {
      const reservation = db.prepare(`
        SELECT sa.assignment_id, sa.time_block_id, sa.participant_id
        FROM schedule_assignments sa
        WHERE sa.assignment_id = ?
      `).get(rid);
      if (!reservation) throw createError(404, 'Reservation not found.');

      if (reservation.time_block_id === blockId) return { changes: 0 };

      const targetBlock = db.prepare(`SELECT capacity_needed FROM time_blocks WHERE block_id = ?`).get(blockId);
      if (!targetBlock) throw createError(404, 'Target time block not found.');

      const currentCountRow = db.prepare(`SELECT COUNT(*) AS cnt FROM reservations WHERE block_id = ?`).get(blockId);
      const currentCount = (currentCountRow && currentCountRow.cnt) || 0; // legacy fallback
      const newCountRow = db.prepare(`SELECT COUNT(*) AS cnt FROM schedule_assignments WHERE time_block_id = ?`).get(blockId);
      const newCount = (newCountRow && newCountRow.cnt) || 0;
      const effectiveCount = Math.max(currentCount, newCount);
      if (effectiveCount >= Number(targetBlock.capacity_needed)) {
        throw createError(409, 'Target time block is already full.');
      }

      const duplicate = db.prepare(`SELECT 1 FROM schedule_assignments WHERE participant_id = ? AND time_block_id = ?`).get(reservation.participant_id, blockId);
      if (duplicate) {
        throw createError(409, 'Volunteer already assigned to the selected time block.');
      }

      if (effectiveCount >= Number(targetBlock.capacity_needed)) {
        throw createError(409, 'Target time block is already full.');
      }

      db.prepare(`UPDATE schedule_assignments SET time_block_id = ?, created_at = datetime('now') WHERE assignment_id = ?`).run(blockId, rid);
      return { changes: 1 };
    });

    return tx(reservationId, newBlockId);
  },

  // Create
  createEvent: (name, description, startTxt, endTxt, signupMode) => {
    try {
      const res = db.prepare(`
        INSERT INTO events (name, description, date_start, date_end, is_published, publish_state, signup_mode)
        VALUES (?, ?, ?, ?, 0, 'draft', COALESCE(?, 'schedule'))
      `).run(name, description, startTxt, endTxt, signupMode || 'schedule');
      return mapRun(res);
    } catch (e) {
      throw createError(500, 'DB error creating event: ' + e.message);
    }
  },

  // Insert a station and auto-increment the display order for the parent event.
  createStation: (eventId, name, overview, tasks) => {
    try {
      const combinedDescription = [overview, tasks].filter(Boolean).join('\n\n');
      const res = db.prepare(`
        INSERT INTO stations (event_id, name, description, description_overview, description_tasks, station_order)
        VALUES (
          ?, ?, ?, ?, ?,
          COALESCE((SELECT MAX(station_order) FROM stations WHERE event_id = ?), -1) + 1
        )
      `).run(eventId, name, combinedDescription, overview || null, tasks || null, eventId);
      return mapRun(res);
    } catch (e) {
      throw createError(500, 'DB error creating station: ' + e.message);
    }
  },

  // Add a time block with the requested capacity under a station.
  createTimeBlock: (stationId, startTxt, endTxt, capacity) => {
    try {
      const res = db.prepare(`
        INSERT INTO time_blocks (station_id, start_time, end_time, capacity_needed, item_order)
        VALUES (
          ?, ?, ?, ?,
          COALESCE((SELECT MAX(item_order) FROM time_blocks WHERE station_id = ?), -1) + 1
        )
      `).run(stationId, startTxt, endTxt, capacity, stationId);
      return mapRun(res);
    } catch (e) {
      throw createError(500, 'DB error creating time block: ' + e.message);
    }
  },

  // Update
  // Apply a partial update to an event record.
  updateEvent: (eventId, patch) => {
    const fields = [];
    const values = [];
    if (patch.name !== undefined) { fields.push(`name = ?`); values.push(patch.name); }
    if (patch.description !== undefined) { fields.push(`description = ?`); values.push(patch.description); }
    if (patch.date_start !== undefined) { fields.push(`date_start = ?`); values.push(patch.date_start); }
    if (patch.date_end !== undefined) { fields.push(`date_end = ?`); values.push(patch.date_end); }
    if (patch.signup_mode !== undefined) { fields.push(`signup_mode = ?`); values.push(patch.signup_mode); }
    if (patch.allow_overlap !== undefined) { fields.push(`allow_overlap = ?`); values.push(patch.allow_overlap ? 1 : 0); }
    if (fields.length === 0) return { changes: 0, lastInsertRowid: 0 };
    values.push(eventId);
    try {
      const res = db.prepare(`UPDATE events SET ${fields.join(', ')} WHERE event_id = ?`).run(values);
      return mapRun(res);
    } catch (e) {
      throw createError(500, 'DB error updating event: ' + e.message);
    }
  },

  // Toggle whether an event is visible to the public sign-up page.
  setEventPublish: (eventId, state) => {
    try {
      const normalized = String(state);
      let publishState = 'draft';
      if (normalized === 'private') publishState = 'private';
      else if (normalized === 'published' || normalized === 'public' || state === true || state === 1 || state === '1') {
        publishState = 'published';
      } else if (state === false || state === 0 || state === '0') {
        publishState = 'draft';
      }
      const isPublished = publishState !== 'draft' ? 1 : 0;
      const res = db.prepare(`UPDATE events SET is_published = ?, publish_state = ? WHERE event_id = ?`)
        .run(isPublished, publishState, eventId);
      return mapRun(res);
    } catch (e) {
      throw createError(500, 'DB error setting publish: ' + e.message);
    }
  },

  // deprecated: setEventState removed (use setEventPublish)

  // Persist edits to a station's descriptive fields.
  updateStation: (stationId, name, overview, tasks) => {
    try {
      const combinedDescription = [overview, tasks].filter(Boolean).join('\n\n');
      const res = db.prepare(`
        UPDATE stations
        SET name = ?, description = ?, description_overview = ?, description_tasks = ?
        WHERE station_id = ?
      `).run(name, combinedDescription, overview || null, tasks || null, stationId);
      return mapRun(res);
    } catch (e) {
      throw createError(500, 'DB error updating station: ' + e.message);
    }
  },

  // Apply a partial update to a time block entry.
  updateTimeBlock: (blockId, patch) => {
    const fields = [];
    const values = [];
    if (patch.start_time !== undefined) { fields.push(`start_time = ?`); values.push(patch.start_time); }
    if (patch.end_time !== undefined) { fields.push(`end_time = ?`); values.push(patch.end_time); }
    if (patch.capacity_needed !== undefined) { fields.push(`capacity_needed = ?`); values.push(patch.capacity_needed); }
    if (patch.title !== undefined) { fields.push(`title = ?`); values.push(patch.title); }
    if (patch.servings_min !== undefined) { fields.push(`servings_min = ?`); values.push(patch.servings_min); }
    if (patch.servings_max !== undefined) { fields.push(`servings_max = ?`); values.push(patch.servings_max); }
    if (fields.length === 0) return { changes: 0, lastInsertRowid: 0 };
    values.push(blockId);
    try {
      const res = db.prepare(`UPDATE time_blocks SET ${fields.join(', ')} WHERE block_id = ?`).run(values);
      return mapRun(res);
    } catch (e) {
      throw createError(500, 'DB error updating time block: ' + e.message);
    }
  },

  // Delete
  // Cascade-delete an event, removing dependent stations, blocks, and reservations.
  deleteEvent: (id) => {
    try {
      const txn = db.transaction((eventId) => {
        db.prepare(`
          DELETE FROM reservations
          WHERE block_id IN (
            SELECT block_id FROM time_blocks
            WHERE station_id IN (SELECT station_id FROM stations WHERE event_id = ?)
          )
        `).run(eventId);
        db.prepare(`
          DELETE FROM time_blocks
          WHERE station_id IN (SELECT station_id FROM stations WHERE event_id = ?)
        `).run(eventId);
        db.prepare(`DELETE FROM stations WHERE event_id = ?`).run(eventId);
        const res = db.prepare(`DELETE FROM events WHERE event_id = ?`).run(eventId);
        return res;
      });
      const res = txn(id);
      return mapRun(res);
    } catch (e) {
      throw createError(500, 'DB error deleting event: ' + e.message);
    }
  },

  // Delete a station and its blocks/reservations via a transaction.
  deleteStation: (id) => {
    try {
      const txn = db.transaction((stationId) => {
        db.prepare(`DELETE FROM reservations WHERE block_id IN (SELECT block_id FROM time_blocks WHERE station_id = ?)`).run(stationId);
        db.prepare(`DELETE FROM time_blocks WHERE station_id = ?`).run(stationId);
        const res = db.prepare(`DELETE FROM stations WHERE station_id = ?`).run(stationId);
        return res;
      });
      const res = txn(id);
      return mapRun(res);
    } catch (e) {
      throw createError(500, 'DB error deleting station: ' + e.message);
    }
  },

  // Delete a single time block and any attached reservations.
  deleteTimeBlock: (blockId) => {
    try {
      const txn = db.transaction((bid) => {
        db.prepare(`DELETE FROM reservations WHERE block_id = ?`).run(bid);
        const res = db.prepare(`DELETE FROM time_blocks WHERE block_id = ?`).run(bid);
        return res;
      });
      const res = txn(blockId);
      return mapRun(res);
    } catch (e) {
      throw createError(500, 'DB error deleting time block: ' + e.message);
    }
  },
  // Update station ordering for an event. Accepts array of { station_id, station_order }
  updateStationsOrder: (pairs) => {
    try {
      const tx = db.transaction((list) => {
        const stmt = db.prepare(`UPDATE stations SET station_order = ? WHERE station_id = ?`);
        for (const p of list) {
          stmt.run(p.station_order, p.station_id);
        }
        return { changes: list.length };
      });
      return tx(pairs);
    } catch (e) {
      throw createError(500, 'DB error updating station order: ' + e.message);
    }
  },
  // Update item ordering within a station. Accepts array of { block_id, item_order }
  updateBlocksOrder: (pairs) => {
    try {
      const tx = db.transaction((list) => {
        const stmt = db.prepare(`UPDATE time_blocks SET item_order = ? WHERE block_id = ?`);
        for (const p of list) {
          stmt.run(p.item_order, p.block_id);
        }
        return { changes: list.length };
      });
      return tx(pairs);
    } catch (e) {
      throw createError(500, 'DB error updating block order: ' + e.message);
    }
  },
};

// ---------- Public DAL ----------
const publicDal = {
  // Helper: get basic info for specific block IDs
  getBlocksInfo: (blockIds) => {
    const ids = Array.from(new Set((Array.isArray(blockIds) ? blockIds : [blockIds]).map(Number).filter(Number.isFinite)));
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`
      SELECT
        tb.block_id,
        tb.title,
        tb.start_time,
        tb.end_time,
        tb.capacity_needed,
        s.event_id,
        s.station_id,
        s.name AS station_name,
        COALESCE(e.signup_mode, 'schedule') AS signup_mode,
        COALESCE(e.allow_overlap, 0) AS allow_overlap
      FROM time_blocks tb
      JOIN stations s ON s.station_id = tb.station_id
      JOIN events e ON e.event_id = s.event_id
      WHERE tb.block_id IN (${placeholders})
    `).all(ids);
  },

  getAssignmentsForBlock: (blockId) => {
    const bid = Number(blockId);
    if (!Number.isFinite(bid)) return [];
    return db.prepare(`
      SELECT sa.assignment_id, sa.time_block_id, sa.participant_id,
             p.registration_id, p.participant_name,
             r.registrant_email, s.event_id
      FROM schedule_assignments sa
      JOIN participants p ON p.participant_id = sa.participant_id
      JOIN registrations r ON r.registration_id = p.registration_id
      JOIN time_blocks tb ON tb.block_id = sa.time_block_id
      JOIN stations s ON s.station_id = tb.station_id
      WHERE sa.time_block_id = ?
    `).all(bid);
  },
  // Only published events are listed publicly
  // Includes spot totals so the list can show how much help is still needed.
  listUpcomingEvents: () => {
    return db.prepare(`
      SELECT e.event_id, e.name, e.description, e.date_start, e.date_end,
             COALESCE(e.signup_mode, 'schedule') AS signup_mode,
             COALESCE(spots.total_spots, 0) AS total_spots,
             COALESCE(spots.filled_spots, 0) AS filled_spots
      FROM events e
      LEFT JOIN (
        SELECT s.event_id,
               SUM(COALESCE(tb.capacity_needed, 0)) AS total_spots,
               SUM(MIN(COALESCE(tb.capacity_needed, 0), COALESCE(
                 CASE WHEN COALESCE(ev.signup_mode, 'schedule') = 'potluck' THEN rpot.cnt ELSE rsched.cnt END, 0
               ))) AS filled_spots
        FROM time_blocks tb
        JOIN stations s ON s.station_id = tb.station_id
        JOIN events ev ON ev.event_id = s.event_id
        LEFT JOIN (
          SELECT time_block_id AS block_id, COUNT(*) AS cnt FROM schedule_assignments GROUP BY time_block_id
        ) rsched ON rsched.block_id = tb.block_id
        LEFT JOIN (
          SELECT item_id AS block_id, COUNT(*) AS cnt FROM potluck_assignments GROUP BY item_id
        ) rpot ON rpot.block_id = tb.block_id
        GROUP BY s.event_id
      ) spots ON spots.event_id = e.event_id
      WHERE COALESCE(e.publish_state, CASE WHEN COALESCE(e.is_published,0)=1 THEN 'published' ELSE 'draft' END) = 'published'
        AND datetime(e.date_end) >= datetime('now')
      ORDER BY datetime(e.date_start) ASC
    `).all();
  },

  // Minimal event lookup used when building volunteer dashboards.
  getEventBasic: (eventId) => {
    return db.prepare(`
      SELECT event_id, name, description, date_start, date_end,
             COALESCE(is_published, 0) AS is_published,
             COALESCE(signup_mode, 'schedule') AS signup_mode,
             COALESCE(allow_overlap, 0) AS allow_overlap
      FROM events
      WHERE event_id = ?
    `).get(eventId);
  },

  // Full event detail (stations + blocks) for the public signup page.
  getEventForPublic: (eventId) => {
    return db.prepare(`
      SELECT
        e.event_id, e.name, e.description, e.date_start, e.date_end,
        COALESCE(e.signup_mode, 'schedule') AS signup_mode,
        COALESCE(e.allow_overlap, 0) AS allow_overlap,
        s.station_id,
        s.name AS station_name,
        s.description AS station_description,
        s.description_overview AS station_description_overview,
        s.description_tasks AS station_description_tasks,
        tb.block_id, tb.start_time, tb.end_time, tb.capacity_needed, tb.title, tb.servings_min, tb.servings_max, tb.item_order,
        COALESCE(
          CASE WHEN COALESCE(e.signup_mode, 'schedule') = 'potluck' THEN rpot.cnt ELSE rsched.cnt END,
          0
        ) AS reserved_count,
        CASE
          WHEN COALESCE(e.signup_mode, 'schedule') = 'potluck'
            THEN CASE WHEN COALESCE(rpot.cnt, 0) >= tb.capacity_needed THEN 1 ELSE 0 END
          ELSE CASE WHEN COALESCE(rsched.cnt, 0) >= tb.capacity_needed THEN 1 ELSE 0 END
        END AS is_full,
        COALESCE(rn.notes_csv, '') AS notes_csv,
        COALESCE(rn.notes_with_names_csv, '') AS notes_with_names_csv
      FROM events e
      LEFT JOIN stations s ON s.event_id = e.event_id
      LEFT JOIN time_blocks tb ON tb.station_id = s.station_id
      LEFT JOIN (
        SELECT time_block_id AS block_id, COUNT(*) AS cnt
        FROM schedule_assignments
        GROUP BY time_block_id
      ) rsched ON rsched.block_id = tb.block_id
      LEFT JOIN (
        SELECT item_id AS block_id, COUNT(*) AS cnt
        FROM potluck_assignments
        GROUP BY item_id
      ) rpot ON rpot.block_id = tb.block_id
      LEFT JOIN (
        SELECT pa.item_id AS block_id,
               GROUP_CONCAT(TRIM(pa.dish_name), '||') AS notes_csv,
               GROUP_CONCAT(TRIM(pa.dish_name) || '::' || TRIM(p.participant_name), '||') AS notes_with_names_csv
        FROM potluck_assignments pa
        JOIN participants p ON p.participant_id = pa.participant_id
        WHERE pa.dish_name IS NOT NULL AND TRIM(pa.dish_name) <> ''
        GROUP BY pa.item_id
      ) rn ON rn.block_id = tb.block_id
      WHERE e.event_id = ?
        AND COALESCE(e.publish_state, CASE WHEN COALESCE(e.is_published,0)=1 THEN 'published' ELSE 'draft' END) IN ('published', 'private')
      ORDER BY
        COALESCE(s.station_order, 0),
        CASE
          WHEN COALESCE(e.signup_mode, 'schedule') = 'potluck'
            THEN COALESCE(tb.item_order, 0)
          ELSE datetime(tb.start_time)
        END,
        tb.block_id ASC
    `).all(eventId);
  },

  // For potluck display: fetch dish notes paired with volunteer names for an event.
  getDishNotesWithNamesForEvent: (eventId) => {
    return db.prepare(`
      SELECT tb.block_id, TRIM(pa.dish_name) AS note, TRIM(p.participant_name) AS name
      FROM potluck_assignments pa
      JOIN participants p ON p.participant_id = pa.participant_id
      JOIN time_blocks tb ON tb.block_id = pa.item_id
      JOIN stations s ON s.station_id = tb.station_id
      WHERE s.event_id = ?
        AND pa.dish_name IS NOT NULL AND TRIM(pa.dish_name) <> ''
    `).all(eventId);
  },

  // Convenience helpers around volunteers and reservations -------------------
  getVolunteerByEmail: (email) => {
    // Try exact match first
    const exact = db.prepare(`SELECT * FROM volunteers WHERE email = ?`).get(email);
    if (exact) { exact._matchedBy = 'exact'; return exact; }
    // Gmail-specific fallback: many prior records may have been stored with dots/subaddresses removed.
    try {
      const s = String(email || '');
      const at = s.lastIndexOf('@');
      if (at > 0) {
        const local = s.slice(0, at);
        const domain = s.slice(at + 1).toLowerCase();
        if (domain === 'gmail.com' || domain === 'googlemail.com') {
          const base = local.split('+')[0];
          const dotless = base.replace(/\./g, '');
          const alt = `${dotless}@${domain}`;
          if (alt !== s) {
            const row = db.prepare(`SELECT * FROM volunteers WHERE email = ?`).get(alt);
            if (row) { row._matchedBy = 'gmail_canonical_alt'; return row; }
          }
        }
      }
    } catch (_) {}
    return undefined;
  },

  getVolunteerById: (volunteerId) => {
    try {
      return db.prepare(`SELECT * FROM volunteers WHERE volunteer_id = ?`).get(volunteerId);
    } catch (_) {
      return undefined;
    }
  },

  createVolunteer: (name, email, phone) => {
    try {
      const res = db.prepare(`
        INSERT INTO volunteers (name, email, phone_number)
        VALUES (?, ?, ?)
      `).run(name, email, phone);
      return mapRun(res);
    } catch (e) {
      const existing = db.prepare(`SELECT * FROM volunteers WHERE email = ?`).get(email);
      if (existing) return { changes: 0, lastInsertRowid: existing.volunteer_id, existing: true };
      throw createError(500, 'DB error creating volunteer: ' + e.message);
    }
  },

  getReservationCountForBlock: (blockId) => {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM reservations WHERE block_id = ?`).get(blockId);
    return (row && row.cnt) || 0;
  },

  createReservation: (volunteerId, blockId, note) => {
    try {
      const res = db.prepare(`
        INSERT INTO reservations (volunteer_id, block_id, reservation_date, note)
        VALUES (?, ?, datetime('now'), ?)
      `).run(volunteerId, blockId, note || null);
      return mapRun(res);
    } catch (e) {
      throw createError(500, 'DB error creating reservation: ' + e.message);
    }
  },

  // Reserve one or more slots, reusing the volunteer record if the email exists.
  reserveVolunteerSlots: (volunteer, blockIds, notes) => {
    const tx = db.transaction((v, ids, n) => {
      let volunteerId;
      const existing = publicDal.getVolunteerByEmail(v.email);
      if (existing) {
        volunteerId = existing.volunteer_id;
        // If we matched a previously-normalized Gmail record, promote it to the exact email provided now.
        if (existing._matchedBy === 'gmail_canonical_alt' && existing.email !== v.email) {
          try {
            db.prepare(`UPDATE volunteers SET email = ? WHERE volunteer_id = ?`).run(v.email, volunteerId);
          } catch (e) {
            // If UNIQUE constraint prevents update, keep existing email and continue.
          }
        }
        db.prepare(`UPDATE volunteers SET name = ?, phone_number = ? WHERE volunteer_id = ?`)
          .run(v.name, v.phone, volunteerId);
      } else {
        const r = publicDal.createVolunteer(v.name, v.email, v.phone);
        volunteerId = r.lastInsertRowid;
      }

      if (!ids.length) return { created: 0, volunteerId, eventId: null };

      const blockEventStmt = db.prepare(`
        SELECT tb.block_id, s.event_id
        FROM time_blocks tb
        JOIN stations s ON s.station_id = tb.station_id
        WHERE tb.block_id = ?
      `);

      let eventId = null;
      let created = 0;
      ids.forEach((blockId) => {
        const info = blockEventStmt.get(blockId);
        if (!info) throw createError(404, `Time block ${blockId} not found.`);
        if (eventId === null) eventId = info.event_id;
        if (eventId !== info.event_id) {
          throw createError(400, 'All selected time blocks must belong to the same event.');
        }

        const dup = db.prepare(`SELECT 1 FROM reservations WHERE volunteer_id = ? AND block_id = ?`).get(volunteerId, blockId);
        if (dup) return;

        const tb = db.prepare(`SELECT capacity_needed FROM time_blocks WHERE block_id = ?`).get(blockId);
        const cap = Number(tb.capacity_needed);
        const current = publicDal.getReservationCountForBlock(blockId);
        if (current >= cap) {
          throw createError(409, 'One or more selected time blocks are already full.');
        }

        let noteValue = null;
        if (n && typeof n === 'object') {
          noteValue = (n[blockId] != null) ? String(n[blockId]) : null;
        } else if (typeof n === 'string') {
          noteValue = n;
        }
        if (noteValue != null) {
          noteValue = String(noteValue).trim().replace(/^\s*,\s*/, '');
        }
        publicDal.createReservation(volunteerId, blockId, noteValue);
        created += 1;
      });

      return { created, volunteerId, eventId };
    });

    const result = tx(volunteer, blockIds, notes);
    return {
      count: result.created,
      volunteerId: result.volunteerId,
      eventId: result.eventId,
      blockIds
    };
  },

  // Tokens power "manage my reservation" links. We keep one per volunteer/event.
  storeVolunteerToken: (token, volunteerId, eventId, expiresAt) => {
    cleanupExpiredTokens();
    const hashedToken = hashToken(token);
    const txn = db.transaction(() => {
      db.prepare(`DELETE FROM volunteer_tokens WHERE volunteer_id = ? AND event_id = ?`).run(volunteerId, eventId);
      db.prepare(`
        INSERT INTO volunteer_tokens (token, volunteer_id, event_id, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(hashedToken, volunteerId, eventId, expiresAt || null);
    });
    txn();
    return token;
  },

  setVolunteerEmailPreference: (volunteerId, opts = {}) => {
    if (!volunteerId) return;
    const reason = typeof opts.reason === 'string' && opts.reason.trim().length ? opts.reason.trim().slice(0, 500) : null;
    if (opts.optIn) {
      db.prepare(`UPDATE volunteers SET email_opt_in = 1, email_opted_out_at = NULL, email_opt_out_reason = NULL WHERE volunteer_id = ?`).run(volunteerId);
    } else {
      db.prepare(`UPDATE volunteers SET email_opt_in = 0, email_opted_out_at = datetime('now'), email_opt_out_reason = ? WHERE volunteer_id = ?`).run(reason, volunteerId);
    }
  },

  getVolunteerToken: (token) => {
    cleanupExpiredTokens();
    const hashed = hashToken(token);
    const row = db.prepare(`
      SELECT
        t.token,
        t.volunteer_id,
        t.event_id,
        t.expires_at,
        v.name AS volunteer_name,
        v.email AS volunteer_email,
        v.phone_number AS volunteer_phone,
        COALESCE(v.email_opt_in, 1) AS email_opt_in,
        v.email_opted_out_at,
        v.email_opt_out_reason,
        e.name AS event_name,
        e.date_start,
        e.date_end,
        COALESCE(e.is_published, 0) AS is_published
      FROM volunteer_tokens t
      JOIN volunteers v ON v.volunteer_id = t.volunteer_id
      JOIN events e ON e.event_id = t.event_id
      WHERE t.token = ?
    `).get(hashed);
    if (row) return row;

    // Legacy fallback: accept plaintext tokens still on disk, then promote to hashed.
    const legacy = db.prepare(`
      SELECT
        t.token,
        t.volunteer_id,
        t.event_id,
        t.expires_at,
        v.name AS volunteer_name,
        v.email AS volunteer_email,
        v.phone_number AS volunteer_phone,
        COALESCE(v.email_opt_in, 1) AS email_opt_in,
        v.email_opted_out_at,
        v.email_opt_out_reason,
        e.name AS event_name,
        e.date_start,
        e.date_end,
        COALESCE(e.is_published, 0) AS is_published
      FROM volunteer_tokens t
      JOIN volunteers v ON v.volunteer_id = t.volunteer_id
      JOIN events e ON e.event_id = t.event_id
      WHERE t.token = ?
    `).get(token);

    if (legacy) {
      try {
        db.prepare(`UPDATE volunteer_tokens SET token = ? WHERE token = ?`).run(hashed, token);
      } catch (_) { /* best effort */ }
      return legacy;
    }

    return null;
  },

  getTokenForVolunteerEvent: (volunteerId, eventId) => {
    cleanupExpiredTokens();
    return db.prepare(`
      SELECT token, volunteer_id, event_id, expires_at
      FROM volunteer_tokens
      WHERE volunteer_id = ? AND event_id = ?
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `).get(volunteerId, eventId);
  },

  getVolunteerReservationsForEvent: (volunteerId, eventId) => {
    return db.prepare(`
      SELECT
        r.reservation_id,
        r.block_id,
        tb.start_time,
        tb.end_time,
        tb.title,
        tb.servings_min,
        tb.servings_max,
        r.note AS note,
        s.station_id,
        s.name AS station_name
      FROM reservations r
      JOIN time_blocks tb ON tb.block_id = r.block_id
      JOIN stations s ON s.station_id = tb.station_id
      WHERE r.volunteer_id = ?
        AND s.event_id = ?
      ORDER BY datetime(tb.start_time) ASC
    `).all(volunteerId, eventId);
  },

  // Replace an existing reservation set with a new collection of time blocks.
  replaceVolunteerReservations: (volunteerId, eventId, nextBlockIds, notes) => {
    const tx = db.transaction((vid, eid, ids, n) => {
      const distinctIds = Array.from(new Set(ids.map(Number).filter(Number.isFinite)));

      const existingRows = db.prepare(`
        SELECT r.reservation_id, r.block_id
        FROM reservations r
        JOIN time_blocks tb ON tb.block_id = r.block_id
        JOIN stations s ON s.station_id = tb.station_id
        WHERE r.volunteer_id = ? AND s.event_id = ?
      `).all(vid, eid);

      const existingIds = existingRows.map(row => row.block_id);
      const toRemove = existingIds.filter(id => !distinctIds.includes(id));
      const toAdd = distinctIds.filter(id => !existingIds.includes(id));

      const blockEventStmt = db.prepare(`
        SELECT tb.block_id, s.event_id, tb.capacity_needed
        FROM time_blocks tb
        JOIN stations s ON s.station_id = tb.station_id
        WHERE tb.block_id = ?
      `);

      toAdd.forEach(blockId => {
        const info = blockEventStmt.get(blockId);
        if (!info) throw createError(404, `Time block ${blockId} not found.`);
        if (info.event_id !== eid) {
          throw createError(400, 'Selected time blocks must belong to the same event.');
        }
        const cap = Number(info.capacity_needed);
        const current = publicDal.getReservationCountForBlock(blockId);
        if (current >= cap) {
          throw createError(409, 'One or more selected time blocks are already full.');
        }
      });

      toRemove.forEach(blockId => {
        db.prepare(`DELETE FROM reservations WHERE volunteer_id = ? AND block_id = ?`).run(vid, blockId);
      });

      toAdd.forEach(blockId => {
        let noteValue = null;
        if (n && typeof n === 'object') {
          noteValue = (n[blockId] != null) ? String(n[blockId]) : null;
        } else if (typeof n === 'string') {
          noteValue = n;
        }
        if (noteValue != null) {
          noteValue = String(noteValue).trim().replace(/^\s*,\s*/, '');
        }
        publicDal.createReservation(vid, blockId, noteValue);
      });

      // Update notes for all selected reservations when notes map provided
      if (n && typeof n === 'object') {
        const updStmt = db.prepare(`UPDATE reservations SET note = ? WHERE volunteer_id = ? AND block_id = ?`);
        distinctIds.forEach(blockId => {
          if (Object.prototype.hasOwnProperty.call(n, blockId)) {
            let noteValue = n[blockId] != null ? String(n[blockId]) : null;
            if (noteValue != null) {
              noteValue = noteValue.trim().replace(/^\s*,\s*/, '');
            }
            updStmt.run(noteValue, vid, blockId);
          }
        });
      } else if (typeof n === 'string' && n.trim().length) {
        // Legacy: single note applies to all selected reservations
        const updAll = db.prepare(`UPDATE reservations SET note = ? WHERE volunteer_id = ? AND block_id = ?`);
        const cleaned = n.trim().replace(/^\s*,\s*/, '');
        distinctIds.forEach(blockId => updAll.run(cleaned, vid, blockId));
      }

      return { added: toAdd.length, removed: toRemove.length };
    });

    return tx(volunteerId, eventId, nextBlockIds, notes);
  },

  // ---------------------------------------------------------------------------
  // Group registrations (multi-participant)
  // ---------------------------------------------------------------------------
  createRegistrationWithAssignments: (eventId, registrant, participantNames, scheduleAssignments, potluckAssignments) => {
    const tx = db.transaction((eid, reg, participantList, sched, pot) => {
      const regRes = db.prepare(`
        INSERT INTO registrations (
          event_id, registrant_name, registrant_email, registrant_phone,
          created_at, manage_token_hash, manage_token_expires_at,
          email_opt_in, email_opted_out_at, email_opt_out_reason
        )
        VALUES (?, ?, ?, ?, datetime('now'), NULL, NULL, ?, NULL, NULL)
      `).run(
        eid,
        reg.name,
        reg.email,
        reg.phone || null,
        typeof reg.email_opt_in === 'undefined' ? 1 : reg.email_opt_in ? 1 : 0
      );
      const registrationId = regRes.lastInsertRowid;
      const insertPart = db.prepare(`INSERT INTO participants (registration_id, participant_name) VALUES (?, ?)`);
      const participantIds = participantList.map(name => insertPart.run(registrationId, name).lastInsertRowid);

      const blockIds = Array.from(new Set([
        ...sched.map(s => Number(s.blockId)),
        ...pot.map(p => Number(p.itemId))
      ].filter(Number.isFinite)));
      const blockInfo = blockIds.length ? publicDal.getBlocksInfo(blockIds) : [];
      const blockMap = new Map(blockInfo.map(b => [Number(b.block_id), b]));
      blockIds.forEach(bid => {
        const info = blockMap.get(bid);
        if (!info) throw createError(404, `Time block ${bid} not found.`);
        if (Number(info.event_id) !== Number(eid)) {
          throw createError(400, 'All assignments must belong to the same event.');
        }
      });

      const schedIds = Array.from(new Set(sched.map(s => Number(s.blockId)).filter(Number.isFinite)));
      const potIds = Array.from(new Set(pot.map(p => Number(p.itemId)).filter(Number.isFinite)));

      // Deduplicate any legacy duplicate assignments for these blocks to keep counts accurate.
      if (schedIds.length) {
        const placeholders = schedIds.map(() => '?').join(',');
        db.prepare(`
          DELETE FROM schedule_assignments
          WHERE time_block_id IN (${placeholders})
            AND rowid NOT IN (
              SELECT MIN(rowid) FROM schedule_assignments
              WHERE time_block_id IN (${placeholders})
              GROUP BY participant_id, time_block_id
            )
        `).run(...schedIds, ...schedIds);
      }
      if (potIds.length) {
        const placeholders = potIds.map(() => '?').join(',');
        db.prepare(`
          DELETE FROM potluck_assignments
          WHERE item_id IN (${placeholders})
            AND rowid NOT IN (
              SELECT MIN(rowid) FROM potluck_assignments
              WHERE item_id IN (${placeholders})
              GROUP BY participant_id, item_id, COALESCE(dish_name,'')
            )
        `).run(...potIds, ...potIds);
      }

      const schedCounts = new Map();
      if (schedIds.length) {
        const placeholders = schedIds.map(() => '?').join(',');
        const rows = db.prepare(`
          SELECT sa.time_block_id, COUNT(*) AS cnt
          FROM schedule_assignments sa
          JOIN time_blocks tb ON tb.block_id = sa.time_block_id
          JOIN stations s ON s.station_id = tb.station_id
          WHERE sa.time_block_id IN (${placeholders}) AND s.event_id = ?
          GROUP BY sa.time_block_id
        `).all([...schedIds, eid]);
        rows.forEach(row => schedCounts.set(Number(row.time_block_id), Number(row.cnt || 0)));
      }
      const potCounts = new Map();
      if (potIds.length) {
        const placeholders = potIds.map(() => '?').join(',');
        const rows = db.prepare(`
          SELECT pa.item_id, COUNT(*) AS cnt
          FROM potluck_assignments pa
          JOIN time_blocks tb ON tb.block_id = pa.item_id
          JOIN stations s ON s.station_id = tb.station_id
          WHERE pa.item_id IN (${placeholders}) AND s.event_id = ?
          GROUP BY pa.item_id
        `).all([...potIds, eid]);
        rows.forEach(row => potCounts.set(Number(row.item_id), Number(row.cnt || 0)));
      }

      const pendingSched = new Map();
      sched.forEach(s => {
        const blockId = Number(s.blockId);
        if (!Number.isFinite(blockId)) return;
        pendingSched.set(blockId, (pendingSched.get(blockId) || 0) + 1);
      });
      const pendingPot = new Map();
      pot.forEach(p => {
        const blockId = Number(p.itemId);
        if (!Number.isFinite(blockId)) return;
        pendingPot.set(blockId, (pendingPot.get(blockId) || 0) + 1);
      });

      schedIds.forEach(bid => {
        const info = blockMap.get(bid);
        const cap = Number(info && info.capacity_needed);
        if (Number.isFinite(cap) && cap > 0) {
          const total = (schedCounts.get(bid) || 0) + (pendingSched.get(bid) || 0);
          if (total > cap) throw createError(409, 'One or more selected time blocks are already full.');
        }
      });
      potIds.forEach(bid => {
        const info = blockMap.get(bid);
        const cap = Number(info && info.capacity_needed);
        if (Number.isFinite(cap) && cap > 0) {
          const total = (potCounts.get(bid) || 0) + (pendingPot.get(bid) || 0);
          if (total > cap) throw createError(409, 'One or more selected items are already full.');
        }
      });

      const insertSched = db.prepare(`INSERT INTO schedule_assignments (participant_id, time_block_id) VALUES (?, ?)`);
      const insertPot = db.prepare(`INSERT INTO potluck_assignments (participant_id, item_id, dish_name) VALUES (?, ?, ?)`);

      const seenSched = new Set();
      sched.forEach(s => {
        const blockId = Number(s.blockId);
        const pIdxRaw = Number.isFinite(Number(s.participantIndex)) ? Number(s.participantIndex) : 0;
        if (!Number.isFinite(blockId)) return;
        const participantId = participantIds[pIdxRaw];
        if (!participantId) throw createError(400, 'Invalid participant reference in assignment.');
        const key = `${participantId}:${blockId}`;
        if (seenSched.has(key)) return;
        seenSched.add(key);
        insertSched.run(participantId, blockId);
      });

      const seenPot = new Set();
      pot.forEach(p => {
        const blockId = Number(p.itemId);
        const pIdxRaw = Number.isFinite(Number(p.participantIndex)) ? Number(p.participantIndex) : 0;
        if (!Number.isFinite(blockId)) return;
        const participantId = participantIds[pIdxRaw];
        if (!participantId) throw createError(400, 'Invalid participant reference in assignment.');
        const key = `${participantId}:${blockId}`;
        if (seenPot.has(key)) return;
        seenPot.add(key);
        const dish = (p.dishName != null && String(p.dishName).trim().length) ? String(p.dishName).trim() : null;
        insertPot.run(participantId, blockId, dish);
      });

      return { registrationId, participantIds };
    });

    return tx(eventId, registrant, participantNames, scheduleAssignments || [], potluckAssignments || []);
  },

  replaceRegistrationAssignments: (registrationId, eventId, scheduleAssignments, potluckAssignments, debugOptions = {}) => {
    const tx = db.transaction((rid, eid, sched, pot, opts) => {
      const debugCap = opts && opts.debugCapacity;
      const debugInfo = debugCap ? { schedule: [], potluck: [] } : null;
      const ignoreSchedMap = new Map();
      const ignorePotMap = new Map();
      if (opts && Array.isArray(opts.ignoreSchedCounts)) {
        opts.ignoreSchedCounts.forEach(bid => {
          const key = Number(bid);
          ignoreSchedMap.set(key, (ignoreSchedMap.get(key) || 0) + 1);
        });
      }
      if (opts && Array.isArray(opts.ignorePotCounts)) {
        opts.ignorePotCounts.forEach(bid => {
          const key = Number(bid);
          ignorePotMap.set(key, (ignorePotMap.get(key) || 0) + 1);
        });
      }
      const registration = db.prepare(`SELECT registration_id FROM registrations WHERE registration_id = ? AND event_id = ?`).get(rid, eid);
      if (!registration) throw createError(404, 'Registration not found.');

      const participantRows = db.prepare(`SELECT participant_id FROM participants WHERE registration_id = ?`).all(rid);
      const participantIds = participantRows.map(p => p.participant_id);
      const participantSet = new Set(participantIds);
      sched.forEach(s => {
        if (!participantSet.has(Number(s.participantId))) throw createError(400, 'Invalid participant for assignment.');
      });
      pot.forEach(p => {
        if (!participantSet.has(Number(p.participantId))) throw createError(400, 'Invalid participant for assignment.');
      });

      const schedExisting = participantIds.length
        ? db.prepare(`SELECT assignment_id, participant_id, time_block_id FROM schedule_assignments WHERE participant_id IN (${participantIds.map(() => '?').join(',')})`).all(participantIds)
        : [];
      const potExisting = participantIds.length
        ? db.prepare(`SELECT assignment_id, participant_id, item_id, dish_name FROM potluck_assignments WHERE participant_id IN (${participantIds.map(() => '?').join(',')})`).all(participantIds)
        : [];

      const allBlockIds = Array.from(new Set([
        ...schedExisting.map(r => Number(r.time_block_id)),
        ...potExisting.map(r => Number(r.item_id)),
        ...sched.map(r => Number(r.blockId || r.time_block_id)),
        ...pot.map(r => Number(r.itemId || r.block_id))
      ].filter(Number.isFinite)));
      const blockInfo = allBlockIds.length ? publicDal.getBlocksInfo(allBlockIds) : [];
      const blockMap = new Map(blockInfo.map(b => [Number(b.block_id), b]));
      allBlockIds.forEach(bid => {
        const info = blockMap.get(bid);
        if (!info) throw createError(404, `Time block ${bid} not found.`);
        if (Number(info.event_id) !== Number(eid)) {
          throw createError(400, 'All assignments must belong to the same event.');
        }
      });

      const schedIds = Array.from(new Set([
        ...sched.map(s => Number(s.blockId || s.time_block_id)),
        ...schedExisting.map(r => Number(r.time_block_id))
      ].filter(Number.isFinite)));
      const potIds = Array.from(new Set([
        ...pot.map(p => Number(p.itemId || p.block_id)),
        ...potExisting.map(r => Number(r.item_id))
      ].filter(Number.isFinite)));

      // Clean orphaned assignments for the relevant blocks so capacity counts are accurate.
      const cleanSchedIds = schedIds.length ? schedIds : [];
      if (cleanSchedIds.length) {
        const placeholders = cleanSchedIds.map(() => '?').join(',');
        db.prepare(`
          DELETE FROM schedule_assignments
          WHERE time_block_id IN (${placeholders})
            AND participant_id NOT IN (SELECT participant_id FROM participants)
        `).run(cleanSchedIds);

        // Drop duplicated rows for the same participant/block so capacity math is stable.
        db.prepare(`
          DELETE FROM schedule_assignments
          WHERE time_block_id IN (${placeholders})
            AND assignment_id NOT IN (
              SELECT MIN(sa.assignment_id)
              FROM schedule_assignments sa
              WHERE sa.time_block_id IN (${placeholders})
              GROUP BY sa.participant_id, sa.time_block_id
            )
        `).run([...cleanSchedIds, ...cleanSchedIds]);

        // Remove assignments whose participant belongs to a different event than the block.
        blockInfo.forEach(info => {
          db.prepare(`
            DELETE FROM schedule_assignments
            WHERE time_block_id = ?
              AND participant_id IN (
                SELECT p.participant_id
                FROM participants p
                JOIN registrations r ON r.registration_id = p.registration_id
                WHERE r.event_id != ?
              )
          `).run(Number(info.block_id), Number(info.event_id));
        });
      }
      const cleanPotIds = potIds.length ? potIds : [];
      if (cleanPotIds.length) {
        const placeholders = cleanPotIds.map(() => '?').join(',');
        db.prepare(`
          DELETE FROM potluck_assignments
          WHERE item_id IN (${placeholders})
            AND participant_id NOT IN (SELECT participant_id FROM participants)
        `).run(cleanPotIds);

        db.prepare(`
          DELETE FROM potluck_assignments
          WHERE item_id IN (${placeholders})
            AND assignment_id NOT IN (
              SELECT MIN(pa.assignment_id)
              FROM potluck_assignments pa
              WHERE pa.item_id IN (${placeholders})
              GROUP BY pa.participant_id, pa.item_id
            )
        `).run([...cleanPotIds, ...cleanPotIds]);

        blockInfo.forEach(info => {
          db.prepare(`
            DELETE FROM potluck_assignments
            WHERE item_id = ?
              AND participant_id IN (
                SELECT p.participant_id
                FROM participants p
                JOIN registrations r ON r.registration_id = p.registration_id
                WHERE r.event_id != ?
              )
          `).run(Number(info.block_id), Number(info.event_id));
        });
      }

      const schedCounts = new Map();
      if (schedIds.length) {
        const placeholders = schedIds.map(() => '?').join(',');
        const schedCountRows = db.prepare(`
          SELECT tb.block_id AS time_block_id, COUNT(DISTINCT sa.participant_id) AS cnt
          FROM schedule_assignments sa
          JOIN participants p ON p.participant_id = sa.participant_id
          JOIN registrations r ON r.registration_id = p.registration_id
          JOIN time_blocks tb ON tb.block_id = sa.time_block_id
          JOIN stations st ON st.station_id = tb.station_id
          WHERE sa.time_block_id IN (${placeholders}) AND st.event_id = ?
          GROUP BY tb.block_id
        `).all([...schedIds, Number(eid)]);
        schedCountRows.forEach(row => schedCounts.set(Number(row.time_block_id), Number(row.cnt || 0)));
        if (debugInfo) {
          debugInfo.rawSchedCounts = schedCountRows;
          debugInfo.rawSchedRows = db.prepare(`
            SELECT sa.assignment_id, sa.time_block_id, sa.participant_id, p.registration_id, r.registrant_email
            FROM schedule_assignments sa
            JOIN participants p ON p.participant_id = sa.participant_id
            JOIN registrations r ON r.registration_id = p.registration_id
            WHERE sa.time_block_id IN (${placeholders})
          `).all(schedIds);
        }
      }
      const potCounts = new Map();
      if (potIds.length) {
        const placeholders = potIds.map(() => '?').join(',');
        const potCountRows = db.prepare(`
          SELECT tb.block_id AS item_id, COUNT(DISTINCT pa.participant_id) AS cnt
          FROM potluck_assignments pa
          JOIN participants p ON p.participant_id = pa.participant_id
          JOIN registrations r ON r.registration_id = p.registration_id
          JOIN time_blocks tb ON tb.block_id = pa.item_id
          JOIN stations st ON st.station_id = tb.station_id
          WHERE pa.item_id IN (${placeholders}) AND st.event_id = ?
          GROUP BY tb.block_id
        `).all([...potIds, Number(eid)]);
        potCountRows.forEach(row => potCounts.set(Number(row.item_id), Number(row.cnt || 0)));
        if (debugInfo) {
          debugInfo.rawPotCounts = potCountRows;
          debugInfo.rawPotRows = db.prepare(`
            SELECT pa.assignment_id, pa.item_id, pa.participant_id, pa.dish_name, p.registration_id, r.registrant_email
            FROM potluck_assignments pa
            JOIN participants p ON p.participant_id = pa.participant_id
            JOIN registrations r ON r.registration_id = p.registration_id
            WHERE pa.item_id IN (${placeholders})
          `).all(potIds);
        }
      }

      const currentSchedCount = new Map();
      schedExisting.forEach(r => {
        currentSchedCount.set(Number(r.time_block_id), (currentSchedCount.get(Number(r.time_block_id)) || 0) + 1);
      });
      const currentPotCount = new Map();
      potExisting.forEach(r => {
        currentPotCount.set(Number(r.item_id), (currentPotCount.get(Number(r.item_id)) || 0) + 1);
      });

      const pendingSched = new Map();
      sched.forEach(s => {
        const bid = Number(s.blockId || s.time_block_id);
        if (!Number.isFinite(bid)) return;
        pendingSched.set(bid, (pendingSched.get(bid) || 0) + 1);
      });
      const pendingPot = new Map();
      pot.forEach(p => {
        const bid = Number(p.itemId || p.block_id);
        if (!Number.isFinite(bid)) return;
        pendingPot.set(bid, (pendingPot.get(bid) || 0) + 1);
      });

      schedIds.forEach(bid => {
        const info = blockMap.get(bid);
        const cap = Number(info && info.capacity_needed);
        if (Number.isFinite(cap) && cap > 0) {
          const ignore = ignoreSchedMap.get(bid) || 0;
          const othersCount = Math.max(0, (schedCounts.get(bid) || 0) - (currentSchedCount.get(bid) || 0) - ignore);
          const totalAfter = othersCount + (pendingSched.get(bid) || 0);
          if (debugInfo) debugInfo.schedule.push({ blockId: bid, cap, othersCount, current: currentSchedCount.get(bid) || 0, pending: pendingSched.get(bid) || 0, totalAfter, ignored: ignore });
          const isNotIncreasing = (pendingSched.get(bid) || 0) <= (currentSchedCount.get(bid) || 0);
          if (totalAfter > cap && !isNotIncreasing) {
            const err = createError(409, 'One or more selected time blocks are already full.');
            if (debugInfo) err.debug = debugInfo;
            throw err;
          }
        }
      });
      potIds.forEach(bid => {
        const info = blockMap.get(bid);
        const cap = Number(info && info.capacity_needed);
        if (Number.isFinite(cap) && cap > 0) {
          const ignore = ignorePotMap.get(bid) || 0;
          const othersCount = Math.max(0, (potCounts.get(bid) || 0) - (currentPotCount.get(bid) || 0) - ignore);
          const totalAfter = othersCount + (pendingPot.get(bid) || 0);
          if (debugInfo) debugInfo.potluck.push({ itemId: bid, cap, othersCount, current: currentPotCount.get(bid) || 0, pending: pendingPot.get(bid) || 0, totalAfter, ignored: ignore });
          const isNotIncreasing = (pendingPot.get(bid) || 0) <= (currentPotCount.get(bid) || 0);
          if (totalAfter > cap && !isNotIncreasing) {
            const err = createError(409, 'One or more selected items are already full.');
            if (debugInfo) err.debug = debugInfo;
            throw err;
          }
        }
      });

      if (participantIds.length) {
        const placeholders = participantIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM schedule_assignments WHERE participant_id IN (${placeholders})`).run(participantIds);
        db.prepare(`DELETE FROM potluck_assignments WHERE participant_id IN (${placeholders})`).run(participantIds);
      }

      const insertSched = db.prepare(`INSERT INTO schedule_assignments (participant_id, time_block_id) VALUES (?, ?)`);
      const insertPot = db.prepare(`INSERT INTO potluck_assignments (participant_id, item_id, dish_name) VALUES (?, ?, ?)`);
      const seenSched = new Set();
      sched.forEach(s => {
        const bid = Number(s.blockId || s.time_block_id);
        const pidRaw = Number.isFinite(Number(s.participantId)) ? Number(s.participantId) : participantIds[s.participantIndex ?? 0];
        const pid = Number(pidRaw);
        if (!participantSet.has(pid) || !Number.isFinite(bid)) return;
        const key = `${pid}:${bid}`;
        if (seenSched.has(key)) return;
        seenSched.add(key);
        insertSched.run(pid, bid);
      });
      const seenPot = new Set();
      pot.forEach(p => {
        const bid = Number(p.itemId || p.block_id);
        const pidRaw = Number.isFinite(Number(p.participantId)) ? Number(p.participantId) : participantIds[p.participantIndex ?? 0];
        const pid = Number(pidRaw);
        if (!participantSet.has(pid) || !Number.isFinite(bid)) return;
        const key = `${pid}:${bid}`;
        if (seenPot.has(key)) return;
        seenPot.add(key);
        const dish = (p.dishName != null && String(p.dishName).trim().length) ? String(p.dishName).trim() : null;
        insertPot.run(pid, bid, dish);
      });

      return debugInfo || true;
    });

    return tx(registrationId, eventId, scheduleAssignments || [], potluckAssignments || [], debugOptions);
  },

  getRegistrationByToken: (token) => {
    const hashed = hashToken(token);
    let row = db.prepare(`
      SELECT
        r.*,
        e.name AS event_name,
        e.date_start,
        e.date_end,
        COALESCE(e.signup_mode, 'schedule') AS signup_mode,
        e.publish_state,
        e.is_published
      FROM registrations r
      JOIN events e ON e.event_id = r.event_id
      WHERE r.manage_token_hash = ?
    `).get(hashed);

    if (row) return row;

    // Legacy fallback: find a registration that matches an older volunteer token/email
    const legacy = publicDal.getVolunteerToken(token);
    if (legacy && legacy.volunteer_email) {
      const reg = db.prepare(`
        SELECT
          r.*,
          e.name AS event_name,
          e.date_start,
          e.date_end,
          COALESCE(e.signup_mode, 'schedule') AS signup_mode,
          e.publish_state,
          e.is_published
        FROM registrations r
        JOIN events e ON e.event_id = r.event_id
        WHERE r.event_id = ? AND LOWER(r.registrant_email) = LOWER(?)
        ORDER BY datetime(r.created_at) DESC
        LIMIT 1
      `).get(legacy.event_id, legacy.volunteer_email);
      if (reg) {
        try {
          db.prepare(`UPDATE registrations SET manage_token_hash = ?, manage_token_expires_at = ? WHERE registration_id = ?`)
            .run(hashed, legacy.expires_at || null, reg.registration_id);
        } catch (_) {}
        return reg;
      }
    }

    return null;
  },

  storeRegistrationToken: (token, registrationId, expiresAt) => {
    const hashed = hashToken(token);
    db.prepare(`
      UPDATE registrations
      SET manage_token_hash = ?, manage_token_expires_at = ?
      WHERE registration_id = ?
    `).run(hashed, expiresAt || null, registrationId);
    return token;
  },

  setRegistrationEmailPreference: (registrationId, opts = {}) => {
    if (!registrationId) return;
    const reason = typeof opts.reason === 'string' && opts.reason.trim().length ? opts.reason.trim().slice(0, 500) : null;
    if (opts.optIn) {
      db.prepare(`UPDATE registrations SET email_opt_in = 1, email_opted_out_at = NULL, email_opt_out_reason = NULL WHERE registration_id = ?`).run(registrationId);
    } else {
      db.prepare(`UPDATE registrations SET email_opt_in = 0, email_opted_out_at = datetime('now'), email_opt_out_reason = ? WHERE registration_id = ?`).run(reason, registrationId);
    }
  },

  findRegistrationByEmail: (eventId, email) => {
    return db.prepare(`
      SELECT *
      FROM registrations
      WHERE event_id = ? AND LOWER(registrant_email) = LOWER(?)
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `).get(eventId, email);
  },

  findRegistrationsByEmail: (eventId, email) => {
    return db.prepare(`
      SELECT *
      FROM registrations
      WHERE event_id = ? AND LOWER(registrant_email) = LOWER(?)
      ORDER BY datetime(created_at) DESC
    `).all(eventId, email);
  },

  deleteEmptyRegistrations: (eventId, email) => {
    const ids = db.prepare(`
      SELECT r.registration_id
      FROM registrations r
      WHERE (? IS NULL OR r.event_id = ?)
        AND (? IS NULL OR LOWER(r.registrant_email) = LOWER(?))
        AND NOT EXISTS (
          SELECT 1 FROM participants p
          JOIN schedule_assignments sa ON sa.participant_id = p.participant_id
          WHERE p.registration_id = r.registration_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM participants p2
          JOIN potluck_assignments pa ON pa.participant_id = p2.participant_id
          WHERE p2.registration_id = r.registration_id
        )
    `).all(eventId || null, eventId || null, email || null, email || null);
    ids.forEach(row => {
      try { publicDal.deleteRegistrationCascade(row.registration_id); } catch (_) {}
    });
    return ids.length;
  },

  listRegistrationsForEvent: (eventId) => {
    return db.prepare(`
      SELECT registration_id, registrant_email
      FROM registrations
      WHERE event_id = ?
    `).all(eventId);
  },

  deleteRegistrationCascade: (registrationId) => {
    const tx = db.transaction((rid) => {
      const participants = db.prepare(`SELECT participant_id FROM participants WHERE registration_id = ?`).all(rid);
      if (participants.length) {
        const ids = participants.map(p => p.participant_id);
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM schedule_assignments WHERE participant_id IN (${placeholders})`).run(ids);
        db.prepare(`DELETE FROM potluck_assignments WHERE participant_id IN (${placeholders})`).run(ids);
        db.prepare(`DELETE FROM participants WHERE participant_id IN (${placeholders})`).run(ids);
      }
      db.prepare(`DELETE FROM registrations WHERE registration_id = ?`).run(rid);
      return true;
    });
    return tx(registrationId);
  },

  getRegistrationDetailWithAssignments: (registrationId) => {
    const registration = db.prepare(`
      SELECT
        r.*,
        e.name AS event_name,
        e.date_start,
        e.date_end,
        COALESCE(e.signup_mode, 'schedule') AS signup_mode
      FROM registrations r
      JOIN events e ON e.event_id = r.event_id
      WHERE r.registration_id = ?
    `).get(registrationId);
    if (!registration) return null;
    const participants = db.prepare(`
      SELECT participant_id, participant_name
      FROM participants
      WHERE registration_id = ?
      ORDER BY participant_id ASC
    `).all(registrationId);

    const participantIds = participants.map(p => p.participant_id);
    const sched = participantIds.length
      ? db.prepare(`
          SELECT
            sa.assignment_id,
            sa.participant_id,
            sa.time_block_id,
            tb.start_time,
            tb.end_time,
            tb.title,
            tb.servings_min,
            tb.servings_max,
            s.station_id,
            s.name AS station_name
          FROM schedule_assignments sa
          JOIN time_blocks tb ON tb.block_id = sa.time_block_id
          JOIN stations s ON s.station_id = tb.station_id
          WHERE sa.participant_id IN (${participantIds.map(() => '?').join(',')})
        `).all(participantIds)
      : [];

    const pot = participantIds.length
      ? db.prepare(`
          SELECT
            pa.assignment_id,
            pa.participant_id,
            pa.item_id,
            pa.dish_name,
            tb.start_time,
            tb.end_time,
            tb.title,
            tb.servings_min,
            tb.servings_max,
            s.station_id,
            s.name AS station_name
          FROM potluck_assignments pa
          JOIN time_blocks tb ON tb.block_id = pa.item_id
          JOIN stations s ON s.station_id = tb.station_id
          WHERE pa.participant_id IN (${participantIds.map(() => '?').join(',')})
        `).all(participantIds)
      : [];

    return { registration, participants, scheduleAssignments: sched, potluckAssignments: pot };
  },

  addParticipant: (registrationId, name) => {
    try {
      const res = db.prepare(`INSERT INTO participants (registration_id, participant_name) VALUES (?, ?)`).run(registrationId, name);
      return { participant_id: res.lastInsertRowid };
    } catch (err) {
      if (err && err.message && /UNIQUE/i.test(err.message)) {
        throw createError(409, 'Participant names must be unique.');
      }
      throw err;
    }
  },

  renameParticipant: (registrationId, participantId, newName) => {
    try {
      const res = db.prepare(`
        UPDATE participants
        SET participant_name = ?
        WHERE participant_id = ? AND registration_id = ?
      `).run(newName, participantId, registrationId);
      if (!res.changes) throw createError(404, 'Participant not found.');
      return mapRun(res);
    } catch (err) {
      if (err && err.message && /UNIQUE/i.test(err.message)) {
        throw createError(409, 'Another participant already has that name.');
      }
      throw err;
    }
  },

  mergeParticipants: (registrationId, fromId, toId) => {
    if (fromId === toId) return { merged: false };
    const tx = db.transaction((rid, srcId, destId) => {
      const src = db.prepare(`SELECT participant_id FROM participants WHERE participant_id = ? AND registration_id = ?`).get(srcId, rid);
      const dest = db.prepare(`SELECT participant_id FROM participants WHERE participant_id = ? AND registration_id = ?`).get(destId, rid);
      if (!src || !dest) throw createError(404, 'Participant not found.');

      const destSched = new Set(db.prepare(`SELECT time_block_id FROM schedule_assignments WHERE participant_id = ?`).all(destId).map(r => Number(r.time_block_id)));
      db.prepare(`SELECT assignment_id, time_block_id FROM schedule_assignments WHERE participant_id = ?`).all(srcId).forEach(row => {
        if (destSched.has(Number(row.time_block_id))) {
          db.prepare(`DELETE FROM schedule_assignments WHERE assignment_id = ?`).run(row.assignment_id);
        } else {
          db.prepare(`UPDATE schedule_assignments SET participant_id = ? WHERE assignment_id = ?`).run(destId, row.assignment_id);
        }
      });

      const destPot = new Set(db.prepare(`SELECT item_id FROM potluck_assignments WHERE participant_id = ?`).all(destId).map(r => Number(r.item_id)));
      db.prepare(`SELECT assignment_id, item_id FROM potluck_assignments WHERE participant_id = ?`).all(srcId).forEach(row => {
        if (destPot.has(Number(row.item_id))) {
          db.prepare(`DELETE FROM potluck_assignments WHERE assignment_id = ?`).run(row.assignment_id);
        } else {
          db.prepare(`UPDATE potluck_assignments SET participant_id = ? WHERE assignment_id = ?`).run(destId, row.assignment_id);
        }
      });

      db.prepare(`DELETE FROM participants WHERE participant_id = ?`).run(srcId);
      return { merged: true };
    });
    return tx(registrationId, fromId, toId);
  },

  deleteParticipant: (registrationId, participantId, removeAssignments) => {
    const tx = db.transaction((rid, pid, remove) => {
      const hasSched = db.prepare(`SELECT 1 FROM schedule_assignments WHERE participant_id = ? LIMIT 1`).get(pid);
      const hasPot = db.prepare(`SELECT 1 FROM potluck_assignments WHERE participant_id = ? LIMIT 1`).get(pid);
      if ((hasSched || hasPot) && !remove) {
        throw createError(400, 'Participant still has assignments. Reassign before deleting.');
      }
      if (remove) {
        db.prepare(`DELETE FROM schedule_assignments WHERE participant_id = ?`).run(pid);
        db.prepare(`DELETE FROM potluck_assignments WHERE participant_id = ?`).run(pid);
      }
      const res = db.prepare(`DELETE FROM participants WHERE participant_id = ? AND registration_id = ?`).run(pid, rid);
      if (!res.changes) throw createError(404, 'Participant not found.');
      return mapRun(res);
    });
    return tx(registrationId, participantId, !!removeAssignments);
  }
};

module.exports = {
  admin,
  public: publicDal,
};
