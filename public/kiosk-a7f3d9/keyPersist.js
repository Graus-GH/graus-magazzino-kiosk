/*
 * If the current URL has ?key=..., carry it along on the header nav links
 * (← Mappa / Analisi soste → / Performance →) so switching between the
 * three dashboard pages doesn't drop it. Does nothing if there's no key.
 */
(function () {
  const key = new URLSearchParams(window.location.search).get("key");
  if (!key) return;

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("a.k-nav-link").forEach(a => {
      try {
        const url = new URL(a.getAttribute("href"), window.location.origin);
        url.searchParams.set("key", key);
        a.setAttribute("href", url.pathname + url.search);
      } catch (err) {
        // malformed href, leave it alone
      }
    });
  });
})();
