const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

// MAIL_DISABLED must win over real SMTP settings outside test mode. The SMTP
// server here is unreachable, so the send would fail if it were used.
const script = `
  require(${JSON.stringify(path.join(__dirname, '../../src/utils/mailer'))})
    .sendMail({ to: 'someone@example.test', subject: 'Disabled check', text: 'hello' })
    .then(() => console.log('SENT-OK'), err => { console.log('SEND-FAILED', err.code || err.message); process.exitCode = 1; });
`;
const out = execFileSync(process.execPath, ['-e', script], {
  cwd: path.join(__dirname, '../..'),
  env: {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    MAIL_DISABLED: 'true',
    MAIL_HOST: '127.0.0.1',
    MAIL_PORT: '9',
    MAIL_USER: 'nobody',
    MAIL_PASS: 'nothing'
  },
  encoding: 'utf8',
  timeout: 15000
});
assert.match(out, /Email \(stream transport\)/);
assert.match(out, /Subject: Disabled check/);
assert.match(out, /SENT-OK/);

console.log('mailer tests passed');
