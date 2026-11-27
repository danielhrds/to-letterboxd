export const SETTINGS_KEY = "settings";
export const TOKEN_KEY = "tmdbToken";
export const TMDB_PERMISSION = { origins: ["https://api.themoviedb.org/*"] };

export const DEFAULTS = Object.freeze({
  enabled: true,
  googlePanel: true,
  googleImdb: true,
  googleResult: true,
  contextMenu: true,
  menuMode: "smart",
  newTab: true,
  theme: "auto",
  tmdbEnabled: false,
  persistentCache: false
});

export function readSettings(value) {
  const settings = { ...DEFAULTS };
  for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
    if (typeof defaultValue === "boolean" && typeof value?.[key] === "boolean") {
      settings[key] = value[key];
    }
  }
  if (["smart", "search"].includes(value?.menuMode)) settings.menuMode = value.menuMode;
  if (["auto", "light", "dark"].includes(value?.theme)) settings.theme = value.theme;
  return settings;
}
