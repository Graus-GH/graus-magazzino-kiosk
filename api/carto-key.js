/*
 * GRAUS Fleet Kiosk — /api/carto-key
 *
 * Hands the map dashboard the CARTO basemaps key for the Positron tile
 * layer. Same idea as /api/tomtom-key: CARTO's tile keys are meant to be used
 * from the browser, so the protection is restricting the key to this site's
 * domain in CARTO's own key settings — not hiding it. It's still kept out of
 * the committed code (CARTO_API_KEY env var on Vercel), and until it's set
 * the big map simply stays on OpenStreetMap instead of breaking.
 *
 * Free key, no card: https://carto.com/basemaps/apikey
 */

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ key: process.env.CARTO_API_KEY || null });
};
