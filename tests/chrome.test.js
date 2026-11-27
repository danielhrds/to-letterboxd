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
  const splitFilm = await readFile(new URL("./fixtures/google-split-film.html", import.meta.url), "utf8");
  const fakeGoogle = "https://www.google.com/search?q=Interstellar";
  const regularHtml = html.replace(/<aside id="rhs">[\s\S]+?<\/aside>/, "");
  const movieHtml = html.replace(
    '<aside id="rhs">',
    '<div id="secondary"></div><aside id="rhs">'
  );
  const otherPages = {
    regular: regularHtml,
    aviator: regularHtml.replace("Interstellar (2014) - IMDb", "The Aviator's Wife (1981)")
      .replace("tt0816692", "tt0080728")
      .replace('<div id="rso"', '<div role="region" aria-label="AI Overview">A 1981 film and a 2013 novel</div><div id="rso"'),
    "split-film": splitFilm,
    "split-series": splitFilm.replace("1976 ‧ Crime/Noir ‧ 1h 54m", "1976 ‧ Série de TV ‧ 54 min"),
    "film-without-sidebar": splitFilm.replace(/<aside id="rhs"[\s\S]+?<\/aside>/, "")
      .replaceAll("Taxi Driver: Motorista de Táxi", "Interstellar")
      .replaceAll("Taxi Driver", "Interstellar").replaceAll("1976", "2014").replaceAll("tt0075314", "tt0816692"),
    "cast-only": movieHtml.replace('<h2 data-attrid="title">Interstellar</h2>', "")
      .replace('id="cast-heading" role="heading" aria-level="2"', 'id="cast-heading" role="heading" aria-level="1"'),
    "panel-imdb": movieHtml.replace('<a href="https://www.themoviedb.org/movie/157336-interstellar">TMDB</a>', ""),
    "film-header": movieHtml.replace('<aside id="rhs">', "<aside>").replace('class="kp-wholepage"', 'id="film-details"'),
    "tmdb-result": regularHtml.replace(/(<\/div>\s*<\/main>)/, `
      <article><h3><a href="https://www.themoviedb.org/movie/157336-interstellar">Interstellar (2014) — TMDB</a></h3></article>
      $1`)
  };
  const errors = [];
  const requestedPosters = new Set();
  onEvent(event => {
    if (event.method === "Runtime.exceptionThrown") {
      const { exception, text } = event.params.exceptionDetails;
      errors.push(exception?.description ?? text);
    }
    if (event.method !== "Fetch.requestPaused") return;
    const url = new URL(event.params.request.url);
    const image = url.hostname === "image.tmdb.org";
    const broken = image && url.pathname.endsWith("/broken-poster.jpg");
    if (image) requestedPosters.add(url.pathname);
    const body = image
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="185" height="278"><rect width="185" height="278" fill="red"/></svg>'
      : otherPages[url.searchParams.get("fixture")] ?? movieHtml;
    void send("Fetch.fulfillRequest", {
      requestId: event.params.requestId,
      responseCode: broken ? 404 : 200,
      responseHeaders: [{ name: "Content-Type", value: image ? "image/svg+xml" : "text/html; charset=utf-8" }],
      body: Buffer.from(broken ? "" : body).toString("base64")
    }, event.sessionId).catch(error => errors.push(error.message));
  });
  await send("Runtime.enable", {}, google.sessionId);
  await send("Page.enable", {}, google.sessionId);
  await send("Runtime.enable", {}, popup.sessionId);
  await send("Emulation.setDeviceMetricsOverride", {
    width: 420, height: 600, deviceScaleFactor: 1, mobile: false
  }, popup.sessionId);
  await send("Fetch.enable", { patterns: [
    { urlPattern: "https://www.google.com/search*", resourceType: "Document" },
    { urlPattern: "https://image.tmdb.org/t/p/*", resourceType: "Image" }
  ] }, google.sessionId);
  await popup.navigate(`${origin}/src/popup/popup.html`);
  await until(() => popup.value("document.querySelector('#settings input[name=googlePanel]')?.checked"));
  assert.equal(await popup.value("document.title"), "To Letterboxd");
  assert.equal(await popup.value("document.getElementById('tmdb-state').textContent"), "TMDB is not configured.");
  assert.equal(await popup.value("document.querySelector('[name=enabled]') === null"), true);
  assert.equal(await popup.value("document.querySelector('#advanced summary').textContent"), "TMDB and cache");
  assert.equal(await popup.value("document.querySelector('#token').type"), "password");
  assert.equal(await popup.value("document.querySelector('#get-token').pathname"), "/settings/api");
  assert.equal(await popup.value("document.querySelector('[name=persistentCache]').checked"), false);
  assert.equal(await popup.value("document.querySelector('[name=language]').value"), "auto");
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
  const placement = await google.value(`(() => {
    const results = document.querySelector('#rso');
    const card = document.querySelector('[data-to-letterboxd=result]');
    const header = document.querySelector('#film-heading');
    const panel = document.querySelector('[data-to-letterboxd=panel]');
    return {
      shortcutAfterResult: document.querySelector('#first-imdb').nextElementSibling?.dataset.toLetterboxd,
      shortcutInTransformedWrapper: Boolean(document.querySelector('#flipped-imdb [data-to-letterboxd]')),
      cardAtHead: results.firstElementChild === card,
      cardWidth: card.getBoundingClientRect().width,
      resultsWidth: results.getBoundingClientRect().width,
      panelAfterTitle: header.nextElementSibling === panel,
      panelGap: panel.getBoundingClientRect().top - header.getBoundingClientRect().bottom
    };
  })()`);
  assert.equal(placement.shortcutAfterResult, "imdb");
  assert.equal(placement.shortcutInTransformedWrapper, false);
  assert.equal(placement.cardAtHead, true);
  assert.equal(placement.cardWidth, placement.resultsWidth);
  assert.equal(placement.panelAfterTitle, true);
  assert.ok(placement.panelGap >= 12);
  assert.equal(await google.value("document.querySelector('[data-to-letterboxd=result] .tl-result-provider strong').textContent"),
    "Letterboxd");
  const resultStyle = await google.value(`(() => {
    const card = document.querySelector('[data-to-letterboxd=result]');
    const name = card.querySelector('.tl-result-source strong');
    const address = card.querySelector('.tl-result-address');
    return {
      separateLines: address.getBoundingClientRect().top >= name.getBoundingClientRect().bottom,
      background: getComputedStyle(card).backgroundColor,
      titleColor: getComputedStyle(card.querySelector('a')).color,
      font: getComputedStyle(card).fontFamily
    };
  })()`);
  assert.equal(resultStyle.separateLines, true);
  assert.equal(resultStyle.background, "rgba(0, 0, 0, 0)");
  assert.equal(resultStyle.titleColor, "rgb(23, 65, 135)");
  assert.match(resultStyle.font, /Arial/);
  assert.equal(await google.value("Boolean(document.querySelector('.tl-film-poster'))"), false);
  await google.value(`(() => {
    const img = document.createElement('img');
    img.id = 'native-poster';
    img.alt = 'Interstellar poster';
    img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABgCAYAAACtxXToAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAADCSURBVHhe7dAhAQAwEIDAT7FIy/P9zeapAOIMkjl3n9kw2DSAwaYBDDYNYLBpAINNAxhsGsBg0wAGmwYw2DSAwaYBDDYNYLBpAINNAxhsGsBg0wAGmwYw2DSAwaYBDDYNYLBpAINNAxhsGsBg0wAGmwYw2DSAwaYBDDYNYLBpAINNAxhsGsBg0wAGmwYw2DSAwaYBDDYNYLBpAINNAxhsGsBg0wAGmwYw2DSAwaYBDDYNYLBpAINNAxhsGsBg0wAGmw+o+AqGowP+qgAAAABJRU5ErkJggg==';
    document.querySelector('.kp-wholepage').append(img);
  })()`);
  await until(() => google.value(`(() => {
    const poster = document.querySelector('.tl-film-poster');
    const native = document.querySelector('#native-poster');
    const bounds = poster?.getBoundingClientRect();
    return poster?.naturalWidth > 0 && poster.currentSrc === native.currentSrc &&
      bounds.width === 76 && bounds.height === 112;
  })()`));
  assert.equal(await google.value(`(() => {
    const panel = document.querySelector('[data-to-letterboxd=panel]');
    return panel.firstElementChild.getBoundingClientRect().width === panel.getBoundingClientRect().width;
  })()`), true);
  const selectLanguage = language => popup.value(`(() => {
    const select = document.querySelector('select[name=language]');
    select.value = ${JSON.stringify(language)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await selectLanguage("pt-BR");
  await until(() => popup.value("document.documentElement.lang === 'pt-BR'"));
  assert.equal(await popup.value("document.querySelector('#advanced summary').textContent"), "TMDB e cache");
  assert.equal(await popup.value("document.querySelector('#tmdb-state').textContent"), "TMDB ainda não configurado.");
  await until(() => google.value(
    "document.querySelector('[data-to-letterboxd=imdb] a')?.textContent === 'Ver no Letterboxd'"));
  assert.equal(await google.value("document.querySelector('[data-to-letterboxd=result] a').textContent"),
    "Interstellar (2014) — Letterboxd");
  assert.equal(await google.value("document.querySelector('.tl-result-address').textContent"), "letterboxd.com › Filme");
  await popup.navigate(`${origin}/src/popup/privacy.html`);
  await until(() => popup.value("document.title === 'Privacidade' && document.documentElement.lang === 'pt-BR'"));
  await popup.navigate(`${origin}/src/resolving/resolving.html`);
  await until(() => popup.value("document.querySelector('#status')?.textContent === 'Busca de filme cancelada'"));
  await popup.navigate(`${origin}/src/popup/popup.html`);
  await until(() => popup.value("document.documentElement.lang === 'pt-BR'"));
  assert.equal(await popup.value("document.querySelector('select[name=language]').value"), "pt-BR");
  await selectLanguage("en");
  await until(() => google.value(
    "document.querySelector('[data-to-letterboxd=imdb] a')?.textContent === 'View on Letterboxd'"));

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
  await until(async () => (await links("result"))[0] === "https://letterboxd.com/film/interstellar/");
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
  assert.equal(await popup.value("getComputedStyle(document.documentElement).backgroundColor"), "rgb(20, 24, 28)");
  assert.equal(await google.value(
    "getComputedStyle(document.querySelector('[data-to-letterboxd=panel] a')).color"), "rgb(232, 234, 237)");
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
  const { currentIndex, entries } = await send("Page.getNavigationHistory", {}, google.sessionId);
  const originalPage = entries[currentIndex].id;
  await google.value(`
    window.restoredFromCache = false;
    window.addEventListener('pageshow', event => { window.restoredFromCache = event.persisted; });
  `);
  await google.navigate("https://www.google.com/search?q=regular&fixture=regular");
  await until(async () => (await links("imdb")).length === 2 && (await links("panel")).length === 0);
  assert.equal((await links("result")).length, 0);

  await popup.value("document.querySelector('input[name=googleImdb]').click()");
  await until(async () => (await links("imdb")).length === 0);
  await send("Page.navigateToHistoryEntry", { entryId: originalPage }, google.sessionId);
  await until(() => google.value("window.restoredFromCache === true"));
  await until(async () => (await links("imdb")).length === 0);
  assert.equal((await links("panel")).length, 1);
  await popup.value("document.querySelector('input[name=googleImdb]').click()");
  await until(async () => (await links("imdb")).length === 2);

  await google.navigate("https://www.google.com/search?q=Interstellar&fixture=cast-only");
  await until(async () => await google.value("location.search.includes('fixture=cast-only')") &&
    (await links("result"))[0] === "https://letterboxd.com/imdb/tt0816692");
  assert.deepEqual(await links("panel"), []);
  assert.equal((await links("imdb")).length, 2);
  await google.navigate("https://www.google.com/search?q=Interstellar&fixture=panel-imdb");
  await until(async () => (await links("result"))[0] === "https://letterboxd.com/imdb/tt0816692");
  assert.equal((await links("panel"))[0], "https://letterboxd.com/imdb/tt0816692");
  await google.navigate("https://www.google.com/search?q=Interstellar&fixture=film-header");
  await until(async () => (await links("panel"))[0] === "https://letterboxd.com/tmdb/157336");
  assert.equal((await links("result"))[0], "https://letterboxd.com/tmdb/157336");
  await google.navigate("https://www.google.com/search?q=Interstellar+%282014%29+film&fixture=tmdb-result");
  await until(async () => (await links("result"))[0] === "https://letterboxd.com/tmdb/157336");
  assert.deepEqual(await links("panel"), []);

  await google.navigate("https://www.google.com/search?q=Interstellar+filme+2014&fixture=regular");
  await until(async () => (await links("result"))[0] === "https://letterboxd.com/imdb/tt0816692");
  assert.deepEqual(await links("panel"), []);
  await google.navigate("https://www.google.com/search?q=Interstellar+filme+2010&fixture=regular");
  await until(async () => await google.value("location.search.includes('2010')") && (await links("imdb")).length === 2);
  assert.deepEqual(await links("result"), []);
  await google.navigate("https://www.google.com/search?q=Interstellar&fixture=film-without-sidebar");
  await until(async () => (await links("result"))[0] === "https://letterboxd.com/imdb/tt0816692");
  assert.equal((await links("panel"))[0], "https://letterboxd.com/imdb/tt0816692");

  const taxi = "https://letterboxd.com/imdb/tt0075314";
  await google.navigate("https://www.google.com/search?q=Taxi+Driver+1976+filme&fixture=split-film");
  await until(async () => (await links("result"))[0] === taxi);
  assert.equal((await links("panel"))[0], taxi);
  assert.deepEqual(await links("imdb"), [taxi]);
  assert.equal(await google.value("document.querySelector('#film-heading').nextElementSibling?.dataset.toLetterboxd"), "panel");
  assert.equal(await google.value("document.querySelector('#film-web-result').firstElementChild?.dataset.toLetterboxd"), "result");
  assert.equal(await google.value("document.querySelector('[data-to-letterboxd=result] a').textContent"),
    "Taxi Driver: Motorista de Táxi (1976) — Letterboxd");
  assert.equal(await google.value("document.querySelector('[data-to-letterboxd=result] p') === null"), true);
  assert.equal(await google.value(`(() => {
    const row = document.querySelector('[data-to-letterboxd=imdb]');
    const button = row.querySelector('a');
    const rowBounds = row.getBoundingClientRect();
    const buttonBounds = button.getBoundingClientRect();
    const iconBounds = button.querySelector('img').getBoundingClientRect();
    const label = document.createRange();
    label.selectNode(button.lastChild);
    const textBounds = label.getBoundingClientRect();
    return Math.abs(rowBounds.left - buttonBounds.left) < 1 &&
      Math.abs(buttonBounds.left + buttonBounds.right - iconBounds.left - textBounds.right) < 1 &&
      Math.abs(buttonBounds.top + buttonBounds.bottom - iconBounds.top - iconBounds.bottom) < 1 &&
      Math.abs(buttonBounds.top + buttonBounds.bottom - textBounds.top - textBounds.bottom) < 3;
  })()`), true);
  await google.value(`(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 80;
    const img = document.createElement('img');
    img.id = 'imdb-thumbnail';
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.src = canvas.toDataURL();
    document.querySelector('#film-web-result').append(img);
  })()`);
  const usesGooglePoster = () => google.value(`(() => {
    const poster = document.querySelector('.tl-film-poster');
    return poster?.naturalWidth === 80 && poster.currentSrc === document.querySelector('#imdb-thumbnail').currentSrc;
  })()`);
  await until(usesGooglePoster);
  assert.equal(await google.value("getComputedStyle(document.querySelector('.tl-film-poster')).objectFit"), "scale-down");

  const worker = await until(async () => (await send("Target.getTargets")).targetInfos.find(target =>
    target.type === "service_worker" && target.url.startsWith(origin)));
  const { sessionId: workerSession } = await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  const inWorker = async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true }, workerSession);
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
  };
  await inWorker(`(() => {
    const networkFetch = globalThis.fetch;
    chrome.permissions.contains = async () => true;
    globalThis.fetch = (input, options) => {
      const url = new URL(input);
      if (url.hostname !== 'api.themoviedb.org') return networkFetch(input, options);
      if (url.pathname === '/3/find/tt0080728') {
        return Promise.resolve(Response.json({ movie_results: [{ id: 1, poster_path: globalThis.testPosterPath }] }));
      }
      if (url.pathname !== '/3/find/tt0075314') throw new Error('Unexpected TMDB movie lookup');
      return Promise.resolve(Response.json({ movie_results: [{ id: 103, poster_path: globalThis.testPosterPath }] }));
    };
  })()`);
  const setTmdb = posterPath => inWorker(`(async () => {
    globalThis.testPosterPath = ${JSON.stringify(posterPath)};
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...settings, tmdbEnabled: Boolean(globalThis.testPosterPath) },
      tmdbToken: globalThis.testPosterPath ? 'test-token-placeholder-' + globalThis.testPosterPath.slice(1) : null
    });
  })()`);
  await google.activate();
  await setTmdb("/priority-poster.jpg");
  await until(() => google.value(`(() => {
    const poster = document.querySelector('.tl-film-poster');
    return poster?.naturalWidth === 185 && poster.currentSrc === 'https://image.tmdb.org/t/p/w185/priority-poster.jpg';
  })()`));
  await setTmdb("/broken-poster.jpg");
  await until(async () => requestedPosters.has("/t/p/w185/broken-poster.jpg") && await usesGooglePoster());
  await setTmdb(null);

  const aviator = "https://letterboxd.com/imdb/tt0080728";
  const aviatorCanonical = "https://letterboxd.com/film/the-aviators-wife/";
  await google.navigate("https://www.google.com/search?q=aviators+wife&fixture=aviator");
  await until(async () => (await links("result"))[0] === aviator);
  assert.ok((await links("imdb")).includes(aviator));
  assert.deepEqual(await links("panel"), []);
  assert.equal(await google.value("document.querySelector('[data-to-letterboxd=result] a').textContent"),
    "The Aviator's Wife (1981) — Letterboxd");
  await google.value(`(() => {
    const result = document.createElement('article');
    result.id = 'native-letterboxd';
    const anchor = document.createElement('a');
    const heading = document.createElement('h3');
    anchor.href = 'https://letterboxd.com/film/the-aviators-wife/';
    heading.textContent = "The Aviator's Wife (1981) directed by Éric Rohmer • Reviews, film + cast • Letterboxd";
    anchor.append(heading);
    result.append(anchor);
    document.querySelector('#rso').append(result);
  })()`);
  await until(async () => (await links("result"))[0] === aviatorCanonical);
  assert.equal(await google.value("document.querySelectorAll('[data-to-letterboxd=result]').length"), 1);
  assert.equal(await google.value("document.querySelector('#native-letterboxd a').href"), aviatorCanonical);
  const filmInfo = await popup.value(`(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.tabs.sendMessage(tab.id, { type: 'googleSelectionFilm' }, { frameId: 0 });
  })()`);
  assert.equal(filmInfo.imdbId, "tt0080728");
  assert.equal(filmInfo.year, 1981);
  assert.equal(filmInfo.canonicalUrl, aviatorCanonical);
  await setTmdb("/aviator-poster.jpg");
  await until(() => google.value(
    "document.querySelector('.tl-film-poster')?.currentSrc === 'https://image.tmdb.org/t/p/w185/aviator-poster.jpg'"));
  assert.deepEqual(await links("result"), [aviatorCanonical]);
  await google.value(`(() => {
    const item = document.createElement('article');
    item.id = 'ambiguous-imdb';
    const anchor = document.createElement('a');
    const heading = document.createElement('h3');
    anchor.href = 'https://www.imdb.com/title/tt0364569/';
    heading.textContent = "The Aviator's Wife (2003) — IMDb";
    anchor.append(heading);
    item.append(anchor);
    document.querySelector('#rso').append(item);
  })()`);
  await until(async () => (await links("result")).length === 0);
  await setTmdb(null);
  await google.value("document.querySelector('#ambiguous-imdb').remove(); document.querySelector('#first-imdb').remove()");
  await until(async () => (await links("result"))[0] === aviatorCanonical);

  await google.navigate("https://www.google.com/search?q=Taxi+Driver&fixture=split-series");
  await until(async () => await google.value("location.search.includes('fixture=split-series')") &&
    (await links("imdb")).length === 1);
  assert.deepEqual(await links("panel"), []);
  assert.deepEqual(await links("result"), []);
  await until(menuExists);
  assert.deepEqual(errors, []);
});
