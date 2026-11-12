import { AdminKey, providers } from "@alchemy.run/convex/aws";
import { mintAdminKey } from "@alchemy.run/convex/internal/adminKey";
import { InstanceNameChanged } from "@alchemy.run/convex/internal/selfhosted";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { BACKEND_IMAGE } from "./support.ts";

const { test } = Test.make({ providers: providers() });
const options = {
  tags: ["provider:convex", "provider:convex:adminkey", "local"],
  timeout: 180_000,
};

const SECRET = Redacted.make("a".repeat(64));
const OTHER_SECRET = Redacted.make("b".repeat(64));
const OTHER_IMAGE = `ghcr.io/convex/convex-backend:other@sha256:${"0".repeat(64)}`;

const key = (props: { image?: string; instanceName?: string; instanceSecret?: typeof SECRET }) =>
  AdminKey("Key", { image: BACKEND_IMAGE, instanceName: "demo", instanceSecret: SECRET, ...props });

const action = (plan: { resources: Record<string, any> }) =>
  Object.values(plan.resources).find((entry) => entry.resource.Type === "Convex.AdminKey")?.action;

test.provider(
  "mints a key that starts with the instance name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(key({}));
      expect(Redacted.value(deployed.value)).toMatch(/^demo\|[0-9a-f]+$/);
      expect(deployed.instanceName).toBe("demo");
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "redeploy keeps the key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = yield* stack.deploy(key({}));
      const second = yield* stack.deploy(key({}));
      expect(Redacted.value(second.value)).toBe(Redacted.value(first.value));
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "image change does not mint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* stack.deploy(key({}));
      expect(action(yield* stack.plan(key({ image: OTHER_IMAGE })))).toBe("noop");
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "secret change replaces the key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = yield* stack.deploy(key({}));
      const second = yield* stack.deploy(key({ instanceSecret: OTHER_SECRET }));
      expect(Redacted.value(second.value)).not.toBe(Redacted.value(first.value));
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "instanceName change fails the plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* stack.deploy(key({}));
      const planned = yield* stack.plan(key({ instanceName: "other" })).pipe(Effect.result);
      expect(Result.isFailure(planned)).toBe(true);
      if (Result.isFailure(planned)) expect(planned.failure).toBeInstanceOf(InstanceNameChanged);
      yield* stack.destroy();
    }),
  options,
);

test(
  "the secret is not in errors",
  Effect.gen(function* () {
    const secret = "c".repeat(64);
    const spawner = yield* ChildProcessSpawner;
    const error = yield* mintAdminKey(spawner, {
      image: `ghcr.io/convex/does-not-exist@sha256:${"0".repeat(64)}`,
      instanceName: "demo",
      instanceSecret: Redacted.make(secret),
    }).pipe(Effect.flip);
    expect(error._tag).toBe("AdminKeyMintFailed");
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
  }),
  options,
);

test(
  "no docker gives DockerUnavailable",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const error = yield* mintAdminKey(
      spawner,
      { image: BACKEND_IMAGE, instanceName: "demo", instanceSecret: SECRET },
      "docker-is-not-installed",
    ).pipe(Effect.flip);
    expect(error._tag).toBe("DockerUnavailable");
    expect(error.message).toContain("Docker");
  }),
  options,
);
