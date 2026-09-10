import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Entry } from "@napi-rs/keyring";
import type { JobberTokens } from "./oauth.js";

function tokenPaths() {
  const configured = (process.env.JOBBER_STATE_DIR ?? "").trim();
  const directory = configured ? path.resolve(configured) : path.join(os.homedir(), ".jobber-mcp");
  return {
    directory,
    tokenFile: path.join(directory, "tokens.enc"),
    keyFile: path.join(directory, "key.hex"),
    lockFile: path.join(directory, "tokens.lock"),
  };
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // NIST SP 800-38D recommends 96-bit GCM nonces
const AUTH_TAG_LENGTH = 16;
const KEYCHAIN_SERVICE = "jobber-mcp";
const KEYCHAIN_ACCOUNT = "encryption-key";

// Cross-process coordination for token refresh: two OS processes (e.g. two Claude Desktop
// windows) can share ~/.jobber-mcp/tokens.enc. The in-process in-flight-promise dedup in oauth.ts
// only prevents races within one process; this lock prevents two processes from refreshing
// concurrently and one's saveTokens() stomping the other's rotated refresh token.
const LOCK_STALE_MS = 30_000; // treat a lock older than this as abandoned by a crashed process
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;

export async function getEncryptionKey(): Promise<Buffer> {
  const { directory, keyFile } = tokenPaths();
  const envKey = process.env.ENCRYPTION_KEY;

  // 1. Env var override (CI/headless, backward compat)
  if (envKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(envKey))
      throw new Error(
        `ENCRYPTION_KEY must be 64 hex chars (32 bytes for AES-256). Got ${envKey.length} chars.`
      );
    try {
      const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      if (!entry.getPassword()) {
        entry.setPassword(envKey);
        console.error("[tokenStorage] Migrated ENCRYPTION_KEY from env to OS keychain. You may remove it from .env.");
      }
    } catch (keychainErr: any) {
      console.error(`[tokenStorage] Keychain write skipped (${keychainErr.message}).`);
    }
    return Buffer.from(envKey, "hex");
  }

  // 2. OS keychain (macOS / Windows Credential Manager / desktop Linux)
  try {
    const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    let keyHex = entry.getPassword();
    if (!keyHex) {
      keyHex = crypto.randomBytes(32).toString("hex");
      entry.setPassword(keyHex);
      console.error("[tokenStorage] Generated encryption key and saved to OS keychain.");
    }
    return Buffer.from(keyHex, "hex");
  } catch (keychainErr: any) {
    console.error(`[tokenStorage] Keychain unavailable (${keychainErr.message}), using file fallback.`);
  }

  // 3. File fallback: ~/.jobber-mcp/key.hex (mode 0600) - WSL2 / headless Linux
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // mkdir's mode is a no-op when the directory already existed with looser permissions - repair it.
  await fs.chmod(directory, 0o700).catch(() => {});
  try {
    const keyHex = (await fs.readFile(keyFile, "utf8")).trim();
    // Same repair as above: writeFile's {mode} option only applies at creation, so re-apply it on
    // every read in case an older version of this code (or a restored backup) left it looser.
    await fs.chmod(keyFile, 0o600).catch(() => {});
    return Buffer.from(keyHex, "hex");
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
  const keyHex = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(keyFile, keyHex, { mode: 0o600 });
  await fs.chmod(keyFile, 0o600).catch(() => {});
  console.error(`[tokenStorage] OS keychain unavailable. Generated encryption key in ${directory} (mode 0600).`);
  return Buffer.from(keyHex, "hex");
}

export async function saveTokens(tokens: JobberTokens): Promise<void> {
  const { directory, tokenFile } = tokenPaths();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);

  const key = await getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const plaintext = JSON.stringify(tokens);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, authTag, encrypted]);
  // Write to a temp file then rename, so a crash mid-write can never leave TOKEN_FILE truncated -
  // fs.rename is atomic on the same filesystem, and readers only ever see the old or new content.
  const tmpFile = `${tokenFile}.tmp-${process.pid}`;
  await fs.writeFile(tmpFile, combined, { mode: 0o600 });
  await fs.chmod(tmpFile, 0o600);
  await fs.rename(tmpFile, tokenFile);
}

export async function loadTokens(): Promise<JobberTokens | null> {
  const { tokenFile } = tokenPaths();
  let combined: Buffer;
  try {
    combined = await fs.readFile(tokenFile);
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  try {
    const key = await getEncryptionKey();
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    return JSON.parse(decrypted.toString("utf8")) as JobberTokens;
  } catch (err: any) {
    console.error(
      `[tokenStorage] WARNING: Token file exists but decryption failed. ` +
      `File may be corrupt or ENCRYPTION_KEY has changed. Detail: ${err.message}`
    );
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  const { tokenFile } = tokenPaths();
  try {
    await fs.unlink(tokenFile);
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err; // ENOENT = already gone, that's fine
  }
}

/**
 * Runs `fn` while holding an exclusive, cross-process lock on the token file. Acquired via
 * `fs.open(LOCK_FILE, "wx")` (exclusive create - fails if the lock already exists); a lock older
 * than LOCK_STALE_MS is assumed abandoned by a crashed process and removed. Callers should re-read
 * token state from disk inside `fn` rather than trusting state captured before the lock was held,
 * since another process may have refreshed and saved while this one was waiting.
 */
export async function withTokenLock<T>(fn: () => Promise<T>): Promise<T> {
  const { directory, lockFile } = tokenPaths();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const start = Date.now();

  for (;;) {
    try {
      const handle = await fs.open(lockFile, "wx");
      await handle.close();
      break;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;

      try {
        const stat = await fs.stat(lockFile);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockFile).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock file vanished between EEXIST and stat - retry immediately
      }

      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(
          "Timed out waiting for the token file lock - another process may be stuck refreshing."
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }

  try {
    return await fn();
  } finally {
    await fs.unlink(lockFile).catch(() => {});
  }
}
