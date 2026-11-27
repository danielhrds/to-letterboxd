const LETTERBOXD = "https://letterboxd.com";
const googleHosts = new Set(["www.google.com", "www.google.com.br"]);
const imdbHosts = new Set(["imdb.com", "www.imdb.com", "m.imdb.com"]);
const tmdbHosts = new Set(["themoviedb.org", "www.themoviedb.org"]);
const letterboxdHosts = new Set(["letterboxd.com", "www.letterboxd.com"]);

export function imdbId(value) {
  return typeof value === "string" && /^tt\d{7,12}$/i.test(value) ? value.toLowerCase() : null;
}

export function tmdbId(value) {
  const id = typeof value === "number" ? String(value) : value;
  return typeof id === "string" && /^[1-9]\d{0,9}$/.test(id) ? id : null;
}

function webUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port) return url;
  } catch {}
  return null;
}

export function isGoogleSearch(value) {
  const url = webUrl(value);
  return Boolean(url && googleHosts.has(url.hostname) && url.pathname === "/search");
}

export function filmLink(value, base) {
  let url = webUrl(value, base);
  if (url && googleHosts.has(url.hostname) && url.pathname === "/url") {
    url = webUrl(url.searchParams.get("q") || url.searchParams.get("url"));
  }
  if (!url) return null;
  const { hostname, pathname } = url;
  if (imdbHosts.has(hostname)) {
    const id = imdbId(pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?title\/(tt\d+)\/?$/i)?.[1]);
    return id ? { imdbId: id, source: "imdb" } : null;
  }
  if (tmdbHosts.has(hostname)) {
    const id = tmdbId(pathname.match(/^\/movie\/(\d+)(?:-[^/]+)?\/?$/)?.[1]);
    return id ? { tmdbId: id, source: "tmdb" } : null;
  }
  if (letterboxdHosts.has(hostname)) {
    const slug = pathname.match(/^\/film\/([a-z0-9][a-z0-9-]*)\/?$/)?.[1];
    if (slug) return { canonicalUrl: `${LETTERBOXD}/film/${slug}/` };
    const imdb = imdbId(pathname.match(/^\/imdb\/(tt\d+)\/?$/i)?.[1]);
    if (imdb) return { imdbId: imdb, source: "letterboxd" };
    const tmdb = tmdbId(pathname.match(/^\/tmdb\/(\d+)\/?$/)?.[1]);
    if (tmdb) return { tmdbId: tmdb, source: "letterboxd" };
  }
  return null;
}

export function redirectUrl(ids) {
  const imdb = imdbId(ids.imdbId);
  const tmdb = tmdbId(ids.tmdbId);
  if (imdb) return `${LETTERBOXD}/imdb/${imdb}`;
  if (tmdb) return `${LETTERBOXD}/tmdb/${tmdb}`;
  return null;
}

export function searchUrl(query) {
  if (typeof query !== "string" || !query.trim()) return null;
  const text = Array.from(query.trim()).slice(0, 400)
    .map(character => /^[\uD800-\uDFFF]$/.test(character) ? "\uFFFD" : character).join("");
  const encoded = encodeURIComponent(text);
  return `${LETTERBOXD}/search/films/${/^\.{1,2}$/.test(text) ? "" : `${encoded}/`}`;
}
