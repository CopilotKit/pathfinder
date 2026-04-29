// Marketing pixels: PostHog + RB2B + Reo. Source of truth lives in
// ../website/src/app/(default)/layout.tsx and the PHProvider component —
// keep keys in sync with that file.
(function () {
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId captureTraceFeedback captureTraceMetric".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  posthog.init('phc_XZdymVYjrph9Mi0xZYGNyCKexxgblXRR1jMENCtdz5Q', { api_host: 'https://eu.posthog.com', defaults: '2025-05-24' });

  !function () {
    var reb2b = window.reb2b = window.reb2b || [];
    if (reb2b.invoked) return;
    reb2b.invoked = true;
    reb2b.methods = ["identify", "collect"];
    reb2b.factory = function (method) {
      return function () {
        var args = Array.prototype.slice.call(arguments);
        args.unshift(method);
        reb2b.push(args);
        return reb2b;
      };
    };
    for (var i = 0; i < reb2b.methods.length; i++) {
      var key = reb2b.methods[i];
      reb2b[key] = reb2b.factory(key);
    }
    reb2b.load = function (key) {
      var script = document.createElement("script");
      script.type = "text/javascript";
      script.async = true;
      script.src = "https://b2bjsstore.s3.us-west-2.amazonaws.com/b/" + key + "/GOYPYHVD49OX.js.gz";
      var first = document.getElementsByTagName("script")[0];
      first.parentNode.insertBefore(script, first);
    };
    reb2b.SNIPPET_VERSION = "1.0.1";
    reb2b.load("GOYPYHVD49OX");
  }();

  !function () {
    var e = "f6eae27a6f1c6bb";
    var t = function () {
      if (window.Reo) {
        window.Reo.init({ clientID: e });
      }
    };
    var n = document.createElement("script");
    n.src = "https://static.reo.dev/" + e + "/reo.js";
    n.defer = true;
    n.onload = t;
    document.head.appendChild(n);
  }();
})();
