/* Minimal CEP bridge used by this panel. */
function CSInterface() {}
CSInterface.prototype.evalScript = function (script, callback) {
  if (!window.__adobe_cep__) { callback('CEP host was not found. Open this panel from Premiere Pro.'); return; }
  window.__adobe_cep__.evalScript(script, callback);
};
CSInterface.prototype.getSystemPath = function (pathType) {
  try {
    var p = window.__adobe_cep__.getSystemPath(pathType);
    if (!p) return '';
    p = decodeURI(p);
    p = p.replace(/^file:\/\//i, '');   // file://C:/...  -> C:/...
    p = p.replace(/^\/+/, '');          // /C:/...       -> C:/...
    return p;
  } catch (e) { return ''; }
};
