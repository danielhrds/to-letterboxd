import { filmLink, imdbId, tmdbId } from "./urls.js";

export function cleanText(value, limit = 250) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export function normalizeTitle(value) {
  return cleanText(value).normalize("NFKD").toLowerCase()
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1").normalize("NFC")
    .replace(/['’‘ʼ＇]/g, "")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
}

export function filmYear(value) {
  const year = String(value);
  return /^(18[789]\d|19\d\d|20\d\d|21\d\d)$/.test(year) ? Number(year) : null;
}

export function yearFromDate(date) {
  return typeof date === "string" && /^\d{4}(?:-\d{2}-\d{2})?$/.test(date)
    ? filmYear(date.slice(0, 4)) : null;
}

export function parseSelection(selection) {
  const raw = cleanText(selection, 1000);
  const links = [...raw.matchAll(/https:\/\/[^\s<>"“”]+/gi)]
    .map(match => filmLink(match[0].replace(/[),.;!?\]}]+$/g, ""))).filter(Boolean);
  const imdb = new Set(links.map(link => link.imdbId).filter(Boolean));
  const tmdb = new Set(links.map(link => link.tmdbId).filter(Boolean));
  const canonical = new Set(links.map(link => link.canonicalUrl).filter(Boolean));
  const outsideUrls = raw.replace(/https?:\/\/\S+/gi, " ");
  for (const match of outsideUrls.matchAll(/\btt\d{7,12}\b/gi)) imdb.add(imdbId(match[0]));
  for (const match of outsideUrls.matchAll(/\btmdb(?:\s+id)?\s*[:#]\s*([1-9]\d{0,9})\b/gi)) {
    tmdb.add(tmdbId(match[1]));
  }
  const distinctKinds = [imdb, tmdb, canonical].filter(ids => ids.size > 0);
  if (distinctKinds.length) {
    if (distinctKinds.length > 1 || distinctKinds[0].size > 1) return { raw, conflictingIds: true };
    return { raw, imdbId: [...imdb][0], tmdbId: [...tmdb][0], canonicalUrl: [...canonical][0] };
  }
  if (raw.length > 180 || /https?:\/\//i.test(raw)) return { raw };
  let title = raw.replace(/\s+/gu, " ");
  const suffix = title.match(/^(.+?)(?:\s*\((\d{4})\)|\s*\[(\d{4})\]|\s+(\d{4}))$/u);
  const year = suffix && filmYear(suffix[2] || suffix[3] || suffix[4]);
  if (year) title = suffix[1];
  title = title.replace(/^(?:"(.+)"|“(.+)”|'(.+)'|‘(.+)’)$/u, (match, ...groups) =>
    groups.slice(0, 4).find(Boolean) ?? match);
  return { raw, title, year: year || null };
}
