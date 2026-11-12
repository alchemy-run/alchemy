import { createHmac, randomBytes } from "node:crypto";
import { gcmsiv } from "@noble/ciphers/aes.js";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Convex's admin key, computed the way the backend's `generate_key` does it
 * (`crates/keybroker` in convex-backend), so deploying needs no Docker:
 *
 * ```
 * key  = KBKDF-CTR-HMAC-SHA256(secret, "admin key")[0..16]
 * body = AdminKey { issued_s, member_id: 0 }          // convex_keys.proto
 * key  = `${instanceName}|` + hex(1 || nonce || AES-128-GCM-SIV(key, nonce, aad = 1, body))
 * ```
 *
 * The backend checks a key by decrypting it with its own secret, so a key made
 * here is as good as one from `generate_key`. A test runs the real backend
 * image against these keys, so a format change in a new image fails there.
 */

/** `ADMIN_KEY_VERSION` in keybroker. Sealed as the AAD and leads the bytes. */
const ADMIN_KEY_VERSION = 1;
/** `Purpose::ADMIN_KEY` in keybroker. */
const ADMIN_KEY_PURPOSE = "admin key";
const KEY_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

export class InvalidInstanceSecret extends Data.TaggedError("InvalidInstanceSecret")<{
  readonly message: string;
}> {}

export class InvalidAdminKey extends Data.TaggedError("InvalidAdminKey")<{
  readonly message: string;
}> {}

/** What an admin key says once opened. */
export interface AdminKeyClaims {
  instanceName: string;
  issuedAt: number;
  memberId: bigint;
}

const secretBytes = (instanceSecret: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const hex = Redacted.value(instanceSecret);
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      // Never repeat the value: it is the backend's root secret.
      return yield* new InvalidInstanceSecret({
        message: `The instance secret must be 32 bytes as 64 hex characters, not ${hex.length} characters.`,
      });
    }
    return Buffer.from(hex, "hex");
  });

/**
 * SP 800-108 counter-mode KDF with HMAC-SHA256, as aws-lc's `kbkdf_ctr_hmac`
 * computes it: `HMAC(secret, be32(1) || label)`. 16 bytes take one block.
 */
const deriveKey = (secret: Uint8Array) =>
  Effect.sync(() =>
    createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(ADMIN_KEY_PURPOSE)]))
      .digest()
      .subarray(0, KEY_LENGTH),
  );

const varint = (value: bigint) => {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80n) {
    bytes.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return bytes;
};

/**
 * `AdminKey { issued_s = 2; oneof identity { member_id = 3 } }`. `member_id`
 * is written even when 0, because a oneof member is always present.
 */
const encodeClaims = (issuedAt: number, memberId: bigint) =>
  Uint8Array.from([0x10, ...varint(BigInt(issuedAt)), 0x18, ...varint(memberId)]);

const decodeClaims = (bytes: Uint8Array) => {
  let offset = 0;
  const readVarint = () => {
    let value = 0n;
    let shift = 0n;
    while (offset < bytes.length) {
      const byte = bytes[offset++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
    }
    return undefined;
  };
  const claims: { issuedAt?: number; memberId?: bigint } = {};
  while (offset < bytes.length) {
    const tag = readVarint();
    if (tag === undefined || (tag & 7n) !== 0n) return undefined;
    const value = readVarint();
    if (value === undefined) return undefined;
    if (tag >> 3n === 2n) claims.issuedAt = Number(value);
    if (tag >> 3n === 3n) claims.memberId = value;
  }
  return claims.issuedAt !== undefined && claims.memberId !== undefined
    ? { issuedAt: claims.issuedAt, memberId: claims.memberId }
    : undefined;
};

/** Mint an admin key for member 0, the generic admin `generate_key` issues. */
export const mintAdminKey = Effect.fn(function* (input: {
  instanceName: string;
  instanceSecret: Redacted.Redacted<string>;
}) {
  const key = yield* deriveKey(yield* secretBytes(input.instanceSecret));
  const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const nonce = yield* Effect.sync(() => randomBytes(NONCE_LENGTH));
  const version = Uint8Array.of(ADMIN_KEY_VERSION);
  const sealed = yield* Effect.sync(() =>
    gcmsiv(key, nonce, version).encrypt(encodeClaims(issuedAt, 0n)),
  );
  const hex = Buffer.concat([version, nonce, sealed]).toString("hex");
  return Redacted.make(`${input.instanceName}|${hex}`);
});

/**
 * Open an admin key the way the backend's `check_admin_key` does. Tests use it
 * to check keys minted by the real `generate_key` against this derivation.
 */
export const openAdminKey = Effect.fn(function* (
  adminKey: Redacted.Redacted<string>,
  instanceSecret: Redacted.Redacted<string>,
) {
  const invalid = (reason: string) =>
    new InvalidAdminKey({ message: `Invalid admin key: ${reason}.` });
  const [instanceName, hex] = Redacted.value(adminKey).split("|");
  if (instanceName === undefined || hex === undefined || !/^([0-9a-f]{2})+$/i.test(hex)) {
    return yield* invalid("expected <instance name>|<hex>");
  }
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length < 1 + NONCE_LENGTH + TAG_LENGTH || bytes[0] !== ADMIN_KEY_VERSION) {
    return yield* invalid(`expected version ${ADMIN_KEY_VERSION}`);
  }
  const key = yield* deriveKey(yield* secretBytes(instanceSecret));
  const opened = yield* Effect.sync(() => {
    try {
      return gcmsiv(key, bytes.subarray(1, 1 + NONCE_LENGTH), bytes.subarray(0, 1)).decrypt(
        bytes.subarray(1 + NONCE_LENGTH),
      );
    } catch {
      return undefined;
    }
  });
  if (opened === undefined) return yield* invalid("it was not sealed with this secret");
  const claims = decodeClaims(opened);
  if (claims === undefined) return yield* invalid("its body is not an AdminKey");
  return { instanceName, ...claims } satisfies AdminKeyClaims;
});
