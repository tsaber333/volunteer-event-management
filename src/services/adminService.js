// src/services/adminService.js
// -----------------------------------------------------------------------------
// Centralised business logic that powers the admin dashboard. Controllers call
// into this module to manipulate events, stations, time blocks, and volunteer
// reservations. The functions below provide validation, input normalization,
// and richer data shaping on top of the raw DAL helpers.
// -----------------------------------------------------------------------------
const dal = require('../db/dal');
const createError = require('http-errors');

/**
 * Normalise a datetime-local string (e.g. `YYYY-MM-DDTHH:mm`) into a canonical
 * `YYYY-MM-DD HH:mm` format so the database always receives consistent values.
 * The helper intentionally avoids timezone conversion because the UI supplies
 * pre-localised values and the schema stores them verbatim.
 */
function toCanonicalLocalString(s) {
  if (!s || typeof s !== 'string') throw createError(400, 'Datetime is required.');
  // Accept "YYYY-MM-DDTHH:mm" (from <input type="datetime-local">) or "YYYY-MM-DD HH:mm"
  const t = s.trim().replace('T', ' ');
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw createError(400, `Invalid datetime format: ${s}`);
  const [_, Y, M, D, h, m2, sec] = m;
  // Normalize to seconds-less canonical text
  return `${Y}-${M}-${D} ${h}:${m2}`;
}

/**
 * Compare two canonical local datetime strings without performing timezone
 * calculations. We convert the plain text into UTC timestamps using the same
 * components which keeps chronological ordering intact for comparison logic.
 */
function cmpLocal(a, b) {
  // Compare two "YYYY-MM-DD HH:mm" strings without timezone by mapping to UTC with the same components
  const A = a.match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})$/);
  const B = b.match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})$/);
  const Au = Date.UTC(+A[1], +A[2]-1, +A[3], +A[4], +A[5]);
  const Bu = Date.UTC(+B[1], +B[2]-1, +B[3], +B[4], +B[5]);
  return Au - Bu;
}

function safeCanonicalLocal(txt) {
  if (!txt) return null;
  try {
    return toCanonicalLocalString(String(txt));
  } catch (err) {
    return null;
  }
}

function sortBlocksForExport(blocks, isPotluck) {
  const list = Array.isArray(blocks) ? blocks.slice() : [];
  if (list.length <= 1) return list;
  const orderValue = (val) => {
    const num = Number(val);
    return Number.isFinite(num) ? num : 0;
  };
  return list.sort((a, b) => {
    if (isPotluck) {
      const ao = orderValue(a && a.item_order);
      const bo = orderValue(b && b.item_order);
      if (ao !== bo) return ao - bo;
      const aid = Number(a && a.block_id) || 0;
      const bid = Number(b && b.block_id) || 0;
      return aid - bid;
    }
    const aStart = safeCanonicalLocal(a && a.start_time);
    const bStart = safeCanonicalLocal(b && b.start_time);
    if (aStart && bStart) {
      const cmp = cmpLocal(aStart, bStart);
      if (cmp) return cmp;
    } else if (aStart || bStart) {
      return aStart ? -1 : 1;
    }
    const aid = Number(a && a.block_id) || 0;
    const bid = Number(b && b.block_id) || 0;
    return aid - bid;
  });
}

/**
 * Allow "Feeds" min/max to be optional in forms. Returns `{ provided, value }`
 * where `provided` tells us if the field was present (even if blank) and
 * `value` is either a non-negative number or `null` to clear it.
 */
function normalizeServingsValue(v) {
  if (v === undefined) return { provided: false, value: undefined };
  if (v === null) return { provided: true, value: null };
  if (typeof v === 'string' && v.trim() === '') return { provided: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n)) return { provided: true, value: null };
  if (n < 0) throw createError(400, 'Feeds must be zero or greater.');
  return { provided: true, value: n };
}

function validateServingsRange(min, max) {
  if (min != null && max != null && max < min) {
    throw createError(400, 'Feeds max must be greater than or equal to min.');
  }
}

/**
 * Retrieve all events for the admin dashboard sorted chronologically so that
 * coordinators always see the next event first.
 */
function getDashboardData() {
  return dal.admin.getAllEvents().sort((a, b) => {
    const aDate = new Date(a.date_start).getTime();
    const bDate = new Date(b.date_start).getTime();
    return bDate - aDate; // Newest (latest start) first
  });
}

/**
 * Resolve full event details for admins including stations, time blocks, and
 * volunteer reservations. The DAL returns a flattened join; this function
 * reshapes the data into a nested structure that the views expect.
 */
function getEventDetailsForAdmin(eventId) {
  const rows = dal.admin.getEventById(eventId);
  if (!rows || rows.length === 0) return null;

  const reservations = dal.admin.getEventReservations ? dal.admin.getEventReservations(eventId) : [];
  const resByBlock = new Map();
  reservations.forEach(r => {
    if (!resByBlock.has(r.block_id)) resByBlock.set(r.block_id, []);
    resByBlock.get(r.block_id).push({
      reservation_id: r.reservation_id,
      volunteer_id: r.volunteer_id,
      name: r.volunteer_name,
      email: r.volunteer_email,
      phone: r.volunteer_phone,
      registrant_name: r.registrant_name,
      registrant_email: r.registrant_email,
      reservation_date: r.reservation_date,
      reservation_note: r.reservation_note || ''
    });
  });

  const rawState = rows[0].publish_state || (rows[0].is_published ? 'published' : 'draft');
  const publishState = (rawState === 'private' || rawState === 'published') ? rawState : 'draft';
  const isPrivate = publishState === 'private';
  const isPublishedLive = publishState === 'published';
  const event = {
    event_id: rows[0].event_id,
    name: rows[0].name,
    description: rows[0].description,
    date_start: rows[0].date_start, // already local text
    date_end: rows[0].date_end,     // already local text
    is_published: publishState !== 'draft', // kept for legacy callers; true for private + public
    is_private: isPrivate,
    publish_state: publishState,
    signup_mode: rows[0].signup_mode || 'schedule',
    allow_overlap: Number(rows[0].allow_overlap || 0) === 1,
    stations: []
  };

  const stationMap = new Map();
  rows.forEach(row => {
    if (!row.station_id) return;
    if (!stationMap.has(row.station_id)) {
      const about = row.station_description_overview || row.station_description || '';
      const duties = row.station_description_tasks || '';
      stationMap.set(row.station_id, {
        station_id: row.station_id,
        name: row.station_name || row.s_name || row.name,
        about,
        duties,
        description: about,
        time_blocks: []
      });
    }
    if (row.block_id) {
      stationMap.get(row.station_id).time_blocks.push({
        block_id: row.block_id,
        start_time: row.start_time, // local text
        end_time: row.end_time,     // local text
        title: row.title || '',
        servings_min: row.servings_min,
        servings_max: row.servings_max,
        item_order: typeof row.item_order === 'number' ? row.item_order : (row.item_order != null ? Number(row.item_order) : undefined),
        capacity_needed:
          typeof row.capacity_needed !== 'undefined'
            ? row.capacity_needed
            : row.capacity,
        reserved_count: row.reserved_count || 0,
        is_full: !!row.is_full,
        reservations: resByBlock.get(row.block_id) || []
      });
    }
  });

  event.stations = Array.from(stationMap.values());
  return event;
}

/**
 * Create a flat, sorted roster for CSV export including volunteer contact info.
 * Sorted by time block start (datetime), then station name, then volunteer name.
 */
function getEventRosterForExport(eventId, opts = {}) {
  const event = getEventDetailsForAdmin(eventId);
  if (!event) return null;

  const rows = [];
  const stations = Array.isArray(event.stations) ? event.stations : [];
  stations.forEach(station => {
    const blocks = Array.isArray(station.time_blocks) ? station.time_blocks : [];
    blocks.forEach(block => {
      const reservations = Array.isArray(block.reservations) ? block.reservations : [];
      reservations.forEach(res => {
        rows.push({
          // Event
          event_id: event.event_id,
          event_name: event.name,
          event_description: event.description || '',
          event_start: event.date_start,
          event_end: event.date_end,
          // Station
          station_id: station.station_id,
          station_name: station.name,
          station_about: station.about || '',
          station_duties: station.duties || '',
          // Block
          block_id: block.block_id,
          block_start: block.start_time,
          block_end: block.end_time,
          servings_min: block.servings_min != null ? block.servings_min : '',
          servings_max: block.servings_max != null ? block.servings_max : '',
          servings: (block.servings_min != null)
            ? String(block.servings_min) + (block.servings_max != null ? `-${block.servings_max}` : '')
            : '',
          block_title: block.title || '',
          capacity_needed: block.capacity_needed,
          reserved_count: Array.isArray(block.reservations) ? block.reservations.length : (block.reserved_count || 0),
          is_full: !!block.is_full,
          // Volunteer & reservation
          reservation_id: res.reservation_id,
          reservation_date: res.reservation_date,
          volunteer_id: res.volunteer_id,
          volunteer_name: res.name,
          volunteer_email: res.email,
          volunteer_phone: res.phone || '',
          registrant_name: res.registrant_name || res.name,
          registrant_email: res.registrant_email || res.email,
          registrant_phone: res.phone || '',
          reservation_note: res.reservation_note || res.note || ''
        });
      });
    });
  });

  // Filtering ---------------------------------------------------------------
  const stationFilter = Array.isArray(opts.stationIds) ? opts.stationIds.map(Number).filter(Number.isFinite) : [];
  let startCanon = null;
  let endCanon = null;
  try { if (opts.start) startCanon = toCanonicalLocalString(String(opts.start)); } catch (_) {}
  try { if (opts.end) endCanon = toCanonicalLocalString(String(opts.end)); } catch (_) {}

  const filtered = rows.filter(r => {
    if (stationFilter.length && !stationFilter.includes(Number(r.station_id))) return false;
    if (startCanon && cmpLocal(toCanonicalLocalString(r.block_start), startCanon) < 0) return false;
    if (endCanon && cmpLocal(toCanonicalLocalString(r.block_start), endCanon) > 0) return false;
    return true;
  });

  // Sorting -----------------------------------------------------------------
  const sortMode = String(opts.sort || 'time_station_name');
  const cmpText = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
  const cmpNum = (a, b) => (Number(a) || 0) - (Number(b) || 0);

  const sorted = filtered.sort((a, b) => {
    if (sortMode === 'station_time_name') {
      const s = cmpText(a.station_name, b.station_name); if (s) return s;
      const t = cmpLocal(toCanonicalLocalString(a.block_start), toCanonicalLocalString(b.block_start)); if (t) return t;
      return cmpText(a.volunteer_name, b.volunteer_name);
    }
    if (sortMode === 'station_only') {
      const s = cmpText(a.station_name, b.station_name); if (s) return s;
      return cmpText(a.volunteer_name, b.volunteer_name);
    }
    // Default: time -> station -> volunteer
    const t = cmpLocal(toCanonicalLocalString(a.block_start), toCanonicalLocalString(b.block_start)); if (t) return t;
    const s = cmpText(a.station_name, b.station_name); if (s) return s;
    return cmpText(a.volunteer_name, b.volunteer_name);
  });

  // Add denormalized helpers for CSV: event_type alias
  const rowsOut = sorted.map(r => ({
    ...r,
    event_type: String(event.signup_mode || 'schedule')
  }));

  return { event, rows: rowsOut };
}

/**
 * Create a flattened list of blocks/items that still have open capacity so
 * coordinators can see what needs to be filled.
 */
function getEventOpenNeedsForExport(eventId) {
  const event = getEventDetailsForAdmin(eventId);
  if (!event) return null;

  const isPotluck = String(event.signup_mode || '').toLowerCase() === 'potluck';
  const rows = [];
  const stations = Array.isArray(event.stations) ? event.stations : [];

  stations.forEach(station => {
    const sortedBlocks = sortBlocksForExport(
      Array.isArray(station.time_blocks) ? station.time_blocks : [],
      isPotluck
    );
    sortedBlocks.forEach(block => {
      const rawCapacity = Number(block && block.capacity_needed);
      const capacity = Number.isFinite(rawCapacity) ? rawCapacity : 0;
      if (capacity <= 0) return;

      const rawReserved = Number(block && block.reserved_count);
      const reservedCount = Array.isArray(block && block.reservations)
        ? block.reservations.length
        : (Number.isFinite(rawReserved) ? rawReserved : 0);
      const openSlots = Math.max(0, capacity - reservedCount);
      if (openSlots <= 0) return;

      rows.push({
        event_id: event.event_id,
        event_name: event.name,
        event_start: event.date_start,
        event_end: event.date_end,
        station_id: station.station_id,
        station_name: station.name,
        station_about: station.about || station.description || '',
        station_duties: station.duties || '',
        block_id: block.block_id,
        block_title: block.title || '',
        block_start: block.start_time || '',
        block_end: block.end_time || '',
        servings_min: block.servings_min,
        servings_max: block.servings_max,
        capacity_needed: capacity,
        reserved_count: reservedCount,
        open_slots: openSlots
      });
    });
  });

  return { event, rows };
}

/**
 * Load a single station and its time blocks for the admin detail view. Similar
 * to `getEventDetailsForAdmin` but scoped to one station.
 */
function getStationDetailsForAdmin(stationId) {
  const rows = dal.admin.getStationWithBlocks(stationId);
  if (!rows || rows.length === 0) return null;

  const station = {
    station_id: rows[0].station_id,
    name: rows[0].station_name || rows[0].name,
    about: rows[0].station_description_overview || rows[0].station_description || '',
    duties: rows[0].station_description_tasks || '',
    description: rows[0].station_description_overview || rows[0].station_description || '',
    time_blocks: []
  };

  rows.forEach(r => {
    if (r.block_id) {
      station.time_blocks.push({
        block_id: r.block_id,
        start_time: r.start_time,
        end_time: r.end_time,
        title: r.title || '',
        servings_min: r.servings_min,
        servings_max: r.servings_max,
        item_order: typeof r.item_order === 'number' ? r.item_order : (r.item_order != null ? Number(r.item_order) : undefined),
        capacity_needed:
          typeof r.capacity_needed !== 'undefined'
            ? r.capacity_needed
            : r.capacity,
        reserved_count: r.reserved_count || 0,
        is_full: !!r.is_full
      });
    }
  });

  return station;
}

/**
 * Create a new event after validating the payload. Dates must be provided and
 * the end needs to be chronologically after the start.
 */
function createEvent(arg) {
  const data = typeof arg === 'object' && arg !== null ? arg : {};
  const { name, description, date_start, date_end } = data;
  const signup_mode = (data.signup_mode || data.mode || 'schedule').toString().trim().toLowerCase() === 'potluck'
    ? 'potluck'
    : 'schedule';

  if (!name || !date_start || !date_end) {
    throw createError(400, 'Event name, start, and end are required.');
  }
  const startTxt = toCanonicalLocalString(date_start);
  const endTxt = toCanonicalLocalString(date_end);
  if (cmpLocal(startTxt, endTxt) >= 0) throw createError(400, 'Event end must be after start.');

  return dal.admin.createEvent(name, description || '', startTxt, endTxt, signup_mode);
}

/**
 * Update an existing event with optional name/description/datetime changes.
 * Only fields present in the payload are persisted.
 */
function updateEvent(eventId, data) {
  if (!eventId) throw createError(400, 'Event ID required.');
  const patch = {};
  if (data.name !== undefined) patch.name = String(data.name || '');
  if (data.description !== undefined) patch.description = String(data.description || '');
  if (data.date_start) patch.date_start = toCanonicalLocalString(data.date_start);
  if (data.date_end) patch.date_end = toCanonicalLocalString(data.date_end);
  if (data.signup_mode !== undefined || data.mode !== undefined) {
    const mode = String(data.signup_mode || data.mode || '').trim().toLowerCase();
    if (mode === 'potluck' || mode === 'schedule') patch.signup_mode = mode;
  }
  if (data.allow_overlap !== undefined) {
    // Checkbox + hidden fallback posts ['0', '1'] when checked; the last value wins.
    const raw = Array.isArray(data.allow_overlap) ? data.allow_overlap[data.allow_overlap.length - 1] : data.allow_overlap;
    patch.allow_overlap = ['1', 'true', 'on', 'yes'].includes(String(raw).trim().toLowerCase());
  }
  if (patch.date_start && patch.date_end && cmpLocal(patch.date_start, patch.date_end) >= 0) {
    throw createError(400, 'Event end must be after start.');
  }
  return dal.admin.updateEvent(eventId, patch);
}

/**
 * Toggle the publish state of an event so it shows up (or disappears) from the
 * public signup experience.
 */
function setEventPublish(eventId, state) {
  if (!eventId) throw createError(400, 'Event ID required.');
  const normalized = String(state || '').toLowerCase();
  const publishState =
    normalized === 'private' ? 'private'
    : normalized === 'published' || normalized === 'public' ? 'published'
    : normalized === 'draft' ? 'draft'
    : (state === true || state === 1 || state === '1') ? 'published'
    : (state === false || state === 0 || state === '0') ? 'draft'
    : 'draft';
  dal.admin.setEventPublish(eventId, publishState);
  return publishState;
}


/**
 * Create a station for a given event. When a `copyStationId` is provided we
 * mirror the source station's descriptive text and time blocks so coordinators
 * can quickly spin up similar stations (e.g. multiple check-in desks).
 */
function createStation(arg1, name, description, copyStationId) {
  let eventId, nm, about, duties, copyFrom;
  if (typeof arg1 === 'object' && arg1 !== null) {
    eventId = arg1.event_id || arg1.eventId;
    nm = arg1.name;
    about = arg1.about ?? arg1.description_overview ?? arg1.summary ?? arg1.description;
    duties = arg1.duties ?? arg1.description_tasks ?? arg1.expectations ?? '';
    copyFrom = arg1.copyStationId || arg1.copy_from_station_id;
  } else {
    eventId = arg1;
    nm = name;
    about = description;
    duties = '';
    copyFrom = copyStationId;
  }
  if (!eventId || !nm) {
    throw createError(400, 'Station requires eventId and name.');
  }

  let sourceStation = null;
  const copyId = copyFrom ? Number(copyFrom) : null;

  if (copyId) {
    const rows = dal.admin.getStationWithBlocks(copyId);
    if (!rows || !rows.length) {
      throw createError(404, 'Source station not found.');
    }
    if (String(rows[0].event_id) !== String(eventId)) {
      throw createError(400, 'You can only copy stations within the same event.');
    }
    sourceStation = {
      about: rows[0].station_description_overview || rows[0].station_description || rows[0].description || '',
      duties: rows[0].station_description_tasks || '',
      blocks: rows
        .filter(row => row.block_id)
        .map(row => ({
          start_time: row.start_time,
          end_time: row.end_time,
          capacity_needed: typeof row.capacity_needed !== 'undefined' ? row.capacity_needed : row.capacity
        }))
    };
  }

  const finalAbout = (about && about.toString().trim().length)
    ? about.toString().trim()
    : (sourceStation && sourceStation.about) || '';
  const finalDuties = (duties && duties.toString().trim().length)
    ? duties.toString().trim()
    : (sourceStation && sourceStation.duties) || '';

  const result = dal.admin.createStation(eventId, nm.trim(), finalAbout, finalDuties);
  const newStationId = result.lastInsertRowid;

  if (sourceStation && sourceStation.blocks.length) {
    try {
      sourceStation.blocks.forEach(block => {
        dal.admin.createTimeBlock(newStationId, block.start_time, block.end_time, block.capacity_needed);
      });
    } catch (err) {
      try {
        dal.admin.deleteStation(newStationId);
      } catch (cleanupErr) {
        console.error('Failed to cleanup station after copy failure:', cleanupErr);
      }
      throw err;
    }
  }

  return { station_id: newStationId };
}

/**
 * Update an existing station's name and descriptive fields.
 */
function updateStation(stationId, data) {
  if (!stationId) throw createError(400, 'Station ID required.');
  const nm = data.name ? String(data.name).trim() : '';
  const about = data.about ?? data.description_overview ?? data.summary ?? data.description ?? '';
  const duties = data.duties ?? data.description_tasks ?? data.expectations ?? '';
  if (!nm) throw createError(400, 'Station name is required.');
  return dal.admin.updateStation(
    stationId,
    nm,
    String(about ?? '').trim(),
    String(duties ?? '').trim()
  );
}

/**
 * Create a time block under a station ensuring the times are valid and the
 * capacity is a positive integer.
 */
function createTimeBlock(data) {
  const { station_id } = data || {};
  let { start_time, end_time, capacity_needed, title, servings_min, servings_max } = data || {};
  if (!station_id) {
    throw createError(400, 'Station ID is required.');
  }

  // Look up the event to detect mode
  const rows = dal.admin.getStationWithBlocks(station_id);
  if (!rows || !rows.length) throw createError(404, 'Station not found.');
  const eventId = rows[0].event_id;
  const event = dal.public.getEventBasic(eventId);
  const mode = event && event.signup_mode ? String(event.signup_mode) : 'schedule';

  // In potluck mode, title is required; times can default to event start/end
  if (mode === 'potluck') {
    title = (title || '').toString().trim();
    if (!title) throw createError(400, 'Item name is required.');
    if (!start_time) start_time = event.date_start;
    if (!end_time) end_time = event.date_end;
  }

  if (!start_time || !end_time || typeof capacity_needed === 'undefined') {
    throw createError(400, 'Start, end, and capacity are required.');
  }
  const startTxt = toCanonicalLocalString(start_time);
  const endTxt = toCanonicalLocalString(end_time);
  if (cmpLocal(startTxt, endTxt) >= 0) throw createError(400, 'End time must be after start time.');
  const cap = Number(capacity_needed);
  if (!Number.isFinite(cap) || cap < 1) throw createError(400, 'Capacity must be a positive number.');

  const servings = {
    min: normalizeServingsValue(servings_min),
    max: normalizeServingsValue(servings_max)
  };
  validateServingsRange(servings.min.value, servings.max.value);

  const res = dal.admin.createTimeBlock(station_id, startTxt, endTxt, cap);
  const patch = {};
  if (title) patch.title = String(title);
  if (servings.min.provided) patch.servings_min = servings.min.value;
  if (servings.max.provided) patch.servings_max = servings.max.value;
  if (Object.keys(patch).length) {
    dal.admin.updateTimeBlock(res.lastInsertRowid, patch);
  }
  return res;
}

/**
 * Update a time block with any subset of start/end/capacity while reusing the
 * same validation routine as creation.
 */
function updateTimeBlock(blockId, data) {
  if (!blockId) throw createError(400, 'Time block ID required.');
  const patch = {};
  if (data.start_time) patch.start_time = toCanonicalLocalString(data.start_time);
  if (data.end_time) patch.end_time = toCanonicalLocalString(data.end_time);
  if (data.capacity_needed !== undefined) {
    const cap = Number(data.capacity_needed);
    if (!Number.isFinite(cap) || cap < 1) throw createError(400, 'Capacity must be a positive number.');
    patch.capacity_needed = cap;
  }
  const servings = {
    min: normalizeServingsValue(data.servings_min),
    max: normalizeServingsValue(data.servings_max)
  };
  if (servings.min.provided) patch.servings_min = servings.min.value;
  if (servings.max.provided) patch.servings_max = servings.max.value;
  if (data.title !== undefined) {
    patch.title = (data.title || '').toString().trim();
  }
  validateServingsRange(servings.min.value, servings.max.value);
  if (patch.start_time && patch.end_time && cmpLocal(patch.start_time, patch.end_time) >= 0) {
    throw createError(400, 'End time must be after start time.');
  }
  return dal.admin.updateTimeBlock(blockId, patch);
}

function slotsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function getBlockRanges(blockIds) {
  const info = dal.public.getBlocksInfo(blockIds);
  const map = new Map();
  info.forEach(b => {
    const start = new Date(String(b.start_time).replace(' ', 'T')).getTime();
    const end = new Date(String(b.end_time).replace(' ', 'T')).getTime();
    map.set(Number(b.block_id), {
      start,
      end,
      signup_mode: String(b.signup_mode || '').toLowerCase(),
      allow_overlap: Number(b.allow_overlap || 0) === 1
    });
  });
  return map;
}

function assertNoOverlapForParticipant(participantId, newBlockId, detail) {
  const assignments = Array.isArray(detail && detail.scheduleAssignments) ? detail.scheduleAssignments : [];
  const existingForParticipant = assignments.filter(a => Number(a.participant_id) === Number(participantId));
  if (!existingForParticipant.length) return;

  const blockIds = Array.from(new Set([
    ...existingForParticipant.map(a => Number(a.time_block_id)),
    Number(newBlockId)
  ].filter(Number.isFinite)));

  const blockMap = getBlockRanges(blockIds);
  const newRange = blockMap.get(Number(newBlockId));
  if (!newRange) return;
  // Only enforce for schedule events that have not opted into overlapping slots
  if ((newRange.signup_mode || 'schedule') !== 'schedule') return;
  if (newRange.allow_overlap) return;

  for (const a of existingForParticipant) {
    const range = blockMap.get(Number(a.time_block_id));
    if (!range || Number(a.time_block_id) === Number(newBlockId)) continue;
    if (slotsOverlap(range, newRange)) {
      throw createError(409, 'This participant is already assigned to an overlapping time block.');
    }
  }
}

/**
 * Add a reservation directly to a time block on behalf of a volunteer. The DAL
 * handles duplicate detection so we simply forward the normalized payload.
 */
function addReservationToBlock(blockId, volunteer, eventId, isPotluck) {
  const eventIdNum = Number(eventId);
  if (!blockId) throw createError(400, 'Time block ID required.');
  if (!Number.isFinite(eventIdNum)) throw createError(400, 'Event ID required.');
  if (!volunteer || !volunteer.name || !volunteer.email) {
    throw createError(400, 'Volunteer name and email are required.');
  }
  const dishNoteRaw = (volunteer.dish_note || volunteer.note || '').toString().trim();
  const registrantEmail = (volunteer.registrant_email || volunteer.email || '').trim();
  const registrantPhone = (volunteer.registrant_phone || volunteer.phone || '').trim();
  const blockIdNum = Number(blockId);
  const participantNameRaw = (volunteer.participant_name || volunteer.name || '').trim();
  const normalizedName = participantNameRaw.length ? participantNameRaw : volunteer.name.trim();

  // If this email already has a registration for the event, reuse it so the
  // manage link stays consistent and the person can manage all assignments.
  const existingReg = registrantEmail
    ? dal.public.findRegistrationByEmail(eventIdNum, registrantEmail)
    : null;

  if (existingReg) {
    const regDetail = dal.public.getRegistrationDetailWithAssignments(existingReg.registration_id);
    if (!regDetail) throw createError(404, 'Registration not found.');

    const participants = Array.isArray(regDetail.participants) ? regDetail.participants : [];
    const schedAssignments = Array.isArray(regDetail.scheduleAssignments)
      ? regDetail.scheduleAssignments.map(a => ({
        participantId: a.participant_id,
        blockId: Number(a.time_block_id)
      }))
      : [];
    const potAssignments = Array.isArray(regDetail.potluckAssignments)
      ? regDetail.potluckAssignments.map(a => ({
        participantId: a.participant_id,
        itemId: Number(a.item_id),
        dishName: a.dish_name
      }))
      : [];

    const existingParticipant = participants.find(
      p => p && typeof p.participant_name === 'string'
        && p.participant_name.trim().toLowerCase() === normalizedName.toLowerCase()
    );
    let participantId = existingParticipant ? existingParticipant.participant_id : null;
    let createdParticipantId = null;
    if (!participantId) {
      const addRes = dal.public.addParticipant(existingReg.registration_id, normalizedName);
      participantId = addRes && addRes.participant_id;
      createdParticipantId = participantId;
    }

    const alreadySched = schedAssignments.some(
      a => a.participantId === participantId && Number(a.blockId) === blockIdNum
    );
    const alreadyPot = potAssignments.some(
      a => a.participantId === participantId && Number(a.itemId) === blockIdNum
    );

    if (isPotluck) {
      if (!alreadyPot) {
        potAssignments.push({ participantId, itemId: blockIdNum, dishName: dishNoteRaw });
      }
    } else if (!alreadySched) {
      assertNoOverlapForParticipant(participantId, blockIdNum, regDetail);
      schedAssignments.push({ participantId, blockId: blockIdNum });
    }

    try {
      dal.public.replaceRegistrationAssignments(
        existingReg.registration_id,
        eventIdNum,
        schedAssignments,
        potAssignments,
        { debugCapacity: true }
      );
    } catch (err) {
      // Clean up the participant we just created if the save failed.
      if (createdParticipantId) {
        try { dal.public.deleteParticipant(existingReg.registration_id, createdParticipantId, true); } catch (_) {}
      }
      if (err && err.debug) {
        try { console.error('[admin:addReservation debug rows]', JSON.stringify(err.debug, null, 2)); } catch (_) {
          console.error('[admin:addReservation debug rows]', err.debug);
        }
        const schedRows = err.debug.rawSchedRows || err.debug.schedRows;
        if (Array.isArray(schedRows)) {
          schedRows.forEach(row => {
            try {
              console.error('[admin:addReservation schedRow]', JSON.stringify(row));
            } catch (_) {
              console.error('[admin:addReservation schedRow]', row);
            }
          });
        }
        if (Array.isArray(err.debug.rawSchedCounts)) {
          console.error('[admin:addReservation schedCounts]', JSON.stringify(err.debug.rawSchedCounts));
        }
        try {
          const liveRows = dal.public.getAssignmentsForBlock(blockIdNum || blockId);
          console.error('[admin:addReservation liveRows]', JSON.stringify(liveRows, null, 2));
        } catch (_) {}
      }
      throw err;
    }

    // Optionally refresh registrant contact if supplied (do not override name unless provided).
    if (volunteer.registrant_name || registrantPhone) {
      dal.admin.updateParticipantContact(participantId, normalizedName, {
        name: volunteer.registrant_name || undefined,
        email: registrantEmail,
        phone: registrantPhone || undefined
      });
    }

    return { registrationId: existingReg.registration_id, participantId };
  }

  const participantNames = [normalizedName];
  const sched = isPotluck ? [] : [{ blockId: blockIdNum, participantIndex: 0 }];
  const pot = isPotluck ? [{ itemId: blockIdNum, dishName: dishNoteRaw, participantIndex: 0 }] : [];

  // Use group-registration aware path so admin adds stay consistent.
  const result = dal.public.createRegistrationWithAssignments(
    eventIdNum,
    {
      name: volunteer.registrant_name || volunteer.name || normalizedName,
      email: registrantEmail,
      phone: registrantPhone
    },
    participantNames,
    sched,
    pot
  );
  if (!result) {
    throw createError(409, 'Unable to add volunteer to this time block.');
  }
  // Ensure any prior registrations for this email are merged into one so the
  // manage link aggregates all assignments.
  try {
    mergeRegistrationsForEmail(eventIdNum, registrantEmail, result.registrationId);
  } catch (_) {
    // do not block success; merging is best-effort
  }
  return result;
}

/**
 * Ensure only one registration exists for an event/email by merging any
 * duplicates into the primary registration. Copies assignments and participants,
 * then deletes the older registrations to avoid double-counting capacity.
 */
function mergeRegistrationsForEmail(eventId, email, primaryIdHint) {
  if (!email) return;
  const regs = dal.public.findRegistrationsByEmail(eventId, email) || [];
  if (!regs.length) return;
  const primary = (primaryIdHint && regs.find(r => r.registration_id === primaryIdHint)) || regs[0];
  const extras = regs.filter(r => r.registration_id !== primary.registration_id);
  if (!extras.length) return;

  // Build participant map for primary
  const primaryDetail = dal.public.getRegistrationDetailWithAssignments(primary.registration_id);
  const nameToParticipant = new Map();
  (primaryDetail.participants || []).forEach(p => {
    nameToParticipant.set(String(p.participant_name).trim().toLowerCase(), p.participant_id);
  });

  const schedAssignments = (primaryDetail.scheduleAssignments || []).map(a => ({
    participantId: a.participant_id,
    blockId: Number(a.time_block_id)
  }));
  const potAssignments = (primaryDetail.potluckAssignments || []).map(a => ({
    participantId: a.participant_id,
    itemId: Number(a.item_id),
    dishName: a.dish_name
  }));

  extras.forEach(reg => {
    const detail = dal.public.getRegistrationDetailWithAssignments(reg.registration_id);
    const participantIdMap = new Map();
    (detail.participants || []).forEach(p => {
      const key = String(p.participant_name).trim().toLowerCase();
      let targetId = nameToParticipant.get(key);
      if (!targetId) {
        const addRes = dal.public.addParticipant(primary.registration_id, p.participant_name);
        targetId = addRes && addRes.participant_id;
        nameToParticipant.set(key, targetId);
      }
      participantIdMap.set(p.participant_id, targetId);
    });

    (detail.scheduleAssignments || []).forEach(a => {
      const targetPid = participantIdMap.get(a.participant_id);
      if (targetPid) {
        const already = schedAssignments.some(sa => sa.participantId === targetPid && Number(sa.blockId) === Number(a.time_block_id));
        if (!already) schedAssignments.push({ participantId: targetPid, blockId: Number(a.time_block_id) });
      }
    });
    (detail.potluckAssignments || []).forEach(a => {
      const targetPid = participantIdMap.get(a.participant_id);
      if (targetPid) {
        const already = potAssignments.some(pa => pa.participantId === targetPid && Number(pa.itemId) === Number(a.item_id));
        if (!already) potAssignments.push({ participantId: targetPid, itemId: Number(a.item_id), dishName: a.dish_name });
      }
    });
  });

  dal.public.replaceRegistrationAssignments(primary.registration_id, eventId, schedAssignments, potAssignments);

  // Clean up duplicates after merging so capacity counts stay correct.
  extras.forEach(reg => {
    try { dal.public.deleteRegistrationCascade(reg.registration_id); } catch (_) {}
  });
}

/**
 * Update volunteer contact details and optionally move the reservation to a
 * different time block (while respecting capacity limits).
 */
function updateReservation(reservationId, payload) {
  if (!reservationId) throw createError(400, 'Reservation ID required.');
  const reservation = dal.admin.getReservationById(reservationId);
  if (!reservation) throw createError(404, 'Reservation not found.');

  const name = payload.name || reservation.volunteer_name;
  const email = payload.email || reservation.volunteer_email;
  const phone = payload.phone || reservation.volunteer_phone || '';
  const hasDishNoteField = Object.prototype.hasOwnProperty.call(payload, 'dish_note')
    || Object.prototype.hasOwnProperty.call(payload, 'note');
  let dishNote = undefined;
  if (hasDishNoteField) {
    const raw = payload.dish_note !== undefined ? payload.dish_note : payload.note;
    if (raw == null) {
      dishNote = null;
    } else {
      const cleaned = String(raw).trim().replace(/^\s*,\s*/, '');
      dishNote = cleaned.length ? cleaned : null;
    }
  }

  if (!name || !email) throw createError(400, 'Volunteer name and email are required.');

  // Update participant name; only update registrant contact if explicitly provided (not the case here).
  dal.admin.updateParticipantContact(reservation.volunteer_id, name, {
    email: email !== reservation.volunteer_email ? email : undefined,
    phone: phone !== reservation.volunteer_phone ? phone : undefined
  });

  if (payload.block_id && Number(payload.block_id) !== reservation.block_id) {
    // Overlap guard for schedule mode
    const detail = dal.public.getRegistrationDetailWithAssignments(reservation.registration_id);
    const newBlockId = Number(payload.block_id);
    assertNoOverlapForParticipant(reservation.volunteer_id, newBlockId, detail);
    dal.admin.moveReservation(reservationId, Number(payload.block_id));
  }

  if (hasDishNoteField) {
    dal.admin.updateReservationNote(reservationId, dishNote);
  }

  return true;
}

/**
 * Remove a reservation entirely from a time block.
 */
function deleteReservation(reservationId) {
  if (!reservationId) throw createError(400, 'Reservation ID required.');
  return dal.admin.deleteReservation(reservationId);
}

/** Convenience wrappers for deletes – DAL already validates referential cleanup. */
const deleteEvent = (id) => dal.admin.deleteEvent(id);
const deleteStation = (id) => dal.admin.deleteStation(id);
const deleteTimeBlock = (id) => dal.admin.deleteTimeBlock(id);

module.exports = {
  getDashboardData,
  getEventDetailsForAdmin,
  getStationDetailsForAdmin,
  /**
   * Create a new event by copying the structure of an existing one.
   * Copies: name (with "Copy of"), description, dates, event type, overlap
   * setting, stations, time blocks / Food Prep items (title and servings).
   * Does NOT copy: publish state (always draft), reservations.
   */
  copyEvent: (sourceEventId) => {
    const src = getEventDetailsForAdmin(sourceEventId);
    if (!src) throw createError(404, 'Source event not found.');

    const name = `Copy of ${src.name}`;
    // Ensure canonical strings
    const startTxt = src.date_start;
    const endTxt = src.date_end;
    const mode = String(src.signup_mode || '').toLowerCase() === 'potluck' ? 'potluck' : 'schedule';

    // Create new event (is_published defaults to 0 in DAL)
    const evRes = dal.admin.createEvent(name, src.description || '', startTxt, endTxt, mode);
    const newEventId = evRes.lastInsertRowid;
    if (src.allow_overlap) dal.admin.updateEvent(newEventId, { allow_overlap: true });

    // Copy stations and blocks in current order; no reservations
    (Array.isArray(src.stations) ? src.stations : []).forEach(st => {
      const sRes = dal.admin.createStation(newEventId, st.name, st.about || '', st.duties || '');
      const newStationId = sRes.lastInsertRowid;
      const blocks = Array.isArray(st.time_blocks) ? st.time_blocks : [];
      blocks.forEach(b => {
        const bRes = dal.admin.createTimeBlock(newStationId, b.start_time, b.end_time, b.capacity_needed);
        const patch = {};
        if (b.title) patch.title = b.title;
        if (b.servings_min != null) patch.servings_min = b.servings_min;
        if (b.servings_max != null) patch.servings_max = b.servings_max;
        if (Object.keys(patch).length) dal.admin.updateTimeBlock(bRes.lastInsertRowid, patch);
      });
    });

    return { event_id: newEventId };
  },
  /**
   * Reorder stations for an event. Expects an array of { station_id, station_order }.
   */
  reorderStations: (eventId, orderArray) => {
    if (!eventId) throw createError(400, 'Event ID required.');
    if (!Array.isArray(orderArray)) throw createError(400, 'Order payload must be an array.');
    const pairs = orderArray.map(item => {
      const station_id = Number(item.station_id);
      const station_order = Number(item.station_order);
      if (!Number.isFinite(station_id) || !Number.isFinite(station_order)) {
        throw createError(400, 'Invalid station payload.');
      }
      return { station_id, station_order };
    });
    return dal.admin.updateStationsOrder(pairs);
  },
  /**
   * Reorder items (time blocks) within a station. Expects an array of { block_id, item_order }.
   */
  reorderBlocks: (stationId, orderArray) => {
    if (!stationId) throw createError(400, 'Station ID required.');
    if (!Array.isArray(orderArray)) throw createError(400, 'Order payload must be an array.');
    const pairs = orderArray.map(item => {
      const block_id = Number(item.block_id);
      const item_order = Number(item.item_order);
      if (!Number.isFinite(block_id) || !Number.isFinite(item_order)) {
        throw createError(400, 'Invalid block payload.');
      }
      return { block_id, item_order };
    });
    return dal.admin.updateBlocksOrder(pairs);
  },
  createEvent,
  updateEvent,
  setEventPublish,
  createStation,
  updateStation,
  createTimeBlock,
  updateTimeBlock,
  addReservationToBlock,
  updateReservation,
  deleteReservation,
  deleteEvent,
  deleteStation,
  deleteTimeBlock,
  getEventRosterForExport,
  getEventOpenNeedsForExport,
};
