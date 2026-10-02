const { test, expect } = require('@playwright/test');
const { ids, signUpFor, quickSignup } = require('./support/helpers');

const count = page => page.locator('#your-signups [data-role="picks-count"]');
const pickGroup = (page, blockId) => page.locator(`[data-role="picks-list"] .pick-group[data-block-id="${blockId}"]`);

async function save(page) {
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Your volunteer schedule has been updated.').first()).toBeVisible();
}

test('manage page: remove a spot, add one, add a new person', async ({ page }) => {
  const { events, blocks } = ids();
  const managePath = await quickSignup(page, {
    eventId: events.serve,
    blockIds: [blocks.greeters9, blocks.greeters10],
    name: 'Mia Manage',
    email: 'mia@example.test'
  });

  await page.goto(managePath);
  await expect(count(page)).toHaveText('(2)');

  await pickGroup(page, blocks.greeters10).locator('.pick-chip__remove').click();
  await expect(page.locator('[data-role="dirty-note"]')).toBeVisible();
  await save(page);
  await expect(count(page)).toHaveText('(1)');

  await signUpFor(page, blocks.setup8);
  await expect(pickGroup(page, blocks.setup8)).toContainText('New');
  await save(page);
  await expect(count(page)).toHaveText('(2)');

  // Mia is busy at 9:30 (Greeters 9–10), so Kitchen goes straight to Max.
  await page.getByRole('button', { name: '+ Add person' }).click();
  await page.getByLabel('Name of the person to add to your group').fill('Max Manage');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await signUpFor(page, blocks.kitchen930);
  await expect(pickGroup(page, blocks.kitchen930).locator('.pick-chip')).toHaveText(/Max Manage/);
  await save(page);
  await expect(count(page)).toHaveText('(3)');
  await expect(page.locator('.participant-list input[name="name"]')).toHaveCount(2);

  const ics = await page.request.get(`${managePath}/calendar.ics`);
  expect(ics.headers()['content-type']).toContain('text/calendar');
  const body = await ics.text();
  expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(3);
  expect(body).toContain('Kitchen');
});

test('removing every spot cancels the sign-up', async ({ page }) => {
  const { events, blocks } = ids();
  const managePath = await quickSignup(page, { eventId: events.serve, blockIds: [blocks.setup8], name: 'Cleo Clear', email: 'cleo@example.test' });

  await page.goto(managePath);
  await pickGroup(page, blocks.setup8).locator('.pick-chip__remove').click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page).toHaveURL(new RegExp(`/events/${events.serve}$`));
  await expect(page.getByText('Your selections have been cleared.')).toBeVisible();
  await expect(page.getByRole('heading', { name: /You’re signed up/ })).toHaveCount(0);
});

test('a failed save never shows other volunteers’ details', async ({ page }) => {
  const { events, blocks } = ids();
  const managePath = await quickSignup(page, { eventId: events.big, blockIds: [blocks.bigSound], name: 'Pry Person', email: 'pry@example.test' });

  // Force a save into the full Parking Lead spot (held by seed-big@example.test), as a crafted request could.
  await page.goto(`${managePath}?debug=capacity`);
  await page.evaluate((blockId) => {
    const input = document.querySelector('input[name="registration_payload"]');
    input.value = JSON.stringify({ scheduleAssignments: [{ blockId, participantName: 'Pry Person' }], potluckAssignments: [] });
    input.form.submit();
  }, blocks.bigParking);

  await expect(page.locator('.notice--error').first()).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain('seed-big@example.test');
  expect(html).not.toContain('rawSchedRows');
});

test('an old or mistyped manage link goes back to the events list', async ({ page }) => {
  await page.goto('/manage/0123456789abcdef0123456789abcdef');
  await expect(page).toHaveURL(/\/events$/);
  await expect(page.getByText('That management link is no longer valid.')).toBeVisible();
});
