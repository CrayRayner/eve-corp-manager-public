'use strict';
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const fs = require('fs');
const { buildAuthUrl, exchangeCode, verifyAndSave, REQUIRED_SCOPES } = require('../auth');
const { getToken, db } = require('../db');
const recovery = require('../db-recovery');

// ── Database recovery (available WITHOUT login) ───────────────────────────────
// A corrupt database breaks the login itself (the callback writes corporation_id),
// so Settings → Backup & Restore becomes unreachable exactly when it is needed.
// These routes expose the same backup/restore logic on the login screen.
//
// Security: state-changing routes here have no session cookie to protect them,
// so sameOriginOnly() blocks cross-origin POSTs from any page in a normal browser.
// Beyond that, anything able to reach localhost can already read and replace the
// database on disk directly — these routes grant no additional access.

// GET /auth/recovery-status — is the database healthy? (drives the login-screen panel)
router.get('/recovery-status', (req, res) => {
  const status = recovery.getStatus();
  res.json({
    healthy:  status.healthy,
    verdict:  status.healthy ? 'ok' : String(status.verdict).split('\n')[0].slice(0, 200),
    exists:   status.exists,
    loggedIn: !!(req.session && req.session.characterId),
  });
});

// GET /auth/recovery-backup — download a snapshot of the CURRENT database.
// Works even when damaged: salvaging what is left beats overwriting it blindly.
router.get('/recovery-backup', recovery.sameOriginOnly, async (req, res) => {
  let tmpPath;
  try {
    tmpPath = await recovery.createSnapshot();
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="corp-backup-${date}.db"`);
    const stream = fs.createReadStream(tmpPath);
    stream.pipe(res);
    stream.on('close', () => { try { fs.unlinkSync(tmpPath); } catch {} });
  } catch (err) {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch {} }
    res.status(500).json({ error: 'Backup failed: ' + err.message });
  }
});

// POST /auth/recovery-restore — upload a .db backup; applied on next launch
router.post('/recovery-restore', recovery.sameOriginOnly, (req, res, next) => {
  recovery.upload.single('file')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      res.json(recovery.stageRestore(req.file.path));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
});

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
