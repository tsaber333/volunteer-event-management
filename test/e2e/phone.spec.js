const { test, expect } = require('@playwright/test');
const { ids, signUpFor, fillContact, confirm, expectNoSideScroll, quickSignup } = require('./support/helpers');
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('phone: picks slide up from the bottom to confirm', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto(`/events/${events.serve}`);
  await expectNoSideScroll(page);

  await signUpFor(page, blocks.greeters10);
  const bar = page.locator('[data-role="picks-bar"]');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('1 spot picked');

  const sheet = page.locator('#signup-step');
  await bar.getByRole('button', { name: 'Continue' }).click();
  await expect(sheet).toHaveClass(/is-sheet/);
  await expect(sheet).toHaveAttribute('role', 'dialog');
  await page.keyboard.press('Escape');
  await expect(sheet).not.toHaveClass(/is-sheet/);
  await expect(bar).toBeVisible();

  await bar.getByRole('button', { name: 'Continue' }).click();
  await fillContact(page, { name: 'Phoebe Phone', email: 'phoebe@example.test' });
  await confirm(page);
  await expect(page.getByRole('heading', { name: 'Thank you for signing up!' })).toBeVisible();
  await expectNoSideScroll(page);
});

test('phone: events list and manage page fit the screen', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto('/events');
  await expectNoSideScroll(page);

  const managePath = await quickSignup(page, { eventId: events.flexible, blockIds: [blocks.parking9], name: 'Mo Mobile', email: 'mo@example.test' });
  await page.goto(managePath);
  await expect(page.getByRole('heading', { name: /Your sign-up for Flexible Day/ })).toBeVisible();
  await expectNoSideScroll(page);
});
