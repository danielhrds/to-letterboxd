import { DEFAULTS, readSettings, SETTINGS_KEY, TMDB_PERMISSION } from "../core/settings.js";
import { localize } from "../ui/localize.js";

localize();

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
const message = key => chrome.i18n.getMessage(key);
let settings = { ...DEFAULTS };
let configured = false;
let busy = false;
let settingsQueue = Promise.resolve();

document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;
form.addEventListener("submit", event => event.preventDefault());

function report(state) {
  tmdbState.textContent = message(state);
}

function reportSettings(state) {
  settingsState.textContent = message(state);
  settingsState.hidden = !state;
}

function render() {
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === "boolean") controls[key].checked = value;
    else controls[key].value = value;
  }
  document.documentElement.dataset.theme = settings.theme;
  controls.tmdbEnabled.disabled = busy || !configured;
  token.disabled = save.disabled = test.disabled = busy;
  remove.disabled = busy || !configured;
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
    if (result.state === "connected" && type === "saveToken") {
      configured = true;
      token.value = "";
    }
    if (result.state === "notConfigured" && type === "removeToken") {
      configured = false;
      token.value = "";
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
    report(configured ? "tmdbDisabled" : "notConfigured");
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
  if (area !== "local" || !changes[SETTINGS_KEY]) return;
  settings = readSettings(changes[SETTINGS_KEY].newValue);
  render();
});

try {
  const [values, state] = await Promise.all([
    chrome.storage.local.get(SETTINGS_KEY),
    chrome.runtime.sendMessage({ type: "tmdbState" })
  ]);
  settings = readSettings(values[SETTINGS_KEY]);
  configured = state.configured === true;
  report(configured ? (settings.tmdbEnabled ? "configured" : "tmdbDisabled") : "notConfigured");
} catch {
  report("unavailable");
}
render();
