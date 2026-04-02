'use strict';

const crypto = require('crypto');

// Encrypt/decrypt sensitive values for DB storage.
// 1) Electron: safeStorage (DPAPI) — prefix "enc:"
// 2) Node-only: AES-256-GCM with key from SESSION_SECRET — prefix "enc2:"
// 3) Legacy: plaintext (no prefix) — returned as-is for backward compatibility.

const ENC2_SALT = 'eve-corp-manager-secret';
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

function getSafeStorage() {
  try {
    const { safeStorage } = require('electron');
    return safeStorage;
  } catch {
    return null;
  }
}

function getSecretKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret === 'change-me-in-production') return null;
  return crypto.scryptSync(secret, ENC2_SALT, 32);
}

function encryptValue(plaintext) {
  if (!plaintext) return '';
  const ss = getSafeStorage();
  if (ss && ss.isEncryptionAvailable()) {
    return 'enc:' + ss.encryptString(plaintext).toString('base64');
  }
  const key = getSecretKey();
  if (!key) return plaintext;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LEN });
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc2:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptValue(stored) {
  if (!stored) return '';
  if (!stored.startsWith('enc')) return stored;

  if (stored.startsWith('enc:')) {
    const ss = getSafeStorage();
    if (!ss || !ss.isEncryptionAvailable()) return '';
    try {
      return ss.decryptString(Buffer.from(stored.slice(4), 'base64'));
    } catch {
      return '';
    }
  }

  if (stored.startsWith('enc2:')) {
    const key = getSecretKey();
    if (!key) return '';
    try {
      const buf = Buffer.from(stored.slice(5), 'base64');
      const iv = buf.subarray(0, IV_LEN);
      const tag = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
      const ciphertext = buf.subarray(IV_LEN + AUTH_TAG_LEN);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LEN });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  return stored;
}

module.exports = { encryptValue, decryptValue };
