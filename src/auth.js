import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || "").split(":");
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)]),
  );
}

export function agentKeyFingerprint(publicKeyPem) {
  const key = createPublicKey(String(publicKeyPem));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Agent public key must be Ed25519");
  }
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("base64url");
}

export function canonicalAgentRequest({ method, path, timestamp, nonce, body = Buffer.alloc(0) }) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `${String(method).toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

export function verifyAgentRequestSignature({ publicKeyPem, signature, ...request }) {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    const canonical = canonicalAgentRequest(request);
    return cryptoVerify(null, Buffer.from(canonical), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(input) {
  const bytes = Buffer.from(input);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/g, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const output = [];
  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 value");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret, timestamp = Date.now(), stepSeconds = 30) {
  const counter = Math.floor(timestamp / 1000 / stepSeconds);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret, code, timestamp = Date.now()) {
  const supplied = Buffer.from(String(code || "").padStart(6, "0"));
  for (const offset of [-30_000, 0, 30_000]) {
    const expected = Buffer.from(totpCode(secret, timestamp + offset));
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return true;
  }
  return false;
}

function encryptionKey(encodedKey) {
  const key = Buffer.from(String(encodedKey || ""), "base64");
  if (key.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}

export function encryptSecret(plaintext, encodedKey) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(encodedKey), nonce);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ciphertext]).toString("base64url");
}

export function decryptSecret(value, encodedKey) {
  const packed = Buffer.from(String(value), "base64url");
  if (packed.length < 29) throw new Error("Encrypted secret is malformed");
  const nonce = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(encodedKey), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
