import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const chrome = process.env.TO_LETTERBOXD_CHROME;
const extensionPath = process.env.TO_LETTERBOXD_EXTENSION_PATH || fileURLToPath(new URL("../", import.meta.url));
const fixture = new URL("./fixtures/google-film.html", import.meta.url);

async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await delay(70);
  } while (Date.now() < end);
  assert.fail("Chrome did not reach the expected state");
}

async function openChrome(context) {
  const temp = await realpath(tmpdir());
  const profile = await mkdtemp(join(temp, "to-letterboxd-chrome-"));
  const browser = spawn(chrome, [
    "--headless", "--disable-gpu", "--disable-background-networking", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profile}`, "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map();
  let receiver = () => {};
  let seq = 0;
  let buffer = "";
  let errors = "";
  browser.stderr.setEncoding("utf8").on("data", chunk => { errors = (errors + chunk).slice(-1500); });
  function fail(error) {
    for (const wait of pending.values()) wait.reject(error);
    pending.clear();
  }
  browser.on("error", fail);
  const closed = new Promise(resolve => browser.once("close", code => {
    fail(new Error(`Chrome exited (${code}). ${errors}`));
    resolve();
  }));
  browser.stdio[3].on("error", fail);
  browser.stdio[4].setEncoding("utf8").on("data", data => {
    buffer += data;
    for (let end = buffer.indexOf("\0"); end !== -1; end = buffer.indexOf("\0")) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const wait = pending.get(message.id);
      if (!wait) {
        receiver(message);
      } else {
        pending.delete(message.id);
        if (message.error) wait.reject(new Error(`${wait.method}: ${message.error.message}`));
        else wait.resolve(message.result);
      }
    }
  });
  async function send(method, params = {}, sessionId) {
    const id = ++seq;
    const result = new Promise((resolve, reject) => pending.set(id, { method, resolve, reject }));
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    const timeout = AbortSignal.timeout(10000);
    const deadline = new Promise((_, reject) => timeout.addEventListener("abort", () =>
      reject(new Error(`Chrome timed out: ${method}. ${errors}`)), { once: true }));
    try {
      return await Promise.race([result, deadline]);
    } finally {
      pending.delete(id);
    }
  }
  context.after(async () => {
    if (browser.exitCode === null) {
      void send("Browser.close").catch(() => {});
      if (!await Promise.race([closed.then(() => true), delay(1000, false)])) browser.kill();
    }
    await closed;
    const resolved = await realpath(profile);
    if (dirname(resolved) === temp && resolved.startsWith(join(temp, "to-letterboxd-chrome-"))) {
      await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
  });
  return { send, onEvent: callback => { receiver = callback; } };
}

async function openPage(send) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  return {
    sessionId,
    activate: () => send("Target.activateTarget", { targetId }),
    navigate: url => send("Page.navigate", { url }, sessionId),
    async value(expression) {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
  };
}

test("installs in Chrome and updates Google controls across settings and result changes", {
  skip: chrome ? false : "Set TO_LETTERBOXD_CHROME to a Chrome executable", timeout: 40000
}, async context => {
  const { send, onEvent } = await openChrome(context);
  const { id } = await send("Extensions.loadUnpacked", { path: extensionPath });
  const origin = `chrome-extension://${id}`;
  const google = await openPage(send);
  const popup = await openPage(send);
  const html = await readFile(fixture, "utf8");
  const fakeGoogle = "https://www.google.com/search?q=Interstellar";
  const regularHtml = html.replace(/<aside id="rhs">[\s\S]+?<\/aside>/, "");
  const movieHtml = html.replace(
    '<aside id="rhs">',
    '<div id="secondary"></div><aside id="rhs">'
  );
  const errors = [];
  onEvent(event => {
    if (event.method === "Runtime.exceptionThrown") errors.push(event.params.exceptionDetails.text);
    if (event.method !== "Fetch.requestPaused") return;
    const body = Buffer.from(event.params.request.url.includes("q=regular") ? regularHtml : movieHtml).toString("base64");
    void send("Fetch.fulfillRequest", {
      requestId: event.params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
      body
    }, event.sessionId).catch(error => errors.push(error.message));
  });
  await send("Runtime.enable", {}, google.sessionId);
  await send("Runtime.enable", {}, popup.sessionId);
  await send("Emulation.setDeviceMetricsOverride", {
    width: 420, height: 600, deviceScaleFactor: 1, mobile: false
  }, popup.sessionId);
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://www.google.com/search*", resourceType: "Document" }] }, google.sessionId);
  await popup.navigate(`${origin}/src/popup/popup.html`);
  await until(() => popup.value("document.querySelector('#settings input[name=googlePanel]')?.checked"));
  assert.equal(await popup.value("document.title"), "To Letterboxd");
  assert.equal(await popup.value("document.getElementById('tmdb-state').textContent"), "TMDB is not configured.");
  assert.equal(await popup.value("document.querySelector('[name=enabled]') === null"), true);
  assert.equal(await popup.value("document.querySelector('#advanced summary').textContent"), "TMDB and cache");
  assert.equal(await popup.value("document.querySelector('#token').type"), "password");
  assert.equal(await popup.value("document.querySelector('#get-token').pathname"), "/settings/api");
  assert.equal(await popup.value("document.querySelector('[name=persistentCache]').checked"), false);
  await popup.value("document.querySelector('#advanced').open = true");
  const popupLayout = await popup.value(`({
    overflow: document.documentElement.scrollWidth > innerWidth,
    padding: getComputedStyle(document.body).paddingRight,
    tokenWidth: document.querySelector('#token').getBoundingClientRect().width
  })`);
  assert.equal(popupLayout.overflow, false);
  assert.equal(popupLayout.padding, "22px");
  assert.ok(popupLayout.tokenWidth > 320);
  const menuExists = () => popup.value("chrome.contextMenus.update('open-letterboxd', {visible: true}).then(() => true, () => false)");
  await until(menuExists);
  await google.navigate(fakeGoogle);
  await google.activate();
  const links = type => google.value(`[...document.querySelectorAll('[data-to-letterboxd="${type}"] a')].map(a => a.href)`);
  try {
    await until(async () => (await links("panel")).length === 2);
  } catch {
    assert.fail(JSON.stringify({
      page: await google.value("({ url: location.href, visibility: document.visibilityState, title: document.title })"),
      panel: await links("panel"),
      imdb: await links("imdb"),
      errors
    }));
  }
  assert.deepEqual(await links("imdb"), ["https://letterboxd.com/imdb/tt0816692", "https://letterboxd.com/imdb/tt0364569"]);
  assert.deepEqual(await links("result"), ["https://letterboxd.com/tmdb/157336"]);
  assert.deepEqual(await links("panel"), ["https://letterboxd.com/tmdb/157336", "https://letterboxd.com/search/films/Interstellar%202014/"]);
  assert.equal(await google.value("document.querySelectorAll('#rso h3').length"), 4);

  await google.value(`
    const item = document.createElement('div');
    const anchor = document.createElement('a');
    const heading = document.createElement('h3');
    heading.textContent = 'Interstellar (2014) directed by Christopher Nolan • Reviews, film + cast • Letterboxd';
    anchor.href = 'https://letterboxd.com/film/interstellar/';
    item.append(anchor);
    anchor.append(heading);
    document.querySelector('#rso').append(item);
  `);
  await until(async () => (await links("result")).length === 0);
  assert.deepEqual(await links("panel"), ["https://letterboxd.com/film/interstellar/"]);
  assert.equal((await links("imdb")).length, 2);

  await popup.value("document.querySelector('input[name=googleImdb]').click()");
  await until(async () => (await links("imdb")).length === 0);
  assert.equal((await links("panel")).length, 1);
  await popup.value("document.querySelector('input[name=newTab]').click()");
  await until(() => google.value("document.querySelector('[data-to-letterboxd=panel] a')?.target === ''"));
  await popup.value(`
    const theme = document.querySelector('select[name=theme]');
    theme.value = 'dark';
    theme.dispatchEvent(new Event('change', { bubbles: true }));
  `);
  await until(() => google.value("document.querySelector('[data-to-letterboxd=panel]')?.dataset.theme === 'dark'"));
  await popup.value("document.querySelector('input[name=contextMenu]').click()");
  await until(async () => !await menuExists());
  assert.equal((await links("panel")).length, 1);
  await popup.value("document.querySelector('input[name=googlePanel]').click()");
  await until(async () => (await links("panel")).length === 0);
  await popup.value("document.querySelector('input[name=googlePanel]').click()");
  await until(async () => (await links("panel")).length === 1);
  await popup.value("document.querySelector('input[name=contextMenu]').click()");
  await popup.value("document.querySelector('input[name=googleImdb]').click()");
  await until(async () => (await links("imdb")).length === 2);
  await google.navigate("https://www.google.com/search?q=regular");
  await until(async () => (await links("imdb")).length === 2 && (await links("panel")).length === 0);
  assert.equal((await links("result")).length, 0);
  await until(menuExists);
  assert.deepEqual(errors, []);
});
