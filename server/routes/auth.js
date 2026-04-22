'use strict';
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { buildAuthUrl, exchangeCode, verifyAndSave, REQUIRED_SCOPES } = require('../auth');
const { getToken, db } = require('../db');

// GET /auth/login — redirect to EVE SSO
router.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const { url, codeVerifier } = buildAuthUrl(state);

  // Store both state (CSRF protection) and codeVerifier (PKCE) in session
  req.session.oauthState    = state;
  req.session.codeVerifier  = codeVerifier;

  // Explicitly save before redirect — ensures state is committed to the
  // session store before EVE SSO redirects back to /auth/callback.
  req.session.save(() => res.redirect(url));
});

// GET /auth/callback — EVE SSO redirects here after user approves
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (state !== req.session.oauthState) {
    return res.redirect('/?auth_error=oauth_state');
  }

  const codeVerifier = req.session.codeVerifier;

  // Clean up session — these are single-use
  delete req.session.oauthState;
  delete req.session.codeVerifier;

  if (!codeVerifier) {
    return res.status(400).send('Missing PKCE verifier. Please try logging in again.');
  }

  try {
    const tokenData = await exchangeCode(code, codeVerifier);
    const { charId, charName, corpId, corpName, grantedScopes } = await verifyAndSave(tokenData);

    // Check all required scopes were granted
    const missingScopes = REQUIRED_SCOPES.filter(s => !grantedScopes.includes(s));
    if (missingScopes.length > 0) {
      console.warn(`[Auth] ${charName} logged in but missing scopes:`, missingScopes);
      return res.redirect(`/?auth_error=missing_scopes&missing=${encodeURIComponent(missingScopes.join(','))}&char=${encodeURIComponent(charName)}`);
    }

    req.session.characterId   = charId;
    req.session.characterName = charName;
    req.session.corporationId = corpId;

    // Kick off immediate sync for the newly authenticated character
    const { updateSchedulerCharacter, runFullSync } = require('../scheduler');
    updateSchedulerCharacter(charId);
    runFullSync(charId).catch(e => console.error('Initial sync error:', e));

    res.redirect('/');
  } catch (err) {
    console.error('Auth callback error:', err.message, err.response?.data ?? '');
    res.redirect('/?auth_error=failed');
  }
});

// GET /auth/logout — browser navigation (redirects back to login page)
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// POST /auth/logout — programmatic logout (returns JSON, used by shutdown flow)
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /auth/me — returns current session info (used by frontend to check login state)
router.get('/me', (req, res) => {
  if (!req.session?.characterId) {
    // Not logged in — but return the last known corp so the login page
    // can personalise itself for returning users (name + logo).
    const last = db.prepare(
      'SELECT corporation_id, corporation_name FROM tokens ORDER BY expires_at DESC LIMIT 1'
    ).get();
    return res.json({
      loggedIn:     false,
      lastCorpId:   last?.corporation_id   || null,
      lastCorpName: last?.corporation_name || null,
    });
  }

  const token = getToken(req.session.characterId);
  res.json({
    loggedIn:        true,
    characterId:     req.session.characterId,
    characterName:   req.session.characterName,
    corporationId:   req.session.corporationId,
    corporationName: token?.corporation_name || null,
    scopes:          token?.scopes || null,
  });
});

module.exports = router;
