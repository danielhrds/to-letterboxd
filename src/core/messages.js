const catalogs = { en: "en", "pt-BR": "pt_BR" };
const loaded = new Map();

export function browserMessages() {
  return {
    language: chrome.i18n.getMessage("localeTag") || "en",
    get: (key, value) => chrome.i18n.getMessage(key, value) ?? ""
  };
}

export async function messagesFor(preference) {
  const browser = browserMessages();
  if (!Object.hasOwn(catalogs, preference) || browser.language === preference) return browser;
  if (!loaded.has(preference)) {
    const url = chrome.runtime.getURL(`_locales/${catalogs[preference]}/messages.json`);
    const catalog = fetch(url).then(response => {
      if (!response.ok) throw new Error("Unable to load messages");
      return response.json();
    }).catch(() => {
      loaded.delete(preference);
      return null;
    });
    loaded.set(preference, catalog);
  }
  const catalog = await loaded.get(preference);
  if (!catalog) return browser;
  return {
    language: preference,
    get(key, value) {
      const entry = catalog[key];
      if (!entry) return browser.get(key, value);
      return entry.message.replace(/\$([a-z0-9_]+)\$/gi, (placeholder, name) => {
        const content = entry.placeholders?.[name.toLowerCase()]?.content;
        return content === "$1" ? value ?? "" : content ?? placeholder;
      });
    }
  };
}
