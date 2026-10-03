// Browser-side stand-in for the Apps Script client API, injected by dev/serve.mjs.
// Mirrors google.script.run's chain (withSuccessHandler / withFailureHandler / withUserObject)
// and google.script.url.getLocation. Every server call is POSTed to /__mock/run/<fn>, where
// dev/serve.mjs runs the real .gs function and returns its JSON-shaped result.
(function () {
  var params = new URLSearchParams(window.location.search);
  var delay = Number(params.get('mock_delay') || 120);
  var failSet = (params.get('mock_fail') || '').split(',').filter(Boolean);
  var offline = params.get('mock_offline') === '1';
  var mapsKey = params.get('mock_key') || '';
  var calls = [];
  window.__mockGasCalls = calls;

  function callServer(name, args) {
    return fetch('/__mock/run/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (reply) {
      if (!reply.ok) throw new Error(reply.error);
      var v = reply.value;
      // mock_key: a key typed by hand for a manual map check, added the way getAllCampusData adds a configured key.
      if (mapsKey && v && v.config && (name === 'getAllCampusData' || name === 'getPublicCampusData')) {
        v.config = v.config.filter(function (c) { return c.key !== 'mapsApiKey'; }).concat([{ key: 'mapsApiKey', value: mapsKey }]);
      }
      return v;
    });
  }

  function runner(state) {
    var api = {
      withSuccessHandler: function (fn) { return runner(Object.assign({}, state, { ok: fn })); },
      withFailureHandler: function (fn) { return runner(Object.assign({}, state, { fail: fn })); },
      withUserObject: function (o) { return runner(Object.assign({}, state, { user: o })); },
    };
    return new Proxy(api, {
      get: function (target, name) {
        if (name in target) return target[name];
        if (typeof name !== 'string') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          calls.push({ fn: name, args: args });
          setTimeout(function () {
            var p;
            if (offline || failSet.indexOf(name) > -1) {
              p = Promise.reject(new Error('Mock failure for ' + name));
            } else {
              p = callServer(name, args);
            }
            p.then(function (v) { if (state.ok) state.ok(v, state.user); },
                   function (e) { if (state.fail) state.fail(e, state.user); else console.error(e); });
          }, delay);
        };
      },
    });
  }

  function location() {
    var parameter = {};
    var parameters = {};
    params.forEach(function (v, k) {
      if (!(k in parameter)) parameter[k] = v;
      (parameters[k] = parameters[k] || []).push(v);
    });
    return { hash: window.location.hash.replace(/^#/, ''), parameter: parameter, parameters: parameters };
  }

  window.google = window.google || {};
  window.google.script = {
    run: runner({}),
    url: { getLocation: function (cb) { setTimeout(function () { cb(location()); }, 0); } },
    host: { close: function () {}, setHeight: function () {}, setWidth: function () {} },
  };
})();
