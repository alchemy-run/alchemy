import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { parseAuthorizedKey } from "@alchemy.run/digitalocean/internal/authorizedKey";
import { getAccount, type NotFound } from "@distilled.cloud/digitalocean";
import { isActionState, State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/** A droplet takes minutes to create and destroy, so `--fast` skips it. */
export const skipSlow = !!process.env.FAST;

/**
 * A name unique to the user and worktree running the test (`stack.stage`),
 * and the same on every run. DigitalOcean names allow lowercase letters,
 * digits and `-`, so the stage's other characters become `-`.
 */
export const testName = (stage: string, suffix: string) =>
  `${stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${suffix}`;

// DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * An `authorized_keys` line for an Ed25519 key derived from the stage and
 * `label`. DigitalOcean registers a key's material once per team, so each
 * user and worktree needs its own material; the same stage gets the same
 * key on every run.
 */
export const testPublicKey = (stage: string, label: string) =>
  Effect.sync(() => {
    const seed = createHash("sha256").update(`${stage}\0${label}`).digest();
    const privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
    const pem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    return parseAuthorizedKey(pem);
  }).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.map((key) => `${key.line} ${label}`),
    Effect.orDie,
  );

export const isGone = <A, E, R>(read: Effect.Effect<A, E | NotFound, R>) =>
  read.pipe(
    Effect.as(false),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
  );

/**
 * Reproduces a crash after the cloud resource was created but before its
 * attributes were committed: the row goes back to `creating` without them.
 */
export const forgetAttributes = Effect.fn(function* (address: {
  readonly stack: string;
  readonly stage: string;
  readonly fqn: string;
}) {
  const state = yield* yield* State;
  const stored = yield* state.get(address);
  if (!stored || isActionState(stored) || stored.status !== "created") {
    return yield* Effect.die(new Error(`Expected a created row for ${address.fqn}`));
  }
  const { attr: _attr, ...creating } = stored;
  yield* state.set({ ...address, value: { ...creating, status: "creating" } });
});

/**
 * A domain unique to the user and worktree, under the standing test zone.
 * DigitalOcean hosts any name a team adds, so nothing at the registrar has
 * to change for the API to accept it.
 */
export const testDomain = (stage: string, label: string) =>
  `${testName(stage, label)}.do.alchemy-test-2.us`;

/** The team account's email, which DigitalOcean has verified for alerts. */
export const accountEmail = getAccount({}).pipe(
  Effect.flatMap((response) => Effect.fromNullishOr(response.account?.email)),
  Effect.orDie,
);
