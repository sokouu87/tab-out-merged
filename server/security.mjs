import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export const SESSION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
export const SCRYPT_OPTIONS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});

export async function createPasswordRecord(password, saltHex = randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), 64, SCRYPT_OPTIONS);
  return {
    passwordSalt: saltHex,
    passwordHash: Buffer.from(derived).toString('hex'),
  };
}

export async function verifyPassword(password, config) {
  try {
    const expected = Buffer.from(config.passwordHash, 'hex');
    const actual = Buffer.from(
      await scrypt(password, Buffer.from(config.passwordSalt, 'hex'), expected.length, SCRYPT_OPTIONS),
    );
    return expected.length > 0 && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hmac(payload, secretHex) {
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update(payload).digest();
}

export function signSessionToken(username, secretHex, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    u: username,
    iat: issuedAt,
    exp: issuedAt + SESSION_MAX_AGE_SECONDS,
  })).toString('base64url');
  return `${payload}.${hmac(payload, secretHex).toString('base64url')}`;
}

export function verifySessionToken(token, { username, secretHex, now = Date.now() }) {
  if (typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;

  try {
    const expected = hmac(payload, secretHex);
    const received = Buffer.from(signature, 'base64url');
    const sameLength = received.length === expected.length;
    const comparable = sameLength ? received : Buffer.alloc(expected.length);
    if (!timingSafeEqual(expected, comparable) || !sameLength) return null;

    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const nowSeconds = Math.floor(now / 1000);
    if (
      parsed?.u !== username ||
      !Number.isInteger(parsed.iat) ||
      !Number.isInteger(parsed.exp) ||
      parsed.exp <= nowSeconds ||
      parsed.iat > nowSeconds + 60
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function secretsEqual(provided, expected) {
  const providedBuffer = Buffer.from(String(provided ?? ''), 'utf8');
  const expectedBuffer = Buffer.from(String(expected ?? ''), 'utf8');
  const sameLength = providedBuffer.length === expectedBuffer.length;
  const comparable = sameLength ? providedBuffer : Buffer.alloc(expectedBuffer.length);
  return expectedBuffer.length > 0 && timingSafeEqual(expectedBuffer, comparable) && sameLength;
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}
