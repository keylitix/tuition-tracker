'use strict';

// Load .env in development. On SmarterASP.NET, iisnode surfaces web.config
// <appSettings> as environment variables, so process.env is the single source
// of config in every environment. Secrets never live in the repo.
require('dotenv').config();

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true' || value === '1';
}

function required(name) {
  const v = process.env[name];
  if (!v) {
    // In production a missing secret is fatal; fail loud rather than run half-configured.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`Missing required config: ${name}`);
    }
  }
  return v;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: parseInt(process.env.PORT, 10) || 3000,
  baseUrl: (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',

  db: {
    server: process.env.DB_SERVER || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 1433,
    database: process.env.DB_NAME || 'tuition',
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || '',
    options: {
      encrypt: bool(process.env.DB_ENCRYPT, false),
      trustServerCertificate: bool(process.env.DB_TRUST_SERVER_CERT, true),
      enableArithAbort: true,
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  },

  stripe: {
    secretKey: required('STRIPE_SECRET_KEY'),
    webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
    customerPortalUrl: process.env.STRIPE_CUSTOMER_PORTAL_URL || '',
  },

  mail: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || 'Tuition Office <office@example.com>',
  },

  school: {
    name: process.env.SCHOOL_NAME || 'The Farm Academy',
    address: process.env.SCHOOL_ADDRESS || '',
  },

  // Magic-link tuning (spec §8)
  magicLink: {
    ttlMinutes: 15,                        // parent self-service: short-lived
    adminSentTtlMinutes: 60 * 24 * 3650,   // office-sent: ~10 years = effectively no expiry (still single-use)
    ratePerEmailPerHour: 5,
  },

  // Admin password-reset tuning
  adminReset: {
    ttlMinutes: 30,
    ratePerEmailPerHour: 5,
  },
};

module.exports = config;
