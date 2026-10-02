-- Enable foreign key support in SQLite.
PRAGMA foreign_keys = ON;

-- High-level event containers.
CREATE TABLE IF NOT EXISTS events (
    event_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    date_start TEXT NOT NULL,
    date_end TEXT NOT NULL
);

-- Locations or roles within an event.
CREATE TABLE IF NOT EXISTS stations (
    station_id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stations_event_id ON stations(event_id);

-- Defined shifts/slots, representing the demand for volunteers.
CREATE TABLE IF NOT EXISTS time_blocks (
    block_id INTEGER PRIMARY KEY,
    station_id INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    capacity_needed INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (station_id) REFERENCES stations(station_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_time_blocks_scheduling ON time_blocks(station_id, start_time, end_time);

-- Personally Identifiable Information (PII) for volunteers.
CREATE TABLE IF NOT EXISTS volunteers (
    volunteer_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone_number TEXT,
    email_opt_in INTEGER NOT NULL DEFAULT 1,
    email_opted_out_at TEXT,
    email_opt_out_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_volunteers_email ON volunteers(email);

-- Links a volunteer to a specific time block, representing a commitment.
CREATE TABLE IF NOT EXISTS reservations (
    reservation_id INTEGER PRIMARY KEY,
    volunteer_id INTEGER NOT NULL,
    block_id INTEGER NOT NULL,
    reservation_date TEXT NOT NULL,
    FOREIGN KEY (volunteer_id) REFERENCES volunteers(volunteer_id) ON DELETE CASCADE,
    FOREIGN KEY (block_id) REFERENCES time_blocks(block_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reservations_volunteer_id ON reservations(volunteer_id);
CREATE INDEX IF NOT EXISTS idx_reservations_block_id ON reservations(block_id);

-- Group registration tables (multi-participant)
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
);
CREATE INDEX IF NOT EXISTS idx_registrations_event ON registrations(event_id);
CREATE INDEX IF NOT EXISTS idx_registrations_token ON registrations(manage_token_hash);

CREATE TABLE IF NOT EXISTS registration_tokens (
    token_hash TEXT PRIMARY KEY,
    registration_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    FOREIGN KEY (registration_id) REFERENCES registrations(registration_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_registration_tokens_registration ON registration_tokens(registration_id);

CREATE TABLE IF NOT EXISTS participants (
    participant_id INTEGER PRIMARY KEY,
    registration_id INTEGER NOT NULL,
    participant_name TEXT NOT NULL,
    FOREIGN KEY (registration_id) REFERENCES registrations(registration_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_participants_registration ON participants(registration_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_participants_reg_name ON participants(registration_id, participant_name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS schedule_assignments (
    assignment_id INTEGER PRIMARY KEY,
    participant_id INTEGER NOT NULL,
    time_block_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (participant_id) REFERENCES participants(participant_id) ON DELETE CASCADE,
    FOREIGN KEY (time_block_id) REFERENCES time_blocks(block_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_schedule_assignments_unique ON schedule_assignments(participant_id, time_block_id);
CREATE INDEX IF NOT EXISTS idx_schedule_assignments_block ON schedule_assignments(time_block_id);

CREATE TABLE IF NOT EXISTS potluck_assignments (
    assignment_id INTEGER PRIMARY KEY,
    participant_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    dish_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (participant_id) REFERENCES participants(participant_id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES time_blocks(block_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_potluck_assignments_unique ON potluck_assignments(participant_id, item_id);
CREATE INDEX IF NOT EXISTS idx_potluck_assignments_item ON potluck_assignments(item_id);
