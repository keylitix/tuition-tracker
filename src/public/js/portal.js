'use strict';

// Parent portal payment picker. Runs under a strict CSP (script-src 'self').
// Reads the server-rendered data and shows a plain-language summary of the
// selected method + plan (first payment, count, total incl. any card fee). For
// "Other amount" it also shows the remaining balance and enforces the date-based
// minimum (at least the remaining half in January; the full balance after May 1).

(function () {
  var dataEl = document.getElementById('paydata');
  var summaryEl = document.getElementById('paysummary');
  var form = document.getElementById('payform');
  var submitEl = document.getElementById('paysubmit');
  if (!dataEl || !summaryEl || !form) return;

  var data;
  try { data = JSON.parse(dataEl.textContent); } catch (e) { return; }
  var previews = data.previews || {};
  var custom = data.custom || null;
  var feeRatePct = data.feeRatePct || 0;

  var otherWrap = document.getElementById('otherwrap');
  var amountEl = document.getElementById('payamount');

  function money(n) {
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function selected(name) {
    var el = form.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }
  function setSubmit(enabled) { if (submitEl) submitEl.disabled = !enabled; }

  // Deadline reminder line for the "Other amount" option.
  function customReminder() {
    if (custom.afterMay1) {
      return 'Your full balance is now due (past May 1) — please pay it in full.';
    }
    if (custom.afterJan15) {
      if (custom.remainingHalfDollars > 0) {
        return 'At least the remaining half (' + money(custom.remainingHalfDollars) + ') is due now; the full balance is due by May 1.';
      }
      return 'You\'ve met the January 15 half-payment. The full balance is due by May 1.';
    }
    return 'At least half of your tuition (' + money(custom.halfDollars) + ') is due by January 15; the full balance by May 1.';
  }

  function describeOther() {
    otherWrap.hidden = false;
    var amount = parseFloat(amountEl.value);
    var method = selected('method') || 'bank';
    var reminder = customReminder();

    if (!(amount > 0)) {
      summaryEl.textContent = 'Enter an amount to pay. ' + reminder;
      setSubmit(false);
      return;
    }
    if (amount > custom.balanceDollars + 0.001) {
      summaryEl.textContent = 'That\'s more than your balance of ' + money(custom.balanceDollars) + '.';
      setSubmit(false);
      return;
    }
    if (amount < custom.minDollars - 0.001) {
      summaryEl.textContent = 'The minimum right now is ' + money(custom.minDollars) + '. ' + reminder;
      setSubmit(false);
      return;
    }
    var fee = method === 'card' ? Math.round(amount * feeRatePct) / 100 : 0;
    var total = amount + fee;
    var remaining = Math.max(0, custom.balanceDollars - amount);
    var feeNote = fee > 0 ? ' (includes ' + money(fee) + ' card fee)' : '';
    summaryEl.textContent =
      'You\'ll pay ' + money(total) + ' now' + feeNote + '. '
      + 'Remaining balance after this payment: ' + money(remaining) + '. ' + reminder;
    setSubmit(true);
  }

  function describe() {
    if (otherWrap) otherWrap.hidden = true;
    setSubmit(true);
    var method = selected('method') || 'bank';
    var plan = selected('choice') || 'full';

    if (plan === 'other' && custom) { describeOther(); return; }

    var p = previews[method] && previews[method][plan];
    if (!p) { summaryEl.textContent = ''; return; }

    var feeNote = p.feeTotal > 0 ? ' (includes ' + money(p.feeTotal) + ' card fee)' : '';
    var msg;
    if (plan === 'full') {
      msg = 'One payment of ' + money(p.total) + ' now' + feeNote + '.';
    } else if (plan === 'monthly') {
      msg = p.cycles + ' monthly payments — about ' + money(p.firstPayment) +
        ' each, first one now and the last by May 1. Total ' + money(p.total) + feeNote + '.';
    } else if (plan === 'semester') {
      var second = p.total - p.firstPayment;
      msg = 'Two payments — ' + money(p.firstPayment) + ' now and ' + money(second) +
        ' on January 15. Total ' + money(p.total) + feeNote + '.';
    }
    summaryEl.textContent = msg;
  }

  form.addEventListener('change', describe);
  if (amountEl) amountEl.addEventListener('input', describe);
  describe();
})();
