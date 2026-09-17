/*
 * GRAUS Fleet Kiosk — VIVES! da Graus welcome page
 *
 * A standalone "message" page for TV3, swapped in manually in place of the
 * Fotovoltaico dashboard whenever there's something to announce (today:
 * the VIVES! event welcome; later: a birthday, a notice, anything else) —
 * see also the "← Torna a Energia" link, which is the way back.
 */

// Companies exhibiting at VIVES!, logos fetched from graus.bz.it/vives/prodotti.
const COMPANIES = [
  { name: "Monpiër de Gherdëina", file: "01-monpier.png" },
  { name: "GustAhr", file: "02-gustahr.png" },
  { name: "Privatbrauerei Antonius", file: "03-antonius.png" },
  { name: "Spezialbierbrauerei Forst", file: "04-forst.png" },
  { name: "Selezione Baladin", file: "05-baladin.png" },
  { name: "Birra Viola", file: "06-birraviola.png" },
  { name: "Kohl Bergapfelsäfte", file: "07-kohl.jpg" },
  { name: "Fonte Plose", file: "08-plose.png" },
  { name: "Sparkling Rocco", file: "09-rocco.jpg" },
  { name: "Dolomitico", file: "10-dolomitico.png" },
  { name: "Birra Castello", file: "11-castello.png" },
  { name: "Herzoglich Bayerisches Brauhaus Tegernsee", file: "12-tegernsee.jpg" }
];

function logoHtml(c) {
  return `
    <div class="v-carousel-logo">
      <img src="/kiosk-a7f3d9/vives/logos/${c.file}" alt="${c.name}" title="${c.name}">
    </div>
  `;
}

function renderCarousel() {
  const row = document.getElementById("v-carousel-row");
  if (!row) return;
  // The track is duplicated once so the CSS animation can loop seamlessly
  // (scroll exactly one copy's width, then snap back unnoticed).
  row.innerHTML = COMPANIES.map(logoHtml).join("") + COMPANIES.map(logoHtml).join("");
}

// Keep ?layout=verticale (and ?key=... if present) when leaving this page,
// same courtesy as keyPersist.js on the other kiosk pages — otherwise
// "torna a Energia" would silently drop back to landscape.
function persistLayoutOnBackLink() {
  const link = document.getElementById("v-back-link");
  if (!link) return;
  const params = new URLSearchParams(window.location.search);
  const keep = new URLSearchParams();
  if (params.get("layout")) keep.set("layout", params.get("layout"));
  if (params.get("key")) keep.set("key", params.get("key"));
  const qs = keep.toString();
  if (qs) link.href = link.href + (link.href.includes("?") ? "&" : "?") + qs;
}

renderCarousel();
persistLayoutOnBackLink();
