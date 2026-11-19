import * as Archil from "@alchemy.run/archil";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Process from "@distilled.cloud/archil/Process";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import EgressGateway, { API_KEY, GATEWAY_TOKEN } from "./fixtures/gateway.ts";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Archil.providers(), Cloudflare.providers()),
});

const observe = (sid: string) =>
  archil.getSandbox({ sid }).pipe(
    Effect.map(({ data }) => (data.status === "deleted" ? undefined : data)),
    Effect.catchTag("NotFound", () => Effect.undefined),
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
      yield* expectFound(Archil.Sandbox.lookup({ name: sandbox.name }), sandbox);
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

test.provider(
  "egress adds a header to matching requests, and the sandbox never holds its value",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = (value: string) =>
        Archil.Sandbox("Proxied", {
          baseImage: "node:24-bookworm",
          idleTtlSeconds: 300,
          network: {
            egress: {
              default: "deny",
              allow: [
                {
                  target: "postman-echo.com",
                  headers: { "X-Alchemy-Secret": Redacted.make(value) },
                },
              ],
            },
          },
        });
      const echoed = (sid: string) =>
        Process.exec(sid, "curl -sS -m 20 https://postman-echo.com/headers").pipe(
          Effect.map((r) => r.stdout + r.stderr),
        );

      // Archil adds the header outside the sandbox, on the way to the target.
      const sandbox = yield* stack.deploy(app("s3cr3t-value"));
      expect(yield* echoed(sandbox.sandboxId)).toContain("s3cr3t-value");
      const env = yield* Process.exec(sandbox.sandboxId, "env; cat /proc/1/environ");
      expect(env.stdout).not.toContain("s3cr3t-value");

      // A new value updates the policy on the running sandbox.
      const rotated = yield* stack.deploy(app("r0tated-value"));
      expect(rotated.sandboxId).toBe(sandbox.sandboxId);
      expect(yield* echoed(sandbox.sandboxId)).toContain("r0tated-value");

      yield* stack.destroy();
      expect(yield* observe(sandbox.sandboxId)).toBeUndefined();
    }),
  { tags: ["provider:archil", "provider:archil:sandbox", "live"], timeout: 300_000 },
);

test.provider(
  "egress forwards matching requests to a Worker gateway that adds the credential",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { gateway, sandbox } = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* EgressGateway;
          const sandbox = yield* Archil.Sandbox("Gatewayed", {
            baseImage: "node:24-bookworm",
            idleTtlSeconds: 300,
            network: {
              egress: {
                default: "deny",
                allow: [
                  {
                    target: "postman-echo.com",
                    // Archil adds the token on the way out, so only the
                    // gateway's own egress rule can call it.
                    headers: { "X-Gateway-Token": Redacted.make(GATEWAY_TOKEN) },
                    forwardUrl: gateway.url.as<string>(),
                  },
                ],
              },
            },
          });
          return { gateway: gateway.url.as<string>(), sandbox };
        }),
      );

      // The sandbox calls the real host; the response came through the
      // gateway, which added the API key and saw which sandbox called.
      const out = yield* Process.exec(
        sandbox.sandboxId,
        "curl -sS -i -m 30 https://postman-echo.com/headers",
      ).pipe(
        Effect.map((r) => r.stdout + r.stderr),
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (body) => body.includes(API_KEY),
          times: 10,
        }),
      );
      expect(out).toContain(API_KEY);
      expect(out.toLowerCase()).toContain(`x-gateway-sandbox: ${sandbox.sandboxId}`.toLowerCase());
      // The gateway strips its token before the upstream sees the request.
      expect(out).not.toContain(GATEWAY_TOKEN);

      // Neither secret is inside the sandbox.
      const env = yield* Process.exec(sandbox.sandboxId, "env; cat /proc/1/environ");
      expect(env.stdout).not.toContain(API_KEY);
      expect(env.stdout).not.toContain(GATEWAY_TOKEN);

      // Without the token Archil adds, the gateway refuses.
      const client = yield* HttpClient.HttpClient;
      const direct = yield* client
        .get(`${gateway}/headers`, {
          headers: { "archil-forwarded-host": "postman-echo.com" },
        })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (r) => r.status === 403,
            times: 10,
          }),
        );
      expect(direct.status).toBe(403);

      yield* stack.destroy();
      expect(yield* observe(sandbox.sandboxId)).toBeUndefined();
    }),
  {
    tags: [
      "provider:archil",
      "provider:archil:sandbox",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 300_000,
  },
);

test.provider(
  "run sets up a sandbox at deploy, a failing command fails the deploy, and new commands replace it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const marker = (sid: string) =>
        Process.exec(sid, "cat /work/marker 2>/dev/null || echo missing").pipe(
          Effect.map((r) => r.stdout.trim()),
        );

      const first = yield* stack.deploy(
        Archil.Sandbox("Golden", { run: ["mkdir -p /work", "echo one > /work/marker"] }),
      );
      expect(yield* marker(first.sandboxId)).toBe("one");
      expect(first.setupHash).toMatch(/.+/);

      // Unchanged commands leave the sandbox alone.
      const same = yield* stack.deploy(
        Archil.Sandbox("Golden", { run: ["mkdir -p /work", "echo one > /work/marker"] }),
      );
      expect(same.sandboxId).toBe(first.sandboxId);

      // New commands replace it: a fresh sandbox runs them from the image.
      const second = yield* stack.deploy(
        Archil.Sandbox("Golden", { run: ["mkdir -p /work", "echo two > /work/marker"] }),
      );
      expect(second.sandboxId).not.toBe(first.sandboxId);
      expect(yield* marker(second.sandboxId)).toBe("two");
      expect(yield* observe(first.sandboxId)).toBeUndefined();

      // A command that exits non-zero fails the deploy.
      const failed = yield* stack
        .deploy(Archil.Sandbox("Golden", { run: ["exit 3"] }))
        .pipe(Effect.flip);
      expect(String(failed)).toContain("exited 3");

      yield* stack.destroy();
      expect(yield* observe(second.sandboxId)).toBeUndefined();
    }),
  { tags: ["provider:archil", "provider:archil:sandbox", "live"], timeout: 300_000 },
);
