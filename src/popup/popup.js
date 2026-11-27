import { browserMessages, messagesFor } from "../core/messages.js";
import { DEFAULTS, readSettings, SETTINGS_KEY, TMDB_PERMISSION, TOKEN_KEY } from "../core/settings.js";
import { validToken } from "../core/tmdb.js";
import { localize } from "../ui/localize.js";

const form = document.getElementById("settings");
const controls = form.elements;
const token = document.getElementById("token");
const tmdbState = document.getElementById("tmdb-state");
const settingsState = document.getElementById("settings-state");
const save = document.getElementById("save-token");
const test = document.getElementById("test-token");
const remove = document.getElementById("remove-token");
const restore = document.getElementById("restore");
const clear = document.getElementById("clear-cache");
let messages = browserMessages();
let languagePreference = "auto";
let tmdbStateKey = "";
let settingsStateKey = "";
let settings = { ...DEFAULTS };
let configured = false;
let hasToken = false;
let busy = false;
let configurationRequest = 0;
let settingsQueue = Promise.resolve();

localize(messages);
document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;
form.addEventListener("submit", event => event.preventDefault());

function report(state) {
  tmdbStateKey = state;
  tmdbState.textContent = messages.get(state);
}

function reportSettings(state) {
  settingsStateKey = state;
  settingsState.textContent = messages.get(state);
  settingsState.hidden = !state;
}

function reportConfiguration() {
  if (!configured) return report(hasToken ? "invalidToken" : "notConfigured");
  report(settings.tmdbEnabled ? "configured" : "tmdbDisabled");
}

function render() {
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === "boolean") controls[key].checked = value;
    else controls[key].value = value;
  }
  document.documentElement.dataset.theme = settings.theme;
  controls.tmdbEnabled.checked = settings.tmdbEnabled && configured;
  controls.tmdbEnabled.disabled = busy || !configured;
  token.disabled = save.disabled = test.disabled = busy;
  remove.disabled = busy || !hasToken;
  if (languagePreference !== settings.language) {
    const preference = settings.language;
    languagePreference = preference;
    void messagesFor(preference).then(localized => {
      if (settings.language !== preference) return;
      messages = localized;
      localize(messages);
      report(tmdbStateKey);
      reportSettings(settingsStateKey);
    });
  }
}

async function refreshConfiguration(reportState = false) {
  const request = ++configurationRequest;
  try {
    const values = await chrome.storage.local.get([SETTINGS_KEY, TOKEN_KEY]);
    if (request !== configurationRequest) return;
    const next = readSettings(values[SETTINGS_KEY]);
    const storedToken = values[TOKEN_KEY];
    const nextConfigured = validToken(storedToken);
    const changed = next.tmdbEnabled !== settings.tmdbEnabled ||
      nextConfigured !== configured || Boolean(storedToken) !== hasToken;
    settings = next;
    configured = nextConfigured;
    hasToken = Boolean(storedToken);
    if (!busy && (reportState || changed)) reportConfiguration();
    render();
  } catch {
    if (request === configurationRequest) report("unavailable");
  }
}

function storeSettings(patch, replace = false) {
  const operation = settingsQueue.then(async () => {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    settings = replace ? { ...DEFAULTS } : { ...readSettings(data[SETTINGS_KEY]), ...patch };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    render();
  });
  settingsQueue = operation.catch(() => reportSettings("unavailable"));
  return operation;
}

async function tmdbAction(type, askPermission) {
  const entered = token.value.trim();
  if (busy) return;
  if (type === "saveToken" && !entered) return report("enterToken");
  if (type === "testToken" && !entered && !configured) return report("notConfigured");
  busy = true;
  render();
  report("checking");
  try {
    if (askPermission && !await chrome.permissions.request(TMDB_PERMISSION)) {
      report("permissionDenied");
      return;
    }
    const result = await chrome.runtime.sendMessage({ type, ...(entered && askPermission && { token: entered }) });
    if ((result.state === "connected" && type === "saveToken") ||
        (result.state === "notConfigured" && type === "removeToken")) {
      token.value = "";
      await refreshConfiguration();
    }
    report(result.state);
  } catch {
    report("unavailable");
  } finally {
    busy = false;
    render();
  }
}

form.addEventListener("change", async event => {
  const control = event.target;
  if (!(control.name in DEFAULTS)) return;
  const value = typeof DEFAULTS[control.name] === "boolean" ? control.checked : control.value;
  try {
    if (control.name === "tmdbEnabled" && value && !await chrome.permissions.request(TMDB_PERMISSION)) {
      render();
      return report("permissionDenied");
    }
    await storeSettings({ [control.name]: value });
    reportSettings("");
    if (control.name === "tmdbEnabled") report(value ? "configured" : "tmdbDisabled");
  } catch {
    reportSettings("unavailable");
    render();
  }
});

save.addEventListener("click", () => tmdbAction("saveToken", true));
test.addEventListener("click", () => tmdbAction("testToken", true));
remove.addEventListener("click", () => tmdbAction("removeToken", false));
restore.addEventListener("click", async () => {
  try {
    await storeSettings({}, true);
    reportSettings("restored");
    reportConfiguration();
  } catch {}
});
clear.addEventListener("click", async () => {
  try {
    const result = await chrome.runtime.sendMessage({ type: "clearCache" });
    reportSettings(result.state);
  } catch {
    reportSettings("unavailable");
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || (!changes[SETTINGS_KEY] && !changes[TOKEN_KEY])) return;
  void refreshConfiguration(Boolean(changes[TOKEN_KEY]));
});

await refreshConfiguration(true);
