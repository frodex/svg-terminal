import { createHmac, timingSafeEqual } from 'node:crypto';

export function createSessionCookie(payload, secret, maxAgeSeconds) {
  const data = { ...payload, exp: Math.floor(Date.now() / 1000) + maxAgeSeconds };
  const json = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = createHmac('sha256', secret).update(json).digest('base64url');
  return `${json}.${sig}`;
}

export function validateSessionCookie(cookie, secret) {
  if (!cookie || typeof cookie !== 'string') return null;
  const parts = cookie.split('.');
  if (parts.length !== 2) return null;
  const [json, sig] = parts;
  const expectedSig = createHmac('sha256', secret).update(json).digest('base64url');
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  } catch { return null; }
  try {
    const payload = JSON.parse(Buffer.from(json, 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}
