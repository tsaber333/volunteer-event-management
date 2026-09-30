const { test, expect } = require('@playwright/test');
const { ids, slot } = require('./support/helpers');

test('events list shows how much help is still needed', async ({ page }) => {
  await page.goto('/events');
  const card = name => page.locator('.event-card', { hasText: name });

  await expect(card('Counts Check')).toContainText('4 spots still needed');
  await expect(card('All Filled')).toContainText('Every spot is filled — thank you!');
  await expect(card('All Filled').getByRole('link', { name: 'View event' })).toBeVisible();
  await expect(card('Potluck Lunch')).toContainText(/\d+ items still needed/);
});

test('event page shows open spots per slot and can hide full ones', async ({ page }) => {
  const { events, blocks } = ids();
  await page.goto(`/events/${events.counts}`);
  await expect(page.locator('[data-role="positions-summary"]')).toHaveText('4 of 5 spots still needed');
  await expect(slot(page, blocks.counts9)).toContainText('2 spots left');
  await expect(slot(page, blocks.counts10)).toContainText('2 spots left');

  await page.goto(`/events/${events.filled}`);
  const full = slot(page, blocks.filled9);
  await expect(full).toContainText('Full — thank you!');
  await expect(full.locator('[data-role="add"]')).toBeHidden();
  await page.getByLabel('Show only open spots').check();
  await expect(full).toBeHidden();
});
