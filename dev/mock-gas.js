// Browser-side stand-in for the Apps Script client API, injected by dev/serve.mjs.
// Mirrors google.script.run's chain (withSuccessHandler / withFailureHandler / withUserObject)
// and google.script.url.getLocation. Server functions are answered from the fixture endpoints.
(function () {
  var params = new URLSearchParams(window.location.search);
  var delay = Number(params.get('mock_delay') || 120);
  var failSet = (params.get('mock_fail') || '').split(',').filter(Boolean);
  var offline = params.get('mock_offline') === '1';
  var mapsKey = params.get('mock_key') || '';
  var calls = [];
  window.__mockGasCalls = calls;

  function getJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function getText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || ('HTTP ' + r.status)); });
      return r.text();
    });
  }

  var server = {
    getAllCampusData: function () {
      return getJson('/__mock/data').then(function (d) {
        if (mapsKey) d.config = (d.config || []).concat([{ key: 'mapsApiKey', value: mapsKey }]);
        return d;
      });
    },
    getPublicCampusData: function () { return server.getAllCampusData(); },
    getDataVersion: function () { return getJson('/__mock/data').then(function (d) { return d.version; }); },
    getFloorPlanSvg: function (floorId) { return getText('/__mock/svg/' + encodeURIComponent(floorId)); },
  };

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
            } else if (!server[name]) {
              p = Promise.reject(new Error('Script function not found: ' + name));
            } else {
              p = server[name].apply(null, args);
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
