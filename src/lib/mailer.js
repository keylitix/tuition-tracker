'use strict';

// Thin wrapper over nodemailer. If SMTP is not configured (dev), magic links are
// logged to the console instead of sent, so local development needs no mail server.
// This app sends only its own magic-link emails — Stripe sends all receipts (spec §2).

const nodemailer = require('nodemailer');
const config = require('../config');

let transporter = null;
function getTransporter() {
  if (!config.mail.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.password } : undefined,
    });
  }
  return transporter;
}

async function sendMagicLink(email, url) {
  const subject = `${config.school.name} — your sign-in link`;
  const text =
    `Sign in to view your tuition statement:\n\n${url}\n\n` +
    `This link expires in ${config.magicLink.ttlMinutes} minutes and can be used once.\n` +
    `If you did not request it, you can ignore this email.`;
  const html =
    `<p>Sign in to view your tuition statement:</p>` +
    `<p><a href="${url}">${url}</a></p>` +
    `<p>This link expires in ${config.magicLink.ttlMinutes} minutes and can be used once. ` +
    `If you did not request it, you can ignore this email.</p>`;

  const tx = getTransporter();
  if (!tx) {
    // Dev fallback — never do this in production, but harmless when SMTP is unset.
    console.log(`\n[mailer] (no SMTP configured) magic link for ${email}:\n${url}\n`);
    return;
  }
  await tx.sendMail({ from: config.mail.from, to: email, subject, text, html });
}

module.exports = { sendMagicLink };
