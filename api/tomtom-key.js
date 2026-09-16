/*
 * GRAUS Fleet Kiosk — /api/tomtom-key
 *
 * Hands the map dashboard TomTom's API key for the live traffic-flow tile
 * layer. Unlike Geotab/SolarEdge, this key is meant to be used directly
 * from the browser (TomTom's tile endpoints are designed for client-side
 * map libraries, the same way a Google Maps JS key or Mapbox public token
 * works) — restrict it to this site's domain in the TomTom developer
 * dashboard rather than trying to hide it, since a referrer-restricted
 * tile key isn't a secret in the same sense as a Geotab session.
 *
 * Still kept out of the committed code and served from an env var so it
 * can be rotated without a redeploy, and so the traffic layer simply
 * doesn't appear (rather than breaking) until TOMTOM_API_KEY is set.
 */

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ key: process.env.TOMTOM_API_KEY || null });
};
