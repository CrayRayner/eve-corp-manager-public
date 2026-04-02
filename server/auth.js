'use strict';
const crypto = require('crypto');
const { db, saveToken, getToken, updateAccessToken } = require('./db');

const SSO_BASE  = 'https://login.eveonline.com';
const TOKEN_URL = `${SSO_BASE}/v2/oauth/token`;
const AUTH_URL  = `${SSO_BASE}/v2/oauth/authorize`;

const REQUIRED_SCOPES = [
  'esi-wallet.read_corporation_wallets.v1',
  'esi-corporations.read_structures.v1',
  'esi-corporations.read_corporation_membership.v1',
  'esi-corporations.track_members.v1',
  'esi-industry.read_corporation_mining.v1',
  'esi-assets.read_corporation_assets.v1',
  'esi-universe.read_structures.v1',   // resolve alliance/other-corp structure names
  'esi-contracts.read_corporation_contracts.v1',
];

const SCOPES = REQUIRED_SCOPES.join(' ');

// ─── PKCE helpers ────────────────────────────────────────────────────────────

/** Generate a cryptographically random PKCE code_verifier (43 URL-safe chars) */
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Derive code_challenge from verifier using S256 method */
function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ─── Auth URL ─────────────────────────────────────────────────────────────────

/**
 * Build the EVE SSO authorization URL.
 * Returns { url, codeVerifier } — store codeVerifier in the session,
 * it is required when exchanging the auth code for tokens.
 */
function buildAuthUrl(state) {
  const codeVerifier  = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             process.env.EVE_CLIENT_ID,
    redirect_uri:          process.env.EVE_CALLBACK_URL,
    scope:                 SCOPES,
    state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });

  return { url: `${AUTH_URL}?${params}`, codeVerifier };
}

// ─── Token exchange ───────────────────────────────────────────────────────────

/**
 * Exchange auth code for tokens using PKCE.
 * No client_secret needed — the code_verifier proves ownership of the request.
 */
async function exchangeCode(code, codeVerifier) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     process.env.EVE_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri:  process.env.EVE_CALLBACK_URL,
    }),
  });
  const data = await res.json();
  return data;
}

// ─── Token refresh ────────────────────────────────────────────────────────────

/** In-flight refresh promise per character (avoid concurrent refresh for same character) */
const refreshLocks = new Map();

/**
 * Refresh an expired access token.
 * PKCE refresh tokens only need client_id — no client_secret.
 * EVE may return a new refresh_token (rotating); we persist it when present.
 */
async function refreshToken(characterId) {
  let lock = refreshLocks.get(characterId);
  if (lock) {
    // Wait for the in-flight refresh; if it fails, propagate the error rather than recursing.
    await lock;
    const row = getToken(characterId);
    if (!row) throw new Error(`No token found for character ${characterId} after refresh`);
    return row.access_token;
  }

  const promise = (async () => {
    const row = getToken(characterId);
    if (!row) throw new Error(`No token found for character ${characterId}`);

    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'refresh_token',
          refresh_token: row.refresh_token,
          client_id:     process.env.EVE_CLIENT_ID,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error_description || data.error || `HTTP ${res.status}`;
        console.error(`[Auth] Token refresh failed for character ${characterId}:`, msg);
        throw new Error(msg);
      }
      const expiresAt = Math.floor(Date.now() / 1000) + data.expires_in - 60;
      const newRefresh = data.refresh_token || row.refresh_token;
      updateAccessToken(characterId, data.access_token, expiresAt, newRefresh);
      console.log(`[Auth] Token refreshed for character ${characterId}`);
      return data.access_token;
    } catch (err) {
      console.error(`[Auth] Token refresh failed for character ${characterId}:`, err.message);
      throw err;
    } finally {
      refreshLocks.delete(characterId);
    }
  })();

  refreshLocks.set(characterId, promise);
  return promise;
}

/** Force a token refresh regardless of expires_at (e.g. after ESI 401). */
async function forceRefreshToken(characterId) {
  refreshLocks.delete(characterId);
  return refreshToken(characterId);
}

// ─── Token helpers ────────────────────────────────────────────────────────────

/** Get a valid (non-expired) access token, refreshing if needed */
async function getValidToken(characterId) {
  const row = getToken(characterId);
  if (!row) throw new Error('Not authenticated');
  if (Math.floor(Date.now() / 1000) < row.expires_at) return row.access_token;
  return refreshToken(characterId);
}

/** Decode EVE SSO JWT payload without external library */
function decodeJwt(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

/** Verify token and extract character + corporation info, then persist to DB */
async function verifyAndSave(tokenData) {
  const jwt      = decodeJwt(tokenData.access_token);
  // sub format: "CHARACTER:EVE:{character_id}"
  const charId   = parseInt(jwt.sub.split(':')[2], 10);
  const charName = jwt.name;
  const expiresAt = Math.floor(Date.now() / 1000) + tokenData.expires_in - 60;

  let corpId = null, corpName = null;
  try {
    const charRes = await fetch(`https://esi.evetech.net/latest/characters/${charId}/`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const charData = await charRes.json();
    corpId = charData.corporation_id;

    const corpRes = await fetch(`https://esi.evetech.net/latest/corporations/${corpId}/`);
    const corpData = await corpRes.json();
    corpName = corpData.name;
  } catch { /* non-critical — corp info will be null until next sync */ }

  saveToken({
    character_id:    charId,
    character_name:  charName,
    corporation_id:  corpId,
    corporation_name: corpName,
    access_token:    tokenData.access_token,
    refresh_token:   tokenData.refresh_token,
    expires_at:      expiresAt,
    scopes:          jwt.scp ? (Array.isArray(jwt.scp) ? jwt.scp.join(' ') : jwt.scp) : '',
  });

  // Clear any previously-cached failed structure resolutions so they get retried
  // with the potentially-updated scope set (e.g. after adding esi-universe.read_structures.v1).
  db.prepare("DELETE FROM name_cache WHERE type = 'failed'").run();

  const grantedScopes = jwt.scp ? (Array.isArray(jwt.scp) ? jwt.scp : [jwt.scp]) : [];
  return { charId, charName, corpId, corpName, grantedScopes };
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/** Express middleware: require authenticated session */
function requireAuth(req, res, next) {
  if (req.session && req.session.characterId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

module.exports = { buildAuthUrl, exchangeCode, verifyAndSave, getValidToken, forceRefreshToken, requireAuth, REQUIRED_SCOPES };
