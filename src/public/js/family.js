// Show method-specific fields on the Record Payment form. No framework — this
// runs under a strict CSP (script-src 'self').
(function () {
  var method = document.getElementById('pay-method');
  if (!method) return;
  var checkWrap = document.getElementById('field-check-number');
  var pctcWrap = document.getElementById('field-pctc-endorsed');

  function sync() {
    var v = method.value;
    if (checkWrap) checkWrap.style.display = v === 'check' ? '' : 'none';
    if (pctcWrap) pctcWrap.style.display = v === 'pctc' ? '' : 'none';
  }
  method.addEventListener('change', sync);
  sync();
})();
