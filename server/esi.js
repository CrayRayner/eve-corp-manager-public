'use strict';
const { getValidToken, forceRefreshToken } = require('./auth');
const { cacheName, getCachedName } = require('./db');

const ESI_BASE = 'https://esi.evetech.net/latest';
const UA       = 'EVE-Corp-Dashboard/1.0 (contact your-email@example.com)';

// Simple in-memory ETag cache  { url → { etag, data } }
const etagCache = new Map();

/** fetch wrapper that builds a query string and parses the body once */
async function esiFetch(url, params, headers) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null)
  ).toString();
  const fullUrl = qs ? `${url}?${qs}` : url;
  const res = await fetch(fullUrl, { headers });
  const data = res.status !== 304 ? await res.json().catch(() => null) : null;
  return { status: res.status, headers: res.headers, data };
}

/** Core ESI GET — handles auth, ETags, 304, 429 retry */
async function esiGet(path, { characterId = null, params = {}, retries = 3 } = {}) {
  const url = `${ESI_BASE}${path}`;
  const headers = { 'User-Agent': UA };

  if (characterId) {
    const token = await getValidToken(characterId);
    headers['Authorization'] = `Bearer ${token}`;
  }

  const cached = etagCache.get(url + JSON.stringify(params));
  if (cached?.etag) headers['If-None-Match'] = cached.etag;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await esiFetch(url, params, headers);

      if (res.status === 304 && cached) return cached.data;

      // ESI-specific: 420 = error limit reached (you've made too many 4xx errors recently)
      if (res.status === 420) {
        const wait = parseInt(res.headers.get('retry-after') || '60', 10) * 1000;
        console.error(`[ESI] 🚫 ERROR LIMIT REACHED on ${path} — banned for ${wait/1000}s. Wait before retrying.`);
        await sleep(wait);
        continue;
      }

      // Standard rate-limit retry
      if (res.status === 429) {
        const wait = parseInt(res.headers.get('retry-after') || '10', 10) * 1000;
        console.warn(`[ESI] ⏳ Rate-limited on ${path} — retrying after ${wait/1000}s`);
        await sleep(wait);
        continue;
      }

      // Warn when ESI error budget is running low (ESI bans at 0)
      const errRemain = parseInt(res.headers.get('x-esi-error-limit-remain') || '100', 10);
      if (errRemain <= 20) {
        console.warn(`[ESI] ⚠️  Error budget LOW: ${errRemain} remaining (reset in ${res.headers.get('x-esi-error-limit-reset') || '?'}s) — triggered by ${path}`);
      }

      if (res.status === 200) {
        const etag = res.headers.get('etag');
        if (etag) {
          etagCache.set(url + JSON.stringify(params), { etag, data: res.data });
        }
        return res.data;
      }

      // 401 with auth: token may be invalidated (e.g. after re-auth). Force refresh and retry once.
      if (res.status === 401 && characterId) {
        try {
          await forceRefreshToken(characterId);
          const token = await getValidToken(characterId);
          headers['Authorization'] = `Bearer ${token}`;
          const retry = await esiFetch(url, params, headers);
          if (retry.status === 304 && cached) return cached.data;
          if (retry.status === 200) {
            const retryEtag = retry.headers.get('etag');
            if (retryEtag) {
              etagCache.set(url + JSON.stringify(params), { etag: retryEtag, data: retry.data });
            }
            return retry.data;
          }
          if (retry.status >= 400 && retry.status < 500) {
            console.warn(`[ESI] ${retry.status} on ${path} after refresh (error budget: ${parseInt(retry.headers.get('x-esi-error-limit-remain') || '100', 10)})`);
          }
          const retryErr = Object.assign(new Error(`ESI ${retry.status} on ${path}`), { status: retry.status, body: retry.data });
          if (retry.status === 401 || retry.status === 403) throw retryErr;
          throw retryErr;
        } catch (refreshErr) {
          if (refreshErr.status === 401 || refreshErr.status === 403) throw refreshErr;
          console.warn(`[ESI] Refresh then retry failed for ${path}:`, refreshErr.message);
          throw Object.assign(new Error(`ESI ${res.status} on ${path}`), { status: res.status, body: res.data });
        }
      }

      // Log 4xx errors so we can see exactly what's failing
      if (res.status >= 400 && res.status < 500) {
        console.warn(`[ESI] ${res.status} on ${path} (error budget: ${errRemain})`);
      }

      // 401/403 are auth failures — permanent, not transient. Never retry them.
      // Retrying would burn 4× error budget for no reason (we'd still get 401 each time).
      const err = Object.assign(new Error(`ESI ${res.status} on ${path}`), { status: res.status, body: res.data });
      if (res.status === 401 || res.status === 403) throw err; // bypass retry loop

      throw err;
    } catch (err) {
      if (attempt === retries || err.status === 401 || err.status === 403) throw err;
      await sleep(2000 * (attempt + 1));
    }
  }
}

/** Paginate an ESI endpoint — collects all pages */
async function esiGetAll(path, options = {}) {
  let page = 1, results = [];
  while (true) {
    const url    = `${ESI_BASE}${path}`;
    const params = { ...(options.params || {}), page };
    const headers = { 'User-Agent': UA };
    if (options.characterId) {
      const token = await getValidToken(options.characterId);
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await esiFetch(url, params, headers);
    if (res.status === 200) {
      results = results.concat(res.data);
      const totalPages = parseInt(res.headers.get('x-pages') || '1', 10);
      if (page >= totalPages) break;
      page++;
    } else if (res.status === 304) {
      // No new data on this page — shouldn't happen without If-None-Match, but handle gracefully
      break;
    } else if (res.status === 429) {
      const wait = parseInt(res.headers.get('retry-after') || '10', 10) * 1000;
      console.warn(`[ESI] esiGetAll rate-limited on ${path} page ${page} — retrying after ${wait / 1000}s`);
      await sleep(wait);
      // Don't increment page — retry the same page
    } else if (res.status === 404) {
      // ESI returns 404 for endpoints with no data (e.g. corp mining ledger with no recent
      // activity). Treat as empty result rather than an error.
      break;
    } else if (res.status === 401 && options.characterId) {
      // Token may be invalidated; force refresh and retry this page once.
      try {
        await forceRefreshToken(options.characterId);
        const token = await getValidToken(options.characterId);
        headers['Authorization'] = `Bearer ${token}`;
        const retry = await esiFetch(url, params, headers);
        if (retry.status === 200) {
          results = results.concat(retry.data);
          const totalPages = parseInt(retry.headers.get('x-pages') || '1', 10);
          if (page >= totalPages) break;
          page++;
        } else if (retry.status === 404) {
          // Same as normal path: 404 = no data (e.g. mining ledger/observers with nothing in period)
          break;
        } else {
          console.warn(`[ESI] esiGetAll got ${retry.status} on ${path} page ${page} after refresh — aborting pagination`);
          throw new Error(`ESI ${retry.status} on ${path}`);
        }
      } catch (refreshErr) {
        if (refreshErr.message && refreshErr.message.startsWith('ESI ')) throw refreshErr;
        console.warn(`[ESI] esiGetAll got 401 on ${path} page ${page} — refresh failed:`, refreshErr.message);
        throw new Error(`ESI 401 on ${path}`);
      }
    } else {
      // Other 4xx/5xx — log clearly so we can diagnose failures (e.g. scope issues = 403)
      console.warn(`[ESI] esiGetAll got ${res.status} on ${path} page ${page} — aborting pagination`);
      throw new Error(`ESI ${res.status} on ${path}`);
    }
  }
  return results;
}

/** Resolve a list of character IDs to names (batch, cached) */
async function resolveNames(ids) {
  const unknown = [];
  const map = {};

  for (const id of ids) {
    const cached = getCachedName(id);
    if (cached) map[id] = cached.name;
    else unknown.push(id);
  }

  if (unknown.length === 0) return map;

  // ESI bulk name endpoint
  const chunks = chunkArray(unknown, 1000);
  for (const chunk of chunks) {
    try {
      const res = await fetch(`${ESI_BASE}/universe/names/`, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
      });
      const data = await res.json();
      for (const { id, name } of data) {
        map[id] = name;
        cacheName(id, name);
      }
    } catch { /* best effort */ }
  }

  return map;
}

/** Resolve a single structure name (requires auth) */
async function resolveStructureName(structureId, characterId) {
  const cached = getCachedName(structureId);
  // Only skip if we have a real name — empty string ('failed') always gets retried
  if (cached && cached.name) return cached.name;
  try {
    const data = await esiGet(`/universe/structures/${structureId}/`, { characterId });
    if (data?.name) { cacheName(structureId, data.name, 'structure'); return data.name; }
  } catch (err) {
    // 401/403: ESI access disabled by owning corp, or character lacks ESI docking rights.
    // Cache empty string so we don't retry every page load (burns error budget).
    // Use ✏️ rename button to set a manual name; clearing name_cache triggers fresh resolve.
    console.warn(`[ESI] Structure ${structureId} inaccessible via ESI (${err.status || err.message}) — use ✏️ to name manually`);
    cacheName(structureId, '', 'failed');
  }
  return `Structure ${structureId}`;
}

/** Resolve a solar system name */
async function resolveSystemName(systemId) {
  const cached = getCachedName(systemId);
  if (cached) return cached.name;
  try {
    const data = await esiGet(`/universe/systems/${systemId}/`);
    if (data?.name) { cacheName(systemId, data.name, 'system'); return data.name; }
  } catch { /* */ }
  return `System ${systemId}`;
}

/** Resolve a type name */
async function resolveTypeName(typeId) {
  const cached = getCachedName(typeId);
  if (cached) return cached.name;
  try {
    const data = await esiGet(`/universe/types/${typeId}/`);
    if (data?.name) { cacheName(typeId, data.name, 'type'); return data.name; }
  } catch { /* */ }
  return `Type ${typeId}`;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { esiGet, esiGetAll, resolveNames, resolveStructureName, resolveSystemName, resolveTypeName };
