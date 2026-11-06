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
      '.hd-app-btn.secondary{background:var(--bg,#f7f8fa);color:var(--text2,#4b5565);border:1px solid var(--border,#e4e7ec)}';
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

  window.HDApp = { isStandalone: isStandalone, openInstallHelp: openInstallHelp };
})();
