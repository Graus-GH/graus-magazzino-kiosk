function cleanName(name) {
  return (name || "").replace(/\s+/g, " ").trim();
}

module.exports = { cleanName };
