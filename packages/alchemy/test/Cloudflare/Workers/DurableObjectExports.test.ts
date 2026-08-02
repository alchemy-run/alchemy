import {
  nextDurableObjectExportState,
  observeDurableObjectExports,
  observeLegacyDurableObjectStorage,
  planDurableObjectExports,
  type DurableObjectExportPlan,
  type DurableObjectExportPlanResult,
} from "@/Cloudflare/Workers/DurableObjectExports";
import {
  encodeDurableObjectExportTags,
  getDurableObjectExportStateFromTags,
} from "@/Cloudflare/Workers/DurableObjectExportTags.ts";
import { describe, expect, test } from "alchemy-test";

const unwrapPlan = (
  result: DurableObjectExportPlanResult,
): DurableObjectExportPlan => {
  if (result._tag === "Failure") throw result.error;
  return result.plan;
};

describe("DurableObjectExports", () => {
  test("derives live, renamed, deleted, transferred, and container exports", () => {
    const plan = unwrapPlan(
      planDurableObjectExports({
        scriptName: "worker-a",
        classes: [
          { className: "CounterV2", previousClassName: "Counter" },
          { className: "Incoming", transferFrom: "worker-b" },
          { className: "Sandbox" },
        ],
        retirements: {
          Removed: { kind: "deleted" },
          Moved: { kind: "transferred", transferredTo: "worker-c" },
        },
        containerClassNames: new Set(["Sandbox"]),
        namespaces: [
          {
            script: "worker-a",
            className: "Counter",
            storage: "legacy-kv",
          },
          {
            script: "worker-b",
            className: "Incoming",
            storage: "sqlite",
          },
        ],
        observedStorageByClass: {},
        observedPendingTransfers: {},
      }),
    );

    expect(plan.exports).toEqual({
      Removed: { type: "durable-object", state: "deleted" },
      Moved: {
        type: "durable-object",
        state: "transferred",
        transferredTo: "worker-c",
      },
      Counter: {
        type: "durable-object",
        state: "renamed",
        renamedTo: "CounterV2",
      },
      CounterV2: { type: "durable-object", storage: "legacy-kv" },
      Incoming: {
        type: "durable-object",
        state: "expecting-transfer",
        storage: "sqlite",
        transferFrom: "worker-b",
      },
      Sandbox: {
        type: "durable-object",
        storage: "sqlite",
        container: "Sandbox",
      },
    });
    expect(plan.changedClasses).toEqual([
      "Removed",
      "Moved",
      "Counter",
      "CounterV2",
      "Incoming",
      "Sandbox",
    ]);
    expect([...plan.omittedBindingClassNames]).toEqual(["Incoming"]);
  });

  test("retains tombstones until Cloudflare reports them removable", () => {
    const submitted = {
      Counter: {
        type: "durable-object" as const,
        state: "deleted" as const,
      },
      Room: {
        type: "durable-object" as const,
        storage: "sqlite" as const,
      },
    };
    const pending = nextDurableObjectExportState(submitted, {
      created: [],
      updated: [],
      deleted: ["Counter"],
      renamed: [],
      transferred: [],
      transferPending: [],
      warnings: [],
      info: [],
      removableEntries: [],
    });
    expect(pending).toEqual({
      tombstones: {
        Counter: { type: "durable-object", state: "deleted" },
      },
      pendingTransfers: {},
      storageByClass: { Room: "sqlite" },
    });

    expect(
      nextDurableObjectExportState(submitted, {
        created: [],
        updated: [],
        deleted: [],
        renamed: [],
        transferred: [],
        transferPending: [],
        warnings: [],
        info: [],
        removableEntries: ["Counter"],
      }),
    ).toEqual({
      tombstones: {},
      pendingTransfers: {},
      storageByClass: { Room: "sqlite" },
    });
  });

  test("drops a rename tombstone when its target is retired", () => {
    const plan = unwrapPlan(
      planDurableObjectExports({
        scriptName: "worker",
        classes: [],
        retirements: { CounterV2: { kind: "deleted" } },
        containerClassNames: new Set(),
        namespaces: [],
        observedStorageByClass: {},
        observedPendingTransfers: {},
        previousState: {
          tombstones: {
            Counter: {
              type: "durable-object",
              state: "renamed",
              renamedTo: "CounterV2",
            },
          },
          pendingTransfers: {},
          storageByClass: { CounterV2: "sqlite" },
        },
      }),
    );

    expect(plan.exports).toEqual({
      CounterV2: { type: "durable-object", state: "deleted" },
    });
  });

  test("retains submitted pending transfers even without reconciliation", () => {
    expect(
      nextDurableObjectExportState(
        {
          Counter: {
            type: "durable-object",
            state: "expecting-transfer",
            storage: "legacy-kv",
            transferFrom: "source-worker",
          },
        },
        undefined,
      ),
    ).toEqual({
      tombstones: {},
      pendingTransfers: {
        Counter: {
          transferFrom: "source-worker",
          storage: "legacy-kv",
        },
      },
      storageByClass: { Counter: "legacy-kv" },
    });
  });

  test("keeps a transfer pending until the source no longer owns it", () => {
    const previousState = {
      tombstones: {},
      pendingTransfers: {
        Counter: {
          transferFrom: "source-worker",
          storage: "sqlite" as const,
        },
      },
      storageByClass: { Counter: "sqlite" as const },
    };
    const waiting = unwrapPlan(
      planDurableObjectExports({
        scriptName: "target-worker",
        classes: [{ className: "Counter", previousClassName: "Counter" }],
        retirements: {},
        containerClassNames: new Set(),
        namespaces: [
          {
            script: "source-worker",
            className: "Counter",
            storage: "sqlite",
          },
        ],
        observedStorageByClass: {},
        observedPendingTransfers: {},
        previousState,
      }),
    );
    expect(waiting.exports?.Counter).toEqual({
      type: "durable-object",
      state: "expecting-transfer",
      storage: "sqlite",
      transferFrom: "source-worker",
    });
    expect([...waiting.omittedBindingClassNames]).toEqual(["Counter"]);
    expect(waiting.changedClasses).toEqual(["Counter"]);

    const activated = unwrapPlan(
      planDurableObjectExports({
        scriptName: "target-worker",
        classes: [{ className: "Counter", previousClassName: "Counter" }],
        retirements: {},
        containerClassNames: new Set(),
        namespaces: [
          {
            script: "target-worker",
            className: "Counter",
            storage: "sqlite",
          },
        ],
        observedStorageByClass: {},
        observedPendingTransfers: {},
        previousState,
      }),
    );
    expect(activated.exports?.Counter).toEqual({
      type: "durable-object",
      storage: "sqlite",
    });
    expect([...activated.omittedBindingClassNames]).toEqual([]);
    expect(activated.changedClasses).toEqual(["Counter"]);
  });

  test("recovers storage and pending transfers from settings exports", () => {
    expect(
      observeDurableObjectExports({
        Counter: {
          type: "durable-object",
          state: "expecting-transfer",
          storage: "legacy-kv",
          transferFrom: "source-worker",
        },
        Handler: { type: "worker" },
      }),
    ).toEqual({
      storageByClass: { Counter: "legacy-kv" },
      pendingTransfers: {
        Counter: {
          transferFrom: "source-worker",
          storage: "legacy-kv",
        },
      },
    });
  });

  test("recovers immutable storage from legacy migration history", () => {
    expect(
      observeLegacyDurableObjectStorage({
        steps: [
          { newClasses: ["Legacy"], newSqliteClasses: ["Room"] },
          { renamedClasses: [{ from: "Legacy", to: "LegacyV2" }] },
          { deletedClasses: ["Room"] },
        ],
      }),
    ).toEqual({ LegacyV2: "legacy-kv" });
  });

  test("fails instead of guessing storage for an existing class", () => {
    const result = planDurableObjectExports({
      scriptName: "dispatch-worker",
      classes: [{ className: "Counter", previousClassName: "Counter" }],
      retirements: {},
      containerClassNames: new Set(),
      namespaces: [],
      observedStorageByClass: {},
      observedPendingTransfers: {},
    });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.error._tag).toBe("DurableObjectStorageUnknown");
    }
  });

  test("round-trips export recovery state through Worker tags", () => {
    const tags = encodeDurableObjectExportTags({
      Room: {
        type: "durable-object",
        storage: "sqlite",
        container: "RoomContainer",
      },
      Incoming: {
        type: "durable-object",
        state: "expecting-transfer",
        storage: "legacy-kv",
        transferFrom: "source:worker",
      },
      Removed: { type: "durable-object", state: "deleted" },
      Old: {
        type: "durable-object",
        state: "renamed",
        renamedTo: "New",
      },
      Moved: {
        type: "durable-object",
        state: "transferred",
        transferredTo: "target-worker",
      },
    });

    expect(tags.every((tag) => tag.length <= 1024)).toBe(true);
    expect(getDurableObjectExportStateFromTags(tags)).toEqual({
      tombstones: {
        Moved: {
          type: "durable-object",
          state: "transferred",
          transferredTo: "target-worker",
        },
        Old: {
          type: "durable-object",
          state: "renamed",
          renamedTo: "New",
        },
        Removed: { type: "durable-object", state: "deleted" },
      },
      pendingTransfers: {
        Incoming: {
          transferFrom: "source:worker",
          storage: "legacy-kv",
        },
      },
      storageByClass: {
        Incoming: "legacy-kv",
        Room: "sqlite",
      },
    });
  });

  test("ignores malformed export recovery tags", () => {
    expect(
      getDurableObjectExportStateFromTags([
        "alchemy:doe:p:Counter:x:source",
        "alchemy:doe:l:%ZZ:s",
        "user-tag",
      ]),
    ).toBeUndefined();
  });
});
