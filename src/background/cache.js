import { normalizeTitle } from "../core/film-input.js";
import { tmdbId } from "../core/urls.js";

const KEY = "filmMatches";
const TTL = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;
let storageQueue = Promise.resolve();
let revision = 0;

export function cacheKey(input) {
  return JSON.stringify([
    normalizeTitle(input.title), normalizeTitle(input.originalTitle),
    input.year, normalizeTitle(input.director), input.locale
  ]);
}

function enqueue(operation) {
  const result = storageQueue.then(operation);
  storageQueue = result.catch(() => {});
  return result;
}

function area(persistent) {
  return persistent ? chrome.storage.local : chrome.storage.session;
}

export async function readMatch(key, persistent) {
  await storageQueue;
  const entries = (await area(persistent).get(KEY))[KEY];
  const entry = Array.isArray(entries) && entries.find(item =>
    item?.key === key && item.expires > Date.now() && tmdbId(item.match?.tmdbId));
  return entry ? entry.match : null;
}

export function saveMatch(key, result, persistent, generation) {
  const storage = area(persistent);
  const { tmdbId, title, year } = result;
  return enqueue(async () => {
    if (generation !== revision) return;
    const data = (await storage.get(KEY))[KEY];
    const entries = Array.isArray(data) ? data : [];
    const live = entries.filter(item => item?.expires > Date.now() && item.key !== key);
    live.unshift({ key, match: { tmdbId, title, year }, expires: Date.now() + TTL });
    await storage.set({ [KEY]: live.slice(0, MAX_ENTRIES) });
  });
}

export function cacheRevision() {
  return revision;
}

export function clearMatches({ persistentOnly = false } = {}) {
  revision++;
  return enqueue(async () => {
    await chrome.storage.local.remove(KEY);
    if (!persistentOnly) await chrome.storage.session.remove(KEY);
  });
}
