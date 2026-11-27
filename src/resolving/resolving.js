import { readSettings, SETTINGS_KEY } from "../core/settings.js";
import { filmLink, redirectUrl, searchUrl } from "../core/urls.js";
import { localize } from "../ui/localize.js";

localize();
const status = document.getElementById("status");
const link = document.getElementById("fallback");
const params = new URLSearchParams(location.hash.slice(1));
const text = params.get("text");
const until = Math.min(Number(params.get("until")), Date.now() + 5000);
const fallback = searchUrl(text);
history.replaceState(null, "", location.pathname);

void chrome.storage.local.get(SETTINGS_KEY).then(data => {
  document.documentElement.dataset.theme = readSettings(data[SETTINGS_KEY]).theme;
}).catch(() => {});

let port;
let timer;
let reconnect;
let finished = false;

function stop() {
  finished = true;
  clearTimeout(timer);
  clearTimeout(reconnect);
  port?.disconnect();
}

function go(url) {
  if (finished) return;
  stop();
  location.replace(url);
}

function connect() {
  if (finished) return;
  if (Date.now() >= until) return go(fallback);
  try {
    port = chrome.runtime.connect({ name: "selection" });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!finished) reconnect = setTimeout(connect, 150);
    });
    port.onMessage.addListener(message => {
      if (finished) return;
      if (message.type === "canceled") {
        stop();
        status.textContent = chrome.i18n.getMessage("resolutionCanceled");
      }
      if (message.type === "result") {
        const destination = filmLink(message.result?.url);
        go(Date.now() < until && destination
          ? destination.canonicalUrl || redirectUrl(destination) || fallback : fallback);
      }
    });
    port.postMessage({ type: "resolve", text, until });
  } catch {
    if (!finished) reconnect = setTimeout(connect, 150);
  }
}

if (fallback && Number.isFinite(until)) {
  link.href = fallback;
  link.hidden = false;
  link.addEventListener("click", event => {
    if (!finished) {
      event.preventDefault();
      go(fallback);
    }
  });
  window.addEventListener("pagehide", stop);
  timer = setTimeout(() => go(fallback), Math.max(0, until - Date.now()));
  connect();
} else {
  status.textContent = chrome.i18n.getMessage("resolutionCanceled");
}
