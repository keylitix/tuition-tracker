'use strict';

// Server-side PDF statement (spec §6.5), rendered from the same data as the
// parent screen. pdfkit is pure JS — no headless browser — so it runs on shared
// hosting. The function streams into `res`; the caller sets headers.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const config = require('../config');
const { formatUSD } = require('./money');

const LOGO_PATH = path.join(__dirname, '..', 'public', 'img', 'logo.png');

// Brand palette (matches the web UI).
const NAVY = '#034187';
const RED = '#d72323';
const INK = '#2a2f36';
const GRAY = '#6b7280';
const LINE = '#d7dce4';

const METHOD_LABEL = {
  ach: 'Bank draft (ACH)',
  card: 'Card',
  check: 'Check',
  pctc: 'PCTC award',
  adjustment: 'Adjustment',
  refund: 'Refund',
};

function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// data: { family, students, charges, payments, balance, schoolYear }
function streamStatement(res, data) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
  doc.pipe(res);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentW = right - left;

  /* ---------------- Letterhead ---------------- */
  let headerBottom = 54;
  try {
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, left, 48, { width: 165 });
      headerBottom = 48 + 165 * (190 / 374); // preserve aspect ratio
    } else {
      throw new Error('no logo');
    }
  } catch (_) {
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20).text(config.school.name, left, 50);
    headerBottom = 80;
  }

  // Right-aligned title block
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18)
    .text('TUITION STATEMENT', left, 54, { width: contentW, align: 'right' });
  doc.fillColor(GRAY).font('Helvetica').fontSize(10)
    .text(`Statement date: ${fmtDate(new Date())}`, left, 80, { width: contentW, align: 'right' })
    .text(`School year: ${data.schoolYear || 'All years'}`, { width: contentW, align: 'right' });
  if (config.school.address) {
    doc.text(config.school.address, { width: contentW, align: 'right' });
  }

  // Rule under the header
  const ruleY = Math.max(headerBottom, 118) + 6;
  doc.moveTo(left, ruleY).lineTo(right, ruleY).lineWidth(1.5).strokeColor(NAVY).stroke();
  doc.y = ruleY + 16;

  /* ---------------- Bill-to ---------------- */
  doc.fillColor(GRAY).font('Helvetica-Bold').fontSize(9).text('STATEMENT FOR', left, doc.y);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(data.family.name, left, doc.y + 2);
  doc.fillColor(GRAY).font('Helvetica').fontSize(10).text(data.family.email || '');
  doc.moveDown(1);

  // Two-column row helper (label left, amount right, same baseline).
  function row(leftText, rightText, opts = {}) {
    const { indent = 0, bold = false, color = INK, size = 10, gap = 5 } = opts;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
    const x = left + indent;
    const y = doc.y;
    doc.text(leftText, x, y, { width: contentW - indent - 95 });
    const leftBottom = doc.y;
    doc.text(rightText, left, y, { width: contentW, align: 'right' });
    doc.y = Math.max(leftBottom, doc.y) + gap;
  }
  function sectionHeader(label) {
    if (doc.y > 660) doc.addPage();
    doc.moveDown(0.4);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(12).text(label, left, doc.y);
    doc.moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).lineWidth(0.75).strokeColor(LINE).stroke();
    doc.y += 8;
  }

  /* ---------------- Charges (grouped by student) ---------------- */
  sectionHeader('Charges');
  const byStudent = new Map();
  for (const s of data.students) byStudent.set(s.id, { student: s, charges: [] });
  for (const ch of data.charges) {
    if (ch.voided) continue;
    if (!byStudent.has(ch.student_id)) {
      byStudent.set(ch.student_id, { student: { first_name: ch.first_name, last_name: ch.last_name }, charges: [] });
    }
    byStudent.get(ch.student_id).charges.push(ch);
  }
  let totalCharged = 0;
  let anyCharge = false;
  for (const { student, charges } of byStudent.values()) {
    if (!charges.length) continue;
    anyCharge = true;
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10.5)
      .text(`${student.first_name} ${student.last_name}`, left, doc.y);
    doc.y += 2;
    for (const ch of charges) {
      totalCharged += Number(ch.amount);
      const due = ch.due_date ? `   (due ${fmtDate(ch.due_date)})` : '';
      row(`${ch.description}${due}`, formatUSD(ch.amount), { indent: 14, color: INK });
    }
    doc.moveDown(0.2);
  }
  if (!anyCharge) doc.fillColor(GRAY).font('Helvetica').fontSize(10).text('No charges.', left + 14, doc.y);
  doc.moveTo(left, doc.y + 1).lineTo(right, doc.y + 1).lineWidth(0.5).strokeColor(LINE).stroke();
  doc.y += 6;
  row('Total charged', formatUSD(totalCharged), { bold: true, color: NAVY });

  /* ---------------- Payments ---------------- */
  sectionHeader('Payments & credits');
  let totalPaid = 0;
  if (!data.payments.length) {
    doc.fillColor(GRAY).font('Helvetica').fontSize(10).text('No payments recorded.', left + 14, doc.y);
    doc.y += 4;
  }
  for (const p of data.payments) {
    totalPaid += Number(p.amount);
    const label = METHOD_LABEL[p.method] || p.method;
    const note = p.note ? ` — ${p.note}` : '';
    const held = p.method === 'pctc' && !p.pctc_endorsed_on ? '  [held, unendorsed]' : '';
    row(`${fmtDate(p.received_on)}   ${label}${note}${held}`, formatUSD(p.amount),
      { indent: 14, color: Number(p.amount) < 0 ? RED : INK, size: 9.5 });
  }
  doc.moveTo(left, doc.y + 1).lineTo(right, doc.y + 1).lineWidth(0.5).strokeColor(LINE).stroke();
  doc.y += 6;
  row('Total paid', formatUSD(totalPaid), { bold: true, color: NAVY });

  /* ---------------- Balance due box ---------------- */
  // Compute from the totals shown above so the box always reconciles with the
  // itemized lines (never trust a passed-in shape here).
  const balanceDue = totalCharged - totalPaid;
  doc.moveDown(1);
  if (doc.y > 690) doc.addPage();
  const boxY = doc.y;
  const boxH = 40;
  const owed = balanceDue > 0.0001;
  doc.roundedRect(left, boxY, contentW, boxH, 6)
    .fillColor(owed ? '#fdecec' : '#e8f0fb').fill();
  doc.fillColor(owed ? RED : NAVY).font('Helvetica-Bold').fontSize(13)
    .text('Balance due', left + 16, boxY + 13);
  doc.fillColor(owed ? RED : NAVY).font('Helvetica-Bold').fontSize(16)
    .text(formatUSD(balanceDue), left, boxY + 11, { width: contentW - 16, align: 'right' });
  doc.y = boxY + boxH + 18;

  /* ---------------- Footer ---------------- */
  doc.fillColor(GRAY).font('Helvetica').fontSize(8.5);
  const genLine = `Generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  doc.text(genLine, left, 742, { width: contentW, align: 'center' });
  doc.text(`${config.school.name} — Questions about your statement? Please contact the school office.`,
    left, 754, { width: contentW, align: 'center' });

  doc.end();
}

module.exports = { streamStatement, METHOD_LABEL };
