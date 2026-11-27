import { cleanText, filmYear, normalizeTitle, parseSelection, yearFromDate } from "../core/film-input.js";
import { filmLink, isGoogleSearch, redirectUrl, searchUrl } from "../core/urls.js";

const OWN = "[data-to-letterboxd]";
const PANEL = '.kp-wholepage, .knowledge-panel, [data-attrid="kc:/film/film:knowledge panel"], #rhs, #kp-wp-tab-overview';
const MOVIE = '[itemscope][itemtype$="/Movie"]';
const DIRECTOR = '[data-attrid="kc:/film/film:director"], [itemprop="director"]';
const RELEASE = '[data-attrid="kc:/film/film:release date"], [itemprop="datePublished"]';
const HEADING = '[data-attrid="title"], [itemprop="name"], h1, [role="heading"]';

const msg = (key, value) => chrome.i18n.getMessage(key, value);
const text = (node, limit) => cleanText(node?.textContent, limit);
const own = node => node?.nodeType === 1 && node.closest(OWN);
const attrText = node => node?.getAttribute("content") || node?.getAttribute("datetime") || text(node);

function webResults() {
  const root = document.querySelector('#rso, #search, main[role="main"], main');
  if (!root) return [];
  return [...root.querySelectorAll("a[href]")].flatMap(anchor => {
    if (own(anchor) || anchor.closest(PANEL) || !anchor.querySelector("h3, [role=heading][aria-level='3']")) return [];
    const ids = filmLink(anchor.href, location.href);
    return [{ anchor, ids }];
  });
}

function typeIsMovie(node) {
  return [node?.["@type"]].flat().some(type => /^(?:https?:\/\/schema\.org\/)?Movie$/.test(type ?? ""));
}

function structuredMovie() {
  const movies = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    if (script.textContent.length > 250000) continue;
    try {
      const data = JSON.parse(script.textContent);
      const roots = (Array.isArray(data) ? data : [data]).flatMap(item =>
        [item, item?.mainEntity, ...(Array.isArray(item?.["@graph"]) ? item["@graph"] : [])]);
      movies.push(...roots.filter(typeIsMovie));
    } catch {}
  }
  return movies.length === 1 ? movies[0] : null;
}

function yearIn(value) {
  return filmYear(String(value ?? "").match(/\b(18[789]\d|19\d\d|20\d\d|21\d\d)\b/)?.[1]);
}

function combineLinks(urls) {
  const links = urls.map(url => filmLink(url, location.href)).filter(Boolean);
  const result = {};
  for (const key of ["canonicalUrl", "imdbId", "tmdbId"]) {
    const values = [...new Set(links.map(link => link[key]).filter(Boolean))];
    if (values.length > 1) return { conflictingIds: true };
    if (values.length === 1) result[key] = values[0];
  }
  return result;
}

function metadata(movie, preferredTitle) {
  const directorItems = [movie?.director].flat();
  const names = [movie?.name, ...[movie?.alternateName].flat()].map(name => cleanText(name)).filter(Boolean);
  return {
    title: preferredTitle || names[0],
    originalTitle: names.find(name => normalizeTitle(name) !== normalizeTitle(preferredTitle || names[0])),
    year: yearFromDate(movie?.datePublished),
    director: directorItems.length === 1 ? cleanText(directorItems[0]?.name) : "",
    ...combineLinks([movie?.url, ...[movie?.sameAs].flat()].filter(url => typeof url === "string"))
  };
}

function filmPanel(movie) {
  for (const panel of document.querySelectorAll(`${PANEL}, ${MOVIE}`)) {
    const heading = panel.querySelector(HEADING);
    const headingData = parseSelection(text(heading, 180));
    const title = headingData.title;
    if (!title || panel.querySelector('[data-attrid^="kc:/tv/"], [itemtype$="/TVSeries"]')) continue;
    const descriptor = text(panel.querySelector('[data-attrid="subtitle"], [data-attrid="type"]'), 150);
    if (/\b(tv series|television series|série de televisão|série de tv|temporadas?|seasons?)\b/i.test(descriptor)) continue;
    const directors = [...panel.querySelectorAll(DIRECTOR)].map(node =>
      text(node.querySelector('[itemprop="name"], a') ?? node, 120).replace(/^(?:directors?|direç[ãa]o|diretores?)\s*:\s*/i, ""));
    const director = directors.length === 1 ? directors[0] : "";
    const year = yearIn(attrText(panel.querySelector(RELEASE))) || yearIn(descriptor) || headingData.year;
    const linkedMovie = [movie?.name, ...[movie?.alternateName].flat()]
      .some(name => name && normalizeTitle(name) === normalizeTitle(title));
    const filmEvidence = panel.matches(MOVIE) || panel.querySelector('[data-attrid^="kc:/film/film:"]') ||
      linkedMovie || (director && year && /\b\d+\s*(?:h\b|min\b|m\b)/i.test(descriptor));
    if (!filmEvidence) continue;
    const data = linkedMovie ? metadata(movie, title) : {};
    const sourceLinks = [...panel.querySelectorAll("a[href]")].filter(anchor =>
      !own(anchor) && !anchor.closest('[aria-roledescription="carousel"]') &&
      (anchor.matches('[itemprop="sameAs"]') || /^(IMDb|TMDB|Letterboxd)$/i.test(text(anchor))));
    const links = combineLinks([
      ...sourceLinks.map(anchor => anchor.href),
      data.canonicalUrl,
      data.imdbId && redirectUrl({ imdbId: data.imdbId }),
      data.tmdbId && redirectUrl({ tmdbId: data.tmdbId })
    ].filter(Boolean));
    const movieYear = data.year || year;
    const conflictingIds = links.conflictingIds || data.conflictingIds ||
      Boolean(year && data.year && Math.abs(year - data.year) > 1);
    const anchor = heading.closest("a, button") ?? heading;
    return {
      anchor,
      film: { ...data, ...links, title, year: movieYear, director: data.director || director, conflictingIds }
    };
  }
  return null;
}

function pageFilm(movie, panel) {
  if (panel) return panel.film;
  const query = parseSelection(new URL(location.href).searchParams.get("q"));
  const tags = /\s+(?:film|movie|filme)$/i;
  const requested = normalizeTitle(query.title?.replace(tags, ""));
  const film = metadata(movie);
  if (requested && [film.title, film.originalTitle].some(title => normalizeTitle(title) === requested) &&
      (!query.year || query.year === film.year)) return film;
  return null;
}

function existingFilm(results, film) {
  const names = [film.title, film.originalTitle].map(normalizeTitle).filter(Boolean);
  const linkedById = results.some(({ ids }) => ids?.source === "letterboxd" &&
    ((ids.imdbId && ids.imdbId === film.imdbId) || (ids.tmdbId && ids.tmdbId === film.tmdbId)));
  const similar = results.flatMap(({ anchor, ids }) => {
    if (!ids?.canonicalUrl) return [];
    if (ids.canonicalUrl === film.canonicalUrl) return [{ url: ids.canonicalUrl, year: film.year }];
    const label = text(anchor.querySelector("h3, [role=heading]"));
    const titled = label.match(/^(.+?\(\d{4}\))\s*(?:directed by|dirigid[oa] por|[•|–—-])\s+.+$/iu)?.[1];
    const candidate = parseSelection(titled ?? label.replace(/\s*[•|–—-]\s*Letterboxd\s*$/i, ""));
    if (names.includes(normalizeTitle(candidate.title)) &&
        (!candidate.year || !film.year || candidate.year === film.year)) {
      return [{ url: ids.canonicalUrl, year: candidate.year }];
    }
    return [];
  });
  const confirmed = [...new Set(similar.filter(item => film.year && item.year === film.year)
    .map(item => item.url))];
  return {
    duplicate: linkedById || similar.length > 0,
    canonicalUrl: confirmed.length === 1 ? confirmed[0] : null
  };
}

function link(url, label, newTab, withIcon = true) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noopener noreferrer";
  if (newTab) anchor.target = "_blank";
  if (withIcon) {
    const icon = document.createElement("img");
    icon.width = icon.height = 16;
    icon.alt = "";
    icon.src = chrome.runtime.getURL("assets/icons/16.png");
    anchor.append(icon);
  }
  anchor.append(document.createTextNode(label));
  return anchor;
}

export function start() {
  let settings;
  let port;
  let timer;
  let reconnectTimer;
  let pending;
  let sequence = 0;
  let page = location.href;
  let theme;
  const widgets = new Map();

  function send(message) {
    try {
      port?.postMessage(message);
    } catch {}
  }

  function cancelResolution() {
    if (pending && !pending.done) send({ type: "cancel" });
    pending = null;
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      render();
    }, 70);
  }

  function connect() {
    if (port || !isGoogleSearch(location.href) || document.hidden) return;
    try {
      port = chrome.runtime.connect({ name: "google" });
    } catch {
      return;
    }
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      if (pending && !pending.done) cancelResolution();
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 500);
    });
    port.onMessage.addListener(message => {
      if (message.type === "settings") {
        if (message.invalidate || !settings || settings.tmdbEnabled !== message.settings.tmdbEnabled) {
          cancelResolution();
        }
        settings = message.settings;
        schedule();
      }
      if (message.type === "invalidate") {
        cancelResolution();
        schedule();
      }
      if (message.type === "result" && pending?.id === message.id) {
        pending.done = true;
        pending.result = message.result;
        schedule();
      }
    });
  }

  function setWidget(keep, key, anchor, type, details, build) {
    if (!anchor?.isConnected) return;
    keep.add(key);
    const signature = JSON.stringify([type, details, settings.newTab, theme]);
    const old = widgets.get(key);
    if (old?.anchor === anchor && old.node.isConnected && old.signature === signature) return;
    old?.node.remove();
    const node = document.createElement(type === "imdb" ? "span" : "div");
    node.dataset.toLetterboxd = type;
    node.dataset.theme = theme;
    build(node);
    if (type === "result") anchor.before(node);
    else anchor.after(node);
    widgets.set(key, { node, signature, anchor });
  }

  function render() {
    const keep = new Set();
    if (page !== location.href) {
      page = location.href;
      cancelResolution();
    }
    if (settings && isGoogleSearch(page)) {
      theme = settings.theme;
      if (theme === "auto") {
        const color = getComputedStyle(document.body).backgroundColor;
        const parts = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
        if (parts) {
          theme = 0.2126 * Number(parts[1]) + 0.7152 * Number(parts[2]) + 0.0722 * Number(parts[3]) > 145
            ? "light" : "dark";
        }
      }
      const results = webResults();
      if (settings.googleImdb) {
        for (const { anchor, ids } of results) {
          if (ids?.source !== "imdb") continue;
          const url = redirectUrl({ imdbId: ids.imdbId });
          setWidget(keep, anchor, anchor, "imdb", url, node =>
            node.append(link(url, msg("viewOnLetterboxd"), settings.newTab)));
        }
      }
      if (settings.googlePanel || settings.googleResult) {
        const movie = structuredMovie();
        const panel = filmPanel(movie);
        const film = pageFilm(movie, panel);
        if (film) {
          const existing = existingFilm(results, film);
          const canonical = film.canonicalUrl || existing.canonicalUrl;
          const fallback = searchUrl([film.title, film.year].filter(Boolean).join(" "));
          let direct = film.conflictingIds ? null : canonical || redirectUrl(film);
          let year = film.year;
          if (!direct && !film.conflictingIds && settings.tmdbEnabled &&
              ((panel && settings.googlePanel) || (!existing.duplicate && settings.googleResult))) {
            const input = { ...film, locale: document.documentElement.lang || chrome.i18n.getUILanguage() };
            const key = JSON.stringify(input);
            if (port && pending?.key !== key) {
              cancelResolution();
              pending = { key, id: ++sequence };
              send({ type: "resolve", id: pending.id, film: input });
            }
            const resolved = pending?.result;
            if (resolved?.status === "confirmedIdentity") {
              direct = redirectUrl(resolved);
              year ||= resolved.year;
            }
          } else {
            cancelResolution();
          }
          if (panel && settings.googlePanel) {
            setWidget(keep, "panel", panel.anchor, "panel", [direct, fallback], node => {
              node.append(link(direct || fallback, msg(direct ? "menuOpen" : "searchOnLetterboxd"), settings.newTab));
              if (direct && !canonical) node.append(link(fallback, msg("searchInstead"), settings.newTab, false));
            });
          }
          const firstResult = results[0]?.anchor.closest(".g, [data-snhf], [data-hveid]") ?? results[0]?.anchor;
          if (settings.googleResult && firstResult && !existing.duplicate) {
            const directResult = direct && year;
            const displayTitle = [film.title, year ? `(${year})` : null].filter(Boolean).join(" ");
            const label = msg(directResult ? "resultTitle" : "resultSearchTitle", displayTitle);
            setWidget(keep, "result", firstResult, "result", [directResult ? direct : fallback, label], node => {
              const heading = document.createElement("div");
              heading.append(link(directResult ? direct : fallback, label, settings.newTab));
              const description = document.createElement("p");
              description.textContent = msg(directResult ? "resultDescription" : "resultSearchDescription");
              const attribution = document.createElement("small");
              attribution.textContent = msg("addedByExtension");
              node.append(heading, description, attribution);
            });
          }
        } else {
          cancelResolution();
        }
      } else {
        cancelResolution();
      }
    } else {
      cancelResolution();
    }
    for (const [key, widget] of widgets) {
      if (keep.has(key)) continue;
      widget.node.remove();
      widgets.delete(key);
    }
  }

  if (!isGoogleSearch(location.href)) return;
  const observer = new MutationObserver(records => {
    if (records.some(record => !own(record.target) && (record.type !== "childList" ||
        [...record.addedNodes, ...record.removedNodes].some(node => !own(node))))) {
      connect();
      schedule();
    }
  });
  observer.observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["href", "data-attrid", "content", "datetime"]
  });
  document.addEventListener("visibilitychange", connect);
  window.addEventListener("popstate", schedule);
  window.navigation?.addEventListener("currententrychange", schedule);
  connect();
}
