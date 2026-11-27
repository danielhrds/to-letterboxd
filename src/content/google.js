import { cleanText, filmYear, normalizeTitle, parseSelection, yearFromDate } from "../core/film-input.js";
import { messagesFor } from "../core/messages.js";
import { filmLink, isGoogleSearch, redirectUrl, searchUrl } from "../core/urls.js";

const OWN = "[data-to-letterboxd]";
const FILM_PANEL = '.kp-wholepage, .knowledge-panel, [data-attrid="kc:/film/film:knowledge panel"]';
const PANEL = `${FILM_PANEL}, #rhs, #kp-wp-tab-overview`;
const MOVIE = '[itemscope][itemtype$="/Movie"]';
const DIRECTOR = '[data-attrid="kc:/film/film:director"], [itemprop="director"]';
const RELEASE = '[data-attrid="kc:/film/film:release date"], [itemprop="datePublished"]';
const FILM_TITLE = '[data-attrid="title"], [data-attrid="kc:/film/film:title"]';
const FILM_DETAILS = '[data-attrid^="kc:/film/film:"]:not([data-attrid="kc:/film/film:title"])';
const MAIN_HEADING = 'h1, [role="heading"][aria-level="1"]';
const RESULT_HEADING = 'h3, [role="heading"][aria-level="3"]';
const EXCLUDED = 'dialog, [role="dialog"], [hidden], [aria-hidden="true"], [aria-roledescription="carousel"]';

const text = (node, limit) => cleanText(node?.textContent, limit);
const own = node => node?.nodeType === 1 && node.closest(OWN);
const attrText = node => node?.getAttribute("content") || node?.getAttribute("datetime") || text(node);

function resultsRoot() {
  return document.getElementById("rso") ?? document.getElementById("search") ??
    document.querySelector('main, [role="main"]');
}

function webResults(root) {
  if (!root) return [];
  const seen = new Set();
  return [...root.querySelectorAll(RESULT_HEADING)].flatMap(heading => {
    const anchor = heading.closest("a[href]") ?? heading.querySelector("a[href]");
    if (!anchor || seen.has(anchor) || own(anchor) || anchor.closest(`${PANEL}, ${EXCLUDED}`)) return [];
    seen.add(anchor);
    const ids = filmLink(anchor.href, location.href);
    return [{ anchor, heading, ids }];
  });
}

function outsideInlineLayout(anchor, boundary) {
  for (let parent = anchor.parentElement; parent && parent !== boundary; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (parent.matches("a, button") || style.display.startsWith("inline") ||
        (style.display === "flex" && style.flexDirection.startsWith("row")) ||
        style.transform !== "none" || style.rotate !== "none" || style.scale !== "none") {
      anchor = parent;
    }
  }
  return anchor;
}

function resultAnchor(anchor, heading, root) {
  const group = anchor.closest(".g, [data-snhf], article");
  if (group && group !== root && root.contains(group)) return outsideInlineLayout(group, root);
  let block = anchor.contains(heading) ? anchor : heading;
  while (block.parentElement && block.parentElement !== root &&
      block.parentElement.querySelectorAll(RESULT_HEADING).length === 1) {
    block = block.parentElement;
  }
  return outsideInlineLayout(block, root);
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

function searchIdentity() {
  const raw = new URL(location.href).searchParams.get("q") ?? "";
  const tags = /\s+(?:film|movie|filme)$/i;
  const parsed = parseSelection(raw);
  const withoutTag = parseSelection(raw.replace(tags, ""));
  return {
    year: parsed.year || withoutTag.year,
    titles: new Set([parsed.title, parsed.title?.replace(tags, ""), withoutTag.title]
      .map(normalizeTitle).filter(Boolean))
  };
}

function panelCandidates() {
  const panels = new Set([
    ...document.querySelectorAll(`${FILM_PANEL}, ${MOVIE}`),
    ...document.querySelectorAll("#rhs, #kp-wp-tab-overview")
  ]);
  for (const heading of document.querySelectorAll(FILM_TITLE)) {
    if (heading.closest(`${PANEL}, ${MOVIE}, #rso, ${EXCLUDED}`)) continue;
    let ancestor = heading.parentElement;
    for (let depth = 0; ancestor && depth < 4 && !ancestor.matches("body, main, #search"); depth++) {
      if (ancestor.querySelector(FILM_DETAILS)) {
        panels.add(ancestor);
        break;
      }
      ancestor = ancestor.parentElement;
    }
  }
  return panels;
}

function filmPanel(movie, query) {
  const movieNames = [movie?.name, ...[movie?.alternateName].flat()].map(normalizeTitle).filter(Boolean);
  for (const panel of panelCandidates()) {
    const name = panel.matches(MOVIE) ? [...panel.querySelectorAll('[itemprop="name"]')]
      .find(node => node.closest("[itemscope]") === panel && !node.closest(EXCLUDED)) : null;
    const expectedTitles = new Set([...query.titles, ...movieNames, normalizeTitle(attrText(name))]);
    const explicit = [...panel.querySelectorAll(FILM_TITLE)].filter(node => !node.closest(EXCLUDED));
    const headings = explicit.length ? explicit : [...panel.querySelectorAll(MAIN_HEADING)]
      .filter(node => !node.closest(EXCLUDED));
    const matches = headings.filter(node => {
      const title = normalizeTitle(parseSelection(text(node)).title);
      return title && expectedTitles.has(title);
    });
    const heading = explicit.length === 1 ? explicit[0] : matches.length === 1 ? matches[0] : null;
    const titleElement = heading ?? (name && !name.matches("meta") ? name : null);
    const headingData = parseSelection(attrText(name || titleElement));
    const title = cleanText(headingData.title, 180);
    if (!title || panel.querySelector('[data-attrid^="kc:/tv/"], [itemtype$="/TVSeries"]')) continue;
    const descriptor = text(panel.querySelector('[data-attrid="subtitle"], [data-attrid="type"]'), 150);
    if (/\b(tv series|television series|série de televisão|série de tv|temporadas?|seasons?)\b/i.test(descriptor)) continue;
    const directors = [...panel.querySelectorAll(DIRECTOR)].map(node =>
      text(node.querySelector('[itemprop="name"], a') ?? node, 120).replace(/^(?:directors?|direç[ãa]o|diretores?)\s*:\s*/i, ""));
    const director = directors.length === 1 ? directors[0] : "";
    const year = yearIn(attrText(panel.querySelector(RELEASE))) || yearIn(descriptor) || headingData.year;
    const linkedMovie = movieNames.includes(normalizeTitle(title));
    const filmEvidence = panel.matches(MOVIE) || panel.querySelector(FILM_DETAILS) ||
      linkedMovie || (director && year && /\b\d+\s*(?:h\b|min\b|m\b)/i.test(descriptor));
    if (!filmEvidence) continue;
    const data = linkedMovie ? metadata(movie, title) : {};
    const sourceLinks = [...panel.querySelectorAll("a[href]")].filter(anchor =>
      !own(anchor) && !anchor.closest(EXCLUDED) &&
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
    const anchor = titleElement && outsideInlineLayout(titleElement, panel);
    return {
      anchor,
      film: { ...data, ...links, title, year: movieYear, director: data.director || director, conflictingIds }
    };
  }
  return null;
}

function resultIdentity(heading) {
  const label = text(heading).replace(/\s*[•|–—-]\s*(?:IMDb|TMDB|The Movie Database(?: \(TMDB\))?)$/i, "");
  return parseSelection(label);
}

function pageFilm(movie, panel, results, query) {
  if (panel) {
    const film = panel.film;
    if (!film.year || film.conflictingIds || film.canonicalUrl || film.imdbId || film.tmdbId) return film;
    const titles = [film.title, film.originalTitle].map(normalizeTitle).filter(Boolean);
    const matches = new Set();
    for (const { heading, ids } of results) {
      if (ids?.source !== "imdb") continue;
      const candidate = resultIdentity(heading);
      if (candidate.year === film.year && titles.includes(normalizeTitle(candidate.title))) matches.add(ids.imdbId);
    }
    return matches.size === 1 ? { ...film, imdbId: matches.values().next().value } : film;
  }
  if (!query.titles.size) return null;
  const film = metadata(movie);
  if ([film.title, film.originalTitle].some(title => query.titles.has(normalizeTitle(title))) &&
      (!query.year || query.year === film.year)) return film;
  const matches = new Map();
  for (const { heading, ids } of results) {
    if (ids?.source !== "tmdb") continue;
    const candidate = resultIdentity(heading);
    if (!query.titles.has(normalizeTitle(candidate.title)) || (query.year && query.year !== candidate.year)) continue;
    matches.set(ids.tmdbId, { title: candidate.title, year: candidate.year, tmdbId: ids.tmdbId });
  }
  return matches.size === 1 ? matches.values().next().value : null;
}

function existingFilm(results, film) {
  const names = [film.title, film.originalTitle].map(normalizeTitle).filter(Boolean);
  const linkedById = results.some(({ ids }) => ids?.source === "letterboxd" &&
    ((ids.imdbId && ids.imdbId === film.imdbId) || (ids.tmdbId && ids.tmdbId === film.tmdbId)));
  const similar = results.flatMap(({ heading, ids }) => {
    if (!ids?.canonicalUrl) return [];
    if (ids.canonicalUrl === film.canonicalUrl) return [{ url: ids.canonicalUrl, year: film.year }];
    const label = text(heading);
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
  let messages;
  let timer;
  let pending;
  let settingsRequest = 0;
  let invalidateResults = false;
  let suspended = false;
  let page = location.href;
  let theme;
  const widgets = new Map();

  function cancelResolution() {
    const port = pending?.port;
    pending = null;
    port?.disconnect();
  }

  function schedule() {
    if (timer || suspended) return;
    timer = setTimeout(() => {
      timer = null;
      render();
    }, 70);
  }

  async function refreshSettings(invalidate = false) {
    if (suspended || !isGoogleSearch(location.href)) return;
    invalidateResults ||= invalidate;
    const request = ++settingsRequest;
    try {
      const next = await chrome.runtime.sendMessage({ type: "googleSettings" });
      if (!next || request !== settingsRequest) return;
      const localized = messages && settings?.language === next.language
        ? messages : await messagesFor(next.language);
      if (request !== settingsRequest) return;
      if (invalidateResults || settings?.tmdbEnabled !== next.tmdbEnabled) cancelResolution();
      invalidateResults = false;
      settings = next;
      messages = localized;
      schedule();
    } catch {}
  }

  function requestFilm(key, film) {
    const request = { key };
    pending = request;
    try {
      const port = chrome.runtime.connect({ name: "googleResolution" });
      request.port = port;
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        request.port = null;
      });
      port.onMessage.addListener(message => {
        if (pending !== request || message.type !== "result") return;
        request.result = message.result;
        request.port = null;
        port.disconnect();
        schedule();
      });
      port.postMessage({ type: "resolve", film });
    } catch {
      request.port?.disconnect();
      request.port = null;
    }
  }

  function setWidget(keep, key, anchor, type, details, build) {
    if (!anchor?.isConnected) return;
    keep.add(key);
    const signature = JSON.stringify([type, details, settings.newTab, theme, messages.language]);
    const old = widgets.get(key);
    const parent = type === "result" ? anchor : anchor.parentElement;
    if (old?.anchor === anchor && old.node.parentElement === parent && old.signature === signature) return;
    old?.node.remove();
    const node = document.createElement("div");
    node.dataset.toLetterboxd = type;
    node.dataset.theme = theme;
    node.lang = messages.language;
    build(node);
    if (type === "result") anchor.prepend(node);
    else anchor.after(node);
    widgets.set(key, { node, signature, anchor });
  }

  function render() {
    const keep = new Set();
    if (page !== location.href) {
      page = location.href;
      cancelResolution();
    }
    if (settings && messages && isGoogleSearch(page)) {
      const msg = messages.get;
      theme = settings.theme;
      if (theme === "auto") {
        const color = getComputedStyle(document.body).backgroundColor;
        const parts = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
        if (parts) {
          theme = 0.2126 * Number(parts[1]) + 0.7152 * Number(parts[2]) + 0.0722 * Number(parts[3]) > 145
            ? "light" : "dark";
        }
      }
      const root = resultsRoot();
      const results = webResults(root);
      if (settings.googleImdb) {
        const placements = new Map();
        for (const { anchor, heading, ids } of results) {
          if (ids?.source !== "imdb") continue;
          const url = redirectUrl({ imdbId: ids.imdbId });
          const placement = resultAnchor(anchor, heading, root);
          const shown = placements.get(placement) ?? new Set();
          if (shown.has(url)) continue;
          shown.add(url);
          placements.set(placement, shown);
          setWidget(keep, anchor, placement, "imdb", url, node =>
            node.append(link(url, msg("viewOnLetterboxd"), settings.newTab)));
        }
      }
      if (settings.googlePanel || settings.googleResult) {
        const movie = structuredMovie();
        const query = searchIdentity();
        const panel = filmPanel(movie, query);
        const film = pageFilm(movie, panel, results, query);
        if (film) {
          const existing = existingFilm(results, film);
          const canonical = film.canonicalUrl || existing.canonicalUrl;
          const fallback = searchUrl([film.title, film.year].filter(Boolean).join(" "));
          let direct = film.conflictingIds ? null : canonical || redirectUrl(film);
          let year = film.year;
          if (!direct && !film.conflictingIds && settings.tmdbEnabled &&
              ((panel?.anchor && settings.googlePanel) || (root && results.length && !existing.duplicate && settings.googleResult))) {
            const input = { ...film, locale: document.documentElement.lang || chrome.i18n.getUILanguage() };
            const key = JSON.stringify(input);
            if (pending?.key !== key) {
              cancelResolution();
              if (!document.hidden) requestFilm(key, input);
            }
            const resolved = pending?.result;
            if (resolved?.status === "confirmedIdentity") {
              direct = redirectUrl(resolved);
              year ||= resolved.year;
            }
          } else {
            cancelResolution();
          }
          if (panel?.anchor && settings.googlePanel) {
            setWidget(keep, "panel", panel.anchor, "panel", [direct, fallback], node => {
              node.append(link(direct || fallback, msg(direct ? "menuOpen" : "searchOnLetterboxd"), settings.newTab));
              if (direct && !canonical) node.append(link(fallback, msg("searchInstead"), settings.newTab, false));
            });
          }
          if (settings.googleResult && root && results.length && !existing.duplicate) {
            const directResult = direct && year;
            const displayTitle = [film.title, year ? `(${year})` : null].filter(Boolean).join(" ");
            const label = msg(directResult ? "resultTitle" : "resultSearchTitle", displayTitle);
            setWidget(keep, "result", root, "result", [directResult ? direct : fallback, label], node => {
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
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === "refreshGoogleSettings") {
      void refreshSettings(message.invalidate === true);
    }
  });
  const observer = new MutationObserver(records => {
    if (records.some(record => !own(record.target) && (record.type !== "childList" ||
        [...record.addedNodes, ...record.removedNodes].some(node => !own(node))))) {
      schedule();
    }
  });
  observer.observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["href", "data-attrid", "content", "datetime"]
  });
  document.addEventListener("visibilitychange", schedule);
  window.addEventListener("popstate", schedule);
  window.navigation?.addEventListener("currententrychange", schedule);
  window.addEventListener("pagehide", () => {
    suspended = true;
    settingsRequest++;
    clearTimeout(timer);
    timer = null;
    cancelResolution();
  });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    suspended = false;
    void refreshSettings();
  });
  void refreshSettings();
}
