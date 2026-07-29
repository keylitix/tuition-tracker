'use strict';

// Server-side PDF statement (spec §6.5), rendered from the same data as the
// parent screen. pdfkit is pure JS — no headless browser — so it runs on iisnode
// shared hosting. The function streams into `res`; the caller sets headers.

const PDFDocument = require('pdfkit');
const config = require('../config');
const { formatUSD } = require('./money');

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
  return dt.toISOString().slice(0, 10);
}

// data: { family, students, charges, payments, balance, schoolYear }
function streamStatement(res, data) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
  doc.pipe(res);

  // Letterhead
  doc.fontSize(20).font('Helvetica-Bold').text(config.school.name);
  if (config.school.address) doc.fontSize(10).font('Helvetica').text(config.school.address);
  doc.moveDown(0.5);
  doc.fontSize(14).font('Helvetica-Bold').text('Tuition Statement');
  doc.fontSize(10).font('Helvetica')
    .text(`Family: ${data.family.name}`)
    .text(`School year: ${data.schoolYear || 'All years'}`)
    .text(`Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  doc.moveDown();

  // Charges, grouped by student
  doc.fontSize(12).font('Helvetica-Bold').text('Charges');
  doc.moveDown(0.25);
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
  doc.fontSize(10).font('Helvetica');
  for (const { student, charges } of byStudent.values()) {
    if (!charges.length) continue;
    doc.font('Helvetica-Bold').text(`${student.first_name} ${student.last_name}`);
    doc.font('Helvetica');
    for (const ch of charges) {
      totalCharged += Number(ch.amount);
      const due = ch.due_date ? `  (due ${fmtDate(ch.due_date)})` : '';
      doc.text(`   ${ch.description}${due}`, { continued: true })
        .text(formatUSD(ch.amount), { align: 'right' });
    }
    doc.moveDown(0.25);
  }
  doc.font('Helvetica-Bold')
    .text('Total charged', { continued: true })
    .text(formatUSD(totalCharged), { align: 'right' });
  doc.moveDown();

  // Payments
  doc.fontSize(12).font('Helvetica-Bold').text('Payments');
  doc.moveDown(0.25);
  let totalPaid = 0;
  doc.fontSize(10).font('Helvetica');
  if (!data.payments.length) {
    doc.text('   No payments recorded.');
  }
  for (const p of data.payments) {
    totalPaid += Number(p.amount);
    const label = METHOD_LABEL[p.method] || p.method;
    const note = p.note ? ` — ${p.note}` : '';
    const held = p.method === 'pctc' && !p.pctc_endorsed_on ? ' [held, unendorsed]' : '';
    doc.text(`   ${fmtDate(p.received_on)}  ${label}${note}${held}`, { continued: true })
      .text(formatUSD(p.amount), { align: 'right' });
  }
  doc.font('Helvetica-Bold')
    .text('Total paid', { continued: true })
    .text(formatUSD(totalPaid), { align: 'right' });
  doc.moveDown();

  // Balance
  doc.fontSize(13).font('Helvetica-Bold')
    .text('Balance due', { continued: true })
    .text(formatUSD(data.balance), { align: 'right' });

  doc.end();
}

module.exports = { streamStatement, METHOD_LABEL };
