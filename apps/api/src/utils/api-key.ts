import crypto from 'crypto';

export function generateApiKey(prefix: string = 'sk_live'): { rawKey: string; keyHash: string; keyPrefix: string } {
  const randomSecret = crypto.randomBytes(24).toString('base64url');
  const rawKey = `${prefix}_${randomSecret}`;
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12);

  return { rawKey, keyHash, keyPrefix };
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
}

