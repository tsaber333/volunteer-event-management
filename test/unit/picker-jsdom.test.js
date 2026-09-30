const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

function loadScript(dom, scriptPath) {
  const code = fs.readFileSync(scriptPath, 'utf8');
  const scriptEl = dom.window.document.createElement('script');
  scriptEl.textContent = code;
  dom.window.document.body.appendChild(scriptEl);
}

async function runScenario() {
  const html = `<!doctype html><html><head></head><body>
    <button id="openTest" data-open="#testModal">Open Modal</button>
    <div id="testModal" class="modal" role="dialog" aria-hidden="true" style="display:none;">
      <div class="modal-content">
        <form>
          <div class="form-group">
            <label for="start-visible">Start</label>
            <input type="hidden" id="start-hidden" name="start_time" value="">
            <input type="datetime-local"
                   id="start-visible"
                   class="datetime-field"
                   data-canonical-target="start-hidden"
                   step="900">
          </div>
          <button type="submit">Save</button>
        </form>
        <button class="close-btn" data-close="#testModal">Close</button>
      </div>
    </div>
  </body></html>`;

  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable' });
  const window = dom.window;
  global.window = window;
  global.document = window.document;

  const clientScript = path.join(__dirname, '..', '..', 'src', 'public', 'js', 'admin-event-detail.js');
  loadScript(dom, clientScript);

  await new Promise(r => setTimeout(r, 50));

  const openButton = window.document.querySelector('#openTest');
  openButton.click();
  await new Promise(r => setTimeout(r, 25));

  const modal = window.document.querySelector('.modal[aria-hidden="false"]');
  if (!modal) throw new Error('Modal did not open');

  const visible = modal.querySelector('.datetime-field');
  const hidden = modal.querySelector('input[type="hidden"][name="start_time"]');
  if (!visible) throw new Error('Visible datetime field missing');
  if (!hidden) throw new Error('Hidden canonical input missing');

  // Simulate user input
  visible.value = '2025-10-06T12:30';
  visible.dispatchEvent(new window.Event('input', { bubbles: true }));
  visible.dispatchEvent(new window.Event('change', { bubbles: true }));

  if (hidden.value !== '2025-10-06 12:30') {
    throw new Error(`Hidden value not canonicalised correctly (got "${hidden.value}")`);
  }

  // Submitting should keep the canonical value intact
  const form = modal.querySelector('form');
  let submitPrevented = false;
  form.addEventListener('submit', e => {
    e.preventDefault();
    submitPrevented = true;
  });
  form.dispatchEvent(new window.Event('submit'));

  if (!submitPrevented) throw new Error('Form submit listener failed');
  if (hidden.value !== '2025-10-06 12:30') {
    throw new Error('Hidden value changed after submit sync');
  }

  return true;
}

runScenario()
  .then(() => {
    console.log('JSDOM datetime sync smoke test: SUCCESS');
  })
  .catch(err => {
    console.error('JSDOM datetime sync smoke test FAILED:', err);
    process.exit(2);
  });
