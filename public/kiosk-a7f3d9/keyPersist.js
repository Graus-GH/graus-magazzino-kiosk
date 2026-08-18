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

// Hamburger menu toggle for the header nav links — shared by all three
// pages. Closes on an outside click; clicking inside the dropdown itself
// doesn't count as "outside" (so link clicks still navigate normally).
(function () {
  document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.getElementById("k-menu-toggle");
    const dropdown = document.getElementById("k-menu-dropdown");
    if (!toggle || !dropdown) return;

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.classList.toggle("k-menu-dropdown--open");
    });
    dropdown.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => dropdown.classList.remove("k-menu-dropdown--open"));
  });
})();
