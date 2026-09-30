// Thin wrapper around nodemailer so the rest of the app can call `sendMail`
// without worrying about transport setup. If no SMTP settings are provided,
// messages are written to stdout (stream transport) so local development
// never fails on missing credentials.
const nodemailer = require('nodemailer');
const { getBranding } = require('../config/branding');

let cachedTransporter = null;

const branding = getBranding();
const DEFAULT_FROM = process.env.MAIL_FROM || `${branding.orgName} Volunteers <no-reply@example.org>`;
const DEFAULT_REPLY_TO = process.env.MAIL_REPLY_TO || 'volunteers@example.org';

function createTransporter() {
  if (cachedTransporter) return cachedTransporter;

  const {
    MAIL_SERVICE,
    MAIL_HOST,
    MAIL_PORT,
    MAIL_SECURE,
    MAIL_USER,
    MAIL_PASS
  } = process.env;

  const baseConfig = {};

  if (MAIL_SERVICE) {
    baseConfig.service = MAIL_SERVICE;
  } else if (MAIL_HOST && MAIL_PORT) {
    baseConfig.host = MAIL_HOST;
    baseConfig.port = Number(MAIL_PORT);
    baseConfig.secure = MAIL_SECURE === 'true';
  }

  if (MAIL_USER && MAIL_PASS) {
    baseConfig.auth = { user: MAIL_USER, pass: MAIL_PASS };
  }

  if (Object.keys(baseConfig).length > 0) {
    cachedTransporter = nodemailer.createTransport(baseConfig);
    cachedTransporter.__defaultFrom = DEFAULT_FROM;
    cachedTransporter.__defaultReplyTo = DEFAULT_REPLY_TO;
    return cachedTransporter;
  }

  // No mail settings supplied: use a stream transport that prints the message
  // to the console so developers can still see email content locally.
  cachedTransporter = nodemailer.createTransport({
    streamTransport: true,
    newline: 'unix',
    buffer: true
  });
  cachedTransporter.__defaultFrom = DEFAULT_FROM;
  cachedTransporter.__defaultReplyTo = DEFAULT_REPLY_TO;
  return cachedTransporter;
}

async function sendMail({ to, subject, text, html, from, replyTo, headers, attachments }) {
  const transporter = createTransporter();
  const message = {
    from: from || transporter.__defaultFrom,
    to,
    subject,
    text,
    html,
    replyTo: replyTo || transporter.__defaultReplyTo
  };
  if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
    message.headers = headers;
  }
  if (Array.isArray(attachments) && attachments.length) {
    message.attachments = attachments;
  }

  const info = await transporter.sendMail(message);

  if (info && info.message && transporter.options.streamTransport) {
    console.log('Email (stream transport):\n', info.message.toString());
  }

  return info;
}

module.exports = { sendMail };
