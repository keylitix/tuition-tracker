'use strict';

// CSP-safe confirmations. The app's CSP sends `script-src-attr 'none'`, which
// blocks inline onsubmit handlers — so confirmations are wired here instead.
// Any <form data-confirm="message"> prompts before submitting. If the message
// contains the token {amount}, it's replaced with the form's amount input value
// (formatted as $X.XX) so edited refund amounts show the real number.
(function () {
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-confirm')) return;
    var msg = form.getAttribute('data-confirm');
    if (msg.indexOf('{amount}') !== -1) {
      var amt = form.querySelector('input[name="amount"]');
      var v = amt ? parseFloat(amt.value) : NaN;
      msg = msg.replace('{amount}', isFinite(v) ? '$' + v.toFixed(2) : 'this amount');
    }
    if (!window.confirm(msg)) e.preventDefault();
  }, true);
})();
