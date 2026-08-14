/**
 * Credential-free unit tests for the Vercel state store's row codec
 * (AES-CTR framing) and Blob pathname scheme — the pure halves shared by
 * the deployed state Function and the CLI.
 */
import {
  decryptRow,
  encryptRow,
  importStateKey,
  NONCE_BYTES,
} from "@/Vercel/StateStore/Codec";
import {
  familyBaseOf,
  isFamilyMember,
  latestOfFamily,
  outputKey,
  parseRowKey,
  parseStackIndexKey,
  pickLatestPerFamily,
  revisionedKey,
  revisionToken,
  rowKey,
  stackIndexKey,
  stackOutputsPrefix,
  stackRowsPrefix,
  stagePrefix,
} from "@/Vercel/StateStore/Keys";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";

const KEY_HEX =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const OTHER_KEY_HEX =
  "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

describe("Vercel StateStore Codec", () => {
  test("encrypt → decrypt round-trips a resource row", async () => {
    const value = {
      kind: "resource",
      fqn: "stack/scope/resource-a",
      instanceId: "inst-a",
      props: { hello: "world", nested: { count: 42, flag: true } },
      attr: { id: "inst-a" },
    };
    const roundTripped = await Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* importStateKey(KEY_HEX);
        const framed = yield* encryptRow(key, value);
        // Framed base64: nonce || ciphertext, never the plaintext.
        expect(framed).not.toContain("hello");
        expect(Buffer.from(framed, "base64").byteLength).toBeGreaterThanOrEqual(
          NONCE_BYTES,
        );
        return yield* decryptRow(key, framed);
      }),
    );
    expect(roundTripped).toEqual(value);
  });

  test("two encryptions of the same value differ (random nonce)", async () => {
    const [a, b] = await Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* importStateKey(KEY_HEX);
        return [
          yield* encryptRow(key, { v: 1 }),
          yield* encryptRow(key, { v: 1 }),
        ] as const;
      }),
    );
    expect(a).not.toEqual(b);
  });

  test("decrypting with the wrong key resolves to undefined (never throws)", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* importStateKey(KEY_HEX);
        const wrongKey = yield* importStateKey(OTHER_KEY_HEX);
        const framed = yield* encryptRow(key, { secret: "value" });
        return yield* decryptRow(wrongKey, framed);
      }),
    );
    // AES-CTR with the wrong key yields garbage bytes — JSON.parse fails
    // and the codec degrades to undefined so the engine reconciles.
    expect(result).toBeUndefined();
  });
});

describe("Vercel StateStore Keys", () => {
  test("rowKey encodes separators so FQNs cannot collide with the scheme", () => {
    const key = rowKey("my-stack", "dev", "stack/scope/resource-a");
    expect(key).toBe("r/my-stack/dev/stack%2Fscope%2Fresource-a");
    expect(key.startsWith(stagePrefix("my-stack", "dev"))).toBe(true);
    expect(key.startsWith(stackRowsPrefix("my-stack"))).toBe(true);
  });

  test("parseRowKey round-trips awkward names", () => {
    const stack = "we/ird stack";
    const stage = "st%age";
    const fqn = "a/b/c d%2F";
    expect(parseRowKey(rowKey(stack, stage, fqn))).toEqual({
      stack,
      stage,
      fqn,
    });
  });

  test("parseRowKey rejects foreign pathnames", () => {
    expect(parseRowKey("o/stack/stage")).toBeUndefined();
    expect(parseRowKey("s/stack")).toBeUndefined();
    expect(parseRowKey("r/only-two/segments")).toBeUndefined();
    expect(parseRowKey("r/a/b/c/d")).toBeUndefined();
  });

  test("stage prefixes do not collide across stages sharing a name prefix", () => {
    // `dev` vs `dev2` — the trailing `/` separates them.
    const key = rowKey("s", "dev2", "fqn");
    expect(key.startsWith(stagePrefix("s", "dev"))).toBe(false);
  });

  test("output keys live under the o/ prefix and parse nowhere else", () => {
    const key = outputKey("my-stack", "dev");
    expect(key).toBe("o/my-stack/dev");
    expect(key.startsWith(stackOutputsPrefix("my-stack"))).toBe(true);
    expect(parseRowKey(key)).toBeUndefined();
  });

  test("stack index keys round-trip and reject nested paths", () => {
    expect(parseStackIndexKey(stackIndexKey("my/stack"))).toBe("my/stack");
    expect(parseStackIndexKey("s/")).toBeUndefined();
    expect(parseStackIndexKey("s/a/b")).toBeUndefined();
    expect(parseStackIndexKey("r/a")).toBeUndefined();
  });
});

describe("Vercel StateStore Revisions", () => {
  const base = rowKey("stack", "stage", "my/fqn");

  test("revision tokens sort by timestamp, revisioned keys parse to the base", () => {
    const older = revisionToken(999, "zzzzzz");
    const newer = revisionToken(1_000, "aaaaaa");
    expect(older < newer).toBe(true);
    const key = revisionedKey(base, newer);
    expect(familyBaseOf(key)).toBe(base);
    expect(parseRowKey(key)).toEqual(parseRowKey(base));
  });

  test("the @ delimiter cannot appear in encoded segments", () => {
    // `@` in stack/stage/fqn is URI-encoded, so a literal `@` always
    // marks the revision suffix.
    const tricky = rowKey("st@ck", "sta@ge", "fq@n");
    expect(tricky).not.toContain("@");
    expect(parseRowKey(revisionedKey(tricky, revisionToken(1, "x")))).toEqual({
      stack: "st@ck",
      stage: "sta@ge",
      fqn: "fq@n",
    });
  });

  test("latestOfFamily prefers the highest revision over the legacy base", () => {
    const r1 = revisionedKey(base, revisionToken(1_000, "aa"));
    const r2 = revisionedKey(base, revisionToken(2_000, "aa"));
    // Sibling rows sharing the base as a name prefix are NOT family.
    const sibling = `${base}x`;
    const siblingRev = revisionedKey(`${base}x`, revisionToken(9_000, "zz"));
    expect(latestOfFamily(base, [base, r1, r2, sibling, siblingRev])).toBe(r2);
    expect(latestOfFamily(base, [r2, r1])).toBe(r2);
    expect(latestOfFamily(base, [base])).toBe(base);
    expect(latestOfFamily(base, [sibling, siblingRev])).toBeUndefined();
    expect(latestOfFamily(base, [])).toBeUndefined();
  });

  test("isFamilyMember distinguishes revisions from prefix-sharing siblings", () => {
    expect(isFamilyMember(base, base)).toBe(true);
    expect(isFamilyMember(base, revisionedKey(base, "r"))).toBe(true);
    expect(isFamilyMember(base, `${base}x`)).toBe(false);
    expect(isFamilyMember(base, revisionedKey(`${base}x`, "r"))).toBe(false);
  });

  test("pickLatestPerFamily returns one pathname per row", () => {
    const otherBase = rowKey("stack", "stage", "other");
    const picked = pickLatestPerFamily([
      base,
      revisionedKey(base, revisionToken(1_000, "aa")),
      revisionedKey(base, revisionToken(2_000, "aa")),
      otherBase,
      revisionedKey(otherBase, revisionToken(500, "bb")),
      outputKey("stack", "stage"),
    ]);
    expect(picked.sort()).toEqual(
      [
        revisionedKey(base, revisionToken(2_000, "aa")),
        revisionedKey(otherBase, revisionToken(500, "bb")),
        outputKey("stack", "stage"),
      ].sort(),
    );
  });
});
