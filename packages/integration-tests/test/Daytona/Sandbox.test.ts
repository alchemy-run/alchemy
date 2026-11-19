import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials } from "@distilled.cloud/daytona/Credentials";
import * as toolboxProcess from "@distilled.cloud/daytona/process";
import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Daytona.providers() });

const observe = (id: string) =>
  sandboxes.getSandbox({ sandboxIdOrName: id }).pipe(
    // Daytona renames a sandbox on delete and destroys it asynchronously.
    Effect.map((s) => (s.state === "destroyed" || s.state === "destroying" ? undefined : s)),
    Effect.catchTag("SandboxNotFound", () => Effect.undefined),
  );

/** Run a command in a sandbox with the deployer's credentials. */
const execIn = (sandboxId: string, command: string) =>
  Effect.gen(function* () {
    const base = yield* Credentials;
    return yield* toolboxProcess.executeCommand({ command }).pipe(
      Effect.provideService(
        Credentials,
        Effect.map(base, (c) => ({ ...c, sandboxId })),
      ),
    );
  });

// Orgs below Daytona's Tier 3 can't set sandbox network rules; set
// DAYTONA_TEST_NETWORK=1 on an account that can.
const networkEntitled = !!process.env.DAYTONA_TEST_NETWORK;

test.provider(
  "create a sandbox, sync labels and intervals in place, stop it, replace it, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Daytona.Sandbox("Box", {
          labels: { team: "alchemy" },
          autoStopInterval: "30 minutes",
        }),
      );
      yield* expectFound(Daytona.Sandbox.lookup({ name: created.name }), created);
      expect(created.state).toEqual("started");
      expect(created.labels).toEqual({ team: "alchemy" });
      const observed = yield* sandboxes.getSandbox({ sandboxIdOrName: created.sandboxId });
      expect(observed.labels?.["alchemy.id"]).toContain("Box");
      expect(observed.autoStopInterval).toEqual(30);

      // Labels and intervals update in place; state stops it.
      const updated = yield* stack.deploy(
        Daytona.Sandbox("Box", {
          labels: { team: "alchemy", env: "test" },
          autoStopInterval: "1 hour",
          state: "stopped",
        }),
      );
      expect(updated.sandboxId).toEqual(created.sandboxId);
      expect(updated.state).toEqual("stopped");
      const after = yield* sandboxes.getSandbox({ sandboxIdOrName: created.sandboxId });
      expect(after.labels?.env).toEqual("test");
      expect(after.autoStopInterval).toEqual(60);

      // Environment variables are fixed at creation: changing them replaces the sandbox.
      const replaced = yield* stack.deploy(
        Daytona.Sandbox("Box", {
          labels: { team: "alchemy", env: "test" },
          env: { MODE: "replaced" },
          state: "stopped",
        }),
      );
      expect(replaced.sandboxId).not.toEqual(created.sandboxId);
      expect(yield* observe(created.sandboxId)).toBeUndefined();

      yield* stack.destroy();
      expect(yield* observe(replaced.sandboxId)).toBeUndefined();
    }),
  { tags: ["provider:daytona", "live"], timeout: 600_000 },
);

test.provider.skipIf(networkEntitled)(
  "network settings below Tier 3 fail with NetworkAccessRestricted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(Daytona.Sandbox("Restricted", { domainAllowList: ["github.com"] }))
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NetworkAccessRestricted");
      yield* stack.destroy();
    }),
  { tags: ["provider:daytona", "live"], timeout: 120_000 },
);

test.provider.skipIf(!networkEntitled)(
  "domain allow list syncs in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Daytona.Sandbox("Net", { domainAllowList: ["github.com"] }),
      );
      const observed = yield* sandboxes.getSandbox({ sandboxIdOrName: created.sandboxId });
      expect(observed.domainAllowList).toEqual("github.com");

      const updated = yield* stack.deploy(
        Daytona.Sandbox("Net", { domainAllowList: ["github.com", "registry.npmjs.org"] }),
      );
      expect(updated.sandboxId).toEqual(created.sandboxId);
      const after = yield* sandboxes.getSandbox({ sandboxIdOrName: created.sandboxId });
      expect((after.domainAllowList ?? "").split(",").sort()).toEqual([
        "github.com",
        "registry.npmjs.org",
      ]);

      yield* stack.destroy();
      expect(yield* observe(created.sandboxId)).toBeUndefined();
    }),
  { tags: ["provider:daytona", "live"], timeout: 600_000 },
);

test.provider(
  "link two ephemeral sandboxes on one runner, change and clear the TTL",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (ttl?: Duration.Input) =>
        stack.deploy(
          Effect.gen(function* () {
            const db = yield* Daytona.Sandbox("Db", { autoDeleteInterval: 0 });
            const app = yield* Daytona.Sandbox("App", {
              autoDeleteInterval: 0,
              linkedSandbox: db,
              ttl,
            });
            return { db, app };
          }),
        );

      const first = yield* deploy("2 hours");
      expect(first.app.linkedSandboxId).toEqual(first.db.sandboxId);
      const firstDestroyAt = Date.parse(first.app.autoDestroyAt ?? "");
      expect(firstDestroyAt - Date.now()).toBeGreaterThan(90 * 60_000);

      // A longer TTL updates in place and moves the deadline out.
      const longer = yield* deploy("3 hours");
      expect(longer.app.sandboxId).toEqual(first.app.sandboxId);
      expect(Date.parse(longer.app.autoDestroyAt ?? "")).toBeGreaterThan(firstDestroyAt);

      // Removing it disables it.
      yield* deploy();
      const cleared = yield* sandboxes.getSandbox({ sandboxIdOrName: first.app.sandboxId });
      expect(cleared.autoDestroyAt).toBeUndefined();

      yield* stack.destroy();
      expect(yield* observe(first.app.sandboxId)).toBeUndefined();
      expect(yield* observe(first.db.sandboxId)).toBeUndefined();
    }),
  { tags: ["provider:daytona", "live"], timeout: 600_000 },
);

// GPU sandboxes need GPU credits in the organization's wallet, and Windows
// sandboxes need Tier 3 or access from Daytona support. Both bill at their
// own, higher rates. Set DAYTONA_TEST_GPU=1 / DAYTONA_TEST_WINDOWS=1 on an
// account that has them.
const gpuEntitled = !!process.env.DAYTONA_TEST_GPU;
const windowsEntitled = !!process.env.DAYTONA_TEST_WINDOWS;

const Gpu = Daytona.Sandbox("Gpu", {
  snapshot: { name: "daytona-gpu" },
  target: "earth",
  autoDeleteInterval: 0,
  autoStopInterval: "15 minutes",
});

test.provider.skipIf(gpuEntitled)(
  "a GPU sandbox without GPU credits fails with GpuCreditsRequired",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack.deploy(Gpu).pipe(Effect.flip);
      expect(error._tag).toEqual("GpuCreditsRequired");
      yield* stack.destroy();
    }),
  { tags: ["provider:daytona", "live"], timeout: 120_000 },
);

test.provider.skipIf(!!process.env.FAST || !gpuEntitled)(
  "a GPU sandbox from the GPU snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const gpu = yield* stack.deploy(Gpu);
      expect(gpu.gpu).toEqual(1);
      expect(gpu.target).toEqual("earth");
      expect(gpu.state).toEqual("started");

      yield* stack.destroy();
      expect(yield* observe(gpu.sandboxId)).toBeUndefined();
    }),
  { tags: ["provider:daytona", "live"], timeout: 600_000 },
);

const windows = (state?: "stopped") =>
  Daytona.Sandbox("Windows", {
    snapshot: { name: "windows-small" },
    target: "us-west-4",
    autoStopInterval: "15 minutes",
    state,
  });

test.provider.skipIf(windowsEntitled)(
  "a Windows sandbox below Tier 3 fails with WindowsSandboxesUnavailable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack.deploy(windows()).pipe(Effect.flip);
      expect(error._tag).toEqual("WindowsSandboxesUnavailable");
      yield* stack.destroy();
    }),
  { tags: ["provider:daytona", "live"], timeout: 120_000 },
);

test.provider.skipIf(!!process.env.FAST || !windowsEntitled)(
  "a Windows sandbox, stopped in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(windows());
      expect(created.sandboxClass).toEqual("windows");
      expect(created.state).toEqual("started");

      const stopped = yield* stack.deploy(windows("stopped"));
      expect(stopped.sandboxId).toEqual(created.sandboxId);
      expect(stopped.state).toEqual("stopped");

      yield* stack.destroy();
      expect(yield* observe(created.sandboxId)).toBeUndefined();
    }),
  { tags: ["provider:daytona", "live"], timeout: 900_000 },
);

test.provider(
  "mount a volume and a secret, set the user and previews, stop and wake it, archive it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (options: {
        public: boolean;
        state?: "started" | "stopped" | "archived";
        secretHost: string;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const cache = yield* Daytona.Volume("Cache", {});
            const token = yield* Daytona.Secret("Token", {
              value: "not-a-token",
              hosts: [options.secretHost],
            });
            const box = yield* Daytona.Sandbox("Mounted", {
              user: "daytona",
              mounts: [{ volume: cache, path: "/home/daytona/cache" }],
              secrets: { API_TOKEN: token },
              public: options.public,
              otelEndpointOverride: "https://api.honeycomb.io/",
              state: options.state,
            });
            return { cache, token, box };
          }),
        );

      const first = yield* deploy({ public: true, secretHost: "api.github.com" });
      const observed = yield* sandboxes.getSandbox({ sandboxIdOrName: first.box.sandboxId });
      expect(observed.user).toEqual("daytona");
      expect(observed.public).toBe(true);
      expect(observed.volumes?.map((v) => [v.volumeId, v.mountPath])).toEqual([
        [first.cache.volumeId, "/home/daytona/cache"],
      ]);
      expect(observed.otelEndpointOverride).toEqual("https://api.honeycomb.io/");
      expect(Object.keys(observed.env ?? {})).toContain("API_TOKEN");

      // Previews go private in place, and a changed secret is remounted.
      const second = yield* deploy({ public: false, secretHost: "api.gitlab.com" });
      expect(second.box.sandboxId).toEqual(first.box.sandboxId);
      expect((yield* sandboxes.getSandbox({ sandboxIdOrName: first.box.sandboxId })).public).toBe(
        false,
      );

      // Stop it, then wake it again.
      const stopped = yield* deploy({
        public: false,
        state: "stopped",
        secretHost: "api.gitlab.com",
      });
      expect(stopped.box.state).toEqual("stopped");
      const woken = yield* deploy({ public: false, secretHost: "api.gitlab.com" });
      expect(woken.box.sandboxId).toEqual(first.box.sandboxId);
      expect(woken.box.state).toEqual("started");

      // Archive it. Daytona moves the disk to object storage in the
      // background, which can take many minutes, so the deploy returns
      // once the archive is under way.
      const archived = yield* deploy({
        public: false,
        state: "archived",
        secretHost: "api.gitlab.com",
      });
      expect(["archiving", "archived"]).toContain(archived.box.state);

      yield* stack.destroy();
      expect(yield* observe(first.box.sandboxId)).toBeUndefined();
    }),
  { tags: ["provider:daytona", "live"], timeout: 300_000 },
);

test.provider(
  "a secret reaches its host as the real value, and the sandbox holds only a placeholder",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // Not a real key. OpenAI's rejection quotes the end of the key it
      // was sent, which shows what left the sandbox.
      const value = "sk-alchemy-not-a-real-key-0000000000000000-zq7w";
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const token = yield* Daytona.Secret("Token", { value, hosts: ["api.openai.com"] });
          const box = yield* Daytona.Sandbox("Proxied", { secrets: { API_TOKEN: token } });
          return { token, box };
        }),
      );

      // Inside the sandbox the variable is the placeholder, never the value.
      const env = yield* execIn(out.box.sandboxId, "sh -c 'printenv API_TOKEN; env'");
      expect(env.result).toContain(out.token.placeholder);
      expect(env.result).not.toContain(value);

      // On the way to the secret's host, Daytona swaps the value in.
      const sent = yield* execIn(
        out.box.sandboxId,
        `sh -c 'curl -sS -m 20 https://api.openai.com/v1/models -H "Authorization: Bearer $API_TOKEN"'`,
      );
      expect(sent.result).toContain("zq7w");
      expect(sent.result).not.toContain(out.token.placeholder.slice(-4));

      yield* stack.destroy();
      expect(yield* observe(out.box.sandboxId)).toBeUndefined();
    }),
  { tags: ["provider:daytona", "provider:daytona:secret", "live"], timeout: 300_000 },
);

// Per-sandbox queue timeouts need the organization feature; set
// DAYTONA_TEST_QUEUE_TIMEOUT=1 on an account that has it.
const queueTimeoutEntitled = !!process.env.DAYTONA_TEST_QUEUE_TIMEOUT;

test.provider.skipIf(queueTimeoutEntitled)(
  "a queue timeout without the feature fails with QueueTimeoutNotEnabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(Daytona.Sandbox("Queued", { queueTimeout: "10 minutes" }))
        .pipe(Effect.flip);
      expect(error._tag).toEqual("QueueTimeoutNotEnabled");
      yield* stack.destroy();
    }),
  { tags: ["provider:daytona", "live"], timeout: 120_000 },
);

test.provider.skipIf(!queueTimeoutEntitled)(
  "a sandbox with a queue timeout",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const box = yield* stack.deploy(Daytona.Sandbox("Queued", { queueTimeout: "10 minutes" }));
      const observed = yield* sandboxes.getSandbox({ sandboxIdOrName: box.sandboxId });
      expect(observed.queueTimeout).toEqual(10);
      yield* stack.destroy();
      expect(yield* observe(box.sandboxId)).toBeUndefined();
    }),
  { tags: ["provider:daytona", "live"], timeout: 600_000 },
);
