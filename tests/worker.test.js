import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { DEFAULTS } from "../src/core/settings.js";

const extension = "chrome-extension://test-extension/";
const placeholder = "test-token-placeholder";

function event() {
  const listeners = [];
  return {
    addListener: listener => listeners.push(listener),
    emit: (...args) => listeners.map(listener => listener(...args))
  };
}

const storageChanged = event();

function storage(name) {
  const values = {};
  return {
    values,
    async get(keys) {
      return Object.fromEntries([keys].flat().map(key => [key, values[key]]));
    },
    async set(entries) {
      const changes = Object.fromEntries(Object.entries(entries).map(([key, value]) => {
        const oldValue = values[key];
        values[key] = value;
        return [key, { oldValue, newValue: value }];
      }));
      storageChanged.emit(changes, name);
    },
    async remove(key) {
      delete values[key];
    },
    async setAccessLevel(properties) {
      this.accessLevel = properties.accessLevel;
    }
  };
}

const local = storage("local");
const session = storage("session");
const tabs = [];
const menu = new Map();
let providerAllowed = false;
globalThis.chrome = {
  storage: { local, session, onChanged: storageChanged },
  runtime: {
    id: "test-extension",
    getURL: path => extension + path,
    onInstalled: event(),
    onStartup: event(),
    onConnect: event(),
    onMessage: event()
  },
  contextMenus: {
    onClicked: event(),
    create(item, callback) {
      menu.set(item.id, item);
      callback();
    },
    remove(id, callback) {
      menu.delete(id);
      callback();
    }
  },
  tabs: {
    async create(properties) { tabs.push({ ...properties, operation: "create" }); },
    async update(tabId, properties) { tabs.push({ ...properties, tabId, operation: "update" }); }
  },
  i18n: { getMessage: () => "Open on Letterboxd", getUILanguage: () => "pt-BR" },
  permissions: {
    onRemoved: event(),
    contains: async () => providerAllowed,
    remove: async () => { providerAllowed = false; }
  }
};

await import("../src/background/service-worker.js");

function choose(selectionText) {
  chrome.contextMenus.onClicked.emit(
    { menuItemId: "open-letterboxd", selectionText }, { id: 11, windowId: 4 }
  );
}

function connect(name, url, senderOverrides = {}) {
  const messages = [];
  const port = {
    name, messages, onMessage: event(), onDisconnect: event(),
    sender: { id: chrome.runtime.id, frameId: 0, url, ...senderOverrides },
    disconnect() { this.disconnected = true; this.onDisconnect.emit(); },
    postMessage: message => messages.push(message)
  };
  chrome.runtime.onConnect.emit(port);
  return port;
}

function beginWaiting() {
  const parsed = new URL(tabs.at(-1).url);
  assert.equal(parsed.pathname, "/src/resolving/resolving.html");
  const params = new URLSearchParams(parsed.hash.slice(1));
  const port = connect("selection", parsed.href);
  port.onMessage.emit({ type: "resolve", text: params.get("text"), until: Number(params.get("until")) });
  return port;
}

async function setup(settings = {}, enabled = false) {
  tabs.length = 0;
  providerAllowed = enabled;
  await local.set({
    tmdbToken: enabled ? placeholder : null,
    settings: { ...DEFAULTS, tmdbEnabled: enabled, ...settings }
  });
  await setImmediate();
}

test("registers and removes the selection menu, and honors global disable", async () => {
  await setup();
  chrome.runtime.onInstalled.emit();
  await setImmediate();
  assert.equal(local.accessLevel, "TRUSTED_CONTEXTS");
  assert.deepEqual(menu.get("open-letterboxd").contexts, ["selection"]);
  await local.set({ settings: { ...DEFAULTS, enabled: false } });
  choose("Interstellar");
  await setImmediate();
  assert.equal(menu.size, 0);
  assert.deepEqual(tabs, []);
});

test("opens one destination and respects search mode, provider disable and the current tab preference", async () => {
  await setup({ newTab: false });
  choose("https://www.imdb.com/title/tt0816692/");
  await setImmediate();
  assert.deepEqual(tabs, [{ url: "https://letterboxd.com/imdb/tt0816692", tabId: 11, operation: "update" }]);
  await setup({ menuMode: "search" });
  choose("tt0816692");
  await setImmediate();
  assert.deepEqual(tabs, [{ url: "https://letterboxd.com/search/films/tt0816692/", windowId: 4, operation: "create" }]);
  await setup();
  choose(" A Viagem de Chihiro ");
  await setImmediate();
  assert.equal(tabs[0].url, "https://letterboxd.com/search/films/A%20Viagem%20de%20Chihiro/");
});

test("rejects foreign senders and exposes only settings to Google", async () => {
  await setup({}, true);
  const external = connect("google", "https://outside.test/search?q=Interstellar");
  assert.equal(external.disconnected, true);
  const google = connect("google", "https://www.google.com/search?q=Interstellar");
  await setImmediate();
  assert.equal(google.messages[0].type, "settings");
  assert.equal(JSON.stringify(google.messages).includes(placeholder), false);
  const callback = () => assert.fail("A content script cannot read the token state");
  assert.deepEqual(chrome.runtime.onMessage.emit(
    { type: "tmdbState" }, google.sender, callback
  ), [undefined]);
  google.disconnect();
});

test("resolves a title in one waiting tab and reuses the cached identity", async context => {
  await setup({}, true);
  let requests = 0;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requests++;
    assert.equal(options.headers.Authorization, `Bearer ${placeholder}`);
    return Response.json({
      page: 1, total_pages: 1,
      results: [{ id: 1, title: "Interstellar", original_title: "Interstellar", release_date: "2014-11-05" }]
    });
  });
  choose("Interstellar (2014)");
  await setImmediate();
  assert.equal(tabs.length, 1);
  const first = beginWaiting();
  await setImmediate();
  assert.equal(first.messages[0].result.url, "https://letterboxd.com/tmdb/1");
  assert.equal(first.messages[0].result.status, "confirmedIdentity");
  first.disconnect();
  choose("Interstellar (2014)");
  await setImmediate();
  const second = beginWaiting();
  await setImmediate();
  assert.equal(second.messages[0].result.strategy, "cache");
  assert.equal(second.messages[0].result.fallback, "https://letterboxd.com/search/films/Interstellar%20(2014)/");
  assert.equal(requests, 1);
  assert.equal(tabs.length, 2);
  second.disconnect();
});

test("cancels the provider when the waiting tab closes and drops the response", async context => {
  await setup({}, true);
  let signal;
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  choose("Oldboy");
  await setImmediate();
  const waiting = beginWaiting();
  await setImmediate();
  assert.equal(signal.aborted, false);
  waiting.disconnect();
  await setImmediate();
  assert.equal(signal.aborted, true);
  assert.deepEqual(waiting.messages, []);
  assert.equal(tabs.length, 1);
});

test("cancels an active resolution immediately when the context menu is disabled", async context => {
  await setup({}, true);
  let signal;
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  choose("Oldboy");
  await setImmediate();
  const waiting = beginWaiting();
  await setImmediate();
  await local.set({ settings: { ...DEFAULTS, contextMenu: false, tmdbEnabled: true } });
  await setImmediate();
  assert.equal(signal.aborted, true);
  assert.deepEqual(waiting.messages, [{ type: "canceled" }]);
  assert.equal(menu.size, 0);
  waiting.disconnect();
});
