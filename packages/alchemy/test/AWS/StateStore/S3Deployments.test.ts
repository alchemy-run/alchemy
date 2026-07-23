import * as AWS from "@/AWS";
import {
  DEPLOYMENTS_DIR,
  batchKey,
  dedupeBatch,
  decodeRecord,
  deploymentsPrefix,
  encodeRecord,
  eventsPrefix,
  pad8,
  recordKey,
  versionFromCommonPrefix,
  versionPrefix,
} from "@/AWS/StateStore/Deployments.ts";
import { State, type DeploymentEvent } from "@/State";
import {
  isStaleOpen,
  maxSeqOf,
  toPublicRecord,
  type StoredDeploymentRecord,
} from "@/State/Deployment.ts";
import * as Core from "@/Test/Core.ts";
import { beforeAll, describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { deploymentStoreConformance } from "../../State/deploymentStoreConformance.ts";

// ---------------------------------------------------------------------------
// Ungated unit tests for the pure helpers the S3 deployment store is built on.
// These run everywhere; no AWS account is touched.
// ---------------------------------------------------------------------------

const stagePrefix = "alchemy/my-stack/dev/";

const event = (seq: number, payload?: unknown): DeploymentEvent => ({
  seq,
  ts: seq * 10,
  payload: payload ?? { kind: "note", seq },
});

const stored = (
  overrides: Partial<StoredDeploymentRecord> = {},
): StoredDeploymentRecord => ({
  stack: "my-stack",
  stage: "dev",
  version: 1,
  meta: { command: "deploy", initiator: { user: "tester" } },
  startedAt: 100,
  heartbeatAt: 100,
  token: "secret-token",
  ...overrides,
});

describe("S3 deployment store key layout", () => {
  it("pads versions and seqs to 8 digits so key order equals numeric order", () => {
    expect(pad8(1)).toBe("00000001");
    expect(pad8(42)).toBe("00000042");
    expect(pad8(12345678)).toBe("12345678");
    // lexicographic order must match numeric order
    expect(pad8(2) < pad8(10)).toBe(true);
    expect(pad8(9) < pad8(11)).toBe(true);
  });

  it("builds the documented key layout under the stage prefix", () => {
    expect(deploymentsPrefix(stagePrefix)).toBe(
      `alchemy/my-stack/dev/${DEPLOYMENTS_DIR}/`,
    );
    expect(recordKey(stagePrefix, 3)).toBe(
      "alchemy/my-stack/dev/.deployments/00000003/record.json",
    );
    expect(eventsPrefix(stagePrefix, 3)).toBe(
      "alchemy/my-stack/dev/.deployments/00000003/events/",
    );
    expect(batchKey(stagePrefix, 3, 17)).toBe(
      "alchemy/my-stack/dev/.deployments/00000003/events/00000017.json",
    );
  });

  it("parses the version back out of a delimiter-list common prefix", () => {
    const prefix = deploymentsPrefix(stagePrefix);
    expect(versionFromCommonPrefix(prefix, versionPrefix(stagePrefix, 1))).toBe(
      1,
    );
    expect(
      versionFromCommonPrefix(prefix, versionPrefix(stagePrefix, 12345678)),
    ).toBe(12345678);
    // object keys (records, batches) are not version prefixes
    expect(
      versionFromCommonPrefix(prefix, recordKey(stagePrefix, 1)),
    ).toBeUndefined();
    expect(
      versionFromCommonPrefix(prefix, batchKey(stagePrefix, 1, 1)),
    ).toBeUndefined();
    // foreign prefixes are ignored
    expect(
      versionFromCommonPrefix(prefix, `${stagePrefix}other/`),
    ).toBeUndefined();
    expect(
      versionFromCommonPrefix(prefix, `${prefix}not-a-version/`),
    ).toBeUndefined();
  });
});

describe("S3 deployment store stale-open predicate", () => {
  it("an ended record is never stale", () => {
    expect(
      isStaleOpen(stored({ endedAt: 100, outcome: "succeeded" }), 1e9, 0),
    ).toBe(false);
  });

  it("an open record within the ttl is live", () => {
    expect(isStaleOpen(stored({ heartbeatAt: 100 }), 150, 60_000)).toBe(false);
  });

  it("an open record whose heartbeat is older than the ttl is stale", () => {
    expect(isStaleOpen(stored({ heartbeatAt: 100 }), 60_100, 60_000)).toBe(
      true,
    );
    // boundary: now - heartbeatAt >= ttl
    expect(isStaleOpen(stored({ heartbeatAt: 100 }), 60_100, 60_001)).toBe(
      false,
    );
  });

  it("ttl 0 marks any open record stale", () => {
    expect(isStaleOpen(stored({ heartbeatAt: 100 }), 100, 0)).toBe(true);
  });
});

describe("S3 deployment store batch dedupe", () => {
  it("keeps everything on an empty journal and acks the highest seq", () => {
    const { retained, ackedSeq } = dedupeBatch(
      [event(2), event(1), event(3)],
      0,
    );
    expect(retained.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(ackedSeq).toBe(3);
  });

  it("drops events at or below the journal high-water mark", () => {
    const { retained, ackedSeq } = dedupeBatch(
      [event(2), event(3), event(4)],
      3,
    );
    expect(retained.map((e) => e.seq)).toEqual([4]);
    expect(ackedSeq).toBe(4);
  });

  it("acks the high-water mark when every event is a duplicate", () => {
    const { retained, ackedSeq } = dedupeBatch([event(1), event(2)], 5);
    expect(retained).toEqual([]);
    expect(ackedSeq).toBe(5);
  });

  it("dedupes repeats inside a single batch, first write wins", () => {
    const { retained } = dedupeBatch(
      [event(1, { first: true }), event(1, { first: false }), event(2)],
      0,
    );
    expect(retained.map((e) => e.seq)).toEqual([1, 2]);
    expect(retained[0]?.payload).toEqual({ first: true });
  });

  it("maxSeqOf finds the highest seq in a batch", () => {
    expect(maxSeqOf([])).toBe(0);
    expect(maxSeqOf([event(3), event(1), event(2)])).toBe(3);
  });
});

describe("S3 deployment store record codec", () => {
  it("round-trips a record through JSON", () => {
    const record = stored({
      endedAt: 200,
      outcome: "failed",
      summary: { counts: { create: 1 }, error: "boom" },
    });
    expect(decodeRecord(encodeRecord(record))).toEqual(record);
  });

  it("drops absent optional fields instead of persisting undefined", () => {
    const decoded = decodeRecord(encodeRecord(stored()));
    expect("endedAt" in decoded).toBe(false);
    expect("outcome" in decoded).toBe(false);
    expect("summary" in decoded).toBe(false);
  });

  it("toPublicRecord strips the token and does not alias the stored record", () => {
    const record = stored();
    const publicRecord = toPublicRecord(record);
    expect("token" in publicRecord).toBe(false);
    expect(publicRecord.version).toBe(1);
    publicRecord.meta.initiator!.user = "intruder";
    expect(record.meta.initiator?.user).toBe("tester");
  });
});

// ---------------------------------------------------------------------------
// Full conformance suite against real S3.
// ---------------------------------------------------------------------------

describe("S3 DeploymentStore (live)", () => {
  // Each `make` builds a fresh StateService over the same bucket + prefix,
  // mirroring the CLI runtime composition (`Core.toEffect` is what
  // `Test.make` uses under the hood) so credentials/region resolution
  // matches `alchemy deploy`.
  const make = () =>
    Core.toEffect(
      Effect.gen(function* () {
        return yield* yield* State;
      }),
      {
        providers: AWS.providers(),
        state: AWS.state({ prefix: "test-deployments" }),
      },
    );

  // The conformance suite assumes a fresh backend (versions start at 1),
  // but the S3 bucket persists across runs — wipe the conformance stack
  // (its slug is derived from the label below) before running.
  beforeAll(async () => {
    await Effect.runPromise(
      make().pipe(
        Effect.flatMap((state) =>
          state.deleteStack({ stack: "s3-deploymentstore-conformance" }),
        ),
      ),
    );
  }, 120_000);

  deploymentStoreConformance({
    label: "S3 DeploymentStore",
    make,
    persistent: true,
  });
});
