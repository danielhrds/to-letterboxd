import { browserMessages, messagesFor } from "../core/messages.js";
import { readSettings, SETTINGS_KEY } from "../core/settings.js";
import { filmLink, redirectUrl, searchUrl } from "../core/urls.js";
import { localize } from "../ui/localize.js";

const status = document.getElementById("status");
const link = document.getElementById("fallback");
const params = new URLSearchParams(location.hash.slice(1));
const text = params.get("text");
const until = Math.min(Number(params.get("until")), Date.now() + 5000);
const fallback = searchUrl(text);
let messages = browserMessages();
localize(messages);
history.replaceState(null, "", location.pathname);

void chrome.storage.local.get(SETTINGS_KEY).then(async data => {
  const settings = readSettings(data[SETTINGS_KEY]);
  document.documentElement.dataset.theme = settings.theme;
  messages = await messagesFor(settings.language);
  localize(messages);
}).catch(() => {});

let port;
let timer;
let reconnect;
let finished = false;

function showCanceled() {
  status.dataset.message = "resolutionCanceled";
  status.textContent = messages.get("resolutionCanceled");
}

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
        showCanceled();
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
  showCanceled();
}
