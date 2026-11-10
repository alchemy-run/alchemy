import { createHash } from "node:crypto";
import { expect } from "@alchemy.run/test";
import type { StateService } from "alchemy/State";
import { SEALED_PREFIX, SEALED_RECORD_MARKER } from "alchemy/State/StateEncryption";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** The fixture's stack. */
export const STACK = "StateUpgrade";

/** The resources the fixture declares; `Large` only with `UPGRADE_LARGE`. */
export const FQNS = ["Secret", "Token", "Large"] as const;

/** A deterministic store name for this user and worktree, `<prefix>-<hash>`. */
export const storeNameFor = (prefix: string, stage: string) =>
  `${prefix}-${createHash("sha256").update(stage).digest("hex").slice(0, 8)}`;

/**
 * The plaintext secrets in a stored record: every `__redacted__` value, as
 * every released version writes a `Redacted`.
 */
export const plaintextSecrets = (text: string): string[] => {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value === null || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === "__redacted__" && typeof inner === "string") found.push(inner);
      else walk(inner);
    }
  };
  walk(JSON.parse(text));
  return found;
};

/** The secrets of a set of stored records, sorted, so two sets compare by value. */
export const secretsOfTexts = (texts: Iterable<string>) =>
  [...texts].flatMap(plaintextSecrets).sort();

/** Every `Redacted` value in a decoded record. */
const redactedValues = (value: unknown): string[] => {
  if (Redacted.isRedacted(value)) {
    const inner = Redacted.value(value);
    return typeof inner === "string" ? [inner] : [];
  }
  if (Array.isArray(value)) return value.flatMap(redactedValues);
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(redactedValues);
};

/**
 * The secrets of a stage as the new version reads them back, records and
 * stack output, sorted. Equal to {@link secretsOfTexts} of what the released
 * version wrote when nothing was lost or changed. The store is opened for
 * the read and closed after it, so it lets go of the stage's lease before
 * the next deploy.
 */
export const secretsThroughStore = <E, R>(open: Effect.Effect<StateService, E, R>, stage: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const state = yield* open;
      const fqns = yield* state.list({ stack: STACK, stage });
      const records = yield* Effect.forEach(fqns, (fqn) => state.get({ stack: STACK, stage, fqn }));
      const output = yield* state.getOutput({ stack: STACK, stage });
      return [...records, output].flatMap(redactedValues).sort();
    }),
  );

/** Every record is sealed, and no secret appears in its text. */
export const expectSealed = (texts: Iterable<string>, secrets: ReadonlyArray<string>) => {
  for (const text of texts) {
    expect(text.startsWith(SEALED_PREFIX)).toBe(true);
    for (const secret of secrets) expect(text.includes(secret)).toBe(false);
  }
};

/** Every record is plaintext JSON, as the released version reads it. */
export const expectPlaintext = (texts: Iterable<string>) => {
  for (const text of texts) {
    expect(text.startsWith(SEALED_PREFIX)).toBe(false);
    expect(() => JSON.parse(text)).not.toThrow();
  }
};

/**
 * Every JSON record (Postgres, HTTP) carries a sealed header, and no secret
 * appears in its text.
 */
export const expectSealedJson = (texts: Iterable<string>, secrets: ReadonlyArray<string>) => {
  for (const text of texts) {
    expect(Object.keys(JSON.parse(text) as object)).toContain(SEALED_RECORD_MARKER);
    for (const secret of secrets) expect(text.includes(secret)).toBe(false);
  }
};
