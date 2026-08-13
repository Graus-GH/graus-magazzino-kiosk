/*
 * Carries ?key=... and ?layout=... along on the header nav links (← Mappa /
 * Analisi soste → / Performance →) so switching between the three dashboard
 * pages doesn't drop them. ?layout=verticale in particular has to survive
 * navigation this way since the TV's forced portrait mode isn't something
 * the next page can redetect on its own (see layoutMode.js). Does nothing
 * if neither param is present.
 */
(function () {
  const params = new URLSearchParams(window.location.search);
  const key = params.get("key");
  const layout = params.get("layout");
  if (!key && !layout) return;

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("a.k-nav-link").forEach(a => {
      try {
        const url = new URL(a.getAttribute("href"), window.location.origin);
        if (key) url.searchParams.set("key", key);
        if (layout) url.searchParams.set("layout", layout);
        a.setAttribute("href", url.pathname + url.search);
      } catch (err) {
        // malformed href, leave it alone
      }
    });
  });
})();
