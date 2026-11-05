import crypto from 'crypto';

// Symmetric encryption for secrets at rest (integration API keys).
// AES-256-GCM with a key derived from SECRET_ENC_KEY. The derivation lets us
// accept an arbitrary-length env secret; set a strong SECRET_ENC_KEY in prod.

// In production a missing SECRET_ENC_KEY must be a hard failure — silently
// falling back to the (public, in-repo) dev key would encrypt every customer
// credential with a key anyone can derive. Checked lazily on first use (not at
// module load) so `next build` can collect page data without prod secrets.
let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (!process.env.SECRET_ENC_KEY && process.env.NODE_ENV === 'production') {
    throw new Error('SECRET_ENC_KEY must be set in production (secrets-at-rest encryption key).');
  }
  cachedKey = crypto.scryptSync(
    process.env.SECRET_ENC_KEY || 'callsera-default-dev-secret-change-me',
    'callsera-secret-salt',
    32,
  );
  return cachedKey;
}

// Stored format: ivHex:tagHex:cipherHex
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptSecret(stored: string): string {
  const [ivHex, tagHex, dataHex] = stored.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('malformed ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

// Binary variants, for file blobs stored in `Bytes` columns (patient
// prescription scans). Same key and cipher as above; the layout is packed
// (iv‖tag‖ciphertext) rather than hex-delimited because hex would double the
// size of every stored file.
const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptBytes(plain: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function decryptBytes(stored: Buffer): Buffer {
  if (stored.length < IV_LEN + TAG_LEN) throw new Error('malformed ciphertext');
  const iv = stored.subarray(0, IV_LEN);
  const tag = stored.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(stored.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
}
