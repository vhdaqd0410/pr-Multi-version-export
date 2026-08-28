/* Minimal CEP bridge used by this panel. */
function CSInterface() {}
CSInterface.prototype.evalScript = function (script, callback) {
  if (!window.__adobe_cep__) { callback('CEP host was not found. Open this panel from Premiere Pro.'); return; }
  window.__adobe_cep__.evalScript(script, callback);
};
