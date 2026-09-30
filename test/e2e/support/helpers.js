const fs = require('fs');
const path = require('path');
const { expect } = require('@playwright/test');

const dir = process.env.VA_TEST_DIR;

function ids() {
  return JSON.parse(fs.readFileSync(path.join(dir, 'seed.json'), 'utf8'));
}

// Emails "sent" by the app during the run, oldest first.
function outbox() {
  const file = path.join(dir, 'outbox.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function waitForEmail(to, subjectPattern) {
  let found = null;
  await expect.poll(() => {
    found = outbox().filter(m => m.to === to && subjectPattern.test(m.subject)).pop() || null;
    return !!found;
  }, { message: `email to ${to} matching ${subjectPattern}` }).toBe(true);
  return found;
}

function manageLinkIn(message) {
  const match = String(message.text || '').match(/https?:\/\/[^\s]+\/manage\/[a-f0-9]+/i);
  if (!match) throw new Error(`No manage link in email "${message.subject}"`);
  return new URL(match[0]).pathname;
}

function slot(page, blockId) {
  return page.locator(`.slot[data-block-id="${blockId}"]`);
}

async function signUpFor(page, blockId) {
  await slot(page, blockId).locator('[data-role="add"]').click();
}

async function fillContact(page, { name, email, phone = '' }) {
  await page.fill('#signup-name', name);
  await page.fill('#signup-email', email);
  if (phone) await page.fill('#signup-phone', phone);
}

async function confirm(page) {
  await page.getByRole('button', { name: 'Confirm sign-up' }).click();
}

async function expectNoSideScroll(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'page should not scroll sideways').toBeLessThanOrEqual(0);
}

// Signs one person up for the given spots and returns the manage page path.
async function quickSignup(page, { eventId, blockIds, name, email }) {
  await page.goto(`/events/${eventId}`);
  for (const blockId of blockIds) await signUpFor(page, blockId);
  await fillContact(page, { name, email });
  await confirm(page);
  await expect(page.getByRole('heading', { name: 'Thank you for signing up!' })).toBeVisible();
  return new URL(await page.getByRole('link', { name: 'See or change my sign-up' }).getAttribute('href'), page.url()).pathname;
}

module.exports = {
  ids,
  outbox,
  waitForEmail,
  manageLinkIn,
  slot,
  signUpFor,
  fillContact,
  confirm,
  expectNoSideScroll,
  quickSignup
};
