import { cleanText, filmYear, normalizeTitle, yearFromDate } from "./film-input.js";
import { tmdbId } from "./urls.js";

const API = "https://api.themoviedb.org/3";
const MAX_PAGES = 2;
const MAX_DETAILS = 6;
const MAX_REQUESTS = 6;
let activeRequests = 0;
let retryAfter = 0;

export function validToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_.-]{20,4096}$/.test(token);
}

function providerError(code) {
  return Object.assign(new Error(code), { code });
}

async function request(path, token, signal, params = {}, fetcher = fetch) {
  signal.throwIfAborted();
  if (Date.now() < retryAfter) throw providerError("rateLimited");
  if (activeRequests >= MAX_REQUESTS) throw providerError("busy");
  const url = new URL(API + path);
  url.search = new URLSearchParams(params).toString();
  activeRequests++;
  try {
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal
    });
    if ([401, 403].includes(response.status)) throw providerError("invalidToken");
    if (response.status === 429) {
      const header = response.headers.get("retry-after");
      const seconds = /^\d+$/.test(header) ? Number(header) : NaN;
      const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
      retryAfter = Date.now() + Math.max(1000, Number.isFinite(wait) ? wait : 30000);
      throw providerError("rateLimited");
    }
    if (!response.ok) throw providerError("unavailable");
    try {
      return await response.json();
    } catch {
      signal.throwIfAborted();
      throw providerError("invalidResponse");
    }
  } finally {
    activeRequests--;
  }
}

export async function validateToken(token, signal, fetcher) {
  const data = await request("/authentication", token, signal, {}, fetcher);
  return data?.success === true;
}

function searchPage(data, page) {
  if (!Array.isArray(data?.results) || !Number.isInteger(data.total_pages) ||
      data.total_pages < 0 || data.page !== page) throw providerError("invalidResponse");
  return data;
}

function language(locale) {
  const match = cleanText(locale, 35).match(/^([a-z]{2})(?:[-_]([a-z]{2}))?$/i);
  if (!match) return "en-US";
  const code = match[1].toLowerCase();
  return match[2] ? `${code}-${match[2].toUpperCase()}` : { en: "en-US", pt: "pt-BR" }[code] ?? code;
}

async function searchMovies(params, token, signal, fetcher) {
  const first = searchPage(await request("/search/movie", token, signal, params, fetcher), 1);
  const pages = [first];
  if (first.total_pages >= MAX_PAGES) {
    pages.push(searchPage(await request("/search/movie", token, signal, { ...params, page: "2" }, fetcher), 2));
  }
  return { complete: first.total_pages <= MAX_PAGES, movies: pages.flatMap(page => page.results) };
}

async function enrich(candidate, locale, director, regionalYear, token, signal, fetcher) {
  const fields = ["alternative_titles", "translations"];
  if (director) fields.push("credits");
  if (regionalYear) fields.push("release_dates");
  const data = await request(`/movie/${candidate.id}`, token, signal,
    { language: locale, append_to_response: fields.join(",") }, fetcher);
  if (tmdbId(data?.id) !== candidate.id || !Array.isArray(data.alternative_titles?.titles) ||
      !Array.isArray(data.translations?.translations) ||
      (director && !Array.isArray(data.credits?.crew)) ||
      (regionalYear && !Array.isArray(data.release_dates?.results))) throw providerError("invalidResponse");
  const titles = [data.title, data.original_title,
    ...data.alternative_titles.titles.map(entry => entry?.title),
    ...data.translations.translations.map(entry => entry?.data?.title)];
  const directors = director ? data.credits.crew.filter(entry => entry?.job === "Director")
    .flatMap(entry => [entry.name, entry.original_name]) : [];
  const years = regionalYear ? data.release_dates.results
    .filter(entry => entry?.iso_3166_1 === locale.split("-")[1])
    .flatMap(entry => Array.isArray(entry.release_dates) ? entry.release_dates : [])
    .map(entry => yearFromDate(entry?.release_date?.split("T")[0])).filter(Boolean) : [];
  return {
    ...candidate,
    titles: [...candidate.titles, ...titles],
    directors,
    years
  };
}

export async function matchTmdb(input, token, signal, fetcher) {
  const titles = [input.title, input.originalTitle].map(value => cleanText(value)).filter(Boolean);
  const wanted = new Set(titles.map(normalizeTitle).filter(Boolean));
  if (!wanted.size) return { reason: "noTitle" };
  const locale = language(input.locale);
  const year = filmYear(input.year);
  const director = normalizeTitle(input.director);
  const queries = [...new Set(titles.flatMap(title => [title, title.replace(/[’‘ʼ＇]/g, "'")]))];
  const candidates = new Map();

  async function collect(releaseYear) {
    const params = { language: locale, include_adult: "false" };
    if (releaseYear) params.primary_release_year = String(releaseYear);
    const searches = await Promise.all(queries.map(query =>
      searchMovies({ ...params, query }, token, signal, fetcher)));
    for (const { movies } of searches) {
      for (const movie of movies) {
        const id = tmdbId(movie?.id);
        const title = cleanText(movie?.title) || cleanText(movie?.original_title);
        if (!id || !title || movie.adult === true) continue;
        const candidate = candidates.get(id) ?? {
          id, title, year: yearFromDate(movie.release_date), titles: []
        };
        candidate.titles.push(movie.title, movie.original_title);
        candidates.set(id, candidate);
      }
    }
    return searches.every(search => search.complete);
  }

  let regionalYear = false;
  let complete = await collect(year);
  if (year && complete && ![...candidates.values()].some(candidate => candidate.year === year)) {
    regionalYear = Boolean(locale.split("-")[1]);
    if (regionalYear) complete = await collect(null);
  }
  if (!complete) return { reason: "incompleteSearch" };
  const pool = [...candidates.values()].filter(candidate => !year ||
    (regionalYear ? candidate.year && Math.abs(candidate.year - year) <= 1 : candidate.year === year));
  const exact = candidate => candidate.titles.some(title => wanted.has(normalizeTitle(title)));
  let matches = pool.filter(exact);
  if (!director && !regionalYear && matches.length > 1) return { reason: "ambiguous" };
  if (director || regionalYear || !matches.length || pool.length > matches.length) {
    if (pool.length > MAX_DETAILS) return { reason: "ambiguous" };
    const expanded = [];
    for (let index = 0; index < pool.length; index += 2) {
      expanded.push(...await Promise.all(pool.slice(index, index + 2).map(candidate =>
        enrich(candidate, locale, director, regionalYear, token, signal, fetcher))));
    }
    matches = expanded.filter(candidate => exact(candidate) &&
      (!director || candidate.directors.some(name => normalizeTitle(name) === director)) &&
      (!regionalYear || candidate.year === year || candidate.years.includes(year)));
  }
  if (matches.length !== 1) return { reason: matches.length ? "ambiguous" : "noMatch" };
  const match = matches[0];
  return { tmdbId: match.id, title: match.title, year: match.year };
}
