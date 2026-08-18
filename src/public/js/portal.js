'use strict';

// Parent portal payment picker. Runs under a strict CSP (script-src 'self').
// Reads the server-rendered preview data and shows a plain-language summary of
// the selected method + plan (first payment, count, total incl. any card fee).

(function () {
  var dataEl = document.getElementById('paydata');
  var summaryEl = document.getElementById('paysummary');
  var form = document.getElementById('payform');
  if (!dataEl || !summaryEl || !form) return;

  var previews;
  try { previews = JSON.parse(dataEl.textContent); } catch (e) { return; }

  function money(n) {
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function selected(name) {
    var el = form.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }

  function describe() {
    var method = selected('method') || 'bank';
    var plan = selected('choice') || 'full';
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
  describe();
})();
