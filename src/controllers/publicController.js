// src/controllers/publicController.js
// ----------------------------------
// Handles the public-facing flow: listing events, rendering the event detail,
// processing volunteer sign-ups, and serving the manage-signup experience.
const { validationResult } = require('express-validator');
const publicService = require('../services/publicService');
const createError = require('http-errors');
const helpers = require('../views/helpers');

// "Remember this device": after signing up (or opening a manage link) we keep
// the manage token in an httpOnly cookie scoped to the event, so returning
// visitors see what they already have before signing up for more.
const REMEMBER_DAYS = Number(process.env.MANAGE_TOKEN_TTL_DAYS || 30);
const TOKEN_PATTERN = /^[a-f0-9]{16,128}$/i;
const MAX_PENDING_PICKS = 50;

function rememberCookieName(eventId) {
  return `signup_${Number(eventId)}`;
}

function readCookie(req, name) {
  const header = req.headers && req.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0 || part.slice(0, idx).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch (_) { return ''; }
  }
  return '';
}

function rememberSignup(res, eventId, token) {
  if (!eventId || !token || !TOKEN_PATTERN.test(token)) return;
  res.cookie(rememberCookieName(eventId), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: Math.max(REMEMBER_DAYS, 1) * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function forgetSignup(res, eventId) {
  if (!eventId) return;
  res.clearCookie(rememberCookieName(eventId), { path: '/' });
}

function getRememberedSignup(req, res, event) {
  const token = readCookie(req, rememberCookieName(event.event_id));
  if (!token) return null;
  const ctx = TOKEN_PATTERN.test(token) ? publicService.getManageContext(token) : null;
  if (!ctx || Number(ctx.registration.event_id) !== Number(event.event_id)) {
    forgetSignup(res, event.event_id);
    return null;
  }
  const summary = publicService.buildSignupSummary(event, ctx.participants);
  if (!summary.total) return null;
  return {
    ...summary,
    token,
    manageUrl: `/manage/${token}`,
    registrantName: ctx.registration.registrant_name || ''
  };
}

// Picks are kept as { blockId, personName, dishName } so they survive being
// handed from the sign-up page to a manage link for an existing registration.
function picksFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const names = Array.isArray(payload.participants)
    ? payload.participants.map(p => String((p && (p.name || p.participant_name)) || p || '').trim())
    : [];
  const sched = Array.isArray(payload.scheduleAssignments) ? payload.scheduleAssignments : [];
  const pot = Array.isArray(payload.potluckAssignments) ? payload.potluckAssignments : [];
  const picks = [];
  sched.forEach(a => {
    const blockId = Number(a && a.blockId);
    if (Number.isFinite(blockId)) picks.push({ blockId, personName: names[Number(a.participantIndex)] || '', dishName: '' });
  });
  pot.forEach(a => {
    const blockId = Number(a && a.itemId);
    if (Number.isFinite(blockId)) {
      picks.push({ blockId, personName: names[Number(a.participantIndex)] || '', dishName: String(a.dishName || '').slice(0, 200) });
    }
  });
  return picks.slice(0, MAX_PENDING_PICKS).map(p => ({ ...p, personName: p.personName.slice(0, 100) }));
}

function stashPendingPicks(req, eventId, picks) {
  if (!req.session || !eventId || !picks.length) return;
  req.session.pendingPicks = req.session.pendingPicks || {};
  req.session.pendingPicks[String(Number(eventId))] = picks;
}

function takePendingPicks(req, eventId) {
  const store = req.session && req.session.pendingPicks;
  const key = String(Number(eventId));
  if (!store || !store[key]) return [];
  const picks = Array.isArray(store[key]) ? store[key] : [];
  delete store[key];
  return picks;
}

function redactRequestBody(body) {
    if (!body || typeof body !== 'object') return {};
    try {
        const clone = JSON.parse(JSON.stringify(body));
        ['name', 'email', 'phone', 'phone_number'].forEach((k) => {
            if (Object.prototype.hasOwnProperty.call(clone, k)) clone[k] = '[redacted]';
        });
        if (clone.dish_notes) clone.dish_notes = '[redacted]';
        return clone;
    } catch (_) {
        return {};
    }
}

exports.showEventsList = (req, res, next) => {
    try {
        const events = publicService.getPublicEvents();
        if (!events || events.length === 0) {
            // If there are no published events, render a friendly landing page
            return res.render('public/no-events', { title: 'No Volunteer Opportunities' });
        }
        const sortedEvents = events.slice().sort((a, b) => {
            const at = new Date(a.date_start).getTime();
            const bt = new Date(b.date_start).getTime();
            if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
            if (Number.isNaN(at)) return 1;
            if (Number.isNaN(bt)) return -1;
            return at - bt;
        });
        const envBase = (process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
        const requestHost = req.get && req.get('host') ? req.get('host') : '';
        const requestBase = (req.protocol && requestHost) ? `${req.protocol}://${requestHost}` : '';
        const shareBaseUrl = envBase || requestBase || '';
        res.render('public/events-list', {
            title: 'Upcoming Events',
            events: sortedEvents,
            helpers,
            shareBaseUrl
        });
    } catch (error) { 
        console.error("--- ERROR IN showEventsList Controller ---", error);
        next(error); 
    }
};

// Volunteer help (public)
exports.showVolunteerHelp = (req, res, next) => {
  try {
    res.render('public/help-volunteers', {
      title: 'Volunteer Help',
      helpers
    });
  } catch (error) {
    console.error('--- ERROR IN showVolunteerHelp ---', error);
    next(error);
  }
};

exports.showEventDetail = (req, res, next) => {
    try {
        const eventId = req.params.eventId;
        const preview = !!(req.user && (req.query.preview === '1' || String(req.query.preview).toLowerCase() === 'true'));
        // Optional return link (when coming from admin preview). Keep internal paths only.
        let backTo = null;
        if (typeof req.query.return === 'string' && req.query.return.startsWith('/')) {
          backTo = req.query.return;
        }
        const event = preview
          ? publicService.getEventDetailsForPreview(eventId)
          : publicService.getEventDetailsForPublic(eventId);
        if (!event) {
            req.flash('error', 'That event is no longer available.');
            return res.redirect('/events');
        }
        const debugLayout = String(req.query.debug || '').toLowerCase() === 'layout';
        const mySignup = preview ? null : getRememberedSignup(req, res, event);
        // Do not pass messages explicitly; app middleware exposes res.locals.messages
        res.render('public/event-detail', { title: event.name, event, helpers, preview, backTo, debugLayout, mySignup, query: req.query });
    } catch (error) {
        console.error(`--- ERROR IN showEventDetail for eventId: ${req.params.eventId} ---`, error);
        next(error);
    }
};

exports.handleSignup = async (req, res, next) => {
    const errors = validationResult(req);
    let payload = {};
    try {
      payload = JSON.parse(req.body.registration_payload || '{}');
    } catch (_) {
      payload = {};
    }
    payload.eventId = payload.eventId || req.body.eventId || req.body.event_id || req.body.event;
    if (!payload.registrant) {
      payload.registrant = {
        name: req.body.name,
        email: req.body.email,
        phone: req.body.phone
      };
    }

    if (!payload.eventId) {
      if (process.env.DEBUG_SIGNUP === '1' || process.env.NODE_ENV !== 'production') {
        try { req.flash('debug', JSON.stringify({ error: 'Missing eventId', body: redactRequestBody(req.body) }, null, 2)); } catch (_) {}
      }
      return res.redirect('/events');
    }

    if (!errors.isEmpty()) {
      const errs = errors.array();
      errs.forEach(error => req.flash('error', error.msg));
      const evt = publicService.getEventDetailsForPublic(payload.eventId);
      return res.status(400).render('public/event-detail', {
        title: (evt && evt.name) || 'Event',
        event: evt,
        helpers,
        draftRegistration: payload,
        messages: req.flash()
      });
    }

    try {
      const result = await publicService.processVolunteerSignup(payload);
      if (result.alreadyRegistered) {
        stashPendingPicks(req, payload.eventId, picksFromPayload(payload));
      }
      // Anyone can type any email, so only a brand-new sign-up is remembered on
      // this device; an existing one is reached through the emailed link only.
      if (result.token && !result.alreadyRegistered) rememberSignup(res, payload.eventId, result.token);
      const evt = publicService.getEventDetailsForPublic(payload.eventId);
      const summary = (evt && result.participants)
        ? publicService.buildSignupSummary(evt, result.participants)
        : null;
      res.render('public/success', {
        title: 'Sign-up Successful!',
        count: summary ? summary.total : 0,
        summary,
        calendar: (evt && !result.alreadyRegistered)
          ? publicService.getCalendarLinks({ event: evt, participants: result.participants, registrationId: result.registrationId, token: result.token })
          : null,
        eventId: payload.eventId,
        eventName: evt ? evt.name : '',
        manageUrl: result.manageUrl,
        alreadyRegistered: result.alreadyRegistered,
        volunteerEmail: payload.registrant ? payload.registrant.email : req.body.email
      });
    } catch (error) {
      console.error(`--- ERROR IN handleSignup for eventId: ${payload.eventId} ---`, error);
      req.flash('error', error.message || 'We could not process your signup.');
      if (process.env.DEBUG_SIGNUP === '1' || process.env.NODE_ENV !== 'production') {
        const debugBlob = {
          eventId: payload.eventId,
          status: error.status || undefined,
          code: error.code || undefined,
          message: error.message,
        };
        try { req.flash('debug', JSON.stringify(debugBlob, null, 2)); } catch (_) {}
      }
      // Re-render with the draft so volunteers keep their picks and details.
      const evt = publicService.getEventDetailsForPublic(payload.eventId);
      if (!evt) return res.redirect('/events');
      return res.status(error.status || 400).render('public/event-detail', {
        title: evt.name,
        event: evt,
        messages: req.flash(),
        helpers,
        draftRegistration: payload
      });
    }
};

// "Not you?" on the event page: stop remembering this device's sign-up.
exports.forgetRememberedSignup = (req, res) => {
  const eventId = Number(req.params.eventId);
  forgetSignup(res, eventId);
  req.flash('success', 'This device no longer shows that sign-up. You can start a new one below.');
  return res.redirect(Number.isFinite(eventId) ? `/events/${eventId}` : '/events');
};

exports.showManageSignup = (req, res, next) => {
    try {
        const token = req.params.token;
        const context = publicService.getManageContext(token);
        if (!context) {
            req.flash('error', 'That management link is no longer valid.');
            return res.redirect('/events');
        }

        const { event, participants, registration } = context;
        rememberSignup(res, event.event_id, token);

        // Picks carried over from the event page: held picks from a sign-up
        // attempt with an already-registered email, or "?add=<id>" links.
        const pendingPicks = takePendingPicks(req, event.event_id);
        const addParam = req.query.add;
        (Array.isArray(addParam) ? addParam : (addParam ? [addParam] : [])).forEach(raw => {
          const blockId = Number(raw);
          if (Number.isFinite(blockId) && pendingPicks.length < MAX_PENDING_PICKS) {
            pendingPicks.push({ blockId, personName: '', dishName: '' });
          }
        });
        const emailPreferences = {
            optIn: Number(registration.email_opt_in ?? 1) !== 0,
            optedOutAt: registration.email_opted_out_at || null,
            optedOutReason: registration.email_opt_out_reason || null,
            volunteerEmail: registration.registrant_email || ''
        };

        const debugCapacity = String(req.query.debug || '').toLowerCase() === 'capacity';

        res.render('public/manage-signup', {
            title: `Manage ${event.name}`,
            event,
            token,
            registration,
            participants,
            pendingPicks,
            summary: publicService.buildSignupSummary(event, participants),
            calendar: publicService.getCalendarLinks({ event, participants, registrationId: registration.registration_id, token }),
            helpers,
            emailPreferences,
            query: req.query,
            debugCapacity
        });
    } catch (error) {
        console.error('--- ERROR IN showManageSignup ---', error);
        next(error);
    }
};

exports.downloadCalendar = (req, res, next) => {
  try {
    const file = publicService.getCalendarFile(req.params.token, req.query.block);
    if (!file) {
      req.flash('error', 'That management link is no longer valid.');
      return res.redirect('/events');
    }
    if (!file.entries.length) {
      req.flash('error', 'There’s nothing to add to your calendar yet.');
      return res.redirect(`/manage/${encodeURIComponent(req.params.token)}`);
    }
    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Cache-Control': 'private, no-store'
    });
    res.send(file.content);
  } catch (error) {
    next(error);
  }
};

exports.updateManageSignup = async (req, res, next) => {
  const token = req.params.token;
  const action = req.body.action || '';
  const debugCapacity = String(req.query.debug || '').toLowerCase() === 'capacity';

  try {
    if (action === 'rename') {
      await publicService.renameParticipant(token, Number(req.body.participantId || req.body.participant_id), req.body.name || req.body.participant_name);
      req.flash('success', 'Participant name updated.');
      return res.redirect(`/manage/${token}`);
    }
    if (action === 'add') {
      await publicService.addParticipant(token, req.body.name || req.body.participant_name);
      req.flash('success', 'Participant added.');
      return res.redirect(`/manage/${token}`);
    }
    if (action === 'merge') {
      await publicService.mergeParticipants(token, Number(req.body.fromId || req.body.from_id), Number(req.body.toId || req.body.to_id));
      req.flash('success', 'Participants merged.');
      return res.redirect(`/manage/${token}`);
    }
    if (action === 'delete') {
      const removeAssignments = String(req.body.removeAssignments || req.body.remove_assignments || '') === '1';
      await publicService.deleteParticipant(token, Number(req.body.participantId || req.body.participant_id), removeAssignments);
      req.flash('success', 'Participant removed.');
      return res.redirect(`/manage/${token}`);
    }

    let payload = {};
    try {
      payload = JSON.parse(req.body.registration_payload || '{}');
    } catch (_) {
      payload = {};
    }
    const scheduleAssignments = payload.scheduleAssignments || [];
    const potluckAssignments = payload.potluckAssignments || [];

    const result = await publicService.updateVolunteerSignup(token, scheduleAssignments, potluckAssignments, { debugCapacity });
    if (debugCapacity && result && result.debug) {
      req.flash('debug', JSON.stringify(result.debug, null, 2));
    }
    if (result && result.deleted) {
      forgetSignup(res, result.eventId);
      req.flash('success', 'Your selections have been cleared.');
      return res.redirect(result.eventId ? `/events/${result.eventId}` : '/events');
    }
    req.flash('success', 'Your volunteer schedule has been updated. Check your email for confirmation.');
    res.redirect(`/manage/${token}${debugCapacity ? '?debug=capacity' : ''}`);
  } catch (error) {
    console.error('--- ERROR IN updateManageSignup ---', error);
    req.flash('error', error.message || 'Unable to update your schedule.');
    if (debugCapacity && error && error.debug) {
      try {
        req.flash('debug', JSON.stringify(error.debug, null, 2));
      } catch (_) {}
    }
    if (process.env.DEBUG_SIGNUP === '1' || process.env.NODE_ENV !== 'production') {
      const debugBlob = {
        token,
        status: error.status || undefined,
        code: error.code || undefined,
        message: error.message,
      };
      try { req.flash('debug', JSON.stringify(debugBlob, null, 2)); } catch (_) {}
    }
    if (error.status === 410) {
      return res.redirect('/events');
    }
    res.redirect(`/manage/${token}${debugCapacity ? '?debug=capacity' : ''}`);
  }
};

exports.updateEmailPreference = async (req, res) => {
  const token = req.params.token;
  const preference = req.body.preference;
  const reason = typeof req.body.reason === 'string' ? req.body.reason : '';
  try {
    const result = await publicService.updateEmailPreference(token, preference, reason);
    if (result.optedIn) {
      req.flash('success', 'Volunteer emails have been resumed for this contact.');
    } else {
      req.flash('success', 'You have unsubscribed from future volunteer emails.');
    }
    return res.redirect(`/manage/${token}#email-preferences`);
  } catch (error) {
    console.error('--- ERROR IN updateEmailPreference ---', error);
    req.flash('error', error.message || 'Unable to update email preferences.');
    if (error.status === 410) {
      return res.redirect('/events');
    }
    return res.redirect(`/manage/${token}`);
  }
};

// AJAX: check if a registration already exists for this event/email; if so, send manage link(s).
exports.checkDuplicateRegistration = async (req, res) => {
  try {
    const eventId = req.body.eventId || req.body.event_id || req.body.event;
    const email = (req.body.email || '').trim();
    if (!eventId || !email) {
      return res.status(400).json({ ok: false, error: 'Missing event or email.' });
    }
    const result = await publicService.checkDuplicateRegistration(eventId, email);
    if (result && result.duplicate) {
      stashPendingPicks(req, eventId, picksFromPayload(req.body.payload));
    }
    return res.json({ ok: result.ok, duplicate: !!result.duplicate });
  } catch (err) {
    console.error('--- ERROR IN checkDuplicateRegistration ---', err);
    return res.status(500).json({ ok: false, error: 'Unable to check duplicates.' });
  }
};

// Sends a manage-link reminder email if a volunteer signup exists for the
// given event and email. Responds with a generic success either way.
exports.sendManageReminder = async (req, res) => {
  const eventId = req.body.eventId || req.body.event_id || req.body.event;
  const email = (req.body.email || '').trim();
  try {
    if (!eventId || !email) {
      // generic message, do not reveal specifics
      try { req.flash('success', 'If we found a signup for that email, we sent a manage link. Please check your inbox.'); } catch (_) {}
      return res.redirect(eventId ? `/events/${eventId}` : '/events');
    }
    await publicService.sendManageReminder(email, eventId);
    try { req.flash('success', 'If we found a signup for that email, we sent a manage link. Please check your inbox.'); } catch (_) {}
    return res.redirect(`/events/${eventId}`);
  } catch (error) {
    console.error('--- ERROR IN sendManageReminder ---', error);
    try { req.flash('success', 'If we found a signup for that email, we sent a manage link. Please check your inbox.'); } catch (_) {}
    return res.redirect(eventId ? `/events/${eventId}` : '/events');
  }
};
