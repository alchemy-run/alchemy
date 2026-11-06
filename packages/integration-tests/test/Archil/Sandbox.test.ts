import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Archil.providers() });

const observe = (sid: string) =>
  archil.getSandbox({ sid }).pipe(
    Effect.map(({ data }) => (data.status === "deleted" ? undefined : data)),
    Effect.catchTag("SandboxNotFound", () => Effect.undefined),
  );

test.provider(
  "sandbox mounts disks, syncs mounts, ports and network in place, and replaces on size change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const Workspace = Archil.Disk("Workspace", {});
      const Reference = Archil.Disk("Reference", {});
      const app = (props: Partial<Archil.SandboxProps>) =>
        Effect.gen(function* () {
          const disk = yield* Workspace;
          const reference = yield* Reference;
          const sandbox = yield* Archil.Sandbox("DevBox", {
            baseImage: "node:24-bookworm",
            mounts: [{ disk: Workspace, path: "/workspace" }],
            idleTtlSeconds: 300,
            ...props,
          });
          return { disk, reference, sandbox };
        });

      const { disk, sandbox } = yield* stack.deploy(app({ ports: [3000] }));
      expect(sandbox.name).toMatch(/^[a-z0-9-]+$/);
      expect(sandbox.endpoints.map((e) => e.port)).toEqual([3000]);
      const live = yield* observe(sandbox.sandboxId);
      expect(live?.mounts?.[0]?.disk_id).toBe(disk.diskId);

      // Ports and egress update in place.
      const updated = yield* stack.deploy(
        app({
          ports: [3000, 8080],
          network: { egress: { default: "deny", allow: ["registry.npmjs.org"] } },
        }),
      );
      expect(updated.sandbox.sandboxId).toBe(sandbox.sandboxId);
      const ports = (yield* archil.listSandboxPorts({ sid: sandbox.sandboxId })).data.ports ?? [];
      expect(ports.map((p) => p.port).sort()).toEqual([3000, 8080]);
      const network = yield* archil.getSandboxNetwork({ sid: sandbox.sandboxId });
      expect(network.data.egress?.default).toBe("deny");
      // Archil adds its own mount endpoints for the mounted disk.
      expect(network.data.egress?.allow).toContain("registry.npmjs.org");

      // Mounts update in place: the sandbox stops and starts with them.
      const remounted = yield* stack.deploy(
        app({
          ports: [3000, 8080],
          network: { egress: { default: "deny", allow: ["registry.npmjs.org"] } },
          mounts: [
            { disk: Workspace, path: "/workspace" },
            { disk: Reference, path: "/reference", mode: "read-only" },
          ],
        }),
      );
      expect(remounted.sandbox.sandboxId).toBe(sandbox.sandboxId);
      const mounts = (yield* observe(sandbox.sandboxId))?.mounts ?? [];
      expect(
        mounts
          .map((m) => ({ disk: m.disk_id, path: m.path, readOnly: m.read_only ?? false }))
          .sort((x, y) => (x.path ?? "").localeCompare(y.path ?? "")),
      ).toEqual([
        { disk: remounted.reference.diskId, path: "/reference", readOnly: true },
        { disk: disk.diskId, path: "/workspace", readOnly: false },
      ]);

      // Size is create-only: a new sandbox replaces the old one.
      const resized = yield* stack.deploy(app({ ports: [3000, 8080], memSizeMiB: 4096 }));
      expect(resized.sandbox.sandboxId).not.toBe(sandbox.sandboxId);
      expect(resized.sandbox.memSizeMiB).toBe(4096);
      expect(yield* observe(sandbox.sandboxId)).toBeUndefined();

      yield* stack.destroy();
      expect(yield* observe(resized.sandbox.sandboxId)).toBeUndefined();
    }),
  { tags: ["provider:archil", "provider:archil:sandbox", "live"], timeout: 300_000 },
);
