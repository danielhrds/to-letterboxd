import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { normalizeTitle, parseSelection } from "../src/core/film-input.js";
import { resolveFilm } from "../src/core/resolver.js";
import { DEFAULTS, readSettings } from "../src/core/settings.js";
import { validateToken } from "../src/core/tmdb.js";
import { filmLink, isGoogleSearch, redirectUrl, searchUrl } from "../src/core/urls.js";

const fakeToken = "test-token-placeholder";
const movie = (id, title, year, original_title = title) => ({
  id, title, original_title, release_date: `${year}-01-01`
});
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers });
const page = (results, number = 1, total_pages = 1) =>
  json({ results, page: number, total_pages });

async function resolve(input, fetcher, timeout = 1000) {
  return resolveFilm(input, { token: fakeToken, signal: AbortSignal.timeout(timeout), fetcher });
}

test("compares punctuation, Latin accents and distinct Japanese characters", () => {
  assert.equal(normalizeTitle("La Femme de l’aviateur"), normalizeTitle("LA FEMME DE L'AVIATEUR"));
  assert.equal(normalizeTitle("Éric Rohmer"), "eric rohmer");
  assert.equal(normalizeTitle(" Ｖ‐Ｆｏｒ "), "v for");
  assert.equal(normalizeTitle("기생충"), "기생충");
  assert.equal(normalizeTitle("千と千尋の神隠し"), "千と千尋の神隠し");
  assert.notEqual(normalizeTitle("は"), normalizeTitle("ば"));
});

test("keeps numeric titles and preserves the original selection for fallback", () => {
  for (const title of ["1917", "1984", "2046", "2001: A Space Odyssey", "12 Angry Men", "8½", "3-Iron", "Se7en"]) {
    assert.deepEqual(parseSelection(title), { raw: title, title, year: null });
  }
  const raw = "“A Mulher do Aviador”\n(1981)";
  assert.deepEqual(parseSelection(raw), { raw, title: "A Mulher do Aviador", year: 1981 });
  assert.equal(parseSelection("1917 2019").title, "1917");
  assert.equal(parseSelection("tmdb:157336").tmdbId, "157336");
  assert.equal(parseSelection("tt0816692, tt0137523").conflictingIds, true);
  assert.equal(parseSelection("https://evil.test/title/tt0816692").imdbId, undefined);
  assert.equal(parseSelection("https://www.themoviedb.org/tv/157336").tmdbId, undefined);
});

test("accepts official film links and unwraps only a Google redirect", () => {
  assert.equal(filmLink("/url?url=https%3A%2F%2Fwww.imdb.com%2Ftitle%2Ftt0816692%2F%3Fx%3D1",
    "https://www.google.com.br/search").imdbId, "tt0816692");
  assert.equal(filmLink("https://letterboxd.com/film/interstellar/?x=1").canonicalUrl,
    "https://letterboxd.com/film/interstellar/");
  assert.equal(redirectUrl({ imdbId: "tt0816692" }), "https://letterboxd.com/imdb/tt0816692");
  for (const path of [
    "https://www.imdb.com.evil.test/title/tt0816692/",
    "https://www.imdb.com:9090/title/tt0816692/",
    "https://www.imdb.com@evil.test/title/tt0816692/",
    "javascript:location.href='https://letterboxd.com/film/interstellar/'",
    "https://letterboxd.com/user/list/interstellar/",
    "https://letterboxd.com/film/interstellar/members/",
    "https://letterboxd.com/tmdb/157336/tv",
    "https://www.imdb.com/title/tt0816692/episodes/",
    "https://www.imdb.com/name/nm0634240/"
  ]) assert.equal(filmLink(path), null, path);
  assert.equal(isGoogleSearch("https://www.google.com/search?q=x"), true);
  assert.equal(isGoogleSearch("https://www.google.com/search/elsewhere"), false);
});

test("accepts localized IMDb title pages and keeps other IMDb paths excluded", () => {
  assert.equal(filmLink("https://www.imdb.com/pt/title/tt0075314/").imdbId, "tt0075314");
  assert.equal(filmLink("/url?q=https%3A%2F%2Fwww.imdb.com%2Fes-es%2Ftitle%2Ftt0075314%2F",
    "https://www.google.com/search").imdbId, "tt0075314");
  assert.equal(filmLink("https://www.imdb.com/pt/name/nm0000217/"), null);
  assert.equal(filmLink("https://www.imdb.com/pt/title/tt0075314/episodes/"), null);
});

test("encodes Unicode and special characters without changing the search host or path", () => {
  assert.equal(searchUrl("花樣年華 / ‘?&’"), "https://letterboxd.com/search/films/%E8%8A%B1%E6%A8%A3%E5%B9%B4%E8%8F%AF%20%2F%20%E2%80%98%3F%26%E2%80%99/");
  assert.equal(new URL(searchUrl("..")).pathname, "/search/films/");
  assert.equal(new URL(searchUrl("https://outside.test/a")).hostname, "letterboxd.com");
  assert.doesNotThrow(() => searchUrl("\uD83D"));
});

test("opens validated links and IDs without a request and sends missing credentials to search", async () => {
  const unexpected = () => assert.fail("Direct resolutions do not call the API");
  assert.equal((await resolve({ imdbId: "tt0816692" }, unexpected)).status, "unverifiedRedirect");
  assert.equal((await resolve({ tmdbId: 157336 }, unexpected)).url, "https://letterboxd.com/tmdb/157336");
  assert.equal((await resolve({ canonicalUrl: "https://letterboxd.com/film/interstellar/" }, unexpected)).status, "linkedPage");
  assert.equal((await resolve({ title: "Oldboy", conflictingIds: true }, unexpected)).status, "ambiguous");
  const result = await resolveFilm({ raw: "Clube da Luta" }, { fetcher: unexpected });
  assert.equal(result.url, searchUrl("Clube da Luta"));
  assert.equal(result.reason, "tmdbOff");
});

test("uses official TMDB search, alternative titles, translations and credits for the Rohmer fixture", async () => {
  const fetcher = async (url, options) => {
    assert.equal(url.origin, "https://api.themoviedb.org");
    assert.equal(options.headers.Authorization, `Bearer ${fakeToken}`);
    assert.equal(options.redirect, "error");
    assert.equal(url.href.includes(fakeToken), false);
    if (url.pathname === "/3/search/movie") {
      return page([movie(7, "The Aviator's Wife", 1981, "La Femme de l'aviateur")]);
    }
    assert.equal(url.pathname, "/3/movie/7");
    assert.equal(url.searchParams.get("append_to_response"), "alternative_titles,translations,credits");
    return json({
      id: 7,
      alternative_titles: { titles: [{ title: "La mujer del aviador" }] },
      translations: { translations: [{ data: { title: "A Mulher do Aviador" } }] },
      credits: { crew: [{ job: "Director", name: "Éric Rohmer" }] }
    });
  };
  for (const title of ["La Femme de l'aviateur", "La Femme de l’aviateur",
    "The Aviator's Wife", "The Aviator’s Wife", "A Mulher do Aviador", "La mujer del aviador"]) {
    const result = await resolve({ title, locale: "pt-BR", director: "Eric Rohmer", year: 1981 }, fetcher);
    assert.equal(result.status, "confirmedIdentity", title);
    assert.equal(result.tmdbId, "7", title);
    assert.equal(result.availability, "unknown");
  }
});

test("distinguishes remakes and reads a second result page before selecting a film", async () => {
  const fetcher = async url => url.searchParams.get("page") === "2"
    ? page([movie(2, "Oldboy", 2013)], 2, 2)
    : page([movie(1, "Oldboy", 2003)], 1, 2);
  assert.equal((await resolve({ title: "Oldboy" }, fetcher)).reason, "ambiguous");
  assert.equal((await resolve({ title: "Oldboy", year: 2013 }, fetcher)).tmdbId, "2");
  assert.equal((await resolve({ title: "Oldboy" }, async () => page([], 1, 99))).reason, "invalidResponse");
  const incomplete = await resolve({ title: "Oldboy" }, async url => page(
    [movie(1, "Oldboy", 2003)], Number(url.searchParams.get("page") || 1), 3));
  assert.equal(incomplete.reason, "incompleteSearch");
});

test("breaks same-year ties only with a decisive lead over the runner-up", async () => {
  const selection = parseSelection("Taxi Driver 1976");
  async function resolveVotes(votes, input = selection) {
    return resolveFilm(input, {
      token: fakeToken,
      signal: AbortSignal.timeout(1000),
      voteTiebreak: true,
      fetcher: async url => {
        if (url.pathname === "/3/movie/2") {
          return json({ id: 2, alternative_titles: { titles: [{ title: "Taxi Driver" }] }, translations: { translations: [] } });
        }
        if (url.pathname.startsWith("/3/movie/")) {
          return json({
            id: Number(url.pathname.split("/").at(-1)),
            alternative_titles: { titles: [] }, translations: { translations: [] }
          });
        }
        return page([
          { ...movie(2, "Taksi Şoförü", 1976), vote_count: votes[1] },
          { ...movie(3, "Taxi Driver", 1976), vote_count: votes[2] },
          { ...movie(103, "Taxi Driver", 1976), vote_count: votes[0] }
        ]);
      }
    });
  }
  const winner = await resolveVotes([60, 20, 19]);
  assert.equal(winner.strategy, "voteTiebreak");
  assert.equal(winner.url, "https://letterboxd.com/tmdb/103");
  assert.equal((await resolveVotes([60, 21, 19])).reason, "ambiguous");
  assert.equal((await resolveVotes([19, 0, 0])).reason, "ambiguous");
  assert.equal((await resolveVotes([10000, undefined, 1])).reason, "ambiguous");
  assert.equal((await resolveVotes([10000, 1, 1], { title: "Taxi Driver" })).reason, "ambiguous");
});

test("retries an unmatched title in English and resolves a unique film with zero votes", async () => {
  const title = "Take Me Out to the Snowland";
  const primary = "私をスキーに連れてって";
  const input = { ...parseSelection("Take Me Out to the\u00a0Snowland (1987)"), locale: "pt-BR" };
  const languages = [];
  const result = await resolveFilm(input, {
    token: fakeToken,
    signal: AbortSignal.timeout(1000),
    voteTiebreak: true,
    fetcher: async url => {
      if (url.pathname === "/3/movie/377620") {
        return json({ id: 377620, alternative_titles: { titles: [{ title }] }, translations: { translations: [] } });
      }
      assert.equal(url.pathname, "/3/search/movie");
      assert.equal(url.searchParams.get("query"), title);
      const language = url.searchParams.get("language");
      languages.push(language);
      if (language === "pt-BR") return page([]);
      assert.equal(language, "en-US");
      assert.equal(url.searchParams.get("primary_release_year"), "1987");
      return page([{ ...movie(377620, "Take Me Skiing", 1987, primary), vote_count: 0 }]);
    }
  });
  assert.deepEqual(languages, ["pt-BR", "pt-BR", "en-US"]);
  assert.equal(result.strategy, "titleMatch");
  assert.equal(result.url, "https://letterboxd.com/tmdb/377620");
});

test("validates a regional release date when the primary year lookup finds no match", async () => {
  const result = await resolve({ title: "Release", locale: "pt-BR", year: 1982 }, async url => {
    if (url.pathname === "/3/search/movie") {
      return page(url.searchParams.has("primary_release_year") ? [] : [movie(2, "Release", 1981)]);
    }
    return json({
      id: 2, alternative_titles: { titles: [] }, translations: { translations: [] },
      release_dates: { results: [{ iso_3166_1: "BR", release_dates: [{ release_date: "1982-03-04T00:00:00Z" }] }] }
    });
  });
  assert.equal(result.tmdbId, "2");
  assert.equal(result.year, 1981);
});

test("treats an exact title and a competing alternative title as ambiguous", async () => {
  const fetcher = async url => {
    if (url.pathname === "/3/search/movie") {
      return page([movie(1, "The Chase", 2017), movie(2, "Pursuit", 2018)]);
    }
    const id = Number(url.pathname.split("/").at(-1));
    return json({
      id,
      alternative_titles: { titles: id === 2 ? [{ title: "The Chase" }] : [] },
      translations: { translations: [] }
    });
  };
  assert.equal((await resolve({ title: "The Chase" }, fetcher)).reason, "ambiguous");
  assert.equal((await resolve({ title: "The Chase", year: 2017 }, fetcher)).tmdbId, "1");
});

test("rejects partial matches, incompatible years and conflicting director evidence", async () => {
  const fetcher = async url => url.pathname === "/3/search/movie"
    ? page([movie(1, "Dune: Part Two", 2024)])
    : json({
      id: 1, alternative_titles: { titles: [] }, translations: { translations: [] },
      credits: { crew: [{ job: "Director", name: "Denis Villeneuve" }] }
    });
  assert.equal((await resolve({ title: "Dune" }, fetcher)).reason, "noMatch");
  assert.equal((await resolve({ title: "Dune: Part Two", year: 1984 }, fetcher)).reason, "noMatch");
  assert.equal((await resolve({ title: "Dune: Part Two", director: "David Lynch" }, fetcher)).reason, "noMatch");
});

test("uses fallback for invalid credentials, malformed responses, network failures and timeout", async () => {
  const input = { title: "Parasita", raw: "“Parasita”" };
  for (const [reason, fetcher] of [
    ["invalidToken", async () => json({}, 401)],
    ["invalidResponse", async () => json({ results: null })],
    ["noMatch", async () => page([])],
    ["unavailable", async () => { throw new TypeError("offline"); }],
    ["canceled", async (_url, options) => delay(200, null, { signal: options.signal })]
  ]) {
    const result = await resolve(input, fetcher, 30);
    assert.equal(result.url, searchUrl(input.raw));
    assert.equal(result.reason, reason);
  }
  assert.equal(await validateToken(fakeToken, AbortSignal.timeout(1000), async url => {
    assert.equal(url.pathname, "/3/authentication");
    return json({ success: true });
  }), true);
});

test("normalizes settings without enabling undeclared options", () => {
  assert.deepEqual(readSettings({ tmdbEnabled: 1, theme: "pink", language: "es", ratings: true }), DEFAULTS);
  assert.deepEqual(readSettings({ enabled: false, menuMode: "search", googleImdb: false, language: "pt-BR" }), {
    ...DEFAULTS, menuMode: "search", googleImdb: false, language: "pt-BR"
  });
});

test("stops TMDB requests during a rate limit and uses search", async () => {
  const input = { title: "Rate limit" };
  const first = await resolve(input, async () => json({}, 429, { "Retry-After": "10" }));
  const second = await resolve(input, () => assert.fail("rate-limited request"));
  assert.equal(first.reason, "rateLimited");
  assert.equal(second.reason, "rateLimited");
  assert.equal(second.url, searchUrl("Rate limit"));
});
