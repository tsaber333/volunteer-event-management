// src/public/js/signup.js
// Sign-up flow for the public event page ("signup" mode) and the manage page
// ("manage" mode). Positions are shown first; each "Sign up" adds a pick, and
// the picks panel collects who fills each spot. Rules mirrored from the server:
// one person can't hold the same slot/item twice, and can't hold overlapping
// time slots unless the event allows it. CSP-safe: no inline handlers.
(function () {
  'use strict';

  const dataEl = document.getElementById('signup-data');
  if (!dataEl) return;
  let cfg;
  try { cfg = JSON.parse(dataEl.textContent || '{}'); } catch (_) { return; }

  const isManage = cfg.mode === 'manage';
  const isPotluck = !!cfg.isPotluck;
  const checkOverlap = !isPotluck && !cfg.allowOverlap;
  const spotWord = isPotluck ? 'item' : 'spot';
  const NEW_PERSON = '__new__';

  const form = document.querySelector('[data-role="picks-form"]');
  const picksList = document.querySelector('[data-role="picks-list"]');
  const picksEmpty = document.querySelector('[data-role="picks-empty"]');
  const picksCount = document.querySelector('[data-role="picks-count"]');
  const payloadInput = document.querySelector('[data-role="payload"]');
  const formError = document.querySelector('[data-role="form-error"]');
  const bar = document.querySelector('[data-role="picks-bar"]');
  const barText = document.querySelector('[data-role="picks-bar-text"]');
  const barGo = document.querySelector('[data-role="picks-bar-go"]');
  const dirtyNote = document.querySelector('[data-role="dirty-note"]');
  const pendingNote = document.querySelector('[data-role="pending-note"]');
  const positionsRoot = document.querySelector('[data-positions]');
  const nameInput = document.getElementById('signup-name');
  const emailInput = document.getElementById('signup-email');
  const phoneInput = document.getElementById('signup-phone');
  const stepSection = document.getElementById(isManage ? 'your-signups' : 'signup-step');
  if (!form || !picksList || !positionsRoot) return;

  // ---- Slots -------------------------------------------------------------
  function parseLocal(value) {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return Number.NaN;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  }

  const slots = new Map();
  positionsRoot.querySelectorAll('.slot[data-block-id]').forEach(el => {
    const id = Number(el.getAttribute('data-block-id'));
    slots.set(id, {
      id,
      el,
      label: el.getAttribute('data-label') || '',
      stationName: el.getAttribute('data-station-name') || '',
      start: parseLocal(el.getAttribute('data-start')),
      end: parseLocal(el.getAttribute('data-end')),
      capacity: Number(el.getAttribute('data-capacity')) || 0,
      reserved: Number(el.getAttribute('data-reserved')) || 0
    });
  });

  function overlaps(a, b) {
    if (!a || !b) return false;
    if (![a.start, a.end, b.start, b.end].every(Number.isFinite)) return false;
    return a.start < b.end && b.start < a.end;
  }

  // ---- People & picks ----------------------------------------------------
  let nextKey = 1;
  let nextUid = 1;
  const people = [];
  const picks = [];
  const savedCountByBlock = new Map();
  let savedSignature = '';

  function personByKey(key) { return people.find(p => p.key === key) || null; }
  function registrantName() { return nameInput ? String(nameInput.value || '').trim() : ''; }
  function personName(p) {
    if (!p) return '';
    return p.isRegistrant ? registrantName() : p.name;
  }
  function personLabel(p) {
    if (!p) return '';
    if (p.isRegistrant) return registrantName() ? `Me (${registrantName()})` : 'Me';
    return p.name;
  }
  function addPerson(name) {
    const clean = String(name || '').trim().slice(0, 100);
    if (!clean) return null;
    const existing = people.find(p => personName(p).toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const person = { key: `n${nextKey++}`, name: clean };
    people.push(person);
    return person;
  }

  if (isManage) {
    (cfg.participants || []).forEach(p => people.push({ key: `id:${p.id}`, id: p.id, name: p.name }));
  } else {
    people.push({ key: 'me', name: '', isRegistrant: true });
  }

  // Returns null, { type: 'same' }, or { type: 'overlap', stationName }.
  function conflictFor(personKey, blockId, exceptUid) {
    if (!personKey) return null;
    const slot = slots.get(blockId);
    for (const pick of picks) {
      if (pick.uid === exceptUid || pick.personKey !== personKey) continue;
      if (pick.blockId === blockId) return { type: 'same' };
      if (checkOverlap && overlaps(slot, slots.get(pick.blockId))) {
        const other = slots.get(pick.blockId);
        return { type: 'overlap', stationName: other ? other.stationName : 'another spot' };
      }
    }
    return null;
  }
  function conflictOptionText(conflict) {
    if (!conflict) return '';
    return conflict.type === 'same' ? 'already signed up for this' : `already signed up for ${conflict.stationName} at this time`;
  }
  function conflictSentence(person, conflict) {
    const isMe = person && person.isRegistrant;
    const who = isMe ? 'You’re' : `${personName(person) || 'This person'} is`;
    if (conflict.type === 'same') return `${who} already signed up for this ${spotWord}.`;
    return `${who} already signed up for ${conflict.stationName} at this time.`;
  }

  function remaining(blockId) {
    const slot = slots.get(blockId);
    if (!slot) return 0;
    const current = picks.filter(p => p.blockId === blockId).length;
    const used = slot.reserved - (savedCountByBlock.get(blockId) || 0) + current;
    return slot.capacity - used;
  }

  function firstAvailablePerson(blockId) {
    const free = people.find(p => !conflictFor(p.key, blockId, null));
    return free ? free.key : '';
  }

  function addPick(blockId, personKey, dishName, opts) {
    const options = opts || {};
    if (!slots.has(blockId)) return null;
    if (!options.force && remaining(blockId) <= 0) return null;
    const pick = {
      uid: nextUid++,
      blockId,
      personKey: personKey != null ? personKey : firstAvailablePerson(blockId),
      dishName: dishName || '',
      saved: !!options.saved
    };
    picks.push(pick);
    return pick;
  }

  function removePick(uid) {
    const idx = picks.findIndex(p => p.uid === uid);
    if (idx >= 0) picks.splice(idx, 1);
  }

  function signature() {
    return picks
      .map(p => `${p.blockId}|${p.personKey}|${String(p.dishName || '').trim()}`)
      .sort()
      .join(';');
  }
  function isDirty() {
    if (isManage) return signature() !== savedSignature;
    // After a duplicate-email check the server holds these picks, so leaving is safe.
    return picks.length > 0 && signature() !== savedSignature;
  }

  // ---- Rendering: picks panel -------------------------------------------
  function renderPicks() {
    picksList.textContent = '';
    const ordered = picks.slice().sort((a, b) => {
      const sa = slots.get(a.blockId);
      const sb = slots.get(b.blockId);
      const ta = sa && Number.isFinite(sa.start) ? sa.start : Infinity;
      const tb = sb && Number.isFinite(sb.start) ? sb.start : Infinity;
      if (ta !== tb) return ta - tb;
      return (sa ? sa.label : '').localeCompare(sb ? sb.label : '') || a.uid - b.uid;
    });

    ordered.forEach(pick => {
      const slot = slots.get(pick.blockId);
      const li = document.createElement('li');
      li.className = 'pick';
      li.dataset.uid = String(pick.uid);
      li.dataset.blockId = String(pick.blockId);

      const what = document.createElement('div');
      what.className = 'pick__what';
      const title = document.createElement('strong');
      title.textContent = slot ? slot.label : `${spotWord} #${pick.blockId}`;
      what.appendChild(title);
      if (isManage && !pick.saved) {
        const tag = document.createElement('span');
        tag.className = 'pick__tag';
        tag.textContent = 'New';
        what.appendChild(tag);
      }
      li.appendChild(what);

      const who = document.createElement('div');
      who.className = 'pick__who';
      const whoLabel = document.createElement('label');
      whoLabel.className = 'pick__label';
      whoLabel.setAttribute('for', `pick-who-${pick.uid}`);
      whoLabel.textContent = 'Who';
      const select = document.createElement('select');
      select.id = `pick-who-${pick.uid}`;
      if (!pick.personKey) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Choose who…';
        placeholder.selected = true;
        placeholder.disabled = true;
        select.appendChild(placeholder);
      }
      people.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.key;
        const reason = conflictFor(p.key, pick.blockId, pick.uid);
        opt.textContent = reason ? `${personLabel(p)} — ${conflictOptionText(reason)}` : personLabel(p);
        if (reason && p.key !== pick.personKey) opt.disabled = true;
        if (p.key === pick.personKey) opt.selected = true;
        select.appendChild(opt);
      });
      const other = document.createElement('option');
      other.value = NEW_PERSON;
      other.textContent = 'Someone else…';
      select.appendChild(other);
      select.addEventListener('change', () => {
        if (select.value === NEW_PERSON) {
          showNewPersonInput(who, select, pick);
          return;
        }
        pick.personKey = select.value;
        refresh();
      });
      who.appendChild(whoLabel);
      who.appendChild(select);
      li.appendChild(who);

      if (isPotluck) {
        const dish = document.createElement('div');
        dish.className = 'pick__dish';
        const dishLabel = document.createElement('label');
        dishLabel.className = 'pick__label';
        dishLabel.setAttribute('for', `pick-dish-${pick.uid}`);
        dishLabel.textContent = 'Dish';
        const dishInput = document.createElement('input');
        dishInput.type = 'text';
        dishInput.id = `pick-dish-${pick.uid}`;
        dishInput.maxLength = 200;
        dishInput.placeholder = 'What are you bringing?';
        dishInput.value = pick.dishName || '';
        dishInput.addEventListener('input', () => {
          pick.dishName = dishInput.value;
          dishInput.classList.remove('input-error');
          updatePayload();
          updateDirty();
        });
        dish.appendChild(dishLabel);
        dish.appendChild(dishInput);
        li.appendChild(dish);
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'selected-slot-remove pick__remove';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${slot ? slot.label : spotWord}`);
      remove.addEventListener('click', () => {
        removePick(pick.uid);
        refresh();
      });
      li.appendChild(remove);

      const problem = pickProblem(pick);
      if (problem) {
        li.classList.add('has-error');
        const err = document.createElement('p');
        err.className = 'pick__error';
        err.textContent = problem;
        li.appendChild(err);
      }

      picksList.appendChild(li);
    });

    if (picksEmpty) picksEmpty.hidden = picks.length > 0;
    if (!isManage) form.hidden = picks.length === 0;
    if (picksCount) picksCount.textContent = picks.length ? `(${picks.length})` : '';
  }

  function showNewPersonInput(container, select, pick) {
    select.hidden = true;
    const wrap = document.createElement('div');
    wrap.className = 'pick__new-person';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 100;
    input.placeholder = 'Their full name';
    input.setAttribute('aria-label', 'Name of the person filling this spot');
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn btn-outline small';
    add.textContent = 'Add';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-link small';
    cancel.textContent = 'Cancel';
    const commit = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      const person = addPerson(name);
      if (person) pick.personKey = person.key;
      refresh();
      const nextSelect = document.getElementById(`pick-who-${pick.uid}`);
      if (nextSelect) nextSelect.focus();
    };
    add.addEventListener('click', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); refresh(); }
    });
    cancel.addEventListener('click', () => refresh());
    wrap.appendChild(input);
    wrap.appendChild(add);
    wrap.appendChild(cancel);
    container.appendChild(wrap);
    input.focus();
  }

  function pickProblem(pick) {
    if (!pick.personKey) return `Choose who is filling this ${spotWord}.`;
    const person = personByKey(pick.personKey);
    const reason = conflictFor(pick.personKey, pick.blockId, pick.uid);
    if (reason && reason.type === 'same') return `${conflictSentence(person, reason)} Choose someone else or remove it.`;
    if (reason) return `${conflictSentence(person, reason)} Choose someone else or remove one of them.`;
    if (remaining(pick.blockId) < 0) return `There aren’t enough open spots here any more. Remove one.`;
    return '';
  }

  // ---- Rendering: positions ---------------------------------------------
  function describePeople(list) {
    const names = list.map(p => personLabel(p) || 'Someone').filter(Boolean);
    return names.join(', ');
  }

  function renderSlots() {
    slots.forEach(slot => {
      const el = slot.el;
      const here = picks.filter(p => p.blockId === slot.id);
      const left = remaining(slot.id);
      const full = left <= 0;

      const spotsText = el.querySelector('[data-role="spots-text"]');
      if (spotsText) {
        spotsText.textContent = full
          ? (here.length ? 'Full (including your picks)' : 'Full — thank you!')
          : `${left} of ${slot.capacity} ${isPotluck ? 'still needed' : (slot.capacity === 1 ? 'spot open' : 'spots open')}`;
      }
      const fill = el.querySelector('.spots-bar__fill');
      if (fill && slot.capacity > 0) {
        fill.style.width = `${Math.min(100, Math.round(((slot.capacity - Math.max(left, 0)) / slot.capacity) * 100))}%`;
      }

      const mine = el.querySelector('[data-role="mine"]');
      if (mine) {
        const names = describePeople(here.map(p => personByKey(p.personKey)).filter(Boolean));
        const unassigned = here.filter(p => !p.personKey).length;
        let text = '';
        if (here.length) {
          text = isManage ? 'Your group: ' : 'Your picks: ';
          text += names || '';
          if (unassigned) text += `${names ? ', ' : ''}${unassigned} to assign`;
        }
        mine.textContent = text;
        mine.hidden = !here.length;
      }

      const note = el.querySelector('[data-role="note"]');
      if (note && checkOverlap) {
        const busy = (full && !here.length) ? [] : people
          .filter(p => !here.some(h => h.personKey === p.key))
          .map(p => {
            const r = conflictFor(p.key, slot.id, null);
            return r && r.type === 'overlap' ? conflictSentence(p, r) : '';
          })
          .filter(Boolean);
        note.textContent = busy.join(' ');
        note.hidden = !busy.length;
      }

      const addBtn = el.querySelector('[data-role="add"]');
      if (addBtn) {
        addBtn.hidden = full;
        addBtn.textContent = here.length ? '+ Add another person' : 'Sign up';
        addBtn.classList.toggle('btn-primary', !here.length);
        addBtn.classList.toggle('btn-outline', !!here.length);
      }
      let badge = el.querySelector('[data-role="full-badge"]');
      if (full && !badge) {
        badge = document.createElement('span');
        badge.className = 'badge';
        badge.dataset.role = 'full-badge';
        badge.textContent = 'Full';
        el.querySelector('.slot__action').appendChild(badge);
      }
      if (badge) badge.hidden = !full;

      const picked = el.querySelector('[data-role="picked"]');
      if (picked) {
        const newHere = here.filter(p => !p.saved);
        picked.textContent = '';
        picked.hidden = !newHere.length;
        if (newHere.length) {
          const label = document.createElement('span');
          label.textContent = newHere.length > 1 ? `✓ Added ×${newHere.length}` : '✓ Added';
          const undo = document.createElement('button');
          undo.type = 'button';
          undo.className = 'btn btn-link small';
          undo.textContent = 'Undo';
          undo.addEventListener('click', () => {
            removePick(newHere[newHere.length - 1].uid);
            refresh();
          });
          picked.appendChild(label);
          picked.appendChild(undo);
        }
      }

      el.classList.toggle('is-full', full);
      el.classList.toggle('is-mine', here.length > 0);
    });
    renderSummary();
    applyOnlyOpen();
  }

  function renderSummary() {
    const summaryEl = positionsRoot.querySelector('[data-role="positions-summary"]');
    if (!summaryEl || !slots.size) return;
    let total = 0;
    let open = 0;
    slots.forEach(slot => {
      total += slot.capacity;
      open += Math.max(0, remaining(slot.id));
    });
    if (!total) return;
    summaryEl.textContent = '';
    if (open > 0) {
      const strong = document.createElement('strong');
      strong.textContent = String(open);
      summaryEl.appendChild(strong);
      summaryEl.appendChild(document.createTextNode(` of ${total} ${spotWord}s still needed`));
    } else {
      summaryEl.textContent = `Every ${spotWord} is filled — thank you!`;
    }
  }

  // ---- View controls -----------------------------------------------------
  const onlyOpen = positionsRoot.querySelector('[data-role="only-open"]');
  const viewMode = positionsRoot.querySelector('[data-role="view-mode"]');
  const stationView = positionsRoot.querySelector('[data-role="station-view"]');
  const timeView = positionsRoot.querySelector('[data-role="time-view"]');
  const timeList = positionsRoot.querySelector('[data-role="time-list"]');
  const placeholders = new Map();
  slots.forEach(slot => {
    const marker = document.createComment(`slot-${slot.id}`);
    slot.el.parentNode.insertBefore(marker, slot.el);
    placeholders.set(slot.id, marker);
  });

  function applyOnlyOpen() {
    const hideFull = !!(onlyOpen && onlyOpen.checked);
    slots.forEach(slot => {
      const keep = !hideFull || !slot.el.classList.contains('is-full') || slot.el.classList.contains('is-mine');
      slot.el.hidden = !keep;
    });
    positionsRoot.querySelectorAll('.positions__station').forEach(card => {
      const anyVisible = Array.from(card.querySelectorAll('.slot')).some(el => !el.hidden);
      card.hidden = !anyVisible;
    });
  }

  function applyViewMode() {
    if (!viewMode || !stationView || !timeView || !timeList) return;
    if (viewMode.value === 'time') {
      Array.from(slots.values())
        .sort((a, b) => (a.start - b.start) || a.label.localeCompare(b.label))
        .forEach(slot => timeList.appendChild(slot.el));
      stationView.hidden = true;
      timeView.hidden = false;
    } else {
      slots.forEach(slot => {
        const marker = placeholders.get(slot.id);
        if (marker && marker.parentNode) marker.parentNode.insertBefore(slot.el, marker.nextSibling);
      });
      timeView.hidden = true;
      stationView.hidden = false;
    }
    applyOnlyOpen();
  }
  if (onlyOpen) onlyOpen.addEventListener('change', applyOnlyOpen);
  if (viewMode) viewMode.addEventListener('change', applyViewMode);

  // ---- Feedback ----------------------------------------------------------
  function toast(message) {
    let host = document.getElementById('toast-root');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-root';
      host.className = 'toast-host';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    host.querySelectorAll('.toast[data-signup-toast]').forEach(old => old.remove());
    const el = document.createElement('div');
    el.className = 'toast toast--success';
    el.setAttribute('role', 'status');
    el.dataset.signupToast = '1';
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 2500);
  }

  function isInView(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  }

  function updateBar() {
    if (!bar) return;
    let show = false;
    if (isManage) {
      show = isDirty() && !isInView(form);
      if (barText) barText.textContent = 'You have unsaved changes';
    } else {
      show = picks.length > 0 && !isInView(form);
      if (barText) barText.textContent = `${picks.length} ${picks.length === 1 ? spotWord : spotWord + 's'} picked`;
    }
    bar.hidden = !show;
  }
  if (barGo) {
    barGo.addEventListener('click', () => {
      const target = stepSection || form;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  window.addEventListener('scroll', updateBar, { passive: true });
  window.addEventListener('resize', updateBar);

  function updateDirty() {
    if (dirtyNote) dirtyNote.hidden = !isDirty();
    updateBar();
  }

  // ---- Payload -----------------------------------------------------------
  function buildPayload() {
    if (isManage) {
      const toRef = (pick) => {
        const person = personByKey(pick.personKey);
        if (person && person.id) return { participantId: person.id };
        return { participantName: person ? person.name : '' };
      };
      return {
        scheduleAssignments: isPotluck ? [] : picks.map(p => ({ blockId: p.blockId, ...toRef(p) })),
        potluckAssignments: isPotluck ? picks.map(p => ({ itemId: p.blockId, dishName: String(p.dishName || '').trim(), ...toRef(p) })) : []
      };
    }
    const usedKeys = [];
    picks.forEach(p => { if (p.personKey && !usedKeys.includes(p.personKey)) usedKeys.push(p.personKey); });
    const names = usedKeys.map(k => personName(personByKey(k)));
    const indexOf = (key) => usedKeys.indexOf(key);
    return {
      eventId: cfg.eventId,
      registrant: {
        name: registrantName(),
        email: emailInput ? String(emailInput.value || '').trim() : '',
        phone: phoneInput ? String(phoneInput.value || '').trim() : ''
      },
      participants: names,
      scheduleAssignments: isPotluck ? [] : picks.map(p => ({ blockId: p.blockId, participantIndex: indexOf(p.personKey) })),
      potluckAssignments: isPotluck ? picks.map(p => ({ itemId: p.blockId, participantIndex: indexOf(p.personKey), dishName: String(p.dishName || '').trim() })) : []
    };
  }
  function updatePayload() {
    if (payloadInput) payloadInput.value = JSON.stringify(buildPayload());
  }

  function refresh() {
    renderPicks();
    renderSlots();
    updatePayload();
    updateDirty();
  }

  // ---- Add from positions -----------------------------------------------
  positionsRoot.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-role="add"]');
    if (!btn) return;
    const slotEl = btn.closest('.slot');
    const blockId = Number(slotEl && slotEl.getAttribute('data-block-id'));
    const slot = slots.get(blockId);
    if (!slot) return;
    if (remaining(blockId) <= 0) {
      toast('Sorry, that one is full.');
      refresh();
      return;
    }
    const pick = addPick(blockId);
    if (!pick) return;
    refresh();
    const person = personByKey(pick.personKey);
    toast(person
      ? `Added ${slot.label} for ${personLabel(person)}.`
      : `Added ${slot.label}. Choose who’s filling it below.`);
  });

  // ---- Validation & submit ----------------------------------------------
  function showError(message, focusEl) {
    if (formError) {
      formError.textContent = message;
      formError.hidden = false;
    }
    const target = focusEl || formError;
    if (target) {
      if (!isInView(target)) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (typeof target.focus === 'function') target.focus({ preventScroll: true });
    }
  }
  function clearError() {
    if (formError) { formError.hidden = true; formError.textContent = ''; }
    [nameInput, emailInput].forEach(el => el && el.classList.remove('input-error'));
  }

  function validate() {
    if (!isManage) {
      if (!picks.length) return { message: `Tap “Sign up” on at least one ${spotWord} above.` };
      const name = registrantName();
      if (!name) {
        nameInput.classList.add('input-error');
        return { message: 'Please enter your name.', focus: nameInput };
      }
      const email = emailInput ? String(emailInput.value || '').trim() : '';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        emailInput.classList.add('input-error');
        return { message: 'Please enter a valid email address.', focus: emailInput };
      }
      const clash = people.find(p => !p.isRegistrant && p.name.toLowerCase() === name.toLowerCase());
      if (clash && picks.some(p => p.personKey === clash.key)) {
        return { message: `${name} is listed as you and as “someone else.” Choose “Me” for your own spots.` };
      }
    }
    for (const pick of picks) {
      const problem = pickProblem(pick);
      if (problem) {
        const row = picksList.querySelector(`.pick[data-uid="${pick.uid}"] select`);
        return { message: problem, focus: row };
      }
      if (isPotluck && !String(pick.dishName || '').trim()) {
        const input = document.getElementById(`pick-dish-${pick.uid}`);
        if (input) input.classList.add('input-error');
        return { message: 'Please enter a dish name for each item.', focus: input };
      }
    }
    return null;
  }

  let submitting = false;
  form.addEventListener('submit', async (e) => {
    if (submitting) return;
    e.preventDefault();
    clearError();
    renderPicks();
    const problem = validate();
    if (problem) {
      showError(problem.message, problem.focus);
      return;
    }
    updatePayload();

    if (isManage) {
      if (!picks.length && !window.confirm('This removes all of your spots and cancels your sign-up. Continue?')) return;
      submitting = true;
      form.submit();
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const csrf = form.querySelector('input[name="_csrf"]');
      const resp = await fetch('/manage/check-duplicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          eventId: cfg.eventId,
          email: String(emailInput.value || '').trim(),
          _csrf: csrf ? csrf.value : '',
          payload: buildPayload()
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.duplicate) {
          if (submitBtn) submitBtn.disabled = false;
          savedSignature = signature();
          showError('This email already has a sign-up for this event. We just emailed you a link — open it in this browser to see what you already have, with these picks waiting for you to review and save.', emailInput);
          return;
        }
      }
    } catch (err) {
      console.warn('[Signup] Duplicate check failed; submitting anyway.', err);
    }
    submitting = true;
    form.submit();
  });

  window.addEventListener('beforeunload', (e) => {
    if (submitting || !isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // Manage page: forms that reload the page would drop unsaved picks.
  document.querySelectorAll('form[data-guard-dirty]').forEach(f => {
    f.addEventListener('submit', (e) => {
      const deleteName = f.getAttribute('data-confirm-delete');
      if (deleteName) {
        const count = Number(f.getAttribute('data-assignment-count')) || 0;
        const detail = count ? ` and their ${count} ${count === 1 ? spotWord : spotWord + 's'}` : '';
        if (!window.confirm(`Remove ${deleteName}${detail} from your sign-up?`)) { e.preventDefault(); return; }
      }
      if (isDirty() && !window.confirm('You have unsaved changes to your sign-ups. They will be lost. Continue?')) {
        e.preventDefault();
        return;
      }
      submitting = true;
    });
  });

  if (nameInput) {
    nameInput.addEventListener('input', () => {
      nameInput.classList.remove('input-error');
      refresh();
    });
  }
  if (emailInput) emailInput.addEventListener('input', () => emailInput.classList.remove('input-error'));

  // ---- Initial state -----------------------------------------------------
  if (isManage) {
    (cfg.saved || []).forEach(a => {
      const blockId = Number(a.blockId);
      savedCountByBlock.set(blockId, (savedCountByBlock.get(blockId) || 0) + 1);
      addPick(blockId, `id:${a.participantId}`, a.dishName || '', { saved: true, force: true });
    });
    savedSignature = signature();

    let added = 0;
    let skipped = 0;
    (cfg.pending || []).forEach(p => {
      const blockId = Number(p.blockId);
      if (!slots.has(blockId) || remaining(blockId) <= 0) { skipped += 1; return; }
      let key = null;
      if (p.personName) {
        const person = addPerson(p.personName);
        key = person ? person.key : null;
      }
      const existing = key ? conflictFor(key, blockId, null) : null;
      if (existing && existing.type === 'same') { skipped += 1; return; }
      if (addPick(blockId, key, p.dishName || '')) added += 1;
    });
    if (pendingNote && (added || skipped)) {
      const parts = [];
      if (added) parts.push(`We added ${added} ${added === 1 ? spotWord : spotWord + 's'} you picked. Check who is filling ${added === 1 ? 'it' : 'each one'}, then press “Save changes.”`);
      if (skipped) parts.push(`${skipped} ${skipped === 1 ? 'pick was' : 'picks were'} skipped because ${skipped === 1 ? 'it is' : 'they are'} full or already yours.`);
      pendingNote.textContent = parts.join(' ');
      pendingNote.hidden = false;
    }
  } else if (cfg.draft && typeof cfg.draft === 'object') {
    const draft = cfg.draft;
    const names = Array.isArray(draft.participants) ? draft.participants.map(n => String((n && n.name) || n || '').trim()) : [];
    const me = registrantName().toLowerCase();
    const keyForIndex = (idx) => {
      const name = names[Number(idx)];
      if (!name) return '';
      if (me && name.toLowerCase() === me) return 'me';
      const person = addPerson(name);
      return person ? person.key : '';
    };
    (Array.isArray(draft.scheduleAssignments) ? draft.scheduleAssignments : []).forEach(a => {
      addPick(Number(a.blockId), keyForIndex(a.participantIndex), '', { force: true });
    });
    (Array.isArray(draft.potluckAssignments) ? draft.potluckAssignments : []).forEach(a => {
      addPick(Number(a.itemId), keyForIndex(a.participantIndex), a.dishName || '', { force: true });
    });
  }

  refresh();
})();
