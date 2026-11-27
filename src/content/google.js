import { cleanText, filmYear, normalizeTitle, parseSelection, yearFromDate } from "../core/film-input.js";
import { messagesFor } from "../core/messages.js";
import { filmLink, isGoogleSearch, redirectUrl, searchUrl } from "../core/urls.js";

const OWN = "[data-to-letterboxd]";
const SPLIT_PANEL = ".kp-wholepage-osrp";
const FILM_PANEL = `.kp-wholepage, ${SPLIT_PANEL}, .knowledge-panel, [data-attrid="kc:/film/film:knowledge panel"]`;
const PANEL = `${FILM_PANEL}, #rhs, #kp-wp-tab-overview`;
const MOVIE = '[itemscope][itemtype$="/Movie"]';
const DIRECTOR = '[data-attrid="kc:/film/film:director"], [itemprop="director"]';
const RELEASE = '[data-attrid="kc:/film/film:release date"], [data-attrid="kc:/film/film:theatrical region aware release date"], [itemprop="datePublished"]';
const FILM_TITLE = '[data-attrid="title"], [data-attrid="kc:/film/film:title"]';
const PANEL_SUBTITLE = '[data-attrid="subtitle"], [data-attrid="type"]';
const FILM_DETAILS = '[data-attrid^="kc:/film/film:"]:not([data-attrid="kc:/film/film:title"])';
const MAIN_HEADING = 'h1, [role="heading"][aria-level="1"]';
const RESULT_HEADING = 'h3, [role="heading"][aria-level="3"]';
const EXCLUDED = 'dialog, [role="dialog"], [hidden], [aria-hidden="true"], [aria-roledescription="carousel"]';
const SERIES = /\b(tv series|television series|série de televisão|série de tv|temporadas?|seasons?|episodes?|episódios?)\b/i;

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

function hasSingleResultHeading(element) {
  return [...element.querySelectorAll(RESULT_HEADING)].filter(heading => !own(heading)).length === 1;
}

function resultAnchor(anchor, heading, root) {
  const group = anchor.closest(".g, [data-snhf], article");
  if (group && group !== root && root.contains(group)) return outsideInlineLayout(group, root);
  let block = anchor.contains(heading) ? anchor : heading;
  while (block.parentElement && block.parentElement !== root &&
      hasSingleResultHeading(block.parentElement)) {
    block = block.parentElement;
  }
  return outsideInlineLayout(block, root);
}

function cardContainer(root, results) {
  if (!root.querySelector("#rhs")) return root;
  const first = results.find(({ anchor }) => anchor.closest("[data-snhf], .g, article")) ?? results[0];
  let slot = resultAnchor(first.anchor, first.heading, root);
  for (let parent = slot.parentElement; parent && parent !== root &&
      !parent.querySelector("#rhs") && hasSingleResultHeading(parent);
      parent = parent.parentElement) {
    if (getComputedStyle(parent).display !== "contents") slot = parent;
  }
  return slot.matches(`a, button, ${RESULT_HEADING}`) ? root : slot;
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
  const raw = (new URL(location.href).searchParams.get("q") ?? "").trim();
  const tags = /\s+(?:film|movie|filme)$/i;
  const parsed = parseSelection(raw);
  const stripped = raw.replace(tags, "");
  const withoutTag = parseSelection(stripped);
  const trimmedTitle = parsed.title?.replace(tags, "");
  const movieTitle = stripped !== raw ? withoutTag.title : trimmedTitle !== parsed.title ? trimmedTitle : "";
  return {
    title: parsed.title,
    year: parsed.year || withoutTag.year,
    movieTitle,
    titles: new Set([parsed.title, trimmedTitle, withoutTag.title]
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
      if (ancestor.querySelector(PANEL_SUBTITLE)) {
        const parent = ancestor.parentElement;
        panels.add(parent && !parent.matches("body, main, #search") ? parent : ancestor);
        break;
      }
      ancestor = ancestor.parentElement;
    }
  }
  return panels;
}

function splitPanelDetails(panel, year, runtime) {
  if (!panel.matches(SPLIT_PANEL) || !year || !runtime || panel.closest("#search, #rhs")) return null;
  const main = panel.closest('main, [role="main"]');
  const sidebar = main?.querySelector("#rhs");
  if (!sidebar?.querySelector(DIRECTOR)) return null;
  const sidebarYear = yearIn(attrText(sidebar.querySelector(RELEASE)));
  return sidebarYear && Math.abs(year - sidebarYear) > 1 ? null : { main, sidebar };
}

function headerImdbLinks(main, title) {
  const names = [title, title.split(/[:–—]/, 1)[0]].map(normalizeTitle).filter(Boolean);
  return [...main.querySelectorAll('a[href*="imdb.com"]')].flatMap(anchor => {
    if (anchor.closest(`#search, #rso, ${EXCLUDED}`) || filmLink(anchor.href)?.source !== "imdb") return [];
    const label = anchor.getAttribute("aria-label") ?? anchor.querySelector("[aria-label]")?.getAttribute("aria-label");
    const normalized = normalizeTitle(label);
    return normalized.endsWith(" imdb") && names.some(name => normalized.startsWith(`${name} `))
      ? [anchor.href] : [];
  });
}

function panelTitles(title, query) {
  const short = title.split(/[:–—]/u, 1)[0].trim();
  return short !== title && query.titles.has(normalizeTitle(short)) ? [title, short] : [title];
}

function filmPanel(movie, query, results) {
  const movieNames = [movie?.name, ...[movie?.alternateName].flat()].map(normalizeTitle).filter(Boolean);
  let matchesSeries = false;
  for (const panel of panelCandidates()) {
    const name = panel.matches(MOVIE) ? [...panel.querySelectorAll('[itemprop="name"]')]
      .find(node => node.closest("[itemscope]") === panel && !node.closest(EXCLUDED)) : null;
    const expectedTitles = new Set([...query.titles, ...movieNames, normalizeTitle(attrText(name))]);
    const explicit = [...panel.querySelectorAll(FILM_TITLE)].filter(node => !node.closest(EXCLUDED));
    const headingSelector = panel.matches(SPLIT_PANEL)
      ? MAIN_HEADING + ', h2, [role="heading"][aria-level="2"]' : MAIN_HEADING;
    const headings = explicit.length ? explicit : [...panel.querySelectorAll(headingSelector)]
      .filter(node => !node.closest(EXCLUDED));
    const matches = headings.filter(node => {
      const title = cleanText(parseSelection(text(node)).title);
      return title && panelTitles(title, query).some(name => expectedTitles.has(normalizeTitle(name)));
    });
    const heading = explicit.length === 1 ? explicit[0] : matches.length === 1 ? matches[0] : null;
    const titleElement = heading ?? (name && !name.matches("meta") ? name : null);
    const headingData = parseSelection(attrText(name || titleElement));
    const title = cleanText(headingData.title, 180);
    if (!title) continue;
    const descriptor = text(panel.querySelector(PANEL_SUBTITLE), 150);
    const year = yearIn(attrText(panel.querySelector(RELEASE))) || yearIn(descriptor) || headingData.year;
    const seriesSelector = '[data-attrid^="kc:/tv/"], [itemtype$="/TVSeries"]';
    if (SERIES.test(descriptor) || panel.matches(seriesSelector) || panel.querySelector(seriesSelector)) {
      const names = [title, title.split(/[:–—]/, 1)[0]].map(titleWithoutArticle);
      matchesSeries ||= (!query.year || !year || query.year === year) &&
        names.includes(titleWithoutArticle(query.movieTitle || query.title));
      continue;
    }
    const runtime = /\b\d+\s*(?:h\b|min\b|m\b)/i.test(descriptor);
    const split = splitPanelDetails(panel, year, runtime);
    const directors = [...(split?.sidebar ?? panel).querySelectorAll(DIRECTOR)].map(node =>
      text(node.querySelector('[itemprop="name"], a') ?? node, 120).replace(/^(?:directors?|direç[ãa]o|diretores?)\s*:\s*/i, ""));
    const director = directors.length === 1 ? directors[0] : "";
    const names = panelTitles(title, query);
    const normalizedNames = names.map(normalizeTitle);
    const linkedMovie = normalizedNames.some(name => movieNames.includes(name));
    const filmHeader = year && runtime && (panel.matches(SPLIT_PANEL) ||
      (titleElement?.matches(FILM_TITLE) && !panel.closest("#rso, #rhs")));
    const main = filmHeader && (split?.main ?? panel.closest('main, [role="main"]'));
    const headerLinks = main ? headerImdbLinks(main, title) : [];
    const matchingHeadline = filmHeader && (
      results.some(({ heading, ids }) => {
        if (ids?.source !== "imdb") return false;
        const candidate = resultIdentity(heading);
        return candidate.year === year && normalizedNames.includes(normalizeTitle(candidate.title));
      }) || letterboxdFilmResult(results, names, year)
    );
    const filmEvidence = panel.matches(MOVIE) || panel.querySelector(FILM_DETAILS) ||
      split || linkedMovie || headerLinks.length || matchingHeadline || (director && year && runtime);
    if (!filmEvidence) continue;
    const data = linkedMovie ? metadata(movie, title) : {};
    const sourceLinks = [...panel.querySelectorAll("a[href]")].filter(anchor =>
      !own(anchor) && !anchor.closest(EXCLUDED) &&
      (anchor.matches('[itemprop="sameAs"]') || /^(IMDb|TMDB|Letterboxd)$/i.test(text(anchor))));
    const links = combineLinks([
      ...sourceLinks.map(anchor => anchor.href),
      ...headerLinks,
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
      film: {
        ...data, ...links, title, originalTitle: data.originalTitle || names[1],
        year: movieYear, director: data.director || director, conflictingIds
      }
    };
  }
  return matchesSeries ? { matchesSeries } : null;
}

function resultIdentity(heading) {
  const label = text(heading).replace(/\s*[•|–—-]\s*(?:IMDb|TMDB|The Movie Database(?: \(TMDB\))?)$/i, "");
  return parseSelection(label);
}

const titleWithoutArticle = title => normalizeTitle(title).replace(/^the /, "");

function imdbFilmResult(results, query) {
  const title = titleWithoutArticle(query.movieTitle || query.title);
  if (!title) return null;
  const matches = new Map();
  for (const { anchor, heading, ids } of results) {
    if (ids?.source !== "imdb") continue;
    const candidate = resultIdentity(heading);
    if (!candidate.year || (query.year && query.year !== candidate.year) ||
        titleWithoutArticle(candidate.title) !== title) continue;
    const result = anchor.closest("[data-snhf], .g, article") ?? anchor;
    if (SERIES.test(text(result, 350))) continue;
    matches.set(ids.imdbId, { title: candidate.title, year: candidate.year, imdbId: ids.imdbId });
  }
  if (matches.size === 1) return matches.values().next().value;
  return matches.size > 1
    ? { title: query.movieTitle || query.title, year: query.year, conflictingIds: true } : null;
}

function pageFilm(movie, panel, results, query) {
  if (panel?.film) {
    const film = panel.film;
    if (!film.year || film.conflictingIds || film.tmdbId) return film;
    const titles = [film.title, film.originalTitle].map(normalizeTitle).filter(Boolean);
    const matches = new Map();
    for (const { heading, ids } of results) {
      if (ids?.source !== "imdb") continue;
      const candidate = resultIdentity(heading);
      if (candidate.year !== film.year) continue;
      if (film.imdbId ? ids.imdbId === film.imdbId : titles.includes(normalizeTitle(candidate.title))) {
        matches.set(ids.imdbId, candidate.title);
      }
    }
    if (matches.size !== 1) return film;
    const [imdbId, imdbTitle] = matches.entries().next().value;
    return { ...film, imdbId, originalTitle: film.originalTitle || imdbTitle };
  }
  if (!query.titles.size) return null;
  const film = metadata(movie);
  if ([film.title, film.originalTitle].some(title => query.titles.has(normalizeTitle(title))) &&
      (!query.year || query.year === film.year)) return film;
  if (panel?.matchesSeries) return null;
  const matches = new Map();
  for (const { heading, ids } of results) {
    if (ids?.source !== "tmdb") continue;
    const candidate = resultIdentity(heading);
    if (!query.titles.has(normalizeTitle(candidate.title)) || (query.year && query.year !== candidate.year)) continue;
    matches.set(ids.tmdbId, { title: candidate.title, year: candidate.year, tmdbId: ids.tmdbId });
  }
  if (matches.size === 1) return matches.values().next().value;
  if (matches.size) return null;
  const imdb = imdbFilmResult(results, query);
  if (imdb) return imdb.conflictingIds && !query.movieTitle ? null : imdb;
  return letterboxdFilmResult(results, [query.movieTitle || query.title], query.year);
}

function letterboxdFilmResult(results, titles, year) {
  const names = titles.map(titleWithoutArticle).filter(Boolean);
  const matches = new Map();
  for (const { heading, ids } of results) {
    if (!ids?.canonicalUrl) continue;
    const label = text(heading);
    const titled = label.match(/^(.+?\(\d{4}\))\s*(?:directed by|dirigid[oa] por|[•|–—-])\s+.+$/iu)?.[1];
    const candidate = parseSelection(titled ?? label.replace(/\s*[•|–—-]\s*Letterboxd\s*$/i, ""));
    if (candidate.year && (!year || candidate.year === year) && names.includes(titleWithoutArticle(candidate.title))) {
      matches.set(ids.canonicalUrl, { title: candidate.title, year: candidate.year, canonicalUrl: ids.canonicalUrl });
    }
  }
  return matches.size === 1 ? matches.values().next().value : null;
}

function canonicalFilmUrl(film, results) {
  return film.canonicalUrl || (film.year &&
    letterboxdFilmResult(results, [film.title, film.originalTitle], film.year)?.canonicalUrl);
}

function posterShape(image) {
  const { naturalWidth, naturalHeight } = image;
  return image.complete && naturalWidth >= 48 && naturalHeight >= 48 && naturalHeight >= naturalWidth * 0.9 &&
    naturalHeight <= naturalWidth * 2.5;
}

function posterSource(image) {
  if (!posterShape(image) || own(image) || !image.getClientRects().length ||
      image.closest('dialog, [role="dialog"], [hidden], [aria-roledescription="carousel"]')) return null;
  const source = image.currentSrc;
  if (!source || source.length > 500000) return null;
  if (/^data:image\/(?:png|jpeg|webp|gif|avif);base64,/i.test(source)) return source;
  try {
    const url = new URL(source);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port) return source;
  } catch {}
  return null;
}

function filmPoster(film, panel, results, root) {
  const titles = [film.title, film.originalTitle].map(normalizeTitle).filter(Boolean);
  const imageLabels = image => [cleanText(image.alt), cleanText(image.getAttribute("aria-label")),
    cleanText(image.parentElement?.closest("[aria-label]")?.getAttribute("aria-label"))].filter(Boolean);
  const generic = /^(?:pôster|poster|film poster|movie poster|thumbnail|miniatura)$/i;
  const matchesTitle = label => {
    const normalized = ` ${normalizeTitle(label)} `;
    return !/\b(trailer|teaser|cast|elenco)\b/i.test(label) &&
      titles.some(title => normalized.includes(` ${title} `));
  };
  let thumbnail;
  for (const { anchor, heading, ids } of results) {
    const match = (ids?.imdbId && ids.imdbId === film.imdbId) ||
      (ids?.tmdbId && ids.tmdbId === film.tmdbId) ||
      (ids?.canonicalUrl && ids.canonicalUrl === film.canonicalUrl);
    if (!match) continue;
    let group = resultAnchor(anchor, heading, root);
    while (group.parentElement && group.parentElement !== root && hasSingleResultHeading(group.parentElement)) {
      group = group.parentElement;
    }
    for (const image of group.querySelectorAll("img")) {
      const labels = imageLabels(image);
      if (labels.length && !labels.every(label => generic.test(label)) && !labels.some(matchesTitle)) continue;
      const source = posterSource(image);
      if (!source) continue;
      if (image.naturalHeight >= image.naturalWidth * 1.2) return source;
      thumbnail ??= source;
    }
  }

  const localPanel = panel?.anchor?.closest(PANEL);
  const main = panel?.anchor?.closest('main, [role="main"]');
  for (const area of new Set([localPanel, main])) {
    for (const image of area?.querySelectorAll("img") ?? []) {
      if ((area === main && image.closest("#rso")) || !imageLabels(image).some(matchesTitle)) continue;
      const source = posterSource(image);
      if (!source) continue;
      if (image.naturalHeight >= image.naturalWidth * 1.2) return source;
      thumbnail ??= source;
    }
  }
  return thumbnail ?? null;
}

function logo(size = 16) {
  const icon = document.createElement("img");
  icon.width = icon.height = size;
  icon.alt = "";
  icon.src = chrome.runtime.getURL("assets/icons/16.png");
  return icon;
}

function link(url, label, newTab, withIcon = true) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noopener noreferrer";
  if (newTab) anchor.target = "_blank";
  if (withIcon) anchor.append(logo());
  anchor.append(label);
  return anchor;
}

function panelLink(url, label, newTab) {
  const anchor = link(url, label, newTab);
  Object.assign(anchor.style, {
    inlineSize: "fit-content",
    minBlockSize: "30px",
    padding: "4px 10px",
    gap: "6px"
  });
  const arrow = document.createElement("span");
  arrow.className = "tl-panel-arrow";
  arrow.style.marginInlineStart = "0";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "↗";
  anchor.append(arrow);
  return anchor;
}

function resultCard(node, url, label, direct, { tmdbPoster, googlePoster }, msg, newTab) {
  const copy = document.createElement("div");
  copy.className = "tl-result-copy";
  const provider = document.createElement("div");
  provider.className = "tl-result-provider";
  const details = document.createElement("div");
  details.className = "tl-result-source";
  const name = document.createElement("strong");
  name.textContent = "Letterboxd";
  const address = document.createElement("div");
  address.className = "tl-result-address";
  address.textContent = msg(direct ? "resultFilmPath" : "resultSearchPath");
  details.append(name, address);
  provider.append(logo(), details);
  const heading = document.createElement("div");
  heading.className = "tl-result-heading";
  heading.setAttribute("role", "heading");
  heading.setAttribute("aria-level", "3");
  heading.textContent = label;
  copy.append(provider, heading);
  if (!direct) {
    const description = document.createElement("p");
    description.textContent = msg("resultSearchDescription");
    copy.append(description);
  }
  const attribution = document.createElement("small");
  attribution.textContent = msg("addedByExtension");
  copy.append(attribution);
  const cardLink = link(url, copy, newTab, false);
  cardLink.className = "tl-result-link";
  cardLink.setAttribute("aria-label", label);
  node.append(cardLink);
  const poster = tmdbPoster || googlePoster;
  if (poster) {
    const image = document.createElement("img");
    image.className = "tl-film-poster";
    image.width = 76;
    image.height = 112;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
      if (googlePoster && image.getAttribute("src") !== googlePoster) {
        image.src = googlePoster;
      } else {
        image.remove();
        delete node.dataset.hasPoster;
      }
    });
    image.src = poster;
    cardLink.append(image);
    node.dataset.hasPoster = "";
  }
}

export function start() {
  if (!chrome.runtime?.id || !isGoogleSearch(location.href)) return;
  const events = new AbortController();
  const { signal } = events;
  let settings;
  let messages;
  let timer;
  const requests = new Map();
  let settingsRequest = 0;
  let invalidateResults = false;
  let suspended = false;
  let page = location.href;
  let theme;
  let palette;
  const widgets = new Map();

  function contextActive(error) {
    if (signal.aborted) return false;
    if (error?.message !== "Extension context invalidated." && chrome.runtime?.id) return true;
    events.abort();
    observer.disconnect();
    clearTimeout(timer);
    timer = null;
    settingsRequest++;
    requests.clear();
    for (const { node } of widgets.values()) node.remove();
    widgets.clear();
    return false;
  }

  function cancelRequest(type) {
    const request = requests.get(type);
    requests.delete(type);
    request?.port?.disconnect();
  }

  function cancelRequests() {
    for (const type of requests.keys()) cancelRequest(type);
  }

  function schedule() {
    if (!contextActive() || timer || suspended) return;
    timer = setTimeout(() => {
      timer = null;
      if (!contextActive()) return;
      try {
        render();
      } catch (error) {
        if (contextActive(error)) throw error;
      }
    }, 70);
  }

  async function refreshSettings(invalidate = false) {
    if (suspended || !contextActive() || !isGoogleSearch(location.href)) return;
    invalidateResults ||= invalidate;
    const request = ++settingsRequest;
    try {
      const next = await chrome.runtime.sendMessage({ type: "googleSettings" });
      if (!contextActive() || !next || request !== settingsRequest) return;
      const localized = messages && settings?.language === next.language
        ? messages : await messagesFor(next.language);
      if (!contextActive() || request !== settingsRequest) return;
      if (invalidateResults || settings?.tmdbEnabled !== next.tmdbEnabled) cancelRequests();
      invalidateResults = false;
      settings = next;
      messages = localized;
      schedule();
    } catch (error) {
      contextActive(error);
    }
  }

  function requestFilm(type, key, film) {
    if (requests.get(type)?.key === key) return requests.get(type).result;
    cancelRequest(type);
    if (document.hidden) return null;
    const request = { key };
    requests.set(type, request);
    try {
      const port = chrome.runtime.connect({ name: "googleResolution" });
      request.port = port;
      port.onDisconnect.addListener(() => {
        request.port = null;
        if (contextActive()) void chrome.runtime.lastError;
      });
      port.onMessage.addListener(message => {
        if (!contextActive() || requests.get(type) !== request || message.type !== "result") return;
        request.result = message.result;
        request.port = null;
        port.disconnect();
        schedule();
      });
      port.postMessage({ type, film });
    } catch (error) {
      if (contextActive(error)) request.port?.disconnect();
      request.port = null;
    }
  }

  function setWidget(keep, key, anchor, type, details, build) {
    if (!anchor?.isConnected) return;
    keep.add(key);
    const signature = JSON.stringify([type, details, settings.newTab, theme, palette, messages.language]);
    const old = widgets.get(key);
    const parent = type === "result" ? anchor : anchor.parentElement;
    if (old?.anchor === anchor && old.node.parentElement === parent && old.signature === signature) return;
    old?.node.remove();
    const node = document.createElement("div");
    node.dataset.toLetterboxd = type;
    node.dataset.theme = theme;
    node.lang = messages.language;
    if (palette.font) node.style.setProperty("--tl-font", palette.font);
    if (palette.link) node.style.setProperty("--tl-link", palette.link);
    if (palette.text) node.style.setProperty("--tl-text", palette.text);
    build(node);
    if (type === "result") anchor.prepend(node);
    else anchor.after(node);
    widgets.set(key, { node, signature, anchor });
  }

  function render() {
    const keep = new Set();
    let needsPoster = false;
    if (page !== location.href) {
      page = location.href;
      cancelRequests();
    }
    if (settings && messages && isGoogleSearch(page)) {
      const msg = messages.get;
      const bodyStyle = getComputedStyle(document.body);
      theme = settings.theme;
      if (theme === "auto") {
        const color = bodyStyle.backgroundColor;
        const parts = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
        if (parts) {
          theme = 0.2126 * Number(parts[1]) + 0.7152 * Number(parts[2]) + 0.0722 * Number(parts[3]) > 145
            ? "light" : "dark";
        }
      }
      const root = resultsRoot();
      const results = webResults(root);
      const nativeStyle = results[0] && getComputedStyle(results[0].heading);
      const bodyColor = bodyStyle.color;
      palette = {
        font: nativeStyle?.fontFamily,
        link: settings.theme === "auto" && nativeStyle?.color !== bodyColor ? nativeStyle?.color : null,
        text: settings.theme === "auto" ? bodyColor : null
      };
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
        const panel = filmPanel(movie, query, results);
        const film = pageFilm(movie, panel, results, query);
        if (film) {
          const canonical = canonicalFilmUrl(film, results);
          const fallback = searchUrl([film.title, film.year].filter(Boolean).join(" "));
          let direct = film.conflictingIds ? null : canonical || redirectUrl(film);
          let year = film.year;
          if (!direct && !film.conflictingIds && settings.tmdbEnabled &&
              ((panel?.anchor && settings.googlePanel) || (root && results.length && settings.googleResult))) {
            const input = { ...film, locale: document.documentElement.lang || chrome.i18n.getUILanguage() };
            const resolved = requestFilm("resolve", JSON.stringify(input), input);
            if (resolved?.status === "confirmedIdentity") {
              direct = redirectUrl(resolved);
              year ||= resolved.year;
            }
          } else {
            cancelRequest("resolve");
          }
          if (panel?.anchor && settings.googlePanel) {
            setWidget(keep, "panel", panel.anchor, "panel", [direct, fallback], node => {
              node.style.justifyContent = "flex-start";
              node.style.textAlign = "start";
              node.append(panelLink(direct || fallback, msg(direct ? "menuOpen" : "searchOnLetterboxd"), settings.newTab));
              if (direct && !canonical) node.append(link(fallback, msg("searchInstead"), settings.newTab, false));
            });
          }
          if (settings.googleResult && root && results.length) {
            const directResult = direct && year;
            const displayTitle = [film.title, year ? `(${year})` : null].filter(Boolean).join(" ");
            const label = msg(directResult ? "resultTitle" : "resultSearchTitle", displayTitle);
            const url = directResult ? direct : fallback;
            const posters = { tmdbPoster: null, googlePoster: null };
            if (directResult) {
              const identity = { ...film, ...filmLink(direct), canonicalUrl: canonical };
              posters.googlePoster = filmPoster(identity, panel, results, root);
              const { imdbId, tmdbId } = identity;
              if (settings.tmdbEnabled && (imdbId || tmdbId)) {
                needsPoster = true;
                posters.tmdbPoster = requestFilm("poster", JSON.stringify([imdbId, tmdbId]), { imdbId, tmdbId }) ?? null;
              }
            }
            setWidget(keep, "result", cardContainer(root, results), "result", [url, label, posters], node =>
              resultCard(node, url, label, directResult, posters, msg, settings.newTab));
          }
        } else {
          cancelRequest("resolve");
        }
      } else {
        cancelRequest("resolve");
      }
    } else {
      cancelRequest("resolve");
    }
    if (!needsPoster) cancelRequest("poster");
    for (const [key, widget] of widgets) {
      if (keep.has(key)) continue;
      widget.node.remove();
      widgets.delete(key);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!contextActive() || sender.id !== chrome.runtime.id || !isGoogleSearch(location.href)) return;
    if (message?.type === "refreshGoogleSettings") {
      void refreshSettings(message.invalidate === true);
    }
    if (message?.type === "googleSelectionFilm") {
      const results = webResults(resultsRoot());
      const movie = structuredMovie();
      const query = searchIdentity();
      const film = pageFilm(movie, filmPanel(movie, query, results), results, query);
      reply(film && { ...film, canonicalUrl: canonicalFilmUrl(film, results) });
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
  document.addEventListener("visibilitychange", schedule, { signal });
  document.addEventListener("load", event => {
    if (event.target instanceof HTMLImageElement && !own(event.target) && posterShape(event.target)) schedule();
  }, { capture: true, signal });
  window.addEventListener("popstate", schedule, { signal });
  window.navigation?.addEventListener("currententrychange", schedule, { signal });
  window.addEventListener("pagehide", () => {
    if (!contextActive()) return;
    suspended = true;
    settingsRequest++;
    clearTimeout(timer);
    timer = null;
    cancelRequests();
  }, { signal });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    suspended = false;
    void refreshSettings();
  }, { signal });
  void refreshSettings();
}
