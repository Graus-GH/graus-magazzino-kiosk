/*
 * Decides whether to render the "verticale" (portrait TV) layout.
 *
 * Forced via ?layout=verticale — set once in the Samsung Smart Signage URL
 * Launcher config. Needed because that display's firmware rotation may
 * present the browser with a landscape viewport regardless of how the panel
 * is physically mounted, so real orientation detection alone can't be
 * trusted there. Falls back to matchMedia for anyone opening the page on an
 * actually portrait-shaped window/monitor (e.g. testing on a phone or a
 * rotated desktop monitor).
 *
 * Must run before first paint (blocking <script>, not deferred) to avoid a
 * flash of the wrong layout.
 */
(function () {
  const forced = new URLSearchParams(window.location.search).get("layout") === "verticale";
  const isPortrait = forced || window.matchMedia("(orientation: portrait)").matches;
  if (isPortrait) document.documentElement.classList.add("k-portrait");
})();
