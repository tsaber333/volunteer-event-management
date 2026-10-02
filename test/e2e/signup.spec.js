const { test, expect } = require('@playwright/test');
const { ids, slot, signUpFor, fillContact, confirm, waitForEmail } = require('./support/helpers');

const picks = page => page.locator('[data-role="picks-list"]');
const pickGroup = (page, blockId) => picks(page).locator(`.pick-group[data-block-id="${blockId}"]`);

test('sign yourself up for a spot', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto(`/events/${events.serve}`);
  await expect(page.locator('[data-role="picks-empty"]')).toBeVisible();

  await signUpFor(page, blocks.greeters9);
  await expect(page.locator('.toast')).toContainText('Added Greeters');
  await expect(slot(page, blocks.greeters9).locator('[data-role="picked"]')).toContainText('✓ Added');

  // On a computer, Step 2 is below the list and the bar scrolls to it.
  const bar = page.locator('[data-role="picks-bar"]');
  await expect(bar).toContainText('1 spot picked');
  const step = page.locator('#signup-step');
  const [listBottom, stepTop] = await page.evaluate(() => [
    document.querySelector('#positions').getBoundingClientRect().bottom,
    document.querySelector('#signup-step').getBoundingClientRect().top
  ]);
  expect(stepTop).toBeGreaterThanOrEqual(listBottom);
  await bar.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Step 2: Review and confirm' })).toBeInViewport();
  await expect(step).not.toHaveClass(/is-sheet/);
  await expect(bar).toBeHidden();

  await fillContact(page, { name: 'Ann Tester', email: 'ann@example.test' });
  await expect(pickGroup(page, blocks.greeters9).locator('.pick-chip')).toHaveText(/Me \(Ann Tester\)/);
  await confirm(page);

  await expect(page.getByRole('heading', { name: 'Thank you for signing up!' })).toBeVisible();
  await expect(page.locator('.my-signup')).toContainText('You reserved 1 spot');
  await expect(page.locator('.my-signup__list')).toContainText('Ann Tester');
  await expect(page.locator('.my-signup__list')).toContainText('Greeters');
  await expect(page.getByRole('link', { name: 'Google Calendar' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download calendar file' })).toBeVisible();

  const email = await waitForEmail('ann@example.test', /^Your volunteer schedule for Serve Day/);
  expect(email.attachments).toEqual([expect.objectContaining({ contentType: expect.stringContaining('text/calendar') })]);
});

test('missing contact details are caught before sending', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto(`/events/${events.serve}`);
  await signUpFor(page, blocks.greeters10);
  const error = page.locator('[data-role="form-error"]');

  await confirm(page);
  await expect(error).toHaveText('Please enter your name.');
  await fillContact(page, { name: 'No Email', email: 'not-an-email' });
  await confirm(page);
  await expect(error).toHaveText('Please enter a valid email address.');
});

test('sign up yourself and a family member', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto(`/events/${events.serve}`);

  await page.getByRole('button', { name: '+ Add person' }).click();
  await page.getByLabel('Name of the person to add to your group').fill('Kid Tester');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // With two people free, "Sign up" asks who is taking it.
  await signUpFor(page, blocks.setup8);
  const chooser = slot(page, blocks.setup8).locator('.slot__chooser');
  await chooser.getByRole('checkbox', { name: 'Me' }).check();
  await chooser.getByRole('checkbox', { name: 'Kid Tester' }).check();
  await chooser.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(pickGroup(page, blocks.setup8).locator('.pick-chip')).toHaveCount(2);

  await fillContact(page, { name: 'Pat Parent', email: 'pat@example.test' });
  await confirm(page);
  await expect(page.locator('.my-signup')).toContainText('You reserved 2 spots');
  await expect(page.locator('.my-signup__list')).toContainText('Pat Parent');
  await expect(page.locator('.my-signup__list')).toContainText('Kid Tester');
});

test('anyone in the group can be taken off a spot, not just the last one added', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto(`/events/${events.serve}`);
  for (const name of ['Ann Able', 'Bo Baker']) {
    await page.getByRole('button', { name: '+ Add person' }).click();
    await page.getByLabel('Name of the person to add to your group').fill(name);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
  }

  await signUpFor(page, blocks.setup8);
  const chooser = slot(page, blocks.setup8).locator('.slot__chooser');
  for (const name of ['Me', 'Ann Able', 'Bo Baker']) await chooser.getByRole('checkbox', { name }).check();
  await chooser.getByRole('button', { name: 'Add', exact: true }).click();

  const mine = slot(page, blocks.setup8).locator('[data-role="mine"]');
  await expect(mine.locator('.pick-chip')).toHaveCount(3);
  await expect(slot(page, blocks.setup8).locator('[data-role="picked"]')).toHaveText('✓ Added ×3');

  await mine.getByRole('button', { name: /^Remove Me/ }).click();
  await mine.getByRole('button', { name: /^Remove Ann Able/ }).click();
  await expect(mine.locator('.pick-chip')).toHaveText([/Bo Baker/]);
  await expect(slot(page, blocks.setup8).locator('[data-role="picked"]')).toHaveText('✓ Added');
  await expect(pickGroup(page, blocks.setup8).locator('.pick-chip')).toHaveText([/Bo Baker/]);
});

test('sign up only someone else', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto(`/events/${events.serve}`);

  await page.getByRole('button', { name: /^✓ Me/ }).click();
  await expect(page.getByRole('button', { name: 'Me (not coming)' })).toBeVisible();
  await page.getByRole('button', { name: '+ Add person' }).click();
  await page.getByLabel('Name of the person to add to your group').fill('Solo Kid');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  await signUpFor(page, blocks.greeters10);
  await expect(pickGroup(page, blocks.greeters10).locator('.pick-chip')).toHaveText(/Solo Kid/);

  await fillContact(page, { name: 'Guardian Person', email: 'guardian@example.test' });
  await confirm(page);
  const list = page.locator('.my-signup__list');
  await expect(list).toContainText('Solo Kid');
  await expect(list).not.toContainText('Guardian Person');
});

test('one person can’t take overlapping times', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto(`/events/${events.serve}`);
  await signUpFor(page, blocks.greeters9);

  const kitchen = slot(page, blocks.kitchen930);
  await expect(kitchen.locator('[data-role="note"]')).toHaveText('You’re already signed up for Greeters at this time.');
  await expect(kitchen.locator('[data-role="add"]')).toHaveText('+ Someone else');

  await kitchen.locator('[data-role="add"]').click();
  const chooser = kitchen.locator('.slot__chooser');
  await expect(chooser.getByRole('checkbox', { name: /^Me/ })).toBeDisabled();
  await expect(chooser).toContainText('busy at Greeters');
  await chooser.getByLabel('Name of someone else taking Kitchen', { exact: false }).fill('Other Helper');
  await chooser.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(pickGroup(page, blocks.kitchen930).locator('.pick-chip')).toHaveText(/Other Helper/);
});

test('a busy group gets one combined note per station', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto(`/events/${events.serve}`);
  for (const name of ['Ann', 'Bo']) {
    await page.getByRole('button', { name: '+ Add person' }).click();
    await page.getByLabel('Name of the person to add to your group').fill(name);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
  }
  await signUpFor(page, blocks.greeters9);
  const chooser = slot(page, blocks.greeters9).locator('.slot__chooser');
  for (const name of ['Me', 'Ann', 'Bo']) await chooser.getByRole('checkbox', { name }).check();
  await chooser.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(slot(page, blocks.kitchen930).locator('[data-role="note"]'))
    .toHaveText('You, Ann and Bo are already signed up for Greeters at this time.');
});

test('overlapping times are fine when the event allows it', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto(`/events/${events.flexible}`);
  await signUpFor(page, blocks.parking9);
  await expect(slot(page, blocks.coffee930).locator('[data-role="add"]')).toHaveText('Sign up');
  await signUpFor(page, blocks.coffee930);
  await expect(picks(page).locator('.pick-chip')).toHaveCount(2);

  await fillContact(page, { name: 'Flex Person', email: 'flex@example.test' });
  await confirm(page);
  await expect(page.locator('.my-signup')).toContainText('You reserved 2 spots');
});
