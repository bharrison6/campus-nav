// google.script.run for the local admin page, injected by tools/admin/server.mjs.
// Mirrors the Apps Script client chain (withSuccessHandler / withFailureHandler / withUserObject): every call is
// POSTed to /__admin/run/<fn>, where the server runs the backend function (tools/admin/gs) and, for a write, saves
// the overrides files.
(function () {
  function callServer(name, args) {
    return fetch('/__admin/run/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (reply) {
      if (!reply.ok) {
        var err = new Error(reply.error);
        if (reply.refused) err.refused = reply.refused; // a save the connectivity check refused: what it would cut off
        throw err;
      }
      return reply.value;
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
          callServer(name, args).then(
            function (v) { if (state.ok) state.ok(v, state.user); },
            function (e) { if (state.fail) state.fail(e, state.user); else console.error(e); }
          );
        };
      },
    });
  }

  window.google = window.google || {};
  window.google.script = { run: runner({}) };
})();
