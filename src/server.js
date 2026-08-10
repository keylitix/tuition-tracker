'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const MSSQLStore = require('connect-mssql-v2');

const config = require('./config');
const { requireAdmin, requireParent, exposeUser } = require('./middleware/auth');
const { csrf } = require('./middleware/csrf');

const app = express();

// Behind IIS/iisnode: trust the proxy so secure cookies and client IPs work.
app.set('trust proxy', 1);

// View helpers (pure functions — safe to share across requests).
const { formatUSD } = require('./lib/money');
const { METHOD_LABEL } = require('./lib/pdf');
app.locals.money = formatUSD;
app.locals.methodLabel = (m) => METHOD_LABEL[m] || m;
app.locals.fmtDate = (d) => {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
};
// Date + time in the school's local (Central) timezone.
app.locals.fmtDateTime = (d) => {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};
app.locals.school = config.school;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], // views + Google Fonts
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      scriptSrc: ["'self'"],
      // Pay/autopay forms post to us, then we redirect to Stripe Checkout — the
      // browser applies form-action to that redirect target, so Stripe's hosted
      // domains must be allowed here or the redirect is silently blocked.
      formAction: ["'self'", 'https://checkout.stripe.com', 'https://billing.stripe.com'],
    },
  },
}));

// --- Stripe webhook: MUST come before the JSON body parser and session/CSRF.
// It reads the raw body for signature verification and authenticates via that
// signature, not a session (spec §7).
app.use('/webhooks', require('./routes/webhooks'));

// Static assets
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Body parsers for normal form posts (everything after the webhook mount)
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// SQL-backed sessions: no in-memory session state, so app-pool recycles are safe
// (spec §3). The store keeps rows in the `sessions` table.
const sessionStore = new MSSQLStore(
  {
    server: config.db.server,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    options: config.db.options,
  },
  {
    table: 'sessions',
    // No in-process cleanup timer (iisnode has no reliable background worker);
    // expired sessions are rejected on read and can be pruned by a SQL job.
    autoRemove: false,
  }
);
sessionStore.on('error', (err) => console.error('Session store error:', err.message));

app.use(session({
  name: 'tt.sid',
  secret: config.sessionSecret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: config.isProd,   // HTTPS-only in production
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8, // 8 hours
  },
}));

app.use(exposeUser);
app.use(csrf);

// --- Routes -------------------------------------------------------
app.get('/', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  if (req.session.family) return res.redirect('/portal');
  res.redirect('/portal/login');
});

// Admin auth (unguarded), then guarded admin area.
app.use('/admin', require('./routes/adminAuth'));
app.use('/admin', requireAdmin, require('./routes/adminRoster'));
app.use('/admin/families', requireAdmin, require('./routes/adminFamily'));
app.use('/admin/pctc', requireAdmin, require('./routes/adminPctc'));
app.use('/admin/export', requireAdmin, require('./routes/adminExport'));
app.use('/admin/import', requireAdmin, require('./routes/adminImport'));
app.use('/admin/settings', requireAdmin, require('./routes/adminSettings'));

// Parent portal: auth (unguarded) then guarded read-only views.
app.use('/portal', require('./routes/parentAuth'));
app.use('/portal', requireParent, require('./routes/parentPortal'));

// Health check (for uptime pings that keep the app pool warm)
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// 404
app.use((req, res) => {
  res.status(404).render('404', { title: 'Not found' });
});

// Error handler (last)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', {
    title: 'Something went wrong',
    message: config.isProd ? 'An unexpected error occurred.' : err.message,
  });
});

// iisnode passes a named-pipe path in process.env.PORT; plain `node` uses a number.
const port = process.env.PORT || config.port;
if (require.main === module) {
  app.listen(port, () => console.log(`Tuition Tracker listening on ${port}`));
}

module.exports = app;
