// src/services/publicService.js
// ---------------------------------------------------------------------------
// Handles public/group registration flows and manage-link operations.
// Responsibilities:
// - Shape event data for the public pages (schedule vs. potluck modes)
// - Validate incoming signups, enforce non-overlapping slots, and create manage links
// - Send confirmation/reminder emails and respect opt-out preferences
const crypto = require('crypto');
const createError = require('http-errors');
const dal = require('../db/dal');
const { fmt12, fmtRange: fmtSlotRange } = require('../views/helpers');
const { sendMail } = require('../utils/mailer');
const { getBranding } = require('../config/branding');
const calendar = require('./calendarService');

const APP_BASE_URL = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN_TTL_DAYS = Number(process.env.MANAGE_TOKEN_TTL_DAYS || 30);

function mapEventRows(rows) {
  if (!rows || rows.length === 0 || !rows[0].event_id) return null;

  const event = {
    event_id: rows[0].event_id,
    name: rows[0].name,
    description: rows[0].description,
    date_start: rows[0].date_start,
    date_end: rows[0].date_end,
    signup_mode: rows[0].signup_mode || 'schedule',
    allow_overlap: Number(rows[0].allow_overlap || 0) === 1,
    stations: []
  };

  const stationMap = new Map();
  rows.forEach(row => {
    if (!row.station_id) return;
    if (!stationMap.has(row.station_id)) {
      const about = row.station_description_overview || row.station_description || row.s_description || '';
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
      const notesRaw = (row.notes_csv ? String(row.notes_csv) : '').split('||').map(s => s.trim()).filter(Boolean);
      const notesWithNamesRaw = (row.notes_with_names_csv ? String(row.notes_with_names_csv) : '').split('||').map(s => s.trim()).filter(Boolean);
      function toShortName(full) {
        if (!full) return '';
        const parts = String(full).trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return '';
        const first = parts[0];
        const last = parts.length > 1 ? parts[parts.length - 1].charAt(0).toUpperCase() + '.' : '';
        return last ? `${first} ${last}` : first;
      }
      const notes = notesWithNamesRaw.length
        ? notesWithNamesRaw.map(pair => {
            const idx = pair.indexOf('::');
            if (idx === -1) return { text: pair, by: '' };
            const text = pair.slice(0, idx).trim();
            const name = pair.slice(idx + 2).trim();
            return { text, by: toShortName(name) };
          })
        : notesRaw.map(text => ({ text, by: '' }));
      stationMap.get(row.station_id).time_blocks.push({
        block_id: row.block_id,
        start_time: row.start_time,
        end_time: row.end_time,
        capacity_needed: typeof row.capacity_needed !== 'undefined' ? row.capacity_needed : row.capacity,
        reserved_count: row.reserved_count || 0,
        servings_min: row.servings_min,
        servings_max: row.servings_max,
        title: row.title || '',
        is_full: !!row.is_full,
        dish_notes: notes
      });
    }
  });

  event.stations = Array.from(stationMap.values());
  return event;
}

function getPublicEvents() {
  return dal.public.listUpcomingEvents();
}

function enrichPotluckDishNotes(event, eventId) {
  try {
    if (event && String(event.signup_mode) === 'potluck') {
      const pairs = dal.public.getDishNotesWithNamesForEvent(Number(eventId));
      const byBlock = new Map();
      pairs.forEach(p => {
        const list = byBlock.get(p.block_id) || [];
        const name = (p.name || '').trim();
        const parts = name.split(/\s+/).filter(Boolean);
        const short = parts.length
          ? parts[0] + (parts.length > 1 ? ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.' : '')
          : '';
        list.push({ text: (p.note || '').trim(), by: short });
        byBlock.set(p.block_id, list);
      });
      (event.stations || []).forEach(st => {
        (st.time_blocks || []).forEach(tb => {
          const withNames = byBlock.get(tb.block_id);
          if (withNames && withNames.length) tb.dish_notes = withNames;
        });
      });
    }
  } catch (e) {
    console.warn('[PublicService] Failed to enrich dish notes with names:', e && e.message);
  }
  return event;
}

function getEventDetailsForPublic(eventId) {
  const rows = dal.public.getEventForPublic(eventId);
  const event = mapEventRows(rows);
  return enrichPotluckDishNotes(event, eventId);
}

function getEventDetailsForPreview(eventId) {
  const rows = dal.admin.getEventById(eventId);
  const event = mapEventRows(rows);
  return event;
}

function parseLocalDate(value) {
  if (!value) return null;
  const str = String(value).replace(' ', 'T');
  const maybe = new Date(str);
  return Number.isNaN(maybe.getTime()) ? null : maybe;
}

function fmtRange(start, end) {
  const s = parseLocalDate(start);
  const e = parseLocalDate(end);
  if (!s && !e) return '';
  if (s && e) return `${fmt12(s.toISOString())} – ${fmt12(e.toISOString())}`;
  return s ? fmt12(s.toISOString()) : fmt12(e.toISOString());
}

function buildManageUrl(token) {
  return `${APP_BASE_URL}/manage/${token}`;
}

function computeExpiryDate(days = TOKEN_TTL_DAYS) {
  if (!Number.isFinite(days) || days <= 0) return null;
  const dt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return dt.toISOString();
}

function issueManageToken(registrationId) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = computeExpiryDate();
  dal.public.storeRegistrationToken(token, registrationId, expiresAt);
  return token;
}

const MAX_HELD_PICKS = 50;
const HELD_PICKS_DAYS = 7;

// Picks are kept as { blockId, personName, dishName } so they survive being
// handed from the sign-up page to the emailed manage link.
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
  return picks.slice(0, MAX_HELD_PICKS).map(p => ({ ...p, personName: p.personName.slice(0, 100) }));
}

// Pairs each pick with a readable label, dropping spots not in this event.
function describeHeldPicks(event, picks) {
  if (!event || !Array.isArray(picks) || !picks.length) return [];
  const isPotluck = String(event.signup_mode || '').toLowerCase() === 'potluck';
  const blocks = new Map();
  (event.stations || []).forEach(st => {
    (st.time_blocks || []).forEach(tb => blocks.set(Number(tb.block_id), { stationName: st.name || 'Station', tb }));
  });
  return picks.map(pick => {
    const found = blocks.get(Number(pick.blockId));
    if (!found) return null;
    const label = isPotluck
      ? `${found.stationName} — ${found.tb.title || 'Item'}`
      : `${found.stationName} — ${fmtSlotRange(found.tb.start_time, found.tb.end_time)}`;
    return { pick, label };
  }).filter(Boolean);
}

function getHeldPicks(registrationId) {
  const { picks, at } = dal.public.getHeldPicks(registrationId);
  if (!picks.length || !at) return [];
  if (Date.now() - new Date(at).getTime() > HELD_PICKS_DAYS * 24 * 60 * 60 * 1000) return [];
  return picks;
}

/**
 * Merge duplicate registrations for the same event/email into a single
 * registration so the person has one manage link. Returns the surviving
 * registration (or null if none).
 */
function mergeRegistrationsForEmail(eventId, email, primaryIdHint) {
  if (!email) return null;
  // Remove any empty shells before merging
  try { dal.public.deleteEmptyRegistrations(eventId, email); } catch (_) {}
  const regs = dal.public.findRegistrationsByEmail(eventId, email) || [];
  if (!regs.length) return null;
  const primary = (primaryIdHint && regs.find(r => r.registration_id === primaryIdHint)) || regs[0];
  const extras = regs.filter(r => r.registration_id !== primary.registration_id);
  if (!extras.length) return primary;

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
        const exists = schedAssignments.some(sa => sa.participantId === targetPid && Number(sa.blockId) === Number(a.time_block_id));
        if (!exists) schedAssignments.push({ participantId: targetPid, blockId: Number(a.time_block_id) });
      }
    });
    (detail.potluckAssignments || []).forEach(a => {
      const targetPid = participantIdMap.get(a.participant_id);
      if (targetPid) {
        const exists = potAssignments.some(pa => pa.participantId === targetPid && Number(pa.itemId) === Number(a.item_id));
        if (!exists) potAssignments.push({ participantId: targetPid, itemId: Number(a.item_id), dishName: a.dish_name });
      }
    });
  });

  // Count extras so capacity checks know these rows will be removed
  const ignoreSched = [];
  const ignorePot = [];
  extras.forEach(reg => {
    const detail = dal.public.getRegistrationDetailWithAssignments(reg.registration_id);
    (detail.scheduleAssignments || []).forEach(a => ignoreSched.push(Number(a.time_block_id)));
    (detail.potluckAssignments || []).forEach(a => ignorePot.push(Number(a.item_id)));
  });

  dal.public.replaceRegistrationAssignments(
    primary.registration_id,
    eventId,
    schedAssignments,
    potAssignments,
    { ignoreSchedCounts: ignoreSched, ignorePotCounts: ignorePot }
  );
  // Remove extras after successful merge so capacity math was accurate but data is consolidated.
  extras.forEach(reg => {
    try { dal.public.deleteRegistrationCascade(reg.registration_id); } catch (_) {}
  });
  try { dal.public.deleteEmptyRegistrations(eventId, email); } catch (_) {}
  return primary;
}

/**
 * Maintenance helper: merge all duplicate registrations for an event so each
 * email has at most one registration (and delete empties).
 */
function mergeAllDuplicatesForEvent(eventId) {
  const eventIdNum = Number(eventId);
  if (!Number.isFinite(eventIdNum)) return { merged: 0, conflicts: [] };
  const regs = dal.public.listRegistrationsForEvent
    ? dal.public.listRegistrationsForEvent(eventIdNum)
    : [];
  const seen = new Map();
  regs.forEach(r => {
    const key = (r.registrant_email || '').trim().toLowerCase();
    if (!key) return;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(r);
  });
  let mergedCount = 0;
  const conflicts = [];
  for (const [email] of seen) {
    try {
      const primary = mergeRegistrationsForEmail(eventIdNum, email);
      if (primary) mergedCount += 1;
    } catch (err) {
      conflicts.push({ email, error: err && err.message ? err.message : String(err) });
    }
  }
  try { dal.public.deleteEmptyRegistrations(eventIdNum, null); } catch (_) {}
  return { merged: mergedCount, conflicts };
}

function resolveSupportContact() {
  const branding = getBranding();
  const supportName = branding.supportContactName || branding.orgName || 'Our team';
  const supportEmail = branding.supportContactEmail;
  const supportPhone = branding.supportContactPhone;
  const orgName = branding.orgName || supportName;
  const orgMailingAddress = branding.mailingAddress || '';
  const supportContactHtml = (() => {
    if (!supportEmail && !supportPhone) {
      return 'Reply to this email and we will help you.';
    }
    const emailHtml = supportEmail
      ? ` at <a href="mailto:${supportEmail}" style="color:#2563eb; font-weight:600;">${supportEmail}</a>`
      : '';
    const sanitizedPhone = supportPhone ? supportPhone.replace(/[^0-9+]/g, '') : '';
    const phoneHtml = supportPhone
      ? `${supportEmail ? ' or call ' : ' at '}<a href="tel:${sanitizedPhone}" style="color:#2563eb; font-weight:600;">${supportPhone}</a>`
      : '';
    return `Reach out${emailHtml}${phoneHtml}.`;
  })();
  return { supportName, supportEmail, supportPhone, supportContactHtml, orgName, orgMailingAddress };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeAddressLines(address) {
  if (!address) return [];
  return String(address)
    .split(/\r?\n+/)
    .map(line => line.trim())
    .filter(Boolean);
}

function buildComplianceFooter({ orgName, supportEmail, supportPhone, mailingAddress, manageUrl }) {
  const safeOrg = orgName || 'Volunteer Team';
  const contactParts = [`Sent by ${safeOrg}`];
  if (supportEmail) contactParts.push(`Email: ${supportEmail}`);
  if (supportPhone) contactParts.push(`Phone: ${supportPhone}`);

  const textLines = contactParts.length ? [contactParts.join(' | ')] : [];
  const addressLines = normalizeAddressLines(mailingAddress);
  if (addressLines.length) {
    textLines.push(`Mailing address: ${addressLines.join(', ')}`);
  }

  const unsubscribeUrl = manageUrl ? `${manageUrl}#email-preferences` : '';
  if (unsubscribeUrl) {
    textLines.push(`Manage your volunteer email preferences: ${unsubscribeUrl}`);
  }

  const linkColor = '#2563eb';
  const htmlSections = [];
  const contactHtmlParts = [`Sent by <strong>${escapeHtml(safeOrg)}</strong>`];
  if (supportEmail) {
    contactHtmlParts.push(`Email: <a href="mailto:${escapeHtml(supportEmail)}" style="color:${linkColor};">${escapeHtml(supportEmail)}</a>`);
  }
  if (supportPhone) {
    const telValue = supportPhone.replace(/[^0-9+]/g, '');
    contactHtmlParts.push(`Phone: <a href="tel:${telValue}" style="color:${linkColor};">${escapeHtml(supportPhone)}</a>`);
  }
  htmlSections.push(`<p style="margin:0 0 12px; color:#475569; font-size:13px;">${contactHtmlParts.join(' &nbsp;&bull;&nbsp; ')}</p>`);
  if (addressLines.length) {
    htmlSections.push(`<p style="margin:8px 0 0; color:#94a3b8; font-size:12px;">Mailing address:<br>${addressLines.map(escapeHtml).join('<br />')}</p>`);
  }
  if (unsubscribeUrl) {
    htmlSections.push(`<p style="margin:12px 0 0; font-size:13px; color:#475569;">Manage email preferences: <a href="${unsubscribeUrl}" style="color:${linkColor};">${unsubscribeUrl}</a></p>`);
  }

  const htmlBlock = `
    <div style="margin-top:32px; padding:20px 24px; background-color:#f8fafc; border-radius:16px; border:1px solid rgba(15,23,42,0.08);">
      <p style="margin:0 0 12px; color:#475569; font-size:13px;">You're receiving this email because you registered as a volunteer. You can update your communication preferences anytime.</p>
      ${htmlSections.join('')}
    </div>
  `;

  return {
    textLines,
    htmlBlock,
    unsubscribeUrl,
    listUnsubscribe: unsubscribeUrl ? `<${unsubscribeUrl}>` : null
  };
}

function groupAssignments(detail) {
  const participants = (detail.participants || []).map(p => ({
    participant_id: p.participant_id,
    participant_name: p.participant_name,
    schedule: [],
    potluck: []
  }));
  const byId = new Map(participants.map(p => [p.participant_id, p]));
  (detail.scheduleAssignments || []).forEach(assign => {
    const target = byId.get(assign.participant_id);
    if (target) target.schedule.push(assign);
  });
  (detail.potluckAssignments || []).forEach(assign => {
    const target = byId.get(assign.participant_id);
    if (target) target.potluck.push(assign);
  });
  return participants;
}

async function sendConfirmationEmail({ registration, event, participants, manageUrl, isUpdate }) {
  if (!registration || !registration.registrant_email) return;
  if (typeof registration.email_opt_in !== 'undefined' && Number(registration.email_opt_in) === 0) {
    console.info('[PublicService] Skipping confirmation email to %s (registrant opted out).', registration.registrant_email);
    return;
  }

  const { supportName, supportEmail, supportPhone, supportContactHtml, orgName, orgMailingAddress } = resolveSupportContact();
  const isPotluckEmail = String(event && event.signup_mode || '').toLowerCase() === 'potluck';
  const subject = isPotluckEmail
    ? (isUpdate ? `Updated food prep signup for ${event.name}` : `Your food prep signup for ${event.name}`)
    : (isUpdate ? `Updated volunteer schedule for ${event.name}` : `Your volunteer schedule for ${event.name}`);

  const listItems = participants.length
    ? participants.map(p => {
        const lines = [];
        if (p.schedule && p.schedule.length) {
          p.schedule.forEach(slot => {
            const timeStr = fmtRange(slot.start_time, slot.end_time);
            lines.push(`• ${p.participant_name}: ${slot.station_name}${timeStr ? ' — ' + timeStr : ''}`);
          });
        }
        if (p.potluck && p.potluck.length) {
          p.potluck.forEach(slot => {
            const dish = slot.dish_name ? ` (Dish: ${slot.dish_name})` : '';
            lines.push(`• ${p.participant_name}: ${slot.station_name} — ${slot.title || 'Item'}${dish}`);
          });
        }
        return lines.join('\n');
      }).filter(Boolean).join('\n')
    : 'You currently have no reserved opportunities.';

  const calendarEntries = calendar.buildEntries({
    event,
    participants,
    registrationId: registration.registration_id,
    manageUrl
  });
  const calendarUrl = calendarEntries.length && manageUrl ? `${manageUrl}/calendar.ics` : '';

  const complianceFooter = buildComplianceFooter({
    orgName,
    supportEmail,
    supportPhone,
    mailingAddress: orgMailingAddress,
    manageUrl
  });

  const textLines = (function(){
    const lines = [`Hi ${registration.registrant_name || registration.registrant_email},`, ''];
    if (isPotluckEmail) {
      lines.push(`Thank you for contributing to the food prep for ${event.name}!`);
      lines.push('');
      lines.push('Here is your group summary:');
    } else {
      lines.push(`Thank you for serving with us at ${event.name}!`);
      lines.push('');
      lines.push('Here is your group schedule:');
    }
    lines.push(listItems || 'No assignments yet.', '', `Manage your signup here: ${manageUrl}`);
    if (calendarUrl) lines.push(`Add to your calendar (file attached, or download): ${calendarUrl}`);
    lines.push('', 'If you have any questions or run into trouble, reach out to us:');
    const contactLines = [];
    if (supportEmail) contactLines.push(`Email: ${supportEmail}`);
    if (supportPhone) contactLines.push(`Phone: ${supportPhone}`);
    if (contactLines.length) {
      lines.push(...contactLines);
    } else {
      lines.push('Reply to this email and we will help you.');
    }
    lines.push('', 'With gratitude,', supportName || 'Volunteer Team', '', 'If you did not request this email you can ignore it.');
    if (complianceFooter.textLines.length) {
      lines.push('', ...complianceFooter.textLines);
    }
    return lines;
  })();

  const text = textLines.join('\n');
  const groupedHtml = participants.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0 24px;">
        ${participants.map((p, idx) => `
          <tr>
            <td style="padding:0 0 12px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
                <tr>
                  <td bgcolor="#f0f4ff" style="background-color:#f0f4ff; border-radius:12px; padding:12px 16px; font-family:'Segoe UI', Arial, sans-serif;">
                    <p style="margin:0 0 6px; font-weight:700; color:#1d4ed8; font-size:15px;">${escapeHtml(p.participant_name)}</p>
                    ${(p.schedule || []).map(slot => `<p style="margin:0 0 6px; color:#475569; font-size:14px;">${escapeHtml(slot.station_name)} — ${escapeHtml(fmtRange(slot.start_time, slot.end_time))}</p>`).join('')}
                    ${(p.potluck || []).map(slot => `<p style="margin:0 0 6px; color:#475569; font-size:14px;">${escapeHtml(slot.station_name)} — ${escapeHtml(slot.title || 'Item')}${slot.dish_name ? ' • Dish: ' + escapeHtml(slot.dish_name) : ''}</p>`).join('')}
                    ${(!p.schedule.length && !p.potluck.length) ? '<p style="margin:0; color:#94a3b8;">No assignments yet.</p>' : ''}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ${idx < participants.length - 1 ? '<tr><td height="6" style="font-size:0; line-height:0;">&nbsp;</td></tr>' : ''}
        `).join('')}
      </table>`
    : '<p style="margin:16px 0 24px; color:#475569; font-family:\'Segoe UI\', Arial, sans-serif;">You currently have no reserved opportunities.</p>';

  const html = `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Volunteer Schedule</title>
        <style>
          a { text-decoration:none; }
        </style>
      </head>
      <body style="margin:0; padding:0; background-color:#dfe4f3;">
        <div role="article" aria-roledescription="email" lang="en" style="background-color:#dfe4f3;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#dfe4f3; margin:0;">
            <tr>
              <td align="center" style="padding:32px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px; background-color:#ffffff; border-radius:18px; box-shadow:0 20px 38px rgba(15,23,42,0.12); overflow:hidden;" bgcolor="#ffffff">
                  <tr>
                    <td bgcolor="#2563eb" style="background-color:#2563eb; padding:28px 32px; color:#ffffff; font-family:'Segoe UI', Arial, sans-serif;">
                      <h1 style="margin:0; font-size:24px; font-weight:700; letter-spacing:-0.01em;">${isPotluckEmail ? 'Thanks for contributing!' : 'Thank you for serving!'}</h1>
                      <p style="margin:12px 0 0; font-size:15px; line-height:1.6; opacity:0.92;">${isPotluckEmail ? `We&rsquo;re excited for your contribution to <strong>${escapeHtml(event.name)}</strong>.` : `We&rsquo;re grateful to have you on the team for <strong>${escapeHtml(event.name)}</strong>.`}</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:32px; font-family:'Segoe UI', Arial, sans-serif; color:#0f172a;">
                      <p style="margin:0 0 16px; font-size:16px;">Hi ${escapeHtml(registration.registrant_name || registration.registrant_email)},</p>
                      <p style="margin:0 0 16px; color:#475569; line-height:1.7;">${isPotluckEmail ? 'Below are the food prep items your group signed up for.' : 'Below you will find your group&rsquo;s volunteer schedule details.'}</p>
                      ${groupedHtml}
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:32px auto 28px;">
                        <tr>
                          <td align="center" role="presentation">
                            <a href="${manageUrl}" style="display:inline-block; background-color:#2563eb; color:#ffffff; padding:14px 28px; font-size:15px; border-radius:999px; font-weight:600; text-decoration:none; font-family:'Segoe UI', Arial, sans-serif;" target="_blank" rel="noopener">
                              Manage Your Signup
                            </a>
                          </td>
                        </tr>
                        ${calendarUrl ? `<tr>
                          <td align="center" style="padding-top:14px; font-family:'Segoe UI', Arial, sans-serif; font-size:14px;">
                            <a href="${escapeHtml(calendarUrl)}" style="color:#1d4ed8; font-weight:600; text-decoration:underline;" target="_blank" rel="noopener">Add to your calendar</a>
                            <span style="color:#64748b;"> &middot; the calendar file is also attached</span>
                          </td>
                        </tr>` : ''}
                      </table>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid rgba(15,23,42,0.08); margin-top:24px; padding-top:24px;">
                        <tr>
                          <td style="font-family:'Segoe UI', Arial, sans-serif;">
                            <p style="margin:0 0 12px; font-weight:600; color:#0f172a;">Need a hand?</p>
                            <p style="margin:0; color:#475569; line-height:1.7;">Our team is here to help with any changes or questions. ${supportContactHtml}</p>
                          </td>
                        </tr>
                      </table>
                      <p style="margin:32px 0 0; color:#475569; font-family:'Segoe UI', Arial, sans-serif;">With gratitude,<br /><strong>${escapeHtml(supportName || 'Volunteer Team')}</strong></p>
                      ${complianceFooter.htmlBlock || ''}
                    </td>
                  </tr>
                  <tr>
                    <td bgcolor="#f3f6fb" style="background-color:#f3f6fb; padding:18px 32px; text-align:center; color:#94a3b8; font-size:13px; font-family:'Segoe UI', Arial, sans-serif;">
                      If you did not request this email you can ignore it.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </div>
      </body>
    </html>`;

  try {
    const headers = complianceFooter.listUnsubscribe ? { 'List-Unsubscribe': complianceFooter.listUnsubscribe } : undefined;
    const attachments = calendarEntries.length
      ? [{
          filename: calendar.icsFilename(event),
          content: calendar.toIcs(calendarEntries, { calendarName: event.name, orgName }),
          contentType: 'text/calendar; charset=utf-8'
        }]
      : undefined;
    await sendMail({
      to: registration.registrant_email,
      subject,
      text,
      html,
      headers,
      attachments
    });
  } catch (err) {
    console.error('Failed to send volunteer confirmation email:', err);
  }
}

function normalizeName(value) {
  return String(value || '').trim();
}

function normalizeDish(value) {
  return String(value || '').trim().replace(/^\s*,\s*/, '');
}

function ensureUniqueParticipants(names) {
  const seen = new Set();
  names.forEach(n => {
    const key = n.toLowerCase();
    if (seen.has(key)) throw createError(400, 'Participant names must be unique within your registration.');
    seen.add(key);
  });
}

function slotsOverlap(a, b) {
  if (!a || !b) return false;
  if (!Number.isFinite(a.start) || !Number.isFinite(a.end) || !Number.isFinite(b.start) || !Number.isFinite(b.end)) {
    return false;
  }
  return a.start < b.end && b.start < a.end;
}

function buildTimeMap(blocks) {
  const map = new Map();
  blocks.forEach(b => {
    const start = parseLocalDate(b.start_time);
    const end = parseLocalDate(b.end_time);
    map.set(Number(b.block_id), {
      start: start ? start.getTime() : Number.NaN,
      end: end ? end.getTime() : Number.NaN
    });
  });
  return map;
}

/**
 * Enforce the per-person rules for a set of assignments:
 * - nobody holds the same slot/item twice
 * - nobody holds overlapping time slots, unless the event allows it
 * `assignments` items are { personKey, blockId }; `nameForKey` labels errors.
 */
function assertAssignmentRules(assignments, { blockInfo, isPotluck, allowOverlap, nameForKey }) {
  const label = (key) => (nameForKey && nameForKey(key)) || 'A participant';
  const seen = new Set();
  assignments.forEach(a => {
    const k = `${a.personKey}|${a.blockId}`;
    if (seen.has(k)) {
      throw createError(400, `${label(a.personKey)} is already signed up for that ${isPotluck ? 'item' : 'time slot'}.`);
    }
    seen.add(k);
  });
  if (isPotluck || allowOverlap) return;

  const timeMap = buildTimeMap(blockInfo || []);
  const byPerson = new Map();
  assignments.forEach(a => {
    const list = byPerson.get(a.personKey) || [];
    list.push({ blockId: a.blockId, ...(timeMap.get(Number(a.blockId)) || { start: Number.NaN, end: Number.NaN }) });
    byPerson.set(a.personKey, list);
  });
  byPerson.forEach((list, key) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (slotsOverlap(list[i], list[j])) {
          throw createError(400, `${label(key)} can't take two time slots that happen at the same time.`);
        }
      }
    }
  });
}

async function processVolunteerSignup(payload) {
  const eventId = Number(payload.eventId);
  if (!Number.isFinite(eventId)) throw createError(400, 'Event is required.');
  const event = dal.public.getEventBasic(eventId);
  if (!event) throw createError(404, 'Event not found.');
  const isPotluck = String(event.signup_mode || '').toLowerCase() === 'potluck';

  const registrant = {
    name: normalizeName(payload.registrant && payload.registrant.name ? payload.registrant.name : payload.name),
    email: normalizeName(payload.registrant && payload.registrant.email ? payload.registrant.email : payload.email),
    phone: normalizeName(payload.registrant && payload.registrant.phone ? payload.registrant.phone : payload.phone),
    email_opt_in: payload.registrant && typeof payload.registrant.email_opt_in !== 'undefined'
      ? payload.registrant.email_opt_in
      : 1
  };
  if (!registrant.name || !registrant.email) {
    throw createError(400, 'Name and email are required.');
  }

  // If this email already has active assignments for this event, short-circuit
  // and send them their manage link instead of allowing a new registration.
  try {
    mergeRegistrationsForEmail(eventId, registrant.email);
  } catch (err) {
    // best-effort merge; continue
  }
  const existingRegs = dal.public.findRegistrationsByEmail(eventId, registrant.email) || [];
  // The manage link goes to the email owner only, never back to the submitter.
  // The new picks wait on their sign-up until they add them from that email.
  if (existingRegs.length) {
    const reminder = await sendManageReminder(registrant.email, eventId, { picks: picksFromPayload(payload) });
    return {
      registrationId: existingRegs[0].registration_id,
      eventId,
      alreadyRegistered: true,
      heldCount: (reminder && reminder.heldCount) || 0
    };
  }

  const participantsInput = Array.isArray(payload.participants) ? payload.participants : [];
  const participantNames = participantsInput.map(p => normalizeName(p && (p.name || p.participant_name || p)));
  if (!participantNames.length) throw createError(400, 'Add at least one participant.');
  ensureUniqueParticipants(participantNames);

  const participantIndexByName = new Map();
  participantNames.forEach((name, idx) => participantIndexByName.set(name.toLowerCase(), idx));

  const scheduleAssignmentsRaw = Array.isArray(payload.scheduleAssignments) ? payload.scheduleAssignments : [];
  const potluckAssignmentsRaw = Array.isArray(payload.potluckAssignments) ? payload.potluckAssignments : [];
  if (!scheduleAssignmentsRaw.length && !potluckAssignmentsRaw.length) {
    throw createError(400, 'Select at least one assignment.');
  }

  if (isPotluck && scheduleAssignmentsRaw.length) {
    throw createError(400, 'This event uses item sign-ups. Please assign items instead of time slots.');
  }
  if (!isPotluck && potluckAssignmentsRaw.length) {
    throw createError(400, 'This event uses scheduled time blocks. Please assign time blocks.');
  }

  const normalizedSched = isPotluck ? [] : scheduleAssignmentsRaw.map(item => {
    const blockId = Number(item.blockId || item.time_block_id || item);
    let idx = null;
    if (Number.isFinite(Number(item.participantIndex))) {
      idx = Number(item.participantIndex);
    } else {
      const participantName = normalizeName(item.participantName || item.participant);
      idx = participantIndexByName.get(participantName.toLowerCase());
    }
    if (!Number.isFinite(blockId) || idx == null || !participantNames[idx]) throw createError(400, 'Each time block must have a participant.');
    return { blockId, participantIndex: idx };
  });
  const normalizedPot = isPotluck ? potluckAssignmentsRaw.map(item => {
    const blockId = Number(item.itemId || item.block_id || item);
    let idx = null;
    if (Number.isFinite(Number(item.participantIndex))) {
      idx = Number(item.participantIndex);
    } else {
      const participantName = normalizeName(item.participantName || item.participant);
      idx = participantIndexByName.get(participantName.toLowerCase());
    }
    const dish = normalizeDish(item.dishName || item.dish);
    if (!Number.isFinite(blockId) || idx == null || !participantNames[idx]) throw createError(400, 'Each item must have a participant selected.');
    if (!dish) throw createError(400, 'Please enter a dish name for each item.');
    return { itemId: blockId, participantIndex: idx, dishName: dish };
  }) : [];

  const blockIds = isPotluck
    ? normalizedPot.map(p => p.itemId)
    : normalizedSched.map(s => s.blockId);
  const blockInfo = dal.public.getBlocksInfo(blockIds);
  if (!blockInfo || !blockInfo.length) throw createError(400, 'No valid selections were submitted.');
  blockInfo.forEach(info => {
    if (Number(info.event_id) !== Number(eventId)) {
      throw createError(400, 'All selections must belong to the same event.');
    }
    const modeForBlock = String(info.signup_mode || '').toLowerCase();
    if (modeForBlock !== (isPotluck ? 'potluck' : 'schedule')) {
      throw createError(400, 'Selections do not match this event\'s sign-up mode.');
    }
  });

  const allowOverlap = Number(event.allow_overlap || 0) === 1;
  assertAssignmentRules(
    (isPotluck ? normalizedPot.map(p => ({ personKey: p.participantIndex, blockId: p.itemId }))
      : normalizedSched.map(s => ({ personKey: s.participantIndex, blockId: s.blockId }))),
    { blockInfo, isPotluck, allowOverlap, nameForKey: (idx) => participantNames[idx] }
  );

  // If this email already has registrations for this event, merge into the
  // existing record so we don't create duplicate manage links.
  let existing = mergeRegistrationsForEmail(eventId, registrant.email);
  if (existing) {
    const detail = dal.public.getRegistrationDetailWithAssignments(existing.registration_id);
    const nameToPid = new Map();
    (detail.participants || []).forEach(p => {
      nameToPid.set(String(p.participant_name).trim().toLowerCase(), p.participant_id);
    });

    // Ensure all incoming participants exist (create missing)
    participantNames.forEach(name => {
      const key = String(name).trim().toLowerCase();
      if (!nameToPid.has(key)) {
        const addRes = dal.public.addParticipant(existing.registration_id, name);
        nameToPid.set(key, addRes && addRes.participant_id);
      }
    });

    const schedAssignments = [];
    const potAssignments = [];

    (detail.scheduleAssignments || []).forEach(a => {
      schedAssignments.push({ participantId: a.participant_id, blockId: Number(a.time_block_id) });
    });
    (detail.potluckAssignments || []).forEach(a => {
      potAssignments.push({ participantId: a.participant_id, itemId: Number(a.item_id), dishName: a.dish_name });
    });

    normalizedSched.forEach(a => {
      const pid = nameToPid.get(participantNames[a.participantIndex].toLowerCase());
      if (!pid) return;
      schedAssignments.push({ participantId: pid, blockId: Number(a.blockId) });
    });
    normalizedPot.forEach(a => {
      const pid = nameToPid.get(participantNames[a.participantIndex].toLowerCase());
      if (!pid) return;
      potAssignments.push({ participantId: pid, itemId: Number(a.itemId), dishName: a.dishName });
    });

    // Dedup to avoid double capacity counts
    const schedSeen = new Set();
    const potSeen = new Set();
    const dedupSched = [];
    const dedupPot = [];
    schedAssignments.forEach(a => {
      const key = `${a.participantId}:${a.blockId}`;
      if (schedSeen.has(key)) return;
      schedSeen.add(key);
      dedupSched.push(a);
    });
    potAssignments.forEach(a => {
      const key = `${a.participantId}:${a.itemId}:${a.dishName || ''}`;
      if (potSeen.has(key)) return;
      potSeen.add(key);
      dedupPot.push(a);
    });

    dal.public.replaceRegistrationAssignments(existing.registration_id, eventId, dedupSched, dedupPot);
    const registrationId = existing.registration_id;
    const token = issueManageToken(registrationId);
    const manageUrl = buildManageUrl(token);
    const updatedDetail = dal.public.getRegistrationDetailWithAssignments(registrationId);
    const participants = groupAssignments(updatedDetail);

    await sendConfirmationEmail({
      registration: {
        registration_id: registrationId,
        registrant_name: registrant.name,
        registrant_email: registrant.email,
        email_opt_in: registrant.email_opt_in
      },
      event,
      participants,
      manageUrl,
      isUpdate: true
    });

    return {
      registrationId,
      eventId,
      alreadyRegistered: true
    };
  }

  const result = dal.public.createRegistrationWithAssignments(
    eventId,
    registrant,
    participantNames,
    normalizedSched,
    normalizedPot
  );
  const registrationId = result.registrationId;
  const token = issueManageToken(registrationId);
  const manageUrl = buildManageUrl(token);

  const detail = dal.public.getRegistrationDetailWithAssignments(registrationId);
  const participants = groupAssignments(detail);

  await sendConfirmationEmail({
    registration: {
      registration_id: registrationId,
      registrant_name: registrant.name,
      registrant_email: registrant.email,
      email_opt_in: registrant.email_opt_in
    },
    event,
    participants,
    manageUrl,
    isUpdate: false
  });

  return {
    registrationId,
    eventId,
    token,
    manageUrl,
    participants,
    alreadyRegistered: false
  };
}

function getManageContext(token) {
  if (!token) return null;
  const registration = dal.public.getRegistrationByToken(token);
  if (!registration) return null;

  if (registration.manage_token_expires_at) {
    const expiry = new Date(registration.manage_token_expires_at);
    if (Number.isFinite(expiry.getTime()) && expiry.getTime() < Date.now()) {
      return null;
    }
  }

  const eventRows = dal.admin.getEventById(registration.event_id);
  const event = enrichPotluckDishNotes(mapEventRows(eventRows), registration.event_id);
  if (!event) return null;

  const detail = dal.public.getRegistrationDetailWithAssignments(registration.registration_id);
  const participants = groupAssignments(detail);

  return {
    registration,
    event,
    participants
  };
}

// .ics for a manage token: every entry, or just one slot when blockId is given.
function getCalendarFile(token, blockId) {
  const context = getManageContext(token);
  if (!context) return null;
  const { event, participants, registration } = context;
  let entries = calendar.buildEntries({
    event,
    participants,
    registrationId: registration.registration_id,
    manageUrl: buildManageUrl(token)
  });
  if (blockId) entries = entries.filter(e => e.blockId === Number(blockId));
  const { orgName } = getBranding();
  return {
    entries,
    filename: calendar.icsFilename(event),
    content: calendar.toIcs(entries, { calendarName: event.name, orgName })
  };
}

function getCalendarLinks({ event, participants, registrationId, token }) {
  if (!token) return null;
  return calendar.buildCalendarLinks({
    event,
    participants,
    registrationId,
    token,
    manageUrl: buildManageUrl(token),
    formatRange: fmtSlotRange
  });
}

/**
 * Summarise an existing registration against the event's slots so pages can
 * show "what you already have" before someone signs up for more.
 * Returns { total, people: [{ id, name, items: [{ blockId, label, dishName }] }],
 *           byBlock: { blockId: [names] }, conflicts: { blockId: [messages] } }.
 */
function buildSignupSummary(event, participants) {
  const isPotluck = String(event && event.signup_mode || '').toLowerCase() === 'potluck';
  const people = [];
  const byBlock = {};
  const conflicts = {};
  let total = 0;

  const labelFor = (a) => (isPotluck
    ? `${a.station_name || 'Item'} — ${a.title || 'Item'}`
    : `${a.station_name || 'Station'} — ${fmtSlotRange(a.start_time, a.end_time)}`);

  (participants || []).forEach(p => {
    const list = isPotluck ? (p.potluck || []) : (p.schedule || []);
    const items = list.map(a => {
      const blockId = Number(isPotluck ? a.item_id : a.time_block_id);
      (byBlock[blockId] = byBlock[blockId] || []).push(p.participant_name);
      return { blockId, label: labelFor(a), dishName: a.dish_name || '' };
    });
    total += items.length;
    people.push({ id: p.participant_id, name: p.participant_name, items });
  });

  if (!isPotluck && !(event && event.allow_overlap)) {
    const range = (s, e) => {
      const a = parseLocalDate(s);
      const b = parseLocalDate(e);
      return { start: a ? a.getTime() : Number.NaN, end: b ? b.getTime() : Number.NaN };
    };
    (event.stations || []).forEach(st => {
      (st.time_blocks || []).forEach(tb => {
        const blockRange = range(tb.start_time, tb.end_time);
        (participants || []).forEach(p => {
          (p.schedule || []).forEach(a => {
            if (Number(a.time_block_id) === Number(tb.block_id)) return;
            if (slotsOverlap(blockRange, range(a.start_time, a.end_time))) {
              (conflicts[tb.block_id] = conflicts[tb.block_id] || [])
                .push(`${p.participant_name} is already signed up for ${a.station_name || 'another station'} at this time.`);
            }
          });
        });
      });
    });
  }

  return { total, people, byBlock, conflicts };
}

async function updateVolunteerSignup(token, scheduleAssignments, potluckAssignments) {
  const context = getManageContext(token);
  if (!context) throw createError(410, 'This link has expired or is no longer valid.');

  const event = context.event;
  const registration = context.registration;
  const isPotluck = String(event.signup_mode || '').toLowerCase() === 'potluck';

  const assignmentsSched = Array.isArray(scheduleAssignments) ? scheduleAssignments : [];
  const assignmentsPot = Array.isArray(potluckAssignments) ? potluckAssignments : [];

  const hasAssignments = assignmentsSched.length || assignmentsPot.length;
  // Allow clearing all assignments (un-volunteer) via manage link
  if (isPotluck && assignmentsSched.length) {
    throw createError(400, 'This event uses item sign-ups. Please assign items instead of time slots.');
  }
  if (!isPotluck && assignmentsPot.length) {
    throw createError(400, 'This event uses scheduled time blocks. Please assign time blocks.');
  }

  const participantRows = dal.public.getRegistrationDetailWithAssignments(registration.registration_id).participants || [];
  const participantById = new Map(participantRows.map(p => [Number(p.participant_id), p]));
  const participantByName = new Map(participantRows.map(p => [String(p.participant_name).trim().toLowerCase(), p]));
  // People added from the manage page arrive by name; they are created only after validation passes.
  const newPeople = new Map();

  function resolvePersonKey(a) {
    const rawId = a.participantId != null ? a.participantId : a.participant_id;
    if (rawId != null && rawId !== '') {
      const pid = Number(rawId);
      if (!participantById.has(pid)) throw createError(400, 'Invalid participant selection.');
      return `id:${pid}`;
    }
    const name = normalizeName(a.participantName || a.participant_name);
    if (!name) throw createError(400, 'Choose who is filling each spot.');
    if (name.length > 100) throw createError(400, 'Names must be 100 characters or fewer.');
    const lower = name.toLowerCase();
    const existing = participantByName.get(lower);
    if (existing) return `id:${existing.participant_id}`;
    if (!newPeople.has(lower)) newPeople.set(lower, name);
    return `new:${lower}`;
  }
  function nameForKey(key) {
    if (key.startsWith('id:')) {
      const p = participantById.get(Number(key.slice(3)));
      return p ? p.participant_name : '';
    }
    return newPeople.get(key.slice(4)) || '';
  }

  const normalizedSched = isPotluck ? [] : assignmentsSched.map(a => {
    const blockId = Number(a.blockId || a.time_block_id || a);
    return { blockId, personKey: resolvePersonKey(a) };
  });
  const normalizedPot = isPotluck ? assignmentsPot.map(a => {
    const blockId = Number(a.itemId || a.block_id || a);
    const personKey = resolvePersonKey(a);
    const dish = normalizeDish(a.dishName || a.dish);
    if (!dish) throw createError(400, 'Please enter a dish name for each item.');
    return { itemId: blockId, personKey, dishName: dish };
  }) : [];

  const blockIds = isPotluck
    ? normalizedPot.map(p => p.itemId)
    : normalizedSched.map(s => s.blockId);
  const blockInfo = blockIds.length ? dal.public.getBlocksInfo(blockIds) : [];
  if (blockIds.length && !blockInfo.length) throw createError(400, 'No valid selections were submitted.');
  if (blockInfo.length) {
    blockInfo.forEach(info => {
      if (Number(info.event_id) !== Number(registration.event_id)) {
        throw createError(400, 'All selections must belong to the same event.');
      }
    });
  }

  assertAssignmentRules(
    isPotluck
      ? normalizedPot.map(p => ({ personKey: p.personKey, blockId: p.itemId }))
      : normalizedSched.map(s => ({ personKey: s.personKey, blockId: s.blockId })),
    { blockInfo, isPotluck, allowOverlap: !!event.allow_overlap, nameForKey }
  );

  const createdIds = [];
  const idForKey = new Map();
  try {
    newPeople.forEach((name, lower) => {
      const res = dal.public.addParticipant(registration.registration_id, name);
      createdIds.push(res.participant_id);
      idForKey.set(`new:${lower}`, res.participant_id);
    });
  } catch (err) {
    createdIds.forEach(pid => { try { dal.public.deleteParticipant(registration.registration_id, pid, true); } catch (_) {} });
    throw err;
  }
  const toParticipantId = (key) => (key.startsWith('id:') ? Number(key.slice(3)) : idForKey.get(key));
  const finalSched = normalizedSched.map(s => ({ blockId: s.blockId, participantId: toParticipantId(s.personKey) }));
  const finalPot = normalizedPot.map(p => ({ itemId: p.itemId, participantId: toParticipantId(p.personKey), dishName: p.dishName }));

  try {
    dal.public.replaceRegistrationAssignments(
      registration.registration_id,
      registration.event_id,
      finalSched,
      finalPot
    );
  } catch (err) {
    createdIds.forEach(pid => { try { dal.public.deleteParticipant(registration.registration_id, pid, true); } catch (_) {} });
    throw err;
  }

  // If everything was cleared, remove the registration to avoid stale manage links.
  if (!finalSched.length && !finalPot.length) {
    try { dal.public.deleteRegistrationCascade(registration.registration_id); } catch (_) {}
    return {
      registration: null,
      event,
      participants: [],
      deleted: true,
      eventId: event.event_id
    };
  }

  dal.public.setHeldPicks(registration.registration_id, []);
  const detail = dal.public.getRegistrationDetailWithAssignments(registration.registration_id);
  const participants = groupAssignments(detail);
  const expiresAt = computeExpiryDate();
  dal.public.storeRegistrationToken(token, registration.registration_id, expiresAt);

  await sendConfirmationEmail({
    registration,
    event,
    participants,
    manageUrl: buildManageUrl(token),
    isUpdate: true
  });

  return { registration, event, participants };
}

async function sendManageReminder(email, eventId, options = {}) {
  const inputEmail = String(email || '').trim();
  const eventIdNum = Number(eventId);
  const event = dal.public.getEventBasic(eventIdNum);
  if (!event || !inputEmail) return;

  let registrations = dal.public.findRegistrationsByEmail(eventIdNum, inputEmail) || [];
  if (!registrations.length) return;

  // Try to merge duplicates so the person gets a single link. If merging fails
  // (e.g., over-capacity edge cases), fall back to sending multiple links.
  try {
    const merged = mergeRegistrationsForEmail(eventIdNum, inputEmail);
    if (merged) {
      registrations = dal.public.findRegistrationsByEmail(eventIdNum, inputEmail) || [merged];
    }
  } catch (err) {
    console.error('Failed to merge registrations for reminder; falling back to multi-link email:', err);
  }

  if (!registrations.length) return;

  const tokens = registrations.map(reg => {
    const token = issueManageToken(reg.registration_id);
    return {
      reg,
      token,
      manageUrl: buildManageUrl(token)
    };
  });

  const primaryReg = tokens[0].reg;
  const isMulti = tokens.length > 1;
  // With several sign-ups there's no single one to add the picks to.
  const held = isMulti ? [] : describeHeldPicks(getEventDetailsForPublic(eventIdNum), options.picks);
  if (held.length) dal.public.setHeldPicks(primaryReg.registration_id, held.map(h => h.pick));
  const holding = held.length > 0;
  const spotWord = String(event.signup_mode || '').toLowerCase() === 'potluck' ? 'item' : 'spot';
  const heldCountText = `${held.length} ${spotWord}${held.length === 1 ? '' : 's'}`;
  const heldLine = (h) => [h.label, h.pick.personName, h.pick.dishName ? `bringing ${h.pick.dishName}` : '']
    .filter(Boolean).join(' — ');
  const subject = holding
    ? `Add your new ${spotWord}s to your sign-up for ${event.name}`
    : isMulti
      ? `Manage your signups for ${event.name}`
      : `Manage your signup for ${event.name}`;
  const { supportName, supportEmail, supportPhone, supportContactHtml, orgName, orgMailingAddress } = resolveSupportContact();
  const contactLines = [];
  if (supportEmail) contactLines.push(`Email: ${supportEmail}`);
  if (supportPhone) contactLines.push(`Phone: ${supportPhone}`);
  const complianceFooter = buildComplianceFooter({
    orgName,
    supportEmail,
    supportPhone,
    mailingAddress: orgMailingAddress,
    manageUrl: tokens[0].manageUrl
  });
  const textParts = [`Hi ${primaryReg.registrant_name || inputEmail},`, ''];
  if (holding) {
    textParts.push(
      `You picked ${heldCountText} for ${event.name}. This email already has a sign-up, so we're holding them for you:`,
      '',
      ...held.map(h => `- ${heldLine(h)}`),
      '',
      `Add these to my sign-up: ${tokens[0].manageUrl}`,
      '',
      'The link opens your sign-up with these ready. Check them and press "Save changes" to finish. It works on any phone or computer.',
      '',
      `Didn't pick these? Just ignore this email. Nothing changes, and we'll let them go after ${HELD_PICKS_DAYS} days.`
    );
  } else {
    textParts.push(
      isMulti
        ? `We found multiple signups for ${event.name} with this email. Use the links below to manage each one.`
        : `Use the link below to view or edit your group selections for ${event.name}.`,
      ''
    );
    tokens.forEach((t, idx) => {
      textParts.push(`Signup ${idx + 1}: ${t.manageUrl}`);
    });
  }
  if (contactLines.length) {
    textParts.push('', 'Need help? Contact us:', ...contactLines);
  } else {
    textParts.push('', 'Need help? Reply to this email and we will help you.');
  }
  textParts.push('', 'With gratitude,', supportName || 'Volunteer Team');
  if (!holding) textParts.push('', 'If you did not request this email you can ignore it.');
  if (complianceFooter.textLines.length) {
    textParts.push('', ...complianceFooter.textLines);
  }
  const text = textParts.join('\n');

  const multiListHtml = tokens.map((t, idx) => `
      <li style="margin-bottom:10px;">
        <div style="font-weight:600; color:#0f172a; margin-bottom:6px;">Signup ${idx + 1}</div>
        <a href="${t.manageUrl}" style="display:inline-block; background-color:#2563eb; color:#ffffff; padding:10px 18px; font-size:14px; border-radius:12px; font-weight:600; text-decoration:none; font-family:'Segoe UI', Arial, sans-serif;" target="_blank" rel="noopener">
          Open manage link
        </a>
        <div style="margin-top:8px; color:#1d4ed8; font-size:13px; word-break:break-all;">
          <a href="${t.manageUrl}" style="color:#1d4ed8;">${t.manageUrl}</a>
        </div>
      </li>`).join('');

  const singleHtmlBlock = (t) => `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px;">
        <tr>
          <td align="center" role="presentation">
            <a href="${t.manageUrl}" style="display:inline-block; background-color:#2563eb; color:#ffffff; padding:14px 28px; font-size:15px; border-radius:999px; font-weight:600; text-decoration:none; font-family:'Segoe UI', Arial, sans-serif;" target="_blank" rel="noopener">
              ${holding ? 'Add these to my sign-up' : 'Manage Your Signup'}
            </a>
          </td>
        </tr>
      </table>
      ${holding ? `<p style="margin:0 0 24px; color:#475569; line-height:1.7;">This opens your sign-up with these ready. Check them and press <strong>Save changes</strong> to finish. It works on any phone or computer.</p>` : ''}
      <p style="margin:0 0 12px; color:#475569; font-size:14px;">If the button doesn't work, copy and paste this URL into your browser:</p>
      <p style="margin:0 0 24px; color:#1d4ed8; font-size:14px; word-break:break-all;"><a href="${t.manageUrl}" style="color:#1d4ed8;">${t.manageUrl}</a></p>
  `;

  const html = `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${subject}</title>
      </head>
      <body style="margin:0; padding:0; background-color:#dfe4f3;">
        <div role="article" aria-roledescription="email" lang="en" style="background-color:#dfe4f3;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#dfe4f3; margin:0;">
            <tr>
              <td align="center" style="padding:32px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px; background-color:#ffffff; border-radius:18px; box-shadow:0 20px 38px rgba(15,23,42,0.12); overflow:hidden;" bgcolor="#ffffff">
                  <tr>
                    <td bgcolor="#2563eb" style="background-color:#2563eb; padding:28px 32px; color:#ffffff; font-family:'Segoe UI', Arial, sans-serif;">
                      <h1 style="margin:0; font-size:24px; font-weight:700; letter-spacing:-0.01em;">${holding ? `Finish adding your ${spotWord}s` : 'Need to make an update?'}</h1>
                      <p style="margin:12px 0 0; font-size:15px; line-height:1.6; opacity:0.92;">
                        ${holding
                          ? `You picked ${heldCountText} for <strong>${escapeHtml(event.name)}</strong>. One tap adds them to your sign-up.`
                          : isMulti
                            ? `We found multiple signups for <strong>${escapeHtml(event.name)}</strong>. Use the links below to manage each one.`
                            : `Open your manage link for <strong>${escapeHtml(event.name)}</strong> to view or edit your selections.`}
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:32px; font-family:'Segoe UI', Arial, sans-serif; color:#0f172a;">
                      <p style="margin:0 0 16px; font-size:16px;">Hi ${escapeHtml(primaryReg.registrant_name || inputEmail)},</p>
                      ${holding
                        ? `<p style="margin:0 0 12px; color:#475569; line-height:1.7;">This email already has a sign-up, so we’re holding these for you:</p>
                      <ul style="padding-left:20px; margin:0 0 24px; color:#0f172a; line-height:1.7;">${held.map(h => `<li>${escapeHtml(heldLine(h))}</li>`).join('')}</ul>`
                        : `<p style="margin:0 0 24px; color:#475569; line-height:1.7;">
                        ${isMulti
                          ? 'Use the manage links below to view or edit each signup.'
                          : 'Use the button below to access your personal manage page.'}
                      </p>`}
                      ${isMulti
                        ? `<ul style="padding-left:18px; margin:0 0 24px; list-style:disc;">${multiListHtml}</ul>`
                        : singleHtmlBlock(tokens[0])}
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid rgba(15,23,42,0.08); margin-top:16px; padding-top:24px;">
                        <tr>
                          <td style="font-family:'Segoe UI', Arial, sans-serif;">
                            <p style="margin:0 0 12px; font-weight:600; color:#0f172a;">Need a hand?</p>
                            <p style="margin:0; color:#475569; line-height:1.7;">Our team is here to help with any changes or questions. ${supportContactHtml}</p>
                          </td>
                        </tr>
                      </table>
                      <p style="margin:32px 0 0; color:#475569; font-family:'Segoe UI', Arial, sans-serif;">With gratitude,<br /><strong>${escapeHtml(supportName || 'Volunteer Team')}</strong></p>
                      ${complianceFooter.htmlBlock || ''}
                    </td>
                  </tr>
                  <tr>
                    <td bgcolor="#f3f6fb" style="background-color:#f3f6fb; padding:18px 32px; text-align:center; color:#94a3b8; font-size:13px; font-family:'Segoe UI', Arial, sans-serif;">
                      ${holding
                        ? 'Didn’t pick these? Just ignore this email — nothing changes.'
                        : 'If you did not request this email you can ignore it.'}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </div>
      </body>
    </html>`;
  try {
    const headers = complianceFooter.listUnsubscribe ? { 'List-Unsubscribe': complianceFooter.listUnsubscribe } : undefined;
    await sendMail({ to: primaryReg.registrant_email, subject, text, html, headers });
  } catch (err) {
    console.error('Failed to send manage reminder email:', err);
  }

  return {
    registrations,
    tokens,
    manageUrls: tokens.map(t => t.manageUrl),
    heldCount: held.length
  };
}

async function updateEmailPreference(tokenValue, preference, reason) {
  if (!tokenValue) {
    throw createError(400, 'Missing management token.');
  }
  const registration = dal.public.getRegistrationByToken(tokenValue);
  if (!registration) {
    throw createError(410, 'This manage link expired. Please request a new one.');
  }

  const normalized = String(preference || '').toLowerCase();
  let shouldOptIn;
  if (['opt-in', 'subscribe', 'resubscribe', 'enable', 'allow'].includes(normalized)) {
    shouldOptIn = true;
  } else if (['opt-out', 'unsubscribe', 'stop', 'disable', 'remove'].includes(normalized)) {
    shouldOptIn = false;
  } else {
    throw createError(400, 'Choose a valid email preference option.');
  }

  const reasonClean = shouldOptIn ? null : (typeof reason === 'string' ? reason.trim().slice(0, 500) : null);
  dal.public.setRegistrationEmailPreference(registration.registration_id, {
    optIn: shouldOptIn,
    reason: reasonClean
  });

  return {
    optedIn: shouldOptIn,
    registration: {
      id: registration.registration_id,
      email: registration.registrant_email,
      name: registration.registrant_name
    },
    eventId: registration.event_id
  };
}

function requireManageContext(token) {
  const ctx = getManageContext(token);
  if (!ctx) throw createError(410, 'This link has expired or is no longer valid.');
  return ctx;
}

function renameParticipant(token, participantId, newName) {
  const ctx = requireManageContext(token);
  const trimmed = normalizeName(newName);
  if (!trimmed) throw createError(400, 'Enter a participant name.');
  const lower = trimmed.toLowerCase();
  const collision = ctx.participants.some(p => p.participant_id !== Number(participantId) && p.participant_name.toLowerCase() === lower);
  if (collision) throw createError(409, 'Another participant already has that name.');
  dal.public.renameParticipant(ctx.registration.registration_id, participantId, trimmed);
  return getManageContext(token);
}

function addParticipant(token, newName) {
  const ctx = requireManageContext(token);
  const trimmed = normalizeName(newName);
  if (!trimmed) throw createError(400, 'Enter a participant name.');
  const lower = trimmed.toLowerCase();
  const collision = ctx.participants.some(p => p.participant_name.toLowerCase() === lower);
  if (collision) throw createError(409, 'Another participant already has that name.');
  dal.public.addParticipant(ctx.registration.registration_id, trimmed);
  return getManageContext(token);
}

function mergeParticipants(token, fromId, toId) {
  const ctx = requireManageContext(token);
  const existsFrom = ctx.participants.some(p => p.participant_id === Number(fromId));
  const existsTo = ctx.participants.some(p => p.participant_id === Number(toId));
  if (!existsFrom || !existsTo) throw createError(404, 'Participant not found.');
  dal.public.mergeParticipants(ctx.registration.registration_id, Number(fromId), Number(toId));
  return getManageContext(token);
}

function deleteParticipant(token, participantId, removeAssignments) {
  const ctx = requireManageContext(token);
  dal.public.deleteParticipant(ctx.registration.registration_id, participantId, removeAssignments);
  return getManageContext(token);
}

module.exports = {
  getPublicEvents,
  getEventDetailsForPublic,
  getEventDetailsForPreview,
  processVolunteerSignup,
  getManageContext,
  buildSignupSummary,
  getCalendarFile,
  getCalendarLinks,
  updateVolunteerSignup,
  sendManageReminder,
  getHeldPicks,
  updateEmailPreference,
  renameParticipant,
  addParticipant,
  mergeParticipants,
  deleteParticipant,
  mergeAllDuplicatesForEvent
};
