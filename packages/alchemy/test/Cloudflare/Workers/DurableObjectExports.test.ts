import {
  buildDurableObjectExports,
  nextDurableObjectExportState,
} from "@/Cloudflare/Workers/DurableObjectExports";
import { describe, expect, test } from "alchemy-test";

describe("DurableObjectExports", () => {
  test("derives live, renamed, deleted, transferred, and container exports", () => {
    const plan = buildDurableObjectExports({
      scriptName: "worker-a",
      classes: [
        { className: "CounterV2", previousClassName: "Counter" },
        { className: "Incoming", transferFrom: "worker-b" },
        { className: "Sandbox" },
      ],
      deletedClasses: ["Removed"],
      transferredClasses: [{ className: "Moved", transferredTo: "worker-c" }],
      containerClassNames: new Set(["Sandbox"]),
      namespaces: [
        {
          script: "worker-a",
          className: "Counter",
          storage: "legacy-kv",
        },
      ],
    });

    expect(plan.exports).toEqual({
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
      Removed: { type: "durable-object", state: "deleted" },
      Moved: {
        type: "durable-object",
        state: "transferred",
        transferredTo: "worker-c",
      },
    });
    expect(plan.changedClasses).toEqual([
      "Counter",
      "CounterV2",
      "Incoming",
      "Sandbox",
      "Removed",
      "Moved",
    ]);
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
      pendingTransfers: [],
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
    ).toBeUndefined();
  });

  test("retains pending transfers when an endpoint omits reconciliation", () => {
    expect(
      nextDurableObjectExportState(
        {
          Counter: {
            type: "durable-object",
            state: "expecting-transfer",
            storage: "sqlite",
            transferFrom: "source-worker",
          },
        },
        undefined,
      ),
    ).toEqual({ tombstones: {}, pendingTransfers: ["Counter"] });
  });
});
