import {
  CREATE_DEPLOYMENT_EVENTS_TABLE,
  DEPLOYMENT_COUNTER_PREFIX,
  DEPLOYMENT_OPEN_PREFIX,
  DEPLOYMENT_RECORD_PREFIX,
  deploymentCounterKey,
  deploymentOpenKey,
  deploymentRecordKey,
  deploymentStagePrefix,
  INSERT_DEPLOYMENT_EVENT,
  parseDeploymentOpenKey,
  parseDeploymentRecordKey,
  SELECT_DEPLOYMENT_MAX_SEQ,
  selectDeploymentEventsSql,
  toPublicDeploymentRecord,
  type StoredDeploymentRecord,
} from "@/Cloudflare/StateStore/Deployments.ts";
import { isStaleOpen } from "@/State/Deployment.ts";
import {
  aesCtrDecryptJson,
  aesCtrEncryptJson,
  importAesCtrKey,
} from "@/Util/aes-ctr.ts";
import { sha256 } from "@/Util/sha256.ts";
import { AlchemyContextLive } from "@/AlchemyContext.ts";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "@/Auth/Credentials.ts";
import { ProfileLive } from "@/Auth/Profile.ts";
import { LoggingCli } from "@/Cli/LoggingCli.ts";
import * as Cloudflare from "@/Cloudflare";
import {
  DeploymentEventWire,
  DeploymentInProgressWire,
  DeploymentNotFoundWire,
  DeploymentRecordWire,
  DeploymentTokenInvalidWire,
} from "@/State/HttpStateApi.ts";
import { State } from "@/State/State.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { beforeAll, describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { deploymentStoreConformance } from "../../State/deploymentStoreConformance.ts";

// ---------------------------------------------------------------------------
// Ungated unit tests for the pure pieces of the Cloudflare DO deployment
// store: key builders, the stale-open predicate, the shared AES-CTR JSON
// codec and the SQL statement builders.
// ---------------------------------------------------------------------------

describe("Cloudflare deployment keys", () => {
  it("record keys are lexicographically ordered by version", () => {
    const k1 = deploymentRecordKey("dev", 1);
    const k2 = deploymentRecordKey("dev", 2);
    const k10 = deploymentRecordKey("dev", 10);
    const k100000 = deploymentRecordKey("dev", 100000);
    expect(k1 < k2).toBe(true);
    expect(k2 < k10).toBe(true);
    expect(k10 < k100000).toBe(true);
  });

  it("record keys live under the stage prefix", () => {
    const key = deploymentRecordKey("dev", 42);
    expect(key.startsWith(deploymentStagePrefix("dev"))).toBe(true);
    expect(key.startsWith(DEPLOYMENT_RECORD_PREFIX)).toBe(true);
  });

  it("a stage prefix never matches another stage that shares a name prefix", () => {
    const key = deploymentRecordKey("dev-extra", 1);
    expect(key.startsWith(deploymentStagePrefix("dev"))).toBe(false);
  });

  it("record/open/counter prefixes are disjoint from each other and from resource keys", () => {
    const record = deploymentRecordKey("dev", 1);
    const open = deploymentOpenKey("dev");
    const counter = deploymentCounterKey("dev");
    expect(record.startsWith(DEPLOYMENT_OPEN_PREFIX)).toBe(false);
    expect(record.startsWith(DEPLOYMENT_COUNTER_PREFIX)).toBe(false);
    expect(open.startsWith(DEPLOYMENT_RECORD_PREFIX)).toBe(false);
    expect(counter.startsWith(DEPLOYMENT_RECORD_PREFIX)).toBe(false);
    // resource keys in the stack DO use the `r\x00` prefix, outputs `o\x00`,
    // the root stack index `s:` — none of the deployment keys may collide.
    for (const key of [record, open, counter]) {
      expect(key.startsWith("r\x00")).toBe(false);
      expect(key.startsWith("o\x00")).toBe(false);
      expect(key.startsWith("s:")).toBe(false);
    }
  });

  it("parseDeploymentRecordKey round-trips", () => {
    expect(
      parseDeploymentRecordKey(deploymentRecordKey("my-stage", 7)),
    ).toEqual({ stage: "my-stage", version: 7 });
    expect(parseDeploymentRecordKey("r\x00dev\x00fqn")).toBeUndefined();
    expect(parseDeploymentRecordKey(deploymentOpenKey("dev"))).toBeUndefined();
  });

  it("parseDeploymentOpenKey round-trips", () => {
    expect(parseDeploymentOpenKey(deploymentOpenKey("my-stage"))).toBe(
      "my-stage",
    );
    expect(
      parseDeploymentOpenKey(deploymentRecordKey("dev", 1)),
    ).toBeUndefined();
    expect(parseDeploymentOpenKey(deploymentCounterKey("dev"))).toBeUndefined();
  });
});

describe("Cloudflare deployment stale-open predicate", () => {
  it("is stale exactly at the ttl boundary (>=)", () => {
    expect(isStaleOpen({ heartbeatAt: 1_000 }, 61_000, 60_000)).toBe(true);
    expect(isStaleOpen({ heartbeatAt: 1_000 }, 60_999, 60_000)).toBe(false);
  });

  it("ttl 0 means always stale", () => {
    expect(isStaleOpen({ heartbeatAt: 5 }, 5, 0)).toBe(true);
  });

  it("a fresh heartbeat under the default ttl is live", () => {
    expect(isStaleOpen({ heartbeatAt: 10_000 }, 10_001, 60_000)).toBe(false);
  });
});

describe("Cloudflare deployment record codec", () => {
  // 32-byte AES-CTR key, hex-encoded — same shape as the deployed store's
  // Secrets-Store-backed encryption key.
  const KEY_HEX =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  const OTHER_KEY_HEX =
    "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

  it.effect("sha256 matches a known vector", () =>
    Effect.gen(function* () {
      const empty = yield* sha256("");
      expect(empty).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    }),
  );

  it.effect("encrypt/decrypt round-trips and never stores plaintext", () =>
    Effect.gen(function* () {
      const key = yield* importAesCtrKey(KEY_HEX);
      const value = {
        command: "deploy",
        initiator: { user: "sam" },
        nested: [1, 2, { deep: true }],
      };
      const data = yield* aesCtrEncryptJson(key, value);
      expect(data).not.toContain("sam");
      const opened = yield* aesCtrDecryptJson<typeof value>(key, data);
      expect(opened).toEqual(value);
      // fresh object every decrypt — no aliasing
      const again = yield* aesCtrDecryptJson<typeof value>(key, data);
      expect(again).not.toBe(opened);
    }),
  );

  it.effect("two encryptions of the same value use distinct nonces", () =>
    Effect.gen(function* () {
      const key = yield* importAesCtrKey(KEY_HEX);
      const a = yield* aesCtrEncryptJson(key, { v: 1 });
      const b = yield* aesCtrEncryptJson(key, { v: 1 });
      expect(a).not.toBe(b);
      expect(yield* aesCtrDecryptJson(key, a)).toEqual({ v: 1 });
      expect(yield* aesCtrDecryptJson(key, b)).toEqual({ v: 1 });
    }),
  );

  it.effect(
    "decrypting with the wrong key fails typed instead of returning garbage",
    () =>
      Effect.gen(function* () {
        const key = yield* importAesCtrKey(KEY_HEX);
        const wrongKey = yield* importAesCtrKey(OTHER_KEY_HEX);
        const data = yield* aesCtrEncryptJson(key, { secret: "value" });
        const result = yield* Effect.result(aesCtrDecryptJson(wrongKey, data));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("AesCtrDecryptError");
        }
      }),
  );
});

describe("Cloudflare deployment public-record assembly", () => {
  const stored: StoredDeploymentRecord = {
    v: 1,
    stack: "my-stack",
    stage: "dev",
    version: 3,
    startedAt: 100,
    heartbeatAt: 200,
    ttlMillis: 60_000,
    tokenHash: "abc123",
    meta: "base64-ciphertext",
  };

  it("never exposes the token hash or ciphertext", () => {
    const record = toPublicDeploymentRecord(stored, { command: "deploy" });
    expect("token" in record).toBe(false);
    expect("tokenHash" in record).toBe(false);
    expect("ttlMillis" in record).toBe(false);
    expect(Object.values(record)).not.toContain("abc123");
    expect(record).toEqual({
      stack: "my-stack",
      stage: "dev",
      version: 3,
      meta: { command: "deploy" },
      startedAt: 100,
      heartbeatAt: 200,
    });
  });

  it("omits endedAt/outcome/summary while open, includes them when closed", () => {
    const open = toPublicDeploymentRecord(stored, { command: "deploy" });
    expect("endedAt" in open).toBe(false);
    expect("outcome" in open).toBe(false);
    expect("summary" in open).toBe(false);

    const closed = toPublicDeploymentRecord(
      { ...stored, endedAt: 300, outcome: "failed" },
      { command: "deploy" },
      { counts: { create: 1 }, error: "boom" },
    );
    expect(closed.endedAt).toBe(300);
    expect(closed.outcome).toBe("failed");
    expect(closed.summary).toEqual({ counts: { create: 1 }, error: "boom" });
  });
});

describe("Cloudflare deployment SQL statements", () => {
  it("event inserts are idempotent per (stage, version, seq)", () => {
    expect(CREATE_DEPLOYMENT_EVENTS_TABLE).toContain(
      "CREATE TABLE IF NOT EXISTS deployment_events",
    );
    expect(CREATE_DEPLOYMENT_EVENTS_TABLE).toContain(
      "PRIMARY KEY (stage, version, seq)",
    );
    expect(INSERT_DEPLOYMENT_EVENT).toContain("INSERT OR IGNORE");
  });

  it("max-seq query coalesces the empty journal to 0", () => {
    expect(SELECT_DEPLOYMENT_MAX_SEQ).toContain("COALESCE(MAX(seq), 0)");
  });

  it("event reads are seq-ascending with an optional inclusive fromSeq", () => {
    const all = selectDeploymentEventsSql(false);
    const from = selectDeploymentEventsSql(true);
    expect(all).toContain("ORDER BY seq ASC");
    expect(all).not.toContain("seq >=");
    expect(from).toContain("seq >= ?");
    expect(from).toContain("ORDER BY seq ASC");
  });
});

// ---------------------------------------------------------------------------
// Wire-schema tests for the HTTP contract in State/HttpStateApi.ts.
// ---------------------------------------------------------------------------

describe("Deployment wire schemas", () => {
  const decodeRecord = Schema.decodeUnknownEffect(DeploymentRecordWire);
  const decodeEvent = Schema.decodeUnknownEffect(DeploymentEventWire);

  it.effect("decodes an open record (no endedAt/outcome/summary)", () =>
    Effect.gen(function* () {
      const record = yield* decodeRecord({
        stack: "s",
        stage: "dev",
        version: 1,
        meta: { command: "deploy", initiator: { user: "sam", pid: 42 } },
        startedAt: 1,
        heartbeatAt: 2,
      });
      expect(record.version).toBe(1);
      expect(record.meta.command).toBe("deploy");
      expect(record.endedAt).toBeUndefined();
    }),
  );

  it.effect("decodes a closed record including store-added outcomes", () =>
    Effect.gen(function* () {
      const record = yield* decodeRecord({
        stack: "s",
        stage: "dev",
        version: 2,
        meta: { command: "destroy" },
        startedAt: 1,
        heartbeatAt: 2,
        endedAt: 3,
        outcome: "completed-late",
        summary: { counts: { create: 1, delete: 2 }, error: "boom" },
      });
      expect(record.outcome).toBe("completed-late");
      expect(record.summary?.counts).toEqual({ create: 1, delete: 2 });
    }),
  );

  it.effect("rejects an unknown outcome", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeRecord({
          stack: "s",
          stage: "dev",
          version: 2,
          meta: { command: "deploy" },
          startedAt: 1,
          heartbeatAt: 2,
          outcome: "exploded",
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("events carry payloads verbatim and fqn optionally", () =>
    Effect.gen(function* () {
      const event = yield* decodeEvent({
        seq: 1,
        ts: 10,
        payload: { kind: "note", nested: [1, 2, 3] },
      });
      expect(event.fqn).toBeUndefined();
      expect(event.payload).toEqual({ kind: "note", nested: [1, 2, 3] });

      const scoped = yield* decodeEvent({
        seq: 2,
        ts: 20,
        fqn: "stack/resource",
        payload: null,
      });
      expect(scoped.fqn).toBe("stack/resource");
    }),
  );

  it.effect("wire error schemas decode with the Deployment.ts tags", () =>
    Effect.gen(function* () {
      const inProgress = yield* Schema.decodeUnknownEffect(
        DeploymentInProgressWire,
      )({
        _tag: "DeploymentInProgress",
        stack: "s",
        stage: "dev",
        holder: {
          stack: "s",
          stage: "dev",
          version: 1,
          meta: { command: "deploy" },
          startedAt: 1,
          heartbeatAt: 2,
        },
      });
      expect(inProgress._tag).toBe("DeploymentInProgress");
      expect(inProgress.holder.version).toBe(1);

      const tokenInvalid = yield* Schema.decodeUnknownEffect(
        DeploymentTokenInvalidWire,
      )({
        _tag: "DeploymentTokenInvalid",
        stack: "s",
        stage: "dev",
        version: 1,
      });
      expect(tokenInvalid._tag).toBe("DeploymentTokenInvalid");

      const notFound = yield* Schema.decodeUnknownEffect(
        DeploymentNotFoundWire,
      )({ _tag: "DeploymentNotFound", stack: "s", stage: "dev", version: 9 });
      expect(notFound._tag).toBe("DeploymentNotFound");
    }),
  );
});

// ---------------------------------------------------------------------------
// Live conformance run against the DEPLOYED Cloudflare state store.
//
// Gated behind ALCHEMY_TEST_STATE_CF because it talks to the real
// `alchemy-state-store` worker on the configured profile's account. The
// operator must have bootstrapped the store from a build that advertises
// the `deployments` capability on `/version` (`alchemy bootstrap
// cloudflare`) before running — history is capability-negotiated, not
// version-gated, so an older store simply reports it off:
//
//   ALCHEMY_TEST_STATE_CF=1 ALCHEMY_PROFILE=testing \
//     bun vitest run test/Cloudflare/StateStore/CfDeployments.test.ts
//
// NOTE: the shared conformance suite runs under `it.effect`'s TestClock, so
// only *server-side* time advances — which is exactly what the deployment
// semantics key off (heartbeats, TTLs and timestamps are all stamped by the
// Durable Object's real clock). Client-side retry schedules will not tick
// under the TestClock, so the store must already be healthy and serving.
// ---------------------------------------------------------------------------

const platformLayer = Layer.mergeAll(
  PlatformServices,
  FetchHttpClient.layer,
  Layer.provide(ProfileLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
);

/**
 * Build a fresh `StateService` over the deployed store — mirrors the layer
 * composition in `Test/Core.ts`'s `toEffect`, minus the stack/deploy
 * machinery the conformance suite doesn't need.
 */
const makeLiveState = () =>
  Effect.gen(function* () {
    return yield* yield* State;
  }).pipe(
    Effect.provide(Cloudflare.state()),
    Effect.provideService(AuthProviders, {}),
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(LoggingCli, AlchemyContextLive),
        platformLayer,
      ),
    ),
  );

describe("Cloudflare state store (live)", () => {
  // The conformance suite assumes a fresh backend (versions start at 1),
  // but the Durable Object persists across runs — wipe the conformance
  // stack (its slug is derived from the label below) first. The DO's
  // deleteAll clears both KV (records, counters, open markers) and SQL
  // (the events table).
  beforeAll(async () => {
    await Effect.runPromise(
      makeLiveState().pipe(
        Effect.flatMap((state) =>
          state.deleteStack({
            stack: "cloudflare-deploymentstore-conformance",
          }),
        ),
      ) as Effect.Effect<void, unknown, never>,
    );
  }, 120_000);

  deploymentStoreConformance({
    label: "Cloudflare DeploymentStore",
    make: makeLiveState,
    persistent: true,
  });
});
