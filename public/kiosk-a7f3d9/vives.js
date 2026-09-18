/*
 * GRAUS Fleet Kiosk — VIVES! da Graus welcome page
 *
 * A standalone "message" page for TV3, swapped in manually in place of the
 * Fotovoltaico dashboard whenever there's something to announce (today:
 * the VIVES! event welcome; later: a birthday, a notice, anything else) —
 * see also the "← Torna a Energia" link, which is the way back.
 *
 * Fixed 1080x1920 design ("stage"), scaled via CSS transform to fit
 * whatever the actual screen is (fit(), below) — this handles both the
 * portrait TV and a landscape office window the same way, always fully
 * visible with letterboxing on one axis, never scrolling.
 */

// Espositori VIVES! 2026 — n = numero tavolo, zoom = fattore di ingrandimento
// del logo dentro il riquadro (i file arrivati come PDF/Drive hanno margini
// bianchi non uniformi). Nomi e numeri tavolo da graus.bz.it/vives/prodotti;
// loghi scaricati in locale invece di linkare Google Drive direttamente.
const ESPOSITORI = [
  { "n": 1, "nome": "Monpiër de Gherdëina", "zoom": 0.86, "logo": "/kiosk-a7f3d9/vives/logos/01-monpi-r-de-gherd-ina.png" },
  { "n": 2, "nome": "GustAhr", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/02-gustahr.png" },
  { "n": 3, "nome": "Privatbrauerei Antonius", "zoom": 1.05, "logo": "/kiosk-a7f3d9/vives/logos/03-privatbrauerei-antonius.jpg" },
  { "n": 4, "nome": "Spezialbierbrauerei Forst", "zoom": 0.88, "logo": "/kiosk-a7f3d9/vives/logos/04-spezialbierbrauerei-forst.png" },
  { "n": 5, "nome": "Selezione Baladin", "zoom": 2.29, "logo": "/kiosk-a7f3d9/vives/logos/05-selezione-baladin.png" },
  { "n": 6, "nome": "Birra Viola", "zoom": 1.3, "logo": "/kiosk-a7f3d9/vives/logos/06-birra-viola.png" },
  { "n": 7, "nome": "Kohl Bergapfelsäfte", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/07-kohl-bergapfels-fte.png" },
  { "n": 8, "nome": "Fonte Plose", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/08-fonte-plose.png" },
  { "n": 9, "nome": "Sparkling Rocco", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/09-sparkling-rocco.jpg" },
  { "n": 10, "nome": "Dolomitico", "zoom": 1.62, "logo": "/kiosk-a7f3d9/vives/logos/10-dolomitico.png" },
  { "n": 11, "nome": "Birra Castello", "zoom": 1.62, "logo": "/kiosk-a7f3d9/vives/logos/11-birra-castello.png" },
  { "n": 12, "nome": "Herzoglich Bayerisches Brauhaus Tegernsee", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/12-herzoglich-bayerisches-brauhau.jpg" },
  { "n": 13, "nome": "Meckatzer Löwenbräu", "zoom": 1.4, "logo": "/kiosk-a7f3d9/vives/logos/13-meckatzer-l-wenbr-u.png" },
  { "n": 14, "nome": "Paulaner Brauerei Gruppe", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/14-paulaner-brauerei-gruppe.png" },
  { "n": 15, "nome": "Warsteiner Brauerei", "zoom": 1.25, "logo": "/kiosk-a7f3d9/vives/logos/15-warsteiner-brauerei.png" },
  { "n": 16, "nome": "Brennerei Walcher", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/16-brennerei-walcher.png" },
  { "n": 17, "nome": "Krumas Spirits", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/17-krumas-spirits.png" },
  { "n": 18, "nome": "Ladina Distillery", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/18-ladina-distillery.png" },
  { "n": 19, "nome": "Zu Plun", "zoom": 2.21, "logo": "/kiosk-a7f3d9/vives/logos/19-zu-plun.jpg" },
  { "n": 20, "nome": "Brunner Philipp - Treml Punsch", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/20-brunner-philipp-treml-punsch.png" },
  { "n": 21, "nome": "Roner", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/21-roner.jpg" },
  { "n": 22, "nome": "Schwarz Brennerei", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/22-schwarz-brennerei.png" },
  { "n": 23, "nome": "Brennerei St. Urban", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/23-brennerei-st-urban.jpg" },
  { "n": 24, "nome": "Unterthurner", "zoom": 1.1, "logo": "/kiosk-a7f3d9/vives/logos/24-unterthurner.png" },
  { "n": 25, "nome": "Villa Laviosa", "zoom": 1.48, "logo": "/kiosk-a7f3d9/vives/logos/25-villa-laviosa.png" },
  { "n": 26, "nome": "Distilleria Marzadro", "zoom": 1.85, "logo": "/kiosk-a7f3d9/vives/logos/26-distilleria-marzadro.png" },
  { "n": 27, "nome": "Villa de Varda", "zoom": 2.4, "logo": "/kiosk-a7f3d9/vives/logos/27-villa-de-varda.png" },
  { "n": 28, "nome": "Fratelli Janousek", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/28-fratelli-janousek.png" },
  { "n": 29, "nome": "Doladira", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/29-doladira.png" },
  { "n": 30, "nome": "Weingut Oberfurner", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/30-weingut-oberfurner.png" },
  { "n": 31, "nome": "Kellerei Eisacktal", "zoom": 1.45, "logo": "/kiosk-a7f3d9/vives/logos/31-kellerei-eisacktal.png" },
  { "n": 32, "nome": "Kuenhof - Fam. Pliger", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/32-kuenhof-fam-pliger.png" },
  { "n": 33, "nome": "Köfererhof", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/33-k-fererhof.png" },
  { "n": 34, "nome": "Gump Hof", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/34-gump-hof.png" },
  { "n": 35, "nome": "Kellerei Bozen", "zoom": 0.85, "logo": "/kiosk-a7f3d9/vives/logos/35-kellerei-bozen.png" },
  { "n": 36, "nome": "Weingut Hans Rottensteiner", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/36-weingut-hans-rottensteiner.png" },
  { "n": 37, "nome": "Weingut Fliederhof", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/37-weingut-fliederhof.png" },
  { "n": 38, "nome": "Weingut Untermoserhof", "zoom": 1.65, "logo": "/kiosk-a7f3d9/vives/logos/38-weingut-untermoserhof.png" },
  { "n": 39, "nome": "Weingut Griesbauerhof", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/39-weingut-griesbauerhof.png" },
  { "n": 40, "nome": "Plattner Christian", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/40-plattner-christian.png" },
  { "n": 41, "nome": "Weingut Loacker", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/41-weingut-loacker.png" },
  { "n": 42, "nome": "Weingut Pranzegg", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/42-weingut-pranzegg.png" },
  { "n": 43, "nome": "Ansitz Dolomytos Sacker", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/43-ansitz-dolomytos-sacker.png" },
  { "n": 44, "nome": "Radoar Hof", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/44-radoar-hof.png" },
  { "n": 45, "nome": "Kellerei Terlan-Andrian", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/45-kellerei-terlan-andrian.png" },
  { "n": 46, "nome": "Weingut Kiemberger", "zoom": 1.01, "logo": "/kiosk-a7f3d9/vives/logos/46-weingut-kiemberger.png" },
  { "n": 47, "nome": "Weingut Kornell", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/47-weingut-kornell.png" },
  { "n": 48, "nome": "Sektkellerei Arunda", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/48-sektkellerei-arunda.webp" },
  { "n": 49, "nome": "Kellerei Meran", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/49-kellerei-meran.png" },
  { "n": 50, "nome": "Weingut Ignaz Niedrist", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/50-weingut-ignaz-niedrist.png" },
  { "n": 51, "nome": "Weingut Stroblhof", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/51-weingut-stroblhof.png" },
  { "n": 52, "nome": "Kellerei Schreckbichl", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/52-kellerei-schreckbichl.png" },
  { "n": 53, "nome": "Kellerei Sankt Pauls", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/53-kellerei-sankt-pauls.png" },
  { "n": 54, "nome": "Comitissa", "zoom": 1.3, "logo": "/kiosk-a7f3d9/vives/logos/54-comitissa.png" },
  { "n": 55, "nome": "Kellerei Kaltern", "zoom": 1.83, "logo": "/kiosk-a7f3d9/vives/logos/55-kellerei-kaltern.png" },
  { "n": 56, "nome": "Weingut Ritterhof", "zoom": 1.26, "logo": "/kiosk-a7f3d9/vives/logos/56-weingut-ritterhof.png" },
  { "n": 57, "nome": "Weingut Peter Sölva", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/57-weingut-peter-s-lva.png" },
  { "n": 58, "nome": "Weingut Tröpfltalhof", "zoom": 1.3, "logo": "/kiosk-a7f3d9/vives/logos/58-weingut-tr-pfltalhof.png" },
  { "n": 59, "nome": "Weingut Walter Schullian", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/59-weingut-walter-schullian.png" },
  { "n": 60, "nome": "Kellerei Kurtatsch", "zoom": 1.3, "logo": "/kiosk-a7f3d9/vives/logos/60-kellerei-kurtatsch.png" },
  { "n": 61, "nome": "Weingut Peter Zemmer", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/61-weingut-peter-zemmer.png" },
  { "n": 62, "nome": "Widmann Wine", "zoom": 1.72, "logo": "/kiosk-a7f3d9/vives/logos/62-widmann-wine.png" },
  { "n": 63, "nome": "Weingut Lageder Alois", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/63-weingut-lageder-alois.png" },
  { "n": 64, "nome": "Kellerei Nals Margreid", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/64-kellerei-nals-margreid.png" },
  { "n": 65, "nome": "Kellerei Tramin", "zoom": 1.01, "logo": "/kiosk-a7f3d9/vives/logos/65-kellerei-tramin.png" },
  { "n": 66, "nome": "Castelfeder", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/66-castelfeder.png" },
  { "n": 67, "nome": "Weingut Baron Longo", "zoom": 2.1, "logo": "/kiosk-a7f3d9/vives/logos/67-weingut-baron-longo.png" },
  { "n": 68, "nome": "Weingut Pfitscher", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/68-weingut-pfitscher.jpg" },
  { "n": 69, "nome": "Salurnis", "zoom": 2.29, "logo": "/kiosk-a7f3d9/vives/logos/69-salurnis.png" },
  { "n": 70, "nome": "Weingut Haderburg", "zoom": 2.4, "logo": "/kiosk-a7f3d9/vives/logos/70-weingut-haderburg.png" },
  { "n": 71, "nome": "Weinmanufaktur Roberto Ferrari", "zoom": 1.75, "logo": "/kiosk-a7f3d9/vives/logos/71-weinmanufaktur-roberto-ferrari.png" },
  { "n": 72, "nome": "Azienda Agricola Foradori", "zoom": 1.3, "logo": "/kiosk-a7f3d9/vives/logos/72-azienda-agricola-foradori.png" },
  { "n": 73, "nome": "Pojer e Sandri", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/73-pojer-e-sandri.png" },
  { "n": 74, "nome": "Cesconi", "zoom": 1.62, "logo": "/kiosk-a7f3d9/vives/logos/74-cesconi.png" },
  { "n": 75, "nome": "Tenuta San Leonardo", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/75-tenuta-san-leonardo.png" },
  { "n": 76, "nome": "Azienda Agricola Andreola", "zoom": 2.29, "logo": "/kiosk-a7f3d9/vives/logos/76-azienda-agricola-andreola.png" },
  { "n": 77, "nome": "Cantina Fasol Menin", "zoom": 1.2, "logo": "/kiosk-a7f3d9/vives/logos/77-cantina-fasol-menin.png" },
  { "n": 78, "nome": "Perlage Winery", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/78-perlage-winery.png" },
  { "n": 79, "nome": "Italo Cescon", "zoom": 1.2, "logo": "/kiosk-a7f3d9/vives/logos/79-italo-cescon.png" },
  { "n": 80, "nome": "De Stefani Winery", "zoom": 1.3, "logo": "/kiosk-a7f3d9/vives/logos/80-de-stefani-winery.png" },
  { "n": 81, "nome": "Tenuta Santa Maria Valverde", "zoom": 1.3, "logo": "/kiosk-a7f3d9/vives/logos/81-tenuta-santa-maria-valverde.png" },
  { "n": 82, "nome": "Falezze", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/82-falezze.png" },
  { "n": 83, "nome": "Lis Neris Wines", "zoom": 1, "logo": "/kiosk-a7f3d9/vives/logos/83-lis-neris-wines.png" },
  { "n": 84, "nome": "Azienda Agricola Castelvecchio", "zoom": 1.5, "logo": "/kiosk-a7f3d9/vives/logos/84-azienda-agricola-castelvecchio.jpg" },
  { "n": 85, "nome": "Corte Aura", "zoom": 1.62, "logo": "/kiosk-a7f3d9/vives/logos/85-corte-aura.png" },
  { "n": 86, "nome": "Azienda Agricola G. D. Vajra", "zoom": 1.3, "logo": "/kiosk-a7f3d9/vives/logos/86-azienda-agricola-g-d-vajra.png" },
  { "n": 87, "nome": "Vinuci - Dealcolati", "zoom": 1.01, "logo": "/kiosk-a7f3d9/vives/logos/87-vinuci-dealcolati.png" },
];

const MOSTRA_NUMERI = true;

function tile(e) {
  const badge = MOSTRA_NUMERI
    ? '<span style="position:absolute;top:6px;left:6px;min-width:26px;height:26px;padding:0 7px;border-radius:999px;background:#005CAA;color:#fff;font-size:13px;font-weight:700;box-shadow:0 0 0 3px #fff;display:flex;align-items:center;justify-content:center">' + e.n + '</span>'
    : '';
  return '<div style="flex:0 0 auto;width:186px;height:112px;background:#fff;border-radius:12px;display:flex;align-items:center;justify-content:center;padding:7px 11px;position:relative">'
    + '<div style="width:100%;height:100%;overflow:hidden;display:flex;align-items:center;justify-content:center">'
    + '<img src="' + e.logo + '" alt="' + e.nome.replace(/"/g,'&quot;') + '" style="width:100%;height:100%;object-fit:contain;transform:scale(' + (e.zoom || 1) + ')">'
    + '</div>' + badge + '</div>';
}

function renderMarquee() {
  const rigaA = document.getElementById("riga-a");
  const rigaB = document.getElementById("riga-b");
  if (!rigaA || !rigaB) return;
  const half = Math.ceil(ESPOSITORI.length / 2);
  const a = ESPOSITORI.slice(0, half), b = ESPOSITORI.slice(half);
  // ogni riga è duplicata: l'animazione scorre esattamente una copia e riparte senza salto
  rigaA.innerHTML = a.concat(a).map(tile).join('');
  rigaB.innerHTML = b.concat(b).map(tile).join('');
}

// Fit-to-screen: il palco resta 1080x1920 e viene scalato al display del kiosk
// (TV portrait o finestra ufficio landscape — stesso meccanismo per entrambi).
function fit() {
  const s = Math.min(window.innerWidth / 1080, window.innerHeight / 1920);
  const stage = document.getElementById("stage");
  if (stage) stage.style.transform = "scale(" + s + ")";
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

renderMarquee();
persistLayoutOnBackLink();
addEventListener("resize", fit);
fit();
