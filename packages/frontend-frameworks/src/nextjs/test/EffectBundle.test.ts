import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeEffectEntrySource,
  makeTakeoverWorkerSource,
  probeOpenNextDoExports,
  scanForServeSentinel,
  SERVE_MOUNT_MARKER,
  TAKEOVER_ENTRY_NAME,
} from "../EffectBundle.ts";
import { effectEntryOf } from "../source.ts";

const runScan = (dir: string) =>
  Effect.runPromise(
    scanForServeSentinel(dir).pipe(Effect.provide(NodeServices.layer)),
  );

describe("EffectBundle", () => {
  let root: string;

  beforeAll(() => {
    root = NodeFs.mkdtempSync(
      NodePath.join(NodeOs.tmpdir(), "alchemy-nextjs-effect-"),
    );
  });

  afterAll(() => {
    NodeFs.rmSync(root, { recursive: true, force: true });
  });

  it("probes exactly the DO classes the OpenNext worker exports", () => {
    expect(
      probeOpenNextDoExports(
        `export { DOQueueHandler } from "./.build/durable-objects/queue.js";`,
      ),
    ).toEqual(["DOQueueHandler"]);
    expect(probeOpenNextDoExports(`export default { fetch() {} };`)).toEqual(
      [],
    );
    expect(
      probeOpenNextDoExports(
        `export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./x.js";`,
      ),
    ).toEqual(["DOQueueHandler", "DOShardedTagCache", "BucketCachePurge"]);
  });

  it("generates the effect entry with routes, site import, and DO bridges", () => {
    const source = makeEffectEntrySource(
      {
        mainPath: "/app/src/site.ts",
        routes: ["/api/*"],
        doClasses: ["Counter"],
        wfClasses: [],
      },
      "/app/src/site.ts",
    );
    expect(source).toContain(`import Site from "/app/src/site.ts";`);
    expect(source).toContain(`routes: ["/api/*"],`);
    expect(source).toContain(
      `export class Counter extends __AlchemyDurableObjectBridge("Counter") {}`,
    );
    expect(source).toContain(`from "alchemy/serve/worker"`);
  });

  it("generates the takeover wrapper re-exporting probed + effect DO classes", () => {
    const wrapper = makeTakeoverWorkerSource({
      openNextDoExports: ["DOQueueHandler"],
      effectDoClasses: ["Counter"],
    });
    expect(wrapper).toContain(`export { DOQueueHandler } from "./worker.js";`);
    expect(wrapper).toContain(
      `export { Counter } from "./alchemy-effect/alchemy-effect.mjs";`,
    );
    expect(wrapper).toContain(
      `export default makeAlchemyWorker(() => import("./worker.js"));`,
    );
    // No spurious export lists when nothing is probed.
    const bare = makeTakeoverWorkerSource({
      openNextDoExports: [],
      effectDoClasses: [],
    });
    expect(bare).not.toContain("export {");
  });

  it("scan finds the sentinel only in OpenNext-owned outputs", async () => {
    const openNext = NodePath.join(root, ".open-next");
    NodeFs.mkdirSync(NodePath.join(openNext, "server-functions", "default"), {
      recursive: true,
    });
    NodeFs.mkdirSync(NodePath.join(openNext, "alchemy-effect"), {
      recursive: true,
    });
    NodeFs.writeFileSync(
      NodePath.join(openNext, "worker.js"),
      `export default { fetch() {} };`,
    );
    // Alchemy's own prebundle always embeds the sentinel — it must never
    // count as a user mount.
    NodeFs.writeFileSync(
      NodePath.join(openNext, "alchemy-effect", "alchemy-effect.mjs"),
      `globalThis["${SERVE_MOUNT_MARKER}"] = true;`,
    );
    expect(await runScan(openNext)).toBe(false);

    // A compiled route handler that mounts alchemy/serve IS a user mount.
    NodeFs.writeFileSync(
      NodePath.join(openNext, "server-functions", "default", "handler.mjs"),
      `/* compiled */ globalThis["${SERVE_MOUNT_MARKER}"] = true;`,
    );
    expect(await runScan(openNext)).toBe(true);
  });

  it("effectEntryOf classifies exports and requires a wrapper mainPath", () => {
    expect(
      effectEntryOf({
        id: "x",
        workerName: "x",
        compatibility: { date: "2026-05-12", flags: [] },
        entry: { kind: "external" },
      }),
    ).toBeUndefined();
    expect(
      effectEntryOf({
        id: "x",
        workerName: "x",
        compatibility: { date: "2026-05-12", flags: [] },
        entry: {
          kind: "effect",
          exports: {
            Counter: { kind: "durableObject" },
            Flow: { kind: "workflow" },
          },
          routes: ["/api/*"],
          mainPath: "/app/src/site.ts",
        },
      }),
    ).toEqual({
      mainPath: "/app/src/site.ts",
      routes: ["/api/*"],
      doClasses: ["Counter"],
      wfClasses: ["Flow"],
    });
    expect(TAKEOVER_ENTRY_NAME).toBe("alchemy-worker.js");
  });
});
