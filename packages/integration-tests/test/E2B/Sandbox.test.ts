import * as E2B from "@alchemy.run/e2b";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import * as Alchemy from "alchemy";
import { localState } from "alchemy/State";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers: E2B.providers() });

const tags = ["provider:e2b", "provider:e2b:sandbox", "live"];

/** E2B's public base template, which the stack doesn't manage. */
const Base = E2B.Template.lookup({ name: "base" });

/** A sandbox's details, or `undefined` once E2B no longer has it. */
const observe = (sandboxId: string) =>
  sandboxes.getSandbox({ sandboxID: sandboxId }).pipe(
    Effect.map((detail): sandboxes.SandboxDetail | undefined => detail),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const expectGone = (sandboxId: string) =>
  observe(sandboxId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (detail) => detail === undefined,
      times: 15,
    }),
    Effect.map((detail) => expect(detail).toBeUndefined()),
  );

test.provider(
  "create, update egress and timeout in place, replace on env, and delete a sandbox",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const box = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Sandbox("Box", {
            template: Base,
            metadata: { purpose: "lifecycle" },
            env: { GREETING: "hello" },
          });
        }),
      );
      const created = yield* observe(box.sandboxId);
      expect(created?.state).toBe("running");
      expect(created?.metadata?.["alchemy::id"]).toBe("Box");
      expect(created?.metadata?.purpose).toBe("lifecycle");
      expect(created?.lifecycle?.onTimeout).toBe("pause");
      expect(created?.lifecycle?.autoResume).toBe(true);
      expect(box.metadata).toEqual({ purpose: "lifecycle" });
      expect(box.domain).toBe(created?.domain ?? "e2b.app");

      // Egress and timeout change in place: same sandbox.
      const restricted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Sandbox("Box", {
            template: Base,
            metadata: { purpose: "lifecycle" },
            env: { GREETING: "hello" },
            timeout: "10 minutes",
            network: { allowOut: ["github.com"] },
          });
        }),
      );
      expect(restricted.sandboxId).toBe(box.sandboxId);
      const updated = yield* observe(box.sandboxId);
      expect(updated?.network?.allowOut).toEqual(["github.com"]);
      expect(updated?.network?.denyOut).toEqual(["0.0.0.0/0"]);
      const lifetime = Date.parse(updated!.endAt) - Date.now();
      expect(lifetime).toBeGreaterThan(6 * 60_000);

      // An unchanged redeploy plans nothing.
      const plan = yield* stack.plan(
        Effect.gen(function* () {
          return yield* E2B.Sandbox("Box", {
            template: Base,
            metadata: { purpose: "lifecycle" },
            env: { GREETING: "hello" },
            timeout: "10 minutes",
            network: { allowOut: ["github.com"] },
          });
        }),
      );
      expect(plan.resources.Box.action).toBe("noop");

      // Env can't change on a live sandbox: a new one replaces it.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Sandbox("Box", {
            template: Base,
            metadata: { purpose: "lifecycle" },
            env: { GREETING: "bonjour" },
            timeout: "10 minutes",
            network: { allowOut: ["github.com"] },
          });
        }),
      );
      expect(replaced.sandboxId).not.toBe(box.sandboxId);
      yield* expectGone(box.sandboxId);
      expect((yield* observe(replaced.sandboxId))?.state).toBe("running");

      yield* stack.destroy();
      yield* expectGone(replaced.sandboxId);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "an egress proxy changes in place, and a host mask or HTTPS ports replace the sandbox",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (network: E2B.SandboxNetwork) =>
        Effect.gen(function* () {
          return yield* E2B.Sandbox("Proxied", { template: Base, network });
        });
      const proxy = (address: string, password: string) => ({
        address,
        username: "sandbox",
        password: Redacted.make(password),
        tls: { enabled: true },
      });

      const box = yield* stack.deploy(program({ egressProxy: proxy("192.0.2.10:1080", "first") }));
      const created = yield* observe(box.sandboxId);
      expect(created?.network?.egressProxy?.address).toBe("192.0.2.10:1080");
      expect(created?.network?.egressProxy?.username).toBe("sandbox");
      expect(created?.network?.egressProxy?.tls?.enabled).toBe(true);

      // A new address or password reaches the running sandbox.
      const moved = yield* stack.deploy(
        program({ egressProxy: proxy("192.0.2.11:1080", "second") }),
      );
      expect(moved.sandboxId).toBe(box.sandboxId);
      expect((yield* observe(box.sandboxId))?.network?.egressProxy?.address).toBe(
        "192.0.2.11:1080",
      );
      const plan = yield* stack.plan(program({ egressProxy: proxy("192.0.2.11:1080", "second") }));
      expect(plan.resources.Proxied.action).toBe("noop");

      // Dropping the proxy clears it, still in place.
      const direct = yield* stack.deploy(program({}));
      expect(direct.sandboxId).toBe(box.sandboxId);
      expect((yield* observe(box.sandboxId))?.network?.egressProxy ?? undefined).toBeUndefined();

      // E2B takes a host mask and HTTPS ports only at create.
      const masked = yield* stack.deploy(
        program({ maskRequestHost: "localhost:${PORT}", httpsPorts: [8443] }),
      );
      expect(masked.sandboxId).not.toBe(box.sandboxId);
      yield* expectGone(box.sandboxId);
      const observed = yield* observe(masked.sandboxId);
      expect(observed?.network?.maskRequestHost).toBe("localhost:${PORT}");
      expect(observed?.network?.httpsPorts).toEqual([8443]);

      yield* stack.destroy();
      yield* expectGone(masked.sandboxId);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a paused sandbox resumes to take a new timeout, and a missing one is recreated",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (timeout: Duration.Input) =>
        Effect.gen(function* () {
          return yield* E2B.Sandbox("Recreated", {
            template: Base,
            timeout,
            network: { allowPublicTraffic: false },
          });
        });
      const box = yield* stack.deploy(program("5 minutes"));
      expect(box.trafficAccessToken).toBeDefined();
      expect(Redacted.value(box.trafficAccessToken!).length).toBeGreaterThan(0);

      // Paused (as on timeout), a new timeout resumes the same sandbox to apply it.
      yield* sandboxes.pauseSandbox({ sandboxID: box.sandboxId });
      expect((yield* observe(box.sandboxId))?.state).toBe("paused");
      const kept = yield* stack.deploy(program("8 minutes"));
      expect(kept.sandboxId).toBe(box.sandboxId);
      const resumed = yield* observe(box.sandboxId);
      expect(resumed?.state).toBe("running");
      expect(Date.parse(resumed!.endAt) - Date.now()).toBeGreaterThan(6 * 60_000);

      // Gone (E2B dropped it): the next deploy that updates it creates a fresh one.
      yield* sandboxes.deleteSandbox({ sandboxID: box.sandboxId });
      yield* expectGone(box.sandboxId);
      const recreated = yield* stack.deploy(program("10 minutes"));
      expect(recreated.sandboxId).not.toBe(box.sandboxId);
      expect((yield* observe(recreated.sandboxId))?.state).toBe("running");

      yield* stack.destroy();
      yield* expectGone(recreated.sandboxId);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a rebuilt template replaces the sandbox, which boots the new build",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (version: string) =>
        Effect.gen(function* () {
          const template = yield* E2B.Template("Versioned", {
            fromTemplate: "base",
            run: [`echo ${version} > /home/user/version.txt`],
          });
          const box = yield* E2B.Sandbox("VersionedBox", { template });
          return { box, buildId: template.buildId };
        });
      const first = yield* stack.deploy(program("v1"));
      expect(first.box.templateBuild).toBe(first.buildId);

      // An unchanged template plans nothing for the sandbox.
      const plan = yield* stack.plan(program("v1"));
      expect(plan.resources.VersionedBox.action).toBe("noop");

      const second = yield* stack.deploy(program("v2"));
      expect(second.buildId).not.toBe(first.buildId);
      expect(second.box.sandboxId).not.toBe(first.box.sandboxId);
      expect(second.box.templateBuild).toBe(second.buildId);
      yield* expectGone(first.box.sandboxId);

      yield* stack.destroy();
      yield* expectGone(second.box.sandboxId);
    }),
  { tags, timeout: 600_000 },
);

// E2B enables volumes per team; set E2B_TEST_VOLUMES=1 on an enabled one.
test.provider.skipIf(!process.env.E2B_TEST_VOLUMES)(
  "mounts a declared volume; changing mounts replaces the sandbox",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (path: string) =>
        Effect.gen(function* () {
          const cache = yield* E2B.Volume("MountedCache", {});
          return yield* E2B.Sandbox("MountedBox", {
            template: Base,
            mounts: [{ volume: cache, path }],
          });
        });
      const box = yield* stack.deploy(program("/cache"));
      expect(box.mounts.map((mount) => mount.path)).toEqual(["/cache"]);
      const detail = yield* observe(box.sandboxId);
      expect(detail?.volumeMounts?.map((mount) => mount.path)).toEqual(["/cache"]);

      const moved = yield* stack.deploy(program("/data"));
      expect(moved.sandboxId).not.toBe(box.sandboxId);
      expect((yield* observe(moved.sandboxId))?.volumeMounts?.map((m) => m.path)).toEqual([
        "/data",
      ]);

      yield* stack.destroy();
      yield* expectGone(moved.sandboxId);
    }),
  { tags, timeout: 240_000 },
);

// The lookup targets belong to another stack, as a lookup's target should.
const TargetStack = Alchemy.Stack(
  "E2BLookupTarget",
  { providers: E2B.providers(), state: localState() },
  Effect.gen(function* () {
    const secret = yield* E2B.Secret("LookupSecret", { value: Redacted.make("looked-up") });
    const box = yield* E2B.Sandbox("LookupBox", { template: Base });
    return { secretName: secret.name, secretId: secret.secretId, sandboxId: box.sandboxId };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "lookup finds a secret and a sandbox another stack manages",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { secretName, secretId, sandboxId } = yield* target;

      const found = yield* stack.deploy(
        Effect.gen(function* () {
          const secret = E2B.Secret.lookup({ name: secretName });
          const box = E2B.Sandbox.lookup({ sandboxId });
          return { secretId: secret.secretId, ref: secret.ref, templateId: box.templateId };
        }),
      );
      expect(found.secretId).toBe(secretId);
      expect(found.ref).toBe(`\${e2b.secrets.${secretName}}`);
      expect(typeof found.templateId).toBe("string");
      expect(found.templateId.length).toBeGreaterThan(0);

      // A lookup is never owned: destroying this stack leaves both in place.
      yield* stack.destroy();
      expect((yield* observe(sandboxId))?.sandboxID).toBe(sandboxId);
    }),
  { tags, timeout: 240_000 },
);
