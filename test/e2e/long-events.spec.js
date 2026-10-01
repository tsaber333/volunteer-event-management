const { test, expect } = require('@playwright/test');
const { ids, slot, signUpFor, expectNoSideScroll, quickSignup } = require('./support/helpers');

const viewMode = page => page.locator('[data-role="view-mode"]');
const onlyOpen = page => page.getByLabel(/Show only open spots/);
const dayLinks = page => page.locator('.positions__day-link:visible');

test('long multi-day event starts grouped by day with full spots hidden', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto(`/events/${events.big}`);

  await expect(viewMode(page)).toHaveValue('time');
  await expect(onlyOpen(page)).toBeChecked();
  await expect(page.locator('[data-role="hidden-count"]')).toHaveText('(1 full hidden)');
  await expect(slot(page, blocks.bigParking)).toBeHidden();

  await expect(dayLinks(page)).toHaveCount(2);
  const headings = page.locator('.positions__day-title:visible');
  await expect(headings).toHaveCount(2);
  // Under a day heading, slots show just the time.
  await expect(slot(page, blocks.bigSound).locator('.slot__title')).toHaveText(/^\d{1,2}:\d{2}\s?[AP]M – \d{1,2}:\d{2}\s?[AP]M$/, { useInnerText: true });

  await dayLinks(page).last().click();
  await expect(page).toHaveURL(/#day-\d{4}-\d{2}-\d{2}$/);
  const top = await headings.last().evaluate(el => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top).toBeLessThan(100);
});

test('full stations shrink to one line and open on tap', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto(`/events/${events.big}`);
  await onlyOpen(page).uncheck();
  await viewMode(page).selectOption('station');

  const parking = page.locator('.positions__station.is-all-full', { hasText: 'Parking Lead' });
  await expect(parking.locator('summary')).toContainText('Full — thank you!');
  await expect(slot(page, blocks.bigParking)).toBeHidden();
  await parking.locator('summary').click();
  await expect(slot(page, blocks.bigParking)).toBeVisible();
  await expect(page.locator('.positions__station.is-all-full')).toHaveCount(1);
});

test('signing up still works in the day view, and a spot you fill stays visible', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto(`/events/${events.big}`);
  await signUpFor(page, blocks.bigSound);

  await expect(slot(page, blocks.bigSound)).toHaveClass(/is-full/);
  await expect(slot(page, blocks.bigSound)).toBeVisible();
  await expect(page.locator(`[data-role="picks-list"] .pick-group[data-block-id="${blocks.bigSound}"]`)).toBeVisible();
  await expect(page.locator('[data-role="hidden-count"]')).toHaveText('(1 full hidden)');
});

test('short single-day events keep the station view with everything shown', async ({ page }) => {
  const { events } = ids();
  await page.goto(`/events/${events.serve}`);
  await expect(viewMode(page)).toHaveValue('station');
  await expect(onlyOpen(page)).not.toBeChecked();
  await expect(page.locator('.positions__days')).toBeHidden();
});

test('view controls work on the “already signed up” page too', async ({ page }) => {
  const { events, blocks } = ids();
  await quickSignup(page, { eventId: events.big, blockIds: [blocks.bigUshersDay2], name: 'Rob Return', email: 'rob@example.test' });
  await page.goto(`/events/${events.big}`);
  await expect(page.getByRole('heading', { name: 'You’re signed up, Rob!' })).toBeVisible();

  await expect(slot(page, blocks.bigParking)).toBeHidden();
  await onlyOpen(page).uncheck();
  await expect(slot(page, blocks.bigParking)).toBeVisible();
  await viewMode(page).selectOption('station');
  await expect(page.locator('.positions__station.is-all-full', { hasText: 'Parking Lead' })).toBeVisible();
});

test('the top bar stays on screen to the bottom of a long page', async ({ page }) => {
  const { events } = ids();
  await page.goto(`/events/${events.big}`);
  await onlyOpen(page).uncheck();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.locator('.topbar').evaluate(el => el.getBoundingClientRect().top)).toBe(0);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('long event fits a phone screen in both views', async ({ page }) => {
    const { events } = ids();
    await page.goto(`/events/${events.big}`);
    await expectNoSideScroll(page);
    await onlyOpen(page).uncheck();
    await expectNoSideScroll(page);
    await viewMode(page).selectOption('station');
    await expectNoSideScroll(page);
  });
});
