// src/public/js/positions.js
// View controls for the positions list on the event, manage and "already
// signed up" pages: "View by" station or date & time (grouped by day, with
// jump links) and "Show only open". signup.js fires "positions:change" on the
// list after picks change which spots are full. CSP-safe: no inline handlers.
(function () {
  'use strict';

  const root = document.querySelector('[data-positions]');
  if (!root) return;
  const onlyOpen = root.querySelector('[data-role="only-open"]');
  const hiddenCount = root.querySelector('[data-role="hidden-count"]');
  const noneOpen = root.querySelector('[data-role="none-open"]');
  const viewMode = root.querySelector('[data-role="view-mode"]');
  const stationView = root.querySelector('[data-role="station-view"]');
  const timeView = root.querySelector('[data-role="time-view"]');
  const timeList = root.querySelector('[data-role="time-list"]');
  const dayLinks = root.querySelector('[data-role="day-links"]');
  const slots = Array.from(root.querySelectorAll('.slot[data-block-id]'));
  if (!slots.length) return;

  // Markers so each slot can go back to its station card.
  const homes = new Map();
  slots.forEach(el => {
    const marker = document.createComment('slot');
    el.parentNode.insertBefore(marker, el);
    homes.set(el, marker);
  });

  // Date & time view: one section per day, slots in start order.
  const days = [];
  function buildDays() {
    if (days.length || !timeList) return;
    const byKey = new Map();
    slots.slice()
      .sort((a, b) => (a.dataset.start || '').localeCompare(b.dataset.start || '')
        || (a.dataset.label || '').localeCompare(b.dataset.label || ''))
      .forEach(el => {
        const key = el.dataset.day || 'other';
        let day = byKey.get(key);
        if (!day) {
          const section = document.createElement('section');
          section.className = 'positions__day';
          section.id = `day-${key}`;
          const heading = document.createElement('h3');
          heading.className = 'positions__day-title';
          heading.textContent = el.dataset.dayLabel || 'Other times';
          const list = document.createElement('ul');
          list.className = 'slot-list';
          section.appendChild(heading);
          section.appendChild(list);
          timeList.appendChild(section);
          let link = null;
          if (dayLinks) {
            link = document.createElement('a');
            link.className = 'positions__day-link';
            link.href = `#${section.id}`;
            link.textContent = heading.textContent;
            dayLinks.appendChild(link);
          }
          day = { section, list, link, slots: [] };
          byKey.set(key, day);
          days.push(day);
        }
        day.slots.push(el);
      });
  }

  function applyFilter() {
    const hideFull = !!(onlyOpen && onlyOpen.checked);
    let hidden = 0;
    slots.forEach(el => {
      const keep = !hideFull || !el.classList.contains('is-full') || el.classList.contains('is-mine');
      el.hidden = !keep;
      if (!keep) hidden += 1;
    });
    root.querySelectorAll('.positions__station').forEach(card => {
      card.hidden = !Array.from(card.querySelectorAll('.slot')).some(el => !el.hidden);
    });
    let visibleDays = 0;
    days.forEach(day => {
      const show = day.slots.some(el => !el.hidden);
      day.section.hidden = !show;
      if (day.link) day.link.hidden = !show;
      if (show) visibleDays += 1;
    });
    if (dayLinks) dayLinks.hidden = visibleDays < 2;
    if (hiddenCount) hiddenCount.textContent = hideFull && hidden ? `(${hidden} full hidden)` : '';
    if (noneOpen) noneOpen.hidden = !(hideFull && hidden === slots.length);
  }

  function applyViewMode() {
    if (viewMode && viewMode.value === 'time' && stationView && timeView && timeList) {
      buildDays();
      days.forEach(day => day.slots.forEach(el => day.list.appendChild(el)));
      stationView.hidden = true;
      timeView.hidden = false;
    } else if (stationView && timeView) {
      slots.forEach(el => {
        const marker = homes.get(el);
        if (marker && marker.parentNode) marker.parentNode.insertBefore(el, marker.nextSibling);
      });
      timeView.hidden = true;
      stationView.hidden = false;
    }
    applyFilter();
  }

  if (onlyOpen) onlyOpen.addEventListener('change', applyFilter);
  if (viewMode) viewMode.addEventListener('change', applyViewMode);
  root.addEventListener('positions:change', applyFilter);
  applyViewMode();
})();
