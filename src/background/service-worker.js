import { cacheKey, cacheRevision, clearMatches, readMatch, saveMatch } from "./cache.js";
import { cleanText, filmYear, parseSelection } from "../core/film-input.js";
import { messagesFor } from "../core/messages.js";
import { fallbackFor, knownDestination, resolveFilm } from "../core/resolver.js";
import { readSettings, SETTINGS_KEY, TMDB_PERMISSION, TOKEN_KEY } from "../core/settings.js";
import { findMoviePoster, validToken, validateToken } from "../core/tmdb.js";
import { filmLink, imdbId, isGoogleSearch, searchUrl, tmdbId } from "../core/urls.js";

const MENU_ID = "open-letterboxd";
const WAIT_MS = 5000;
const popup = chrome.runtime.getURL("src/popup/popup.html");
const waiting = chrome.runtime.getURL("src/resolving/resolving.html");
const trustedStorage = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
const googlePorts = new Map();
const menuPorts = new Map();
const inFlight = new Map();
let menuQueue = Promise.resolve();
let tokenRevision = 0;

async function configuration() {
  await trustedStorage;
  const data = await chrome.storage.local.get([SETTINGS_KEY, TOKEN_KEY]);
  return { settings: readSettings(data[SETTINGS_KEY]), token: data[TOKEN_KEY] };
}

function updateMenu() {
  menuQueue = menuQueue.catch(() => {}).then(async () => {
    const { settings } = await configuration();
    await new Promise(resolve => chrome.contextMenus.remove(MENU_ID, () => {
      void chrome.runtime.lastError;
      resolve();
    }));
    if (settings.contextMenu) {
      const messages = await messagesFor(settings.language);
      await new Promise(resolve => chrome.contextMenus.create({
        id: MENU_ID, title: messages.get("menuOpen"), contexts: ["selection"]
      }, () => {
        void chrome.runtime.lastError;
        resolve();
      }));
    }
  });
}

async function openInTab(url, tab, newTab) {
  if (newTab || !Number.isInteger(tab?.id)) {
    await chrome.tabs.create({ url, ...(Number.isInteger(tab?.windowId) && { windowId: tab.windowId }) });
  } else {
    await chrome.tabs.update(tab.id, { url });
  }
}

async function openSelection(text, tab) {
  const started = Date.now();
  const raw = cleanText(text, 1000);
  if (!raw) return;
  const { settings, token } = await configuration();
  if (!settings.contextMenu) return;
  const input = parseSelection(raw);
  const known = settings.menuMode === "smart" ? knownDestination(input) : null;
  const canResolve = settings.menuMode === "smart" && input.title && settings.tmdbEnabled &&
    validToken(token) && await chrome.permissions.contains(TMDB_PERMISSION);
  if (known || !canResolve || Date.now() - started >= WAIT_MS) {
    await openInTab(known?.url || searchUrl(raw), tab, settings.newTab);
    return;
  }
  const fragment = new URLSearchParams({ text: raw, until: String(started + WAIT_MS) });
  await openInTab(`${waiting}#${fragment}`, tab, settings.newTab);
}

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch {}
}

function notifyGoogleTabs(invalidate) {
  void chrome.tabs.query({}).then(tabs => {
    for (const { id } of tabs) {
      if (!Number.isInteger(id)) continue;
      void chrome.tabs.sendMessage(id, { type: "refreshGoogleSettings", invalidate }, { frameId: 0 })
        .catch(() => {});
    }
  }).catch(() => {});
}

function abortJobs() {
  for (const job of inFlight.values()) job.controller.abort();
  inFlight.clear();
}

async function tmdbAvailable({ settings, token }) {
  return settings.tmdbEnabled && validToken(token) && chrome.permissions.contains(TMDB_PERMISSION);
}

async function resolveShared(input, config, consumer) {
  if (!await tmdbAvailable(config)) return fallbackFor(input, "tmdbOff");
  const { settings, token } = config;
  consumer.throwIfAborted();
  const key = cacheKey(input);
  let job = inFlight.get(key);
  if (!job) {
    const generation = cacheRevision();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(WAIT_MS)]);
    const promise = (async () => {
      const cached = await readMatch(key, settings.persistentCache).catch(() => null);
      const result = await resolveFilm(input, { token, cached, signal });
      if (result.status === "confirmedIdentity" && !cached && !signal.aborted) {
        void saveMatch(key, result, settings.persistentCache, generation).catch(() => {});
      }
      return result;
    })().finally(() => {
      if (inFlight.get(key)?.controller === controller) inFlight.delete(key);
    });
    job = { controller, promise, consumers: 0 };
    inFlight.set(key, job);
  }
  job.consumers++;
  let cancel;
  try {
    const canceled = new Promise(resolve => {
      cancel = () => resolve(fallbackFor(input, "canceled"));
      consumer.addEventListener("abort", cancel, { once: true });
    });
    const result = await Promise.race([job.promise, canceled]);
    const fallback = fallbackFor(input, result.reason);
    return result.status === "confirmedIdentity" ? { ...result, fallback: fallback.url } : fallback;
  } finally {
    consumer.removeEventListener("abort", cancel);
    if (--job.consumers === 0 && inFlight.get(key) === job) {
      inFlight.delete(key);
      job.controller.abort();
    }
  }
}

function googleInput(message) {
  if (!message || typeof message !== "object") return null;
  const input = {
    title: cleanText(message.title),
    originalTitle: cleanText(message.originalTitle),
    year: filmYear(message.year),
    director: cleanText(message.director, 120),
    locale: cleanText(message.locale, 35),
    canonicalUrl: filmLink(message.canonicalUrl)?.canonicalUrl,
    imdbId: imdbId(message.imdbId),
    tmdbId: tmdbId(message.tmdbId),
    conflictingIds: message.conflictingIds === true
  };
  return input.title ? input : null;
}

function connectGoogle(port) {
  const controller = new AbortController();
  let started = false;
  googlePorts.set(port, controller);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    controller.abort();
    googlePorts.delete(port);
  });
  port.onMessage.addListener(message => {
    if (started || controller.signal.aborted || !["resolve", "poster"].includes(message?.type)) return;
    const lookup = message.type === "poster";
    const input = lookup
      ? { imdbId: imdbId(message.film?.imdbId), tmdbId: tmdbId(message.film?.tmdbId) }
      : googleInput(message.film);
    if (lookup ? !input.imdbId && !input.tmdbId : !input || knownDestination(input)) return;
    started = true;
    void (async () => {
      const config = await configuration();
      if (controller.signal.aborted) return;
      const { settings, token } = config;
      let result = null;
      if (lookup) {
        if (settings.googleResult && await tmdbAvailable(config)) {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(WAIT_MS)]);
          result = await findMoviePoster(input, token, signal);
        }
      } else {
        result = settings.googlePanel || settings.googleResult
          ? await resolveShared(input, config, controller.signal) : fallbackFor(input, "disabled");
      }
      if (!controller.signal.aborted) safePost(port, { type: "result", result });
    })().catch(() => {
      if (!controller.signal.aborted) safePost(port, {
        type: "result", result: lookup ? null : fallbackFor(input, "unavailable")
      });
    });
  });
}

function connectMenu(port) {
  const controller = new AbortController();
  let started = false;
  menuPorts.set(port, controller);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    controller.abort();
    menuPorts.delete(port);
  });
  port.onMessage.addListener(message => {
    if (message?.type === "cancel") return controller.abort();
    if (message?.type !== "resolve" || controller.signal.aborted || started ||
        typeof message.text !== "string" || message.text.length > 1000 ||
        !Number.isFinite(message.until) || message.until > Date.now() + WAIT_MS) return;
    started = true;
    const input = { ...parseSelection(message.text), locale: chrome.i18n.getUILanguage() };
    void (async () => {
      const config = await configuration();
      if (!config.settings.contextMenu) {
        safePost(port, { type: "canceled" });
        return;
      }
      const remaining = message.until - Date.now();
      const result = remaining > 0 && config.settings.menuMode === "smart"
        ? knownDestination(input) ?? await resolveShared(
          input, config, AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]))
        : fallbackFor(input, "searchMode");
      if (!controller.signal.aborted) safePost(port, { type: "result", result });
    })().catch(() => {
      if (!controller.signal.aborted) safePost(port, { type: "result", result: fallbackFor(input, "unavailable") });
    });
  });
}

async function popupAction(message, revision) {
  const { settings, token } = await configuration();
  if (message.type === "tmdbState") return { configured: validToken(token) };
  if (message.type === "clearCache") {
    await clearMatches();
    return { state: "cacheCleared" };
  }
  if (message.type === "removeToken") {
    if (revision !== tokenRevision) return { state: "unavailable" };
    await chrome.storage.local.set({ [TOKEN_KEY]: null, [SETTINGS_KEY]: { ...settings, tmdbEnabled: false } });
    if (revision === tokenRevision) await chrome.permissions.remove(TMDB_PERMISSION);
    return { state: "notConfigured" };
  }
  const candidate = message.token ?? token;
  if (!validToken(candidate)) return { state: candidate ? "invalidToken" : "notConfigured" };
  if (!await chrome.permissions.contains(TMDB_PERMISSION)) return { state: "permissionDenied" };
  try {
    if (!await validateToken(candidate, AbortSignal.timeout(WAIT_MS))) return { state: "invalidToken" };
  } catch (error) {
    return { state: ["invalidToken", "rateLimited"].includes(error.code) ? error.code : "tmdbUnavailable" };
  }
  if (message.type === "saveToken") {
    const current = await configuration();
    if (revision !== tokenRevision) return { state: "unavailable" };
    await chrome.storage.local.set({
      [TOKEN_KEY]: candidate, [SETTINGS_KEY]: { ...current.settings, tmdbEnabled: true }
    });
  }
  return { state: "connected" };
}

chrome.runtime.onInstalled.addListener(updateMenu);
chrome.runtime.onStartup.addListener(updateMenu);
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) void openSelection(info.selectionText, tab).catch(() => {});
});

chrome.runtime.onConnect.addListener(port => {
  const { sender } = port;
  if (sender?.id !== chrome.runtime.id || sender.frameId !== 0) return port.disconnect();
  if (port.name === "googleResolution" && isGoogleSearch(sender.url)) return connectGoogle(port);
  if (port.name === "selection" && sender.url?.split("#")[0] === waiting) return connectMenu(port);
  port.disconnect();
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "googleSettings" && sender.frameId === 0 && isGoogleSearch(sender.url)) {
    void configuration().then(({ settings }) => reply(settings), () => reply(null));
    return true;
  }
  if (sender.url !== popup ||
      !["tmdbState", "saveToken", "testToken", "removeToken", "clearCache"].includes(message?.type)) return;
  if (["saveToken", "removeToken"].includes(message.type)) tokenRevision++;
  void popupAction(message, tokenRevision).then(reply, () => reply({ state: "unavailable" }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || (!changes[SETTINGS_KEY] && !changes[TOKEN_KEY])) return;
  const before = readSettings(changes[SETTINGS_KEY]?.oldValue);
  const after = readSettings(changes[SETTINGS_KEY]?.newValue);
  if (changes[SETTINGS_KEY] && (before.contextMenu !== after.contextMenu ||
      (after.contextMenu && before.language !== after.language))) {
    updateMenu();
  }
  if (changes[TOKEN_KEY]) void clearMatches().catch(() => {});
  else if (before.persistentCache && !after.persistentCache) {
    void clearMatches({ persistentOnly: true }).catch(() => {});
  }
  const invalidate = Boolean(changes[TOKEN_KEY]) || Boolean(changes[SETTINGS_KEY] &&
    ["googlePanel", "googleResult", "tmdbEnabled", "persistentCache"]
      .some(key => before[key] !== after[key]));
  if (changes[SETTINGS_KEY] && !after.contextMenu) {
    for (const [port, controller] of menuPorts) {
      controller.abort();
      safePost(port, { type: "canceled" });
    }
  }
  if (invalidate) {
    for (const [port, controller] of googlePorts) {
      controller.abort();
      port.disconnect();
    }
    googlePorts.clear();
    abortJobs();
  }
  if (changes[SETTINGS_KEY] || invalidate) notifyGoogleTabs(invalidate);
});

chrome.permissions.onRemoved.addListener(permissions => {
  if (!permissions.origins?.some(origin => TMDB_PERMISSION.origins.includes(origin))) return;
  void configuration().then(({ settings }) => {
    if (settings.tmdbEnabled) return chrome.storage.local.set({
      [SETTINGS_KEY]: { ...settings, tmdbEnabled: false }
    });
  }).catch(() => {});
});
