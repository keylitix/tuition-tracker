// Let the office upload a CSV file: read it in the browser and drop its contents
// into the textarea, so the existing paste-and-import flow handles the rest.
// Runs under a strict CSP (script-src 'self').
(function () {
  var file = document.getElementById('csv-file');
  var textarea = document.getElementById('csv');
  var name = document.getElementById('csv-file-name');
  if (!file || !textarea) return;

  file.addEventListener('change', function () {
    var f = file.files && file.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      textarea.value = reader.result;
      if (name) name.textContent = f.name + ' loaded — review below, then Import.';
    };
    reader.onerror = function () {
      if (name) name.textContent = 'Could not read that file.';
    };
    reader.readAsText(f);
  });
})();
