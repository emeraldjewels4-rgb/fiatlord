/* web9999 adverts - loader.
 *
 * Keeps the advert strip at the bottom of the dashboard closed unless the
 * document in the frame (/ads.html) reports that it actually has a unit to show.
 * That means an empty ads.html costs the page nothing: no visible box, no
 * layout shift, no request to any ad network.
 *
 * The frame is same-origin, but the message is still treated as untrusted: only
 * a sane height is accepted, so a misbehaving or compromised unit cannot stretch
 * the strip over the dashboard.
 */
(function () {
  'use strict';

  var strip = document.getElementById('web9999-ad');
  var frame = document.getElementById('web9999-ad-frame');
  if (!strip || !frame) return;

  var MAX_HEIGHT = 320;   // an advert taller than this is a bug, not an advert

  function activate(height) {
    var h = Math.ceil(Number(height) || 0);
    if (!h || h < 10 || h > MAX_HEIGHT) return;
    if (strip.dataset.open === '1') return;      // idempotent: a second report cannot grow it
    strip.dataset.open = '1';
    frame.style.height = h + 'px';
    strip.style.visibility = 'visible';
    strip.style.pointerEvents = 'auto';          // only interactive once it is really there
    // The strip is position:fixed, so without this it sits on top of the last
    // rows of the dashboard. Reserve its height at the end of the page instead:
    // the advert costs space, never content.
    var reserved = h + 16;                        // + strip padding and border
    document.body.style.paddingBottom = reserved + 'px';
    document.documentElement.style.setProperty('--web9999-ad-height', reserved + 'px');
  }

  window.addEventListener('message', function (event) {
    if (event.source !== frame.contentWindow) return;      // only our own frame
    var data = event.data;
    if (!data || data.type !== 'web9999-ad' || !data.active) return;
    activate(data.height);
  });

})();
