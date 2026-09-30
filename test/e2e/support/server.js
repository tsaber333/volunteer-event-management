// Starts the app for the browser tests against a throwaway database in
// VA_TEST_DIR. Mail goes to an outbox file, never to a real mailbox.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = process.env.VA_TEST_DIR;
if (!dir) throw new Error('VA_TEST_DIR must be set (see playwright.config.js).');
fs.mkdirSync(dir, { recursive: true });

// Set before anything loads dotenv, so a local .env can't point the tests at
// real data or a real mail server (dotenv never overrides existing keys).
Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: process.env.TEST_PORT || '3199',
  APP_BASE_URL: `http://127.0.0.1:${process.env.TEST_PORT || '3199'}`,
  APP_TIMEZONE: 'America/Vancouver',
  DB_PATH: path.join(dir, 'volunteer.db'),
  SESSION_DB_PATH: path.join(dir, 'sessions.db'),
  SESSION_SECRET: crypto.randomBytes(24).toString('hex'),
  MAIL_OUTBOX: path.join(dir, 'outbox.jsonl'),
  MAIL_SERVICE: '',
  MAIL_HOST: '',
  MAIL_PORT: '',
  MAIL_USER: '',
  MAIL_PASS: '',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: ''
});

require('../../../src/config/database').initDatabase();
const { seed } = require('./seed');

seed()
  .then(ids => {
    fs.writeFileSync(path.join(dir, 'seed.json'), JSON.stringify(ids, null, 2));
    fs.writeFileSync(process.env.MAIL_OUTBOX, '');
    require('../../../src/server');
  })
  .catch(err => {
    console.error('Seeding the test database failed:', err);
    process.exit(1);
  });
