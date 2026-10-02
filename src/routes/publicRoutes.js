// src/routes/publicRoutes.js
// Public-facing routes for volunteers plus the login entry point for admins.
const express = require('express');
const router = express.Router();
const passport = require('passport');
const publicController = require('../controllers/publicController');
const { validateSignup } = require('../middleware/validators');

function redactBody(body) {
  if (!body || typeof body !== 'object') return {};
  try {
    const clone = JSON.parse(JSON.stringify(body));
    ['name', 'email', 'phone', 'phone_number'].forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(clone, key)) clone[key] = '[redacted]';
    });
    if (clone.dish_notes) clone.dish_notes = '[redacted]';
    if (clone.blockIds) clone.blockIds = Array.isArray(clone.blockIds) ? clone.blockIds.map(() => '[id]') : '[list]';
    if (clone['blockIds[]']) clone['blockIds[]'] = Array.isArray(clone['blockIds[]']) ? clone['blockIds[]'].map(() => '[id]') : '[list]';
    return clone;
  } catch (_) {
    return {};
  }
}

// Home page redirects to the events list
router.get('/', (req, res) => res.redirect('/events'));

// Public login page for administrators
router.get('/login', (req, res) => {
    const nextUrl = (req.session && req.session.returnTo) || req.query.next || '';
    if (req.isAuthenticated && req.isAuthenticated()) {
      const target = (nextUrl && nextUrl.startsWith('/')) ? nextUrl : '/admin/dashboard';
      return res.redirect(target);
    }
    // Precompute the Google auth link with ?next= to preserve desired redirect after auth
    const googleAuthHref = nextUrl && nextUrl.startsWith('/')
      ? `/auth/google?next=${encodeURIComponent(nextUrl)}`
      : '/auth/google';
    res.render('login', { title: 'Admin Login', messages: req.flash('error'), googleAuthHref });
});

// Volunteer-facing help page
router.get('/help', publicController.showVolunteerHelp);

// List of all upcoming events
router.get('/events', publicController.showEventsList);

// Detail page for a specific event with signup forms
// Event detail; if preview=1 and user not authenticated, require login and send back
router.get(
  '/events/:eventId',
  (req, res, next) => {
    const wantsPreview = (req.query && (req.query.preview === '1' || String(req.query.preview).toLowerCase() === 'true'));
    const isAuthed = (req.isAuthenticated && req.isAuthenticated());
    if (wantsPreview && !isAuthed) {
      const nextUrl = req.originalUrl || `/events/${req.params.eventId}?preview=1`;
      if (req.session) req.session.returnTo = nextUrl;
      return res.redirect(`/login?next=${encodeURIComponent(nextUrl)}`);
    }
    next();
  },
  publicController.showEventDetail
);

// "Not you?" — stop remembering this device's sign-up for the event
router.post('/events/:eventId/forget', publicController.forgetRememberedSignup);

// Lost manage link reminder — define BEFORE /manage/:token to avoid capturing "remind" as a token
router.get('/manage/remind', (req, res) => {
  // No UI here; this route exists to prevent /manage/:token from capturing it on GET
  return res.redirect('/events');
});
router.post('/manage/remind', async (req, res) => {
  try {
    await publicController.sendManageReminder(req, res);
  } catch (err) {
    console.error('--- ERROR IN /manage/remind ---', err);
    // Always show the same message to the user
    try { req.flash('success', 'If we found a signup for that email, we sent a manage link. Please check your inbox.'); } catch (_) {}
    const eventId = req.body && (req.body.eventId || req.body.event_id || req.body.event);
    return res.redirect(eventId ? `/events/${eventId}` : '/events');
  }
});

// Duplicate check (AJAX) for step 1: if a registration already exists, send manage link.
// Manage existing signup via emailed token
router.get('/manage/:token', publicController.showManageSignup);
router.get('/manage/:token/calendar.ics', publicController.downloadCalendar);
router.post(
  '/manage/:token',
  (req, res, next) => {
    const debug = (process.env.DEBUG_SIGNUP === '1' || process.env.NODE_ENV !== 'production');
    if (debug) {
      try { req.flash('debug', JSON.stringify({ note: 'Incoming POST /manage body snapshot', body: redactBody(req.body) }, null, 2)); } catch (_) {}
    }
    next();
  },
  publicController.updateManageSignup
);

router.post('/manage/:token/preferences', publicController.updateEmailPreference);

// --- CRITICAL FIX ---
// Signup submission endpoint. It is now a single, clean route.
// The eventId and blockIds are now passed in the request body, not as URL params.
// Debug body snapshot (only in dev/DEBUG_SIGNUP) then run validation + handler
router.post(
  '/signup',
  (req, res, next) => {
    const debug = (process.env.DEBUG_SIGNUP === '1' || process.env.NODE_ENV !== 'production');
    if (debug) {
      try {
        req.flash('debug', JSON.stringify({
          note: 'Incoming POST /signup body snapshot',
          body: redactBody(req.body)
        }, null, 2));
      } catch (_) {}
    }
    next();
  },
  validateSignup,
  publicController.handleSignup
);
// Temporary debug endpoint in case a redirect lands on GET /signup
router.get('/signup', (req, res) => {
  const debug = (process.env.DEBUG_SIGNUP === '1' || process.env.NODE_ENV !== 'production');
  if (debug) {
    req.flash('error', 'Direct GET /signup is not supported.');
    req.flash('debug', JSON.stringify({
      note: 'Hit GET /signup. This usually means a prior POST redirected here. Check the debug block for the POST handler.',
      path: '/signup',
    }, null, 2));
  }
  return res.redirect('/events');
});

// --- Authentication routes (Google OAuth) ---
// Initiate OAuth flow. We keep this at /auth/google so public links are simple.
// Capture an optional ?next= param before starting OAuth, so we can restore it in callback
router.get('/auth/google', (req, res, next) => {
  const raw = (req.query && req.query.next) || (req.session && req.session.returnTo) || '';
  let nextUrl = '';
  if (typeof raw === 'string' && raw) {
    try { nextUrl = decodeURIComponent(raw); } catch (_) { nextUrl = raw; }
  }
  if (typeof nextUrl !== 'string' || !nextUrl.startsWith('/')) {
    nextUrl = '';
  }
  if (nextUrl && req.session) {
    req.session.returnTo = nextUrl; // normalized
  }
  return passport.authenticate('google', {
    scope: ['profile', 'email'],
    state: nextUrl || undefined
  })(req, res, next);
});

// OAuth callback. Passport's callbackURL is set to `${APP_BASE_URL}/admin/auth/google/callback`.
router.get('/admin/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login', failureFlash: true }),
    (req, res) => {
        // Successful auth -> send to originally requested URL if present
        let redirectTo = '/admin/dashboard';
        try {
          // Prefer OAuth state (round-tripped by Google) if provided
          const state = req.query && req.query.state;
          if (state && typeof state === 'string') {
            const decoded = decodeURIComponent(state);
            if (decoded.startsWith('/')) redirectTo = decoded;
          }
          // Fallback to session returnTo
          if (redirectTo === '/admin/dashboard') {
            const rt = req.session && req.session.returnTo;
            if (rt && typeof rt === 'string' && rt.startsWith('/')) {
              redirectTo = rt;
            }
          }
          if (req.session) delete req.session.returnTo;
        } catch (_) {}
        res.redirect(redirectTo);
    }
);

// Logout route used by the header
router.get('/logout', (req, res, next) => {
    // passport@0.7 requires a callback for logout
    req.logout(function(err) {
        if (err) return next(err);
        // Destroy session and redirect home
        req.session && req.session.destroy(() => res.redirect('/'));
    });
});

module.exports = router;
