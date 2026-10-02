// src/public/js/main.js
// Public-side behaviors (CSP-safe; no inline JS).
// IMPORTANT: We do NOT convert times. We display exactly what the server rendered.
// The Selected Times list is built from the UI text inside each opportunity.

document.addEventListener('DOMContentLoaded', () => {
  // Toast/snackbar on Manage page ---------------------------------------------------
  try {
    const toastRoot = document.getElementById('toast-root');
    const toastData = document.getElementById('manage-toast-data');
    const showToast = (message, variant) => {
      if (!toastRoot || !message) return;
      const el = document.createElement('div');
      el.className = 'toast ' + (variant === 'success' ? 'toast--success' : (variant === 'danger' ? 'toast--danger' : ''));
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.innerHTML = `
        <svg class="toast__icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 14.414-4.207-4.207 1.414-1.414L11 13.586l4.793-4.793 1.414 1.414L11 16.414Z"/></svg>
        <span>${message}</span>
        <button type="button" class="toast__close" aria-label="Close">×</button>`;
      toastRoot.appendChild(el);
      const remove = () => { try { el.remove(); } catch (_) {} };
      const close = el.querySelector('.toast__close');
      if (close) close.addEventListener('click', remove);
      setTimeout(remove, 4200);
    };
    // Try data attribute first; fall back to inline success notice text.
    let successMsg = '';
    if (toastData) {
      successMsg = toastData.getAttribute('data-success') || '';
    }
    if (successMsg && successMsg.trim()) {
      showToast(successMsg.trim(), 'success');
    } else {
      const inline = document.querySelector('.notice.notice--success');
      if (inline) {
        const text = (inline.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) showToast(text, 'success');
      }
    }
  } catch (_) {}
  console.log('DOM fully loaded. Initializing scripts.');

  function fallbackCopyText(text) {
    return new Promise((resolve, reject) => {
      try {
        const el = document.createElement('textarea');
        el.value = text;
        el.setAttribute('readonly', '');
        el.style.position = 'fixed';
        el.style.top = '-999px';
        el.style.left = '-999px';
        document.body.appendChild(el);
        el.select();
        el.setSelectionRange(0, el.value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(el);
        if (ok) resolve();
        else reject(new Error('Copy command failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  function copyTextToClipboard(text) {
    if (!text) return Promise.reject(new Error('Nothing to copy'));
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
    }
    return fallbackCopyText(text);
  }

  // Optional debug outlines (?debug=containers)
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === 'containers') {
      document.documentElement.classList.add('debug-containers');
    }
  } catch (_) {}

  // Share link buttons (admin + public pages) -------------------------------
  (function initShareLinkCopyButtons() {
    const buttons = document.querySelectorAll('[data-copy-share-link]');
    if (!buttons.length) return;
    buttons.forEach((btn) => {
      if (btn.dataset.shareHandlerAttached === '1') return;
      btn.dataset.shareHandlerAttached = '1';
      const defaultLabel = btn.getAttribute('data-label-default') || 'Copy link';
      const successLabel = btn.getAttribute('data-label-success') || 'Copied!';
      const errorLabel = btn.getAttribute('data-label-error') || 'Unable to copy';
      const labelEl = btn.querySelector('.share-link__copy-label') || btn;

      function resetState() {
        btn.classList.remove('is-busy');
        btn.classList.remove('is-copied');
        if (labelEl) labelEl.textContent = defaultLabel;
      }

      btn.addEventListener('click', () => {
        const value = btn.getAttribute('data-copy-share-link');
        if (!value) return;
        btn.classList.add('is-busy');
        copyTextToClipboard(value).then(() => {
          btn.classList.add('is-copied');
          if (labelEl) labelEl.textContent = successLabel;
          setTimeout(() => resetState(), 2000);
        }).catch(() => {
          btn.classList.remove('is-copied');
          if (labelEl) labelEl.textContent = errorLabel;
          setTimeout(() => resetState(), 2500);
        });
      });
    });
  })();

  // ---- (Admin pages) datepicker initialization handled in admin JS when a modal opens ----

  // Responsive navigation toggle
  try {
    const navToggle = document.querySelector('[data-nav-toggle]');
    const primaryNav = document.querySelector('[data-nav]');
    if (navToggle && primaryNav) {
      const closeNav = () => {
        primaryNav.setAttribute('data-nav-state', 'closed');
        navToggle.setAttribute('aria-expanded', 'false');
      };
      navToggle.addEventListener('click', () => {
        const isOpen = primaryNav.getAttribute('data-nav-state') === 'open';
        const next = isOpen ? 'closed' : 'open';
        primaryNav.setAttribute('data-nav-state', next);
        navToggle.setAttribute('aria-expanded', String(!isOpen));
      });
      primaryNav.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => closeNav());
      });
      window.addEventListener('resize', () => {
        if (window.innerWidth >= 961) {
          closeNav();
        }
      });
    }
  } catch (err) {
    console.error('[NavToggle] Failed to initialize responsive navigation toggle:', err);
  }

  // Account menu (header) — close when clicking outside or pressing Esc
  try {
    const closeOpenAccountMenus = () => {
      document.querySelectorAll('details.account-menu[open]').forEach(d => d.removeAttribute('open'));
    };

    document.addEventListener('click', (e) => {
      document.querySelectorAll('details.account-menu[open]').forEach(d => {
        if (!d.contains(e.target)) d.removeAttribute('open');
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeOpenAccountMenus();
    });
  } catch (err) {
    console.error('[AccountMenu] Failed to wire outside/esc close:', err);
  }

  // Help dropdown (header) — close when clicking outside or pressing Esc
  try {
    const closeHelpMenus = () => {
      document.querySelectorAll('.topbar__help details[open]').forEach(d => d.removeAttribute('open'));
    };

    document.addEventListener('click', (e) => {
      document.querySelectorAll('.topbar__help details[open]').forEach(d => {
        if (!d.contains(e.target)) d.removeAttribute('open');
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeHelpMenus();
    });
  } catch (err) {
    console.error('[HelpMenu] Failed to wire outside/esc close:', err);
  }

  // Print helpers (CSP-safe; no inline handlers)
  try {
    const params = new URLSearchParams(location.search || '');
    const auto = params.get('auto');
    // Debug helpers: enable spacing outlines with ?debug=spacing
    const debugFlag = params.get('debug');
    if (debugFlag && /^(1|true|on|yes|spacing)$/i.test(debugFlag)) {
      try { document.body.classList.add('debug-spacing'); } catch (_) {}
    }
    const printBtn = document.querySelector('[data-action="print"]');
    if (printBtn) {
      printBtn.addEventListener('click', (e) => {
        e.preventDefault();
        try { window.print(); } catch (err) { console.error('[Print] Failed to invoke print:', err); }
      });
    }
    if (auto === '1') {
      setTimeout(() => {
        try { window.print(); } catch (err) { console.error('[Print] Auto print failed:', err); }
      }, 200);
    }
  } catch (err) {
    console.error('[Print] Initialization error:', err);
  }

  // Admin Dashboard: client-side sorting for events table
  try {
    const eventsTable = document.querySelector('#adminEventsTable');
    if (eventsTable) {
      const tbody = eventsTable.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr.event-row'));

      function parseDateForAdmin(raw) {
        if (!raw) return Number.NaN;
        let d = new Date(raw);
        if (Number.isNaN(d.getTime())) {
          d = new Date(String(raw).replace(' ', 'T'));
        }
        if (Number.isNaN(d.getTime())) {
          d = new Date(String(raw).replace(' ', 'T') + 'Z');
        }
        const t = d.getTime();
        return Number.isNaN(t) ? Number.NaN : t;
      }

      function applyAdminSort(key, direction) {
        const dir = direction === 'desc' ? -1 : 1;
        const sorted = rows.slice().sort((a, b) => {
          if (key === 'date') {
            const aRaw = a.getAttribute('data-sort-date') || '';
            const bRaw = b.getAttribute('data-sort-date') || '';
            const aTs = parseDateForAdmin(aRaw);
            const bTs = parseDateForAdmin(bRaw);
            if (Number.isNaN(aTs) && Number.isNaN(bTs)) return 0;
            if (Number.isNaN(aTs)) return 1;
            if (Number.isNaN(bTs)) return -1;
            if (aTs === bTs) return 0;
            return aTs < bTs ? -1 * dir : 1 * dir;
          }
          if (key === 'name') {
            const aName = (a.getAttribute('data-sort-name') || '').toLowerCase();
            const bName = (b.getAttribute('data-sort-name') || '').toLowerCase();
            return aName.localeCompare(bName) * dir;
          }
          if (key === 'status') {
            const aStatus = (a.getAttribute('data-sort-status') || '').toLowerCase();
            const bStatus = (b.getAttribute('data-sort-status') || '').toLowerCase();
            if (aStatus === bStatus) return 0;
            return aStatus < bStatus ? -1 * dir : 1 * dir;
          }
          return 0;
        });

        sorted.forEach(tr => tbody.appendChild(tr));
      }

      // Default: newest (latest start) first
      applyAdminSort('date', 'desc');

      const headers = eventsTable.querySelectorAll('thead th[data-sort-key]');
      headers.forEach(th => {
        const key = th.getAttribute('data-sort-key');
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => {
          const current = th.getAttribute('data-sort-dir') || 'desc';
          const next = current === 'asc' ? 'desc' : 'asc';
          headers.forEach(h => h.removeAttribute('aria-sort'));
          th.setAttribute('data-sort-dir', next);
          th.setAttribute('aria-sort', next === 'asc' ? 'ascending' : 'descending');
          applyAdminSort(key, next);
        });
      });

      // Allow clicking anywhere on the row to manage the event (except action controls)
      rows.forEach(row => {
        const targetUrl = row.getAttribute('data-event-url');
        if (!targetUrl) return;
        row.addEventListener('click', (event) => {
          const blocker = event.target.closest('a, button, summary, input, select, textarea, details');
          if (blocker) return;
          window.location.href = targetUrl;
        });
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            const blocker = event.target.closest('a, button, summary, input, select, textarea, details');
            if (blocker) return;
            event.preventDefault();
            window.location.href = targetUrl;
          }
        });
        row.setAttribute('tabindex', '0');
        row.setAttribute('role', 'link');
        const eventName = row.getAttribute('data-event-name') || row.getAttribute('data-sort-name') || 'event';
        row.setAttribute('aria-label', 'Manage event ' + eventName);
      });
    }
  } catch (err) {
    console.error('[AdminDashboard] Failed to initialize table sorting:', err);
  }

  // Generic dropdowns (details.dropdown) — stable + floating portal for dashboard
  try {

    const portalMap = new WeakMap(); // details -> { menu, placeholder }

    function openPortal(details) {
      if (!details.classList.contains('dropdown--float')) return;
      const summary = details.querySelector('summary');
      const menu = details.querySelector('.dropdown__menu');
      if (!summary || !menu) return;
      if (portalMap.has(details)) return; // already portaled
      const placeholder = document.createElement('span');
      placeholder.style.display = 'none';
      menu.parentNode.insertBefore(placeholder, menu);
      document.body.appendChild(menu);
      menu.classList.add('is-portal');
      // Measure and position
      const rect = summary.getBoundingClientRect();
      const menuWidth = 240;
      const prevDisp = menu.style.display, prevVis = menu.style.visibility;
      if (getComputedStyle(menu).display === 'none') { menu.style.visibility = 'hidden'; menu.style.display = 'block'; }
      const menuHeight = Math.max(menu.offsetHeight || 0, 120);
      menu.style.display = prevDisp; menu.style.visibility = prevVis;
      let left = rect.right - menuWidth;
      let top = rect.bottom + 6;
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < menuHeight + 12) top = rect.top - menuHeight - 6;
      left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - 8));
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
      menu.style.right = 'auto';
      portalMap.set(details, { menu, placeholder });
    }

    function closePortal(details) {
      const data = portalMap.get(details);
      if (!data) return;
      const { menu, placeholder } = data;
      menu.classList.remove('is-portal');
      menu.style.left = '';
      menu.style.top = '';
      menu.style.right = '';
      if (placeholder.parentNode) placeholder.parentNode.insertBefore(menu, placeholder);
      placeholder.remove();
      portalMap.delete(details);
    }

    // Close on outside click (consider portaled menus)
    document.addEventListener('click', (e) => {
      document.querySelectorAll('details.dropdown[open]').forEach(d => {
        const data = portalMap.get(d);
        const menu = data && data.menu;
        if (d.contains(e.target)) return;
        if (menu && menu.contains(e.target)) return;
        d.removeAttribute('open');
      });
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('details.dropdown[open]').forEach(d => d.removeAttribute('open'));
    });

    // Toggle handler to portal/unportal floating menus
    document.addEventListener('toggle', (e) => {
      const el = e.target;
      if (!(el && el.matches && el.matches('details.dropdown'))) return;
      if (el.open) {
        openPortal(el);
      } else {
        closePortal(el);
      }
    }, true);

    // Reposition on scroll/resize
    const repro = () => document.querySelectorAll('details.dropdown.dropdown--float[open]').forEach(d => { closePortal(d); openPortal(d); });
    window.addEventListener('resize', repro);
    window.addEventListener('scroll', repro, true);

  } catch (err) {
    console.error('[Dropdowns] Failed to wire outside/esc close:', err);
  }

  // Debug overlay: outline elements that may create stacking contexts (useful for modal z-index bugs)
  (function(){
    const debugKey = 'ui-debug-overlay';
    function createOverlay() {
      const style = document.createElement('style');
      style.id = 'ui-debug-overlay-style';
      style.textContent = `
        .ui-debug-outline { outline: 2px dashed rgba(255,0,0,0.9) !important; }
      `;
      document.head.appendChild(style);
      const els = Array.from(document.querySelectorAll('*'));
      els.forEach(el => {
        try {
          const cs = getComputedStyle(el);
          if (['fixed','absolute','relative','sticky'].includes(cs.position) || cs.zIndex !== 'auto' || cs.transform !== 'none') {
            el.classList.add('ui-debug-outline');
          }
        } catch (e) { /* ignore */ }
      });
    }

    function removeOverlay() {
      const style = document.getElementById('ui-debug-overlay-style');
      if (style) style.remove();
      document.querySelectorAll('.ui-debug-outline').forEach(e => e.classList.remove('ui-debug-outline'));
    }

    function toggleDebug(force) {
      const on = typeof force === 'boolean' ? force : !localStorage.getItem(debugKey);
      if (on) {
        createOverlay();
        localStorage.setItem(debugKey, '1');
        console.log('UI debug overlay: ON');
      } else {
        removeOverlay();
        localStorage.removeItem(debugKey);
        console.log('UI debug overlay: OFF');
      }
    }

    // keyboard shortcut: Ctrl+Shift+D to toggle
    document.addEventListener('keydown', function(e){
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        toggleDebug();
      }
    });

    // restore state
    if (localStorage.getItem(debugKey)) toggleDebug(true);
  })();

});
  // Generic datetime -> hidden canonical sync for any form using .datetime-field
  try {
    function canonicalFromLocal(value) {
      if (!value) return '';
      if (value.includes('T')) {
        const [date, time] = value.split('T');
        return `${date} ${time.slice(0, 5)}`;
      }
      const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
      const d = new Date(value);
      if (!isNaN(d)) {
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
      return '';
    }

    function syncDatetimeFields(root) {
      const forms = Array.from((root || document).querySelectorAll('form'));
      forms.forEach(form => {
        if (form._canonInit) return;
        form.addEventListener('submit', () => {
          form.querySelectorAll('.datetime-field').forEach(field => {
            const targetId = field.getAttribute('data-canonical-target');
            if (!targetId) return;
            const hidden = document.getElementById(targetId);
            if (hidden) hidden.value = canonicalFromLocal(field.value);
          });
        });
        form._canonInit = true;
      });
    }
    syncDatetimeFields(document);
  } catch (err) {
    console.error('[DatetimeSync] init failed:', err);
  }

  // Admin Dashboard: validate New Event form client-side (modal)
  try {
    const newEventForm = document.getElementById('newEventForm');
    if (newEventForm) {
      newEventForm.addEventListener('submit', (e) => {
        const name = document.getElementById('event-name');
        const startVisible = document.getElementById('event-start-new');
        const endVisible = document.getElementById('event-end-new');
        const errors = [];
        if (!name || !name.value.trim()) errors.push('Event name is required.');
        if (!startVisible || !startVisible.value) errors.push('Start date & time is required.');
        if (!endVisible || !endVisible.value) errors.push('End date & time is required.');
        if (startVisible && endVisible && startVisible.value && endVisible.value) {
          const s = new Date(startVisible.value);
          const t = new Date(endVisible.value);
          if (!isNaN(s) && !isNaN(t) && t <= s) errors.push('End must be after start.');
        }
        if (errors.length) {
          e.preventDefault();
          // Render inline error list near the form
          let box = document.getElementById('newEventErrors');
          if (!box) {
            box = document.createElement('div');
            box.id = 'newEventErrors';
            box.className = 'notice notice--error';
            newEventForm.insertBefore(box, newEventForm.firstChild);
          }
          box.innerHTML = '<ul>' + errors.map(m => `<li>${m}</li>`).join('') + '</ul>';
          try { name && name.focus(); } catch (_) {}
        }
      });
    }
  } catch (err) {
    console.error('[NewEventValidation] init failed:', err);
  }
