const { test, expect } = require('@playwright/test');
const { ids, slot, signUpFor, fillContact, confirm, waitForEmail, manageLinkIn, quickSignup } = require('./support/helpers');

test('this device remembers your sign-up until you say “Not you?”', async ({ page }) => {
  const { events, blocks } = ids();
  const managePath = await quickSignup(page, { eventId: events.serve, blockIds: [blocks.greeters10], name: 'Rita Return', email: 'rita@example.test' });

  await page.goto(`/events/${events.serve}`);
  await expect(page.getByRole('heading', { name: 'You’re signed up, Rita!' })).toBeVisible();
  await expect(page.locator('.my-signup__list')).toContainText('Greeters');
  await expect(page.getByRole('link', { name: 'Add more or make changes' })).toHaveAttribute('href', managePath);
  await expect(page.getByRole('heading', { name: 'What’s still needed' })).toBeVisible();
  await expect(slot(page, blocks.setup8).getByRole('link', { name: 'Add' }))
    .toHaveAttribute('href', `${managePath}?add=${blocks.setup8}#your-signups`);

  await page.getByRole('button', { name: 'Not you? Start a new sign-up' }).click();
  await expect(page.getByText('This device no longer shows that sign-up.')).toBeVisible();
  await expect(page.getByRole('heading', { name: /You’re signed up/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Step 1: Choose where you’d like to help' })).toBeVisible();
});

test('typing someone else’s email never opens their sign-up', async ({ page, browser }) => {
  const { events, blocks } = ids();
  await quickSignup(page, { eventId: events.serve, blockIds: [blocks.greeters9], name: 'Vera Victim', email: 'vera@example.test' });

  const strangerCtx = await browser.newContext();
  const stranger = await strangerCtx.newPage();
  await stranger.goto(`/events/${events.serve}`);
  await signUpFor(stranger, blocks.kitchen930);
  await fillContact(stranger, { name: 'Mallory', email: 'vera@example.test' });
  await confirm(stranger);
  await expect(stranger.getByRole('heading', { name: 'You already have a sign-up for this event' })).toBeVisible();
  await expect(stranger.locator('a[href^="/manage/"]')).toHaveCount(0);

  await stranger.goto(`/events/${events.serve}`);
  await expect(stranger.getByRole('heading', { name: /You’re signed up/ })).toHaveCount(0);
  await expect(stranger.locator('a[href^="/manage/"]')).toHaveCount(0);
  await expect(stranger.locator('main')).not.toContainText('Vera');
  await strangerCtx.close();
});

test('signing up again with the same email emails an “Add these to my sign-up” button that works on any device', async ({ page, browser }) => {
  const { events, blocks } = ids();
  await quickSignup(page, { eventId: events.serve, blockIds: [blocks.setup8], name: 'Sam Same', email: 'sam@example.test' });

  const phoneCtx = await browser.newContext();
  const phone = await phoneCtx.newPage();
  await phone.goto(`/events/${events.serve}`);
  await signUpFor(phone, blocks.greeters10);
  await fillContact(phone, { name: 'Sam Same', email: 'sam@example.test' });
  await confirm(phone);
  await expect(phone.getByRole('heading', { name: 'You already have a sign-up for this event' })).toBeVisible();
  await expect(phone.getByRole('heading', { name: 'Check your email to finish' })).toBeVisible();
  await expect(phone.locator('main')).toContainText('Your 1 new spot will be ready');
  await phoneCtx.close();

  const email = await waitForEmail('sam@example.test', /^Add your new spots to your sign-up for Serve Day/);
  expect(email.text).toContain('You picked 1 spot for Serve Day');
  expect(email.text).toMatch(/- Greeters — .+ — Sam Same/);
  expect(email.text).toContain('Add these to my sign-up: http');
  expect(email.html).toContain('Add these to my sign-up');

  // A different browser from the one that made the picks.
  const laptopCtx = await browser.newContext();
  const laptop = await laptopCtx.newPage();
  const link = manageLinkIn(email);
  await laptop.goto(link);
  await expect(laptop.locator('[data-role="pending-note"]')).toContainText('We added 1 spot you picked.');
  const newPick = laptop.locator(`[data-role="picks-list"] .pick-group[data-block-id="${blocks.greeters10}"]`);
  await expect(newPick).toContainText('New');

  await laptop.getByRole('button', { name: 'Save changes' }).click();
  await expect(laptop.getByText('Your volunteer schedule has been updated.').first()).toBeVisible();
  await expect(laptop.locator('#your-signups [data-role="picks-count"]')).toHaveText('(2)');

  await laptop.goto(link);
  await expect(laptop.locator('#your-signups [data-role="picks-count"]')).toHaveText('(2)');
  await expect(laptop.locator('[data-role="pending-note"]')).not.toBeVisible();
  await laptopCtx.close();
});
