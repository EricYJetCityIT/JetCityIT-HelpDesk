// Shared by the staff console (staff.html) and the client ticket-tracking page (track.html):
//  1. registers the service worker (/sw.js), which is what lets the page open with no signal, and
//  2. powers the "Get the app" button: any element with the attribute data-install-app is shown on
//     phones/tablets that haven't installed the app yet, and opens a short how-to.
//
// There is no app store involved: the "app" is the website itself, added to the home screen
// (the same approach as the crew-calendar site). iPhone has no one-tap install, so the how-to walks
// through Safari's Share > Add to Home Screen; Android can install with one tap when Chrome offers it.
//
// The page's <script> tag configures it:  data-app-name="Help Desk Staff"
//
//  3. powers the alerts (push notifications) control: any element with data-alerts-button becomes the
//     button for this device once the page calls HDApp.configureAlerts(...) -- see the Alerts section below.
(function () {
  'use strict';

  var script = document.currentScript;
  var appName = (script && script.getAttribute('data-app-name')) || 'the Help Desk app';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function (e) {
        console.error('Service worker registration failed:', e);
      });
    });
  }

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  function isIOS() {
    // iPadOS reports itself as a Mac, so a Mac with a touch screen is an iPad.
    return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isAndroid() {
    return /Android/i.test(navigator.userAgent);
  }
  function isTouchDevice() {
    return isIOS() || isAndroid() || navigator.maxTouchPoints > 0;
  }

  // Chrome/Edge on Android (and desktop) offer a real install prompt; it has to be held until the
  // user taps our button.
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
  });
  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    syncButtons();
    closeHelp();
  });

  function syncButtons() {
    var show = !isStandalone() && isTouchDevice();
    var buttons = document.querySelectorAll('[data-install-app]');
    for (var i = 0; i < buttons.length; i++) buttons[i].style.display = show ? '' : 'none';
  }

  // ---- the how-to dialog (built with DOM calls, no HTML strings, so nothing here can inject markup) ----
  var overlay = null;
  var lastFocus = null;

  function injectStyles() {
    if (document.getElementById('hd-app-styles')) return;
    var s = document.createElement('style');
    s.id = 'hd-app-styles';
    s.textContent =
      '.hd-app-overlay{position:fixed;inset:0;background:rgba(5,16,26,.6);display:flex;align-items:center;justify-content:center;padding:20px;z-index:9999}' +
      '.hd-app-card{background:var(--surface,#fff);color:var(--text,#0f1724);border:1px solid var(--border,#e4e7ec);border-radius:16px;max-width:420px;width:100%;max-height:90vh;overflow:auto;padding:24px 22px;box-shadow:0 12px 48px rgba(0,0,0,.35)}' +
      '.hd-app-card h2{font-size:18px;margin:0 0 6px;letter-spacing:-.2px}' +
      '.hd-app-card p{font-size:13.5px;line-height:1.5;color:var(--text2,#4b5565);margin:0 0 14px}' +
      '.hd-app-steps{list-style:none;counter-reset:s;margin:0 0 16px;padding:0}' +
      '.hd-app-steps li{counter-increment:s;position:relative;padding-left:34px;margin-bottom:12px;font-size:14px;line-height:1.5}' +
      '.hd-app-steps li::before{content:counter(s);position:absolute;left:0;top:0;width:24px;height:24px;border-radius:50%;background:var(--green-light,#e7f7f1);color:var(--green-dark,#0f8f6e);font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}' +
      '.hd-app-btn{display:block;width:100%;padding:12px;border:none;border-radius:10px;font:inherit;font-weight:700;font-size:15px;cursor:pointer;background:var(--green,#16a37f);color:#fff;margin-bottom:8px}' +
      '.hd-app-btn.secondary{background:var(--bg,#f7f8fa);color:var(--text2,#4b5565);border:1px solid var(--border,#e4e7ec)}' +
      '.hd-app-btn:disabled{opacity:.6;cursor:default}' +
      '.hd-app-note{font-size:13px;line-height:1.5;background:var(--bg,#f7f8fa);color:var(--text2,#4b5565);border:1px solid var(--border,#e4e7ec);border-radius:10px;padding:10px 12px;margin:0 0 14px}' +
      '.hd-app-note.err{background:#fdecea;color:#b42318;border-color:#f4b8b2}';
    document.head.appendChild(s);
  }

  function el(tag, text, className) {
    var n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (className) n.className = className;
    return n;
  }

  // A list item where part of the sentence is bold: pieces alternate plain / bold.
  function stepItem(parts) {
    var li = document.createElement('li');
    parts.forEach(function (p, i) {
      if (i % 2 === 1) { var b = document.createElement('strong'); b.textContent = p; li.appendChild(b); }
      else li.appendChild(document.createTextNode(p));
    });
    return li;
  }

  function closeHelp() {
    if (!overlay) return;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    overlay = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKey(e) {
    if (e.key === 'Escape') closeHelp();
  }

  function openInstallHelp() {
    if (overlay) return;
    injectStyles();
    lastFocus = document.activeElement;

    overlay = el('div', null, 'hd-app-overlay');
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeHelp(); });
    var card = el('div', null, 'hd-app-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'hd-app-title');

    var title = el('h2', 'Get the ' + appName + ' app');
    title.id = 'hd-app-title';
    card.appendChild(title);
    card.appendChild(el('p', "Install it once and it shows up as an app icon on your phone. It isn't in the App Store or Google Play; it's this website, added to your home screen."));

    var primary = null;
    if (isStandalone()) {
      card.appendChild(el('p', 'This app is already installed on this device.'));
    } else if (isIOS()) {
      var ol = el('ol', null, 'hd-app-steps');
      ol.appendChild(stepItem(['Open this page in ', 'Safari', ' (the blue compass icon).']));
      // On current iPhones Safari's default compact toolbar keeps Share under the ⋯ (More) button.
      ol.appendChild(stepItem(['Tap the ', 'Share', " button, the square with an arrow pointing up. If you don't see it, tap the ", '\u22EF', ' (More) button first, then ', 'Share', '.']));
      ol.appendChild(stepItem(['Scroll down and tap ', 'Add to Home Screen', '.']));
      ol.appendChild(stepItem(['If you see an ', 'Open as Web App', ' switch, leave it on. Then tap ', 'Add', ' in the top right corner.']));
      card.appendChild(ol);
    } else if (isAndroid() || deferredPrompt) {
      if (deferredPrompt) {
        primary = el('button', 'Install app', 'hd-app-btn');
        primary.type = 'button';
        primary.addEventListener('click', function () {
          var p = deferredPrompt;
          deferredPrompt = null;
          p.prompt();
          if (p.userChoice && p.userChoice.finally) p.userChoice.finally(closeHelp);
          else closeHelp();
        });
        card.appendChild(primary);
      } else {
        var ol2 = el('ol', null, 'hd-app-steps');
        ol2.appendChild(stepItem(['Open this page in ', 'Chrome', '.']));
        ol2.appendChild(stepItem(['Tap the ', '\u22EE', ' menu (top right).']));
        ol2.appendChild(stepItem(['Tap ', 'Install app', ' (or ', 'Add to Home screen', ').']));
        card.appendChild(ol2);
      }
    } else {
      card.appendChild(el('p', 'Open this page on your phone to install it. On a computer, Chrome and Edge also show an install icon at the right end of the address bar.'));
    }

    var close = el('button', 'Close', 'hd-app-btn secondary');
    close.type = 'button';
    close.addEventListener('click', closeHelp);
    card.appendChild(close);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    (primary || close).focus();
  }

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('[data-install-app]');
    if (t) { e.preventDefault(); openInstallHelp(); }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncButtons);
  else syncButtons();

  // ---- Alerts (push notifications) ----
  // The page decides who is signed in and how to talk to its own API; this file does everything else.
  // A page calls HDApp.configureAlerts({ audience, identity, pitch, call }) once its person is signed in, where
  //   call(action, body) -> Promise<json>   action is 'key' | 'subscribe' | 'unsubscribe' | 'test'
  // and any element carrying data-alerts-button then shows up as the control for this device.
  //
  // iPhone only allows alerts for an app that has been ADDED TO THE HOME SCREEN (and opened from there),
  // so in a normal Safari tab the button explains that instead of failing.
  var alertsCfg = null;
  var SYNC_KEY = 'hd_push_sync';
  var SYNC_EVERY_MS = 12 * 60 * 60 * 1000;

  function pushCapable() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  function needsInstallFirst() {
    return isIOS() && !isStandalone();
  }
  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('Timed out')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }
  // serviceWorker.ready never settles if registration failed, so it is always raced against a timer.
  function swReady() {
    return withTimeout(navigator.serviceWorker.ready, 8000);
  }
  async function currentSub() {
    if (!pushCapable()) return null;
    try { return await (await swReady()).pushManager.getSubscription(); } catch (e) { return null; }
  }

  // 'unsupported' | 'needs-install' | 'blocked' | 'off' | 'on'
  async function alertsState() {
    if (!pushCapable()) return needsInstallFirst() ? 'needs-install' : 'unsupported';
    if (Notification.permission === 'denied') return 'blocked';
    var sub = await currentSub();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  }

  function keyBytes(b64url) {
    var pad = new Array((4 - (b64url.length % 4)) % 4 + 1).join('=');
    var raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function sameKey(sub, bytes) {
    var k = sub.options && sub.options.applicationServerKey;
    // Some browsers don't report the key a subscription was made with. Unknown is treated as unchanged: guessing
    // "changed" would drop and recreate the device's push address every time the app is opened.
    if (!k) return true;
    var a = new Uint8Array(k);
    if (a.length !== bytes.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== bytes[i]) return false;
    return true;
  }

  // When this device last told the server about itself, and for whom.
  function stampId(cfg) { return String(cfg.audience || '') + ':' + String(cfg.identity || ''); }
  function readStamp() {
    try { return JSON.parse(localStorage.getItem(SYNC_KEY) || 'null') || {}; } catch (e) { return {}; }
  }
  function writeStamp(cfg) {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify({ id: stampId(cfg), at: Date.now() })); } catch (e) { /* storage unavailable: it just syncs every time */ }
  }
  function clearStamp() {
    try { localStorage.removeItem(SYNC_KEY); } catch (e) { /* ignore */ }
  }

  // Creates (or keeps) this device's push address and tells the server about it. Also what repairs a
  // device whose address changed, or that was registered under an older signing key.
  async function registerDevice(cfg) {
    var reg = await swReady();
    var k = await cfg.call('key');
    var bytes = keyBytes(k.publicKey);
    var sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, bytes)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    await cfg.call('subscribe', { subscription: sub.toJSON() });
    writeStamp(cfg);
  }

  function enableAlerts(cfg) {
    // The permission prompt is only allowed straight from a tap, so asking is the very first thing this does.
    var asked = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
    return asked.then(function (perm) {
      if (perm !== 'granted') throw new Error("Alerts weren't allowed on this device.");
      // If the server can't be told, the phone's own address is dropped again, so the button never says
      // "on" for a device the server doesn't know about. (Only for this tap: this path starts with no address,
      // so nothing that was working is ever removed, unlike the silent refresh in syncAlerts.)
      return registerDevice(cfg).catch(function (e) {
        return currentSub().then(function (sub) {
          return sub ? sub.unsubscribe().catch(function () {}) : null;
        }).then(function () { throw e; });
      });
    });
  }

  // Alerts are only ever switched OFF here by the person, never silently back ON: if this device has no
  // address (they turned alerts off, or the browser dropped it), opening the app does not recreate one.
  async function syncAlerts() {
    var cfg = alertsCfg;
    if (!cfg || !pushCapable() || Notification.permission !== 'granted') return;
    if (!(await currentSub())) return;
    var stamp = readStamp();
    if (stamp.id === stampId(cfg) && Date.now() - (stamp.at || 0) < SYNC_EVERY_MS) return;
    await registerDevice(cfg);
  }

  // `call` may be given by a page that is about to forget who is signed in (the client page's "not you"),
  // so the server can still be told after its own session is gone.
  async function disableAlerts(call) {
    var send = call || (alertsCfg && alertsCfg.call);
    var sub = await currentSub();
    var endpoint = sub && sub.endpoint;
    if (sub) { try { await sub.unsubscribe(); } catch (e) { /* the server's copy dies on its own at the next alert */ } }
    clearStamp();
    if (endpoint && send) { try { await send('unsubscribe', { endpoint: endpoint }); } catch (e) { /* ditto */ } }
    refreshAlertButtons();
  }

  async function refreshAlertButtons() {
    var buttons = document.querySelectorAll('[data-alerts-button]');
    if (!buttons.length) return;
    var state = alertsCfg ? await alertsState() : 'unsupported';
    var label = state === 'on' ? '🔔 Alerts on' : state === 'blocked' ? '🔕 Alerts blocked' : state === 'off' ? '🔔 Turn on alerts' : '🔔 Alerts';
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].style.display = state === 'unsupported' ? 'none' : '';
      buttons[i].textContent = label;
    }
  }

  function errText(e) {
    return (e && e.message) || 'Something went wrong.';
  }
  function testText(r) {
    if (r && r.sent > 0) return 'Test alert sent. You should see it in a moment.';
    if (r && r.devices === 0) return 'This device is not registered yet. Turn alerts off and on again.';
    return 'The test alert could not be delivered. Try turning alerts off and on again.';
  }

  function openAlertsDialog() {
    if (overlay || !alertsCfg) return;
    injectStyles();
    lastFocus = document.activeElement;
    overlay = el('div', null, 'hd-app-overlay');
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeHelp(); });
    var card = el('div', null, 'hd-app-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'hd-app-title');
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    // Reading the device's state can take a few seconds when the service worker is slow to start, so the
    // dialog shows something (and a way out) straight away instead of an empty box.
    var wait = el('h2', 'Alerts on this device');
    wait.id = 'hd-app-title';
    card.appendChild(wait);
    card.appendChild(el('p', 'Checking this device\u2026'));
    var closeNow = el('button', 'Close', 'hd-app-btn secondary');
    closeNow.type = 'button';
    closeNow.addEventListener('click', closeHelp);
    card.appendChild(closeNow);
    closeNow.focus();
    renderAlerts(card, '', false);
  }

  // Draws the dialog for the device's CURRENT state. `note` is a status line; `isError` colors it as one.
  async function renderAlerts(card, note, isError) {
    var cfg = alertsCfg;
    var state = await alertsState();
    if (!overlay || !cfg) return; // closed while the state was being read
    while (card.firstChild) card.removeChild(card.firstChild);

    var title = el('h2', 'Alerts on this device');
    title.id = 'hd-app-title';
    card.appendChild(title);

    var primary = null;
    function button(text, secondary, onClick) {
      var b = el('button', text, 'hd-app-btn' + (secondary ? ' secondary' : ''));
      b.type = 'button';
      if (onClick) b.addEventListener('click', onClick);
      return b;
    }
    // Runs `work`, then redraws; the button is disabled meanwhile so a double tap can't run it twice.
    function busy(b, text, work) {
      return function () {
        b.disabled = true;
        b.textContent = text;
        work().catch(function (e) { return renderAlerts(card, errText(e), true); });
      };
    }

    if (state === 'needs-install') {
      card.appendChild(el('p', 'On iPhone, alerts only work in the installed app. Add it to your Home Screen first, then open it from there and turn alerts on.'));
      primary = button('Show me how', false, function () { closeHelp(); openInstallHelp(); });
    } else if (state === 'unsupported') {
      card.appendChild(el('p', "This browser can't show alerts. Chrome, Edge, Firefox and Safari can."));
    } else if (state === 'blocked') {
      card.appendChild(el('p', isIOS()
        ? 'Alerts are switched off for this app on your phone. Open Settings, tap Notifications, find this app in the list, and turn on Allow Notifications. Then come back here.'
        : 'Alerts are blocked for this site. Open the site settings in your browser (the lock icon next to the address), set Notifications to Allow, then come back here.'));
    } else if (state === 'off') {
      card.appendChild(el('p', cfg.pitch || 'Get a notification on this device when something happens on a ticket.'));
      primary = button('Turn on alerts', false, null);
      primary.addEventListener('click', function () {
        primary.disabled = true;
        primary.textContent = 'Turning on…';
        enableAlerts(cfg).then(function () {
          refreshAlertButtons();
          // A real alert straight away: the quickest way to see that the whole chain works on this phone.
          return renderAlerts(card, 'Alerts are on. Sending a test alert…', false).then(function () {
            return cfg.call('test', {}).then(
              function (r) { return renderAlerts(card, testText(r), false); },
              function (e) { return renderAlerts(card, 'Alerts are on, but the test alert did not go through: ' + errText(e), true); }
            );
          });
        }).catch(function (e) {
          refreshAlertButtons();
          return renderAlerts(card, errText(e), true);
        });
      });
    } else { // 'on'
      card.appendChild(el('p', 'Alerts are on for this device. ' + (cfg.pitch || '')));
    }

    if (note) {
      var n = el('p', note, 'hd-app-note' + (isError ? ' err' : ''));
      n.setAttribute('role', isError ? 'alert' : 'status');
      card.appendChild(n);
    }
    if (primary) card.appendChild(primary);
    if (state === 'on') {
      var test = button('Send a test alert', false, null);
      test.addEventListener('click', busy(test, 'Sending…', function () {
        return cfg.call('test', {}).then(function (r) { return renderAlerts(card, testText(r), false); });
      }));
      card.appendChild(test);
      var off = button('Turn off alerts', true, null);
      off.addEventListener('click', busy(off, 'Turning off…', function () {
        return disableAlerts().then(function () { return renderAlerts(card, 'Alerts are off for this device.', false); });
      }));
      card.appendChild(off);
      primary = test;
    }
    var close = button('Close', true, closeHelp);
    card.appendChild(close);
    (primary || close).focus();
  }

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('[data-alerts-button]');
    if (t) { e.preventDefault(); openAlertsDialog(); }
  });

  // cfg = { audience: 'staff' | 'client', identity, pitch, call }, or null once nobody is signed in.
  function configureAlerts(cfg) {
    alertsCfg = cfg || null;
    refreshAlertButtons();
    if (alertsCfg) syncAlerts().then(refreshAlertButtons, function (e) { console.error('Alerts sync failed:', e); });
  }

  window.HDApp = {
    isStandalone: isStandalone,
    openInstallHelp: openInstallHelp,
    configureAlerts: configureAlerts,
    alertsOff: disableAlerts,
  };
})();
