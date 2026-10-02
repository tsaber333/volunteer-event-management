// src/app.js
// -----------------
// Central Express configuration for both the public sign-up experience and the admin
// dashboard. We keep the module free of business logic so request handling can be
// unit-tested via the controllers/services layer. Anything mounted here affects the
// entire application lifecycle (e.g., security middleware, session handling).
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const passport = require('passport');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const createError = require('http-errors');
const flash = require('connect-flash');
const { getBranding } = require('./config/branding');
const { SqliteSessionStore } = require('./utils/sqliteSessionStore');

require('./config/passport-setup');

const publicRoutes = require('./routes/publicRoutes');
const adminRoutes = require('./routes/adminRoutes');

const app = express();

app.set('trust proxy', 1);

// Drop obvious WordPress/CMS probes early to avoid session creation and noisy logs.
const wordpressProbePattern = /(\/|^)(?:wp-admin|wp-content|wp-includes|wp-login\.php|xmlrpc\.php|wlwmanifest\.xml)/i;
const phpProbePattern = /\.php(\?|$)/i;

// Serve a real favicon if present in the static folder; otherwise return 204.
app.get('/favicon.ico', (req, res) => {
    const faviconPath = path.join(__dirname, 'public', 'favicon.ico');
    fs.stat(faviconPath, (err, stat) => {
        if (!err && stat && stat.isFile()) {
            return res.sendFile(faviconPath);
        }
        return res.status(204).send();
    });
});

const brandingForCsp = getBranding();
const imgSrc = ["'self'", 'data:'];
const appendHost = (url) => {
    try {
        const { origin } = new URL(url);
        if (origin && !imgSrc.includes(origin)) imgSrc.push(origin);
    } catch (_) { /* ignore invalid URLs */ }
};
if (brandingForCsp.logoUrl) appendHost(brandingForCsp.logoUrl);
if (brandingForCsp.faviconUrl) appendHost(brandingForCsp.faviconUrl);

// Baseline security headers. Only the assets that truly need to be third-party hosted
// are permitted in the CSP declarations below.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            "script-src": ["'self'", "https://cdn.jsdelivr.net"],
            "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            "img-src": imgSrc,
        },
    },
}));

app.use((req, res, next) => {
    const url = (req.originalUrl || '').toLowerCase();
    if (wordpressProbePattern.test(url) || phpProbePattern.test(url)) {
        return res.status(410).type('text/plain').send('Gone');
    }
    next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 24) {
    throw new Error('SESSION_SECRET must be set to a long, random value (24+ chars).');
}

const sessionStore = new SqliteSessionStore({
    dbPath: process.env.SESSION_DB_PATH || path.join(__dirname, '../db/sessions.db')
});

app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: sessionStore,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    }
}));

app.use(flash());
app.use(passport.initialize());
app.use(passport.session());

// CSRF protection for all state-changing requests using a simple, session-bound token.
app.use((req, res, next) => {
    const method = (req.method || 'GET').toUpperCase();
    if (!req.session) return next(new Error('Session support is required for CSRF protection.'));
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    }
    res.locals.csrfToken = req.session.csrfToken;

    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next();

    const incomingToken = (req.body && req.body._csrf) || req.get('csrf-token') || (req.query && req.query._csrf);
    if (incomingToken && incomingToken === req.session.csrfToken) {
        return next();
    }

    const message = 'Your session expired. Please refresh and try again.';
    if (req.xhr || req.get('x-requested-with') === 'XMLHttpRequest' || req.accepts('json')) {
        return res.status(403).json({ ok: false, error: message });
    }
    req.flash && req.flash('error', message);
    return res.status(403).redirect('back');
});

// Attach branding information to every response so views can render dynamic titles.
app.use((req, res, next) => {
    res.locals.brand = getBranding();
    next();
});

// Expose user and flash messages to all views
// Make the authenticated user and any flash messages available to all templates.
app.use((req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.messages = req.flash();
    next();
});

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/signup', apiLimiter);
app.use('/manage/remind', apiLimiter);
app.use('/manage/check-duplicate', apiLimiter);

app.use('/', publicRoutes);
app.use('/admin', adminRoutes);

app.use((req, res, next) => {
    next(createError(404, `Page Not Found: ${req.originalUrl}`));
});

app.use((err, req, res, next) => {
    console.error("--- GLOBAL ERROR HANDLER ---");
    console.error("Timestamp:", new Date().toISOString());
    console.error("Route:", req.method, req.originalUrl);
    console.error("Status:", err.status || 500);
    console.error("Message:", err.message);
    if (process.env.NODE_ENV === 'development') {
        console.error("Stack:", err.stack);
    }
    console.error("--------------------------");

    res.locals.message = err.message;
    res.locals.error = process.env.NODE_ENV === 'development' ? err : {};
    res.status(err.status || 500);
    res.render('error');
});

module.exports = app;
