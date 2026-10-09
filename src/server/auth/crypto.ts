import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../db/paths";

/**
 * AES-256-GCM for integration secrets (API keys, OAuth tokens) at rest.
 * Key: ENCRYPTION_KEY (32 bytes, base64). In development a key is generated
 * once into ~/.outbound-os/dev-encryption.key so nothing needs configuring locally.
 */
let cached: Buffer | null = null;

function key(): Buffer {
  if (cached) return cached;
  const env = process.env.ENCRYPTION_KEY;
  if (env) {
    const k = Buffer.from(env, "base64");
    if (k.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
    cached = k;
    return k;
  }
  if (process.env.NODE_ENV === "production" && process.env.DATABASE_URL) {
    throw new Error("ENCRYPTION_KEY is required in production");
  }
  const file = path.join(dataDir(), "dev-encryption.key");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  cached = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  return cached;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(".");
}

export function decryptSecret(blob: string): string {
  const [v, ivB, tagB, encB] = blob.split(".");
  if (v !== "v1") throw new Error("Unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encB, "base64url")), decipher.final()]).toString("utf8");
}

/** "sk-…a1b2" — for showing that a secret is set without revealing it. */
export function maskSecret(s: string): string {
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}
