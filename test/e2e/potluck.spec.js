const { test, expect } = require('@playwright/test');
const { ids, signUpFor, fillContact, confirm, waitForEmail } = require('./support/helpers');

test('Food Prep sign-up asks what dish you’re bringing', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto(`/events/${events.potluck}`);
  await signUpFor(page, blocks.casserole);

  const row = page.locator(`[data-role="picks-list"] .pick[data-block-id="${blocks.casserole}"]`);
  await expect(row.getByLabel('Who')).toBeVisible();
  await fillContact(page, { name: 'Dee Dish', email: 'dee@example.test' });
  await confirm(page);
  await expect(page.locator('[data-role="form-error"]')).toHaveText('Please enter a dish name for each item.');

  await row.getByLabel('Dish').fill('Mac and cheese');
  await confirm(page);
  await expect(page.getByRole('heading', { name: 'Thank you for signing up!' })).toBeVisible();
  await expect(page.locator('.my-signup__list')).toContainText('Casserole');
  await expect(page.locator('.my-signup__list')).toContainText('(Mac and cheese)');
  await waitForEmail('dee@example.test', /^Your food prep signup for Potluck Lunch/);
});
