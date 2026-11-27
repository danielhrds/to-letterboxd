import { cleanText, filmYear } from "./film-input.js";
import { matchTmdb } from "./tmdb.js";
import { filmLink, imdbId, redirectUrl, searchUrl, tmdbId } from "./urls.js";

export function fallbackFor(input, reason, details = {}) {
  const title = cleanText(input.title);
  const year = filmYear(input.year);
  const query = input.raw || [title, year].filter(Boolean).join(" ");
  const fallback = searchUrl(query);
  return {
    status: reason === "ambiguous" || reason === "conflictingIds" ? "ambiguous" : "fallback",
    url: fallback, canonicalUrl: null, title, year, imdbId: null, tmdbId: null,
    confidence: "unresolved", availability: "unknown", strategy: "search",
    provider: "letterboxd", fallback, reason, ...details
  };
}

export function knownDestination(input) {
  if (input.conflictingIds) return fallbackFor(input, "conflictingIds");
  const canonicalUrl = filmLink(input.canonicalUrl)?.canonicalUrl;
  const ids = { imdbId: imdbId(input.imdbId), tmdbId: tmdbId(input.tmdbId) };
  const url = canonicalUrl || redirectUrl(ids);
  if (!url) return null;
  return fallbackFor(input, null, {
    ...ids, status: canonicalUrl ? "linkedPage" : "unverifiedRedirect", url,
    canonicalUrl: canonicalUrl ?? null,
    confidence: "high", availability: canonicalUrl ? "linked" : "unknown",
    strategy: canonicalUrl ? "filmLink" : ids.imdbId ? "imdbId" : "tmdbId"
  });
}

export async function resolveFilm(input, { token, cached, signal, fetcher } = {}) {
  const known = knownDestination(input);
  if (known) return known;
  if (!token || !input.title) return fallbackFor(input, token ? "noTitle" : "tmdbOff");
  try {
    signal.throwIfAborted();
    const match = cached ?? await matchTmdb(input, token, signal, fetcher);
    signal.throwIfAborted();
    if (!match.tmdbId) return fallbackFor(input, match.reason);
    return fallbackFor(input, null, {
      status: "confirmedIdentity",
      url: redirectUrl(match),
      title: match.title,
      year: match.year,
      tmdbId: match.tmdbId,
      confidence: "high",
      strategy: cached ? "cache" : "titleMatch",
      provider: "tmdb"
    });
  } catch (error) {
    return fallbackFor(input, signal.aborted ? "canceled" : error.code ?? "unavailable");
  }
}
