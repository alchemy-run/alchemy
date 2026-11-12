import { AdminKey, providers } from "@alchemy.run/convex/aws";
import { mintAdminKey, openAdminKey } from "@alchemy.run/convex/internal/adminKey";
import { InstanceNameChanged } from "@alchemy.run/convex/internal/selfhosted";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { BACKEND_IMAGE } from "./support.ts";

const { test } = Test.make({ providers: providers() });
const options = {
  tags: ["provider:convex", "provider:convex:adminkey", "local"],
  timeout: 180_000,
};
const unit = { tags: ["provider:convex", "provider:convex:adminkey", "unit"] };

const SECRET = Redacted.make("a".repeat(64));
const OTHER_SECRET = Redacted.make("b".repeat(64));

/**
 * Printed by the backend image's own `generate_key demo <SECRET>` (BACKEND_IMAGE).
 * Opening it proves the derivation, cipher and layout match Convex's.
 */
const GENERATED_BY_CONVEX = Redacted.make(
  "demo|01061ebd26c175c9879677449e89e188ee4edf82e8dd785b89466254b5a0c318eceaa982b6",
);

const key = (props: { instanceName?: string; instanceSecret?: typeof SECRET }) =>
  AdminKey("Key", { instanceName: "demo", instanceSecret: SECRET, ...props });

const action = (plan: { resources: Record<string, any> }) =>
  Object.values(plan.resources).find((entry) => entry.resource.Type === "Convex.AdminKey")?.action;

test.provider(
  "mints a key that starts with the instance name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(key({}));
      expect(Redacted.value(deployed.value)).toMatch(/^demo\|01[0-9a-f]+$/);
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
      expect(action(yield* stack.plan(key({})))).toBe("noop");
      const second = yield* stack.deploy(key({}));
      expect(Redacted.value(second.value)).toBe(Redacted.value(first.value));
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
  "opens a key minted by Convex's generate_key",
  Effect.gen(function* () {
    const claims = yield* openAdminKey(GENERATED_BY_CONVEX, SECRET);
    expect(claims.instanceName).toBe("demo");
    expect(claims.memberId).toBe(0n);
    expect(claims.issuedAt).toBeGreaterThan(1_700_000_000);
  }),
  unit,
);

test(
  "a minted key opens with its secret and no other",
  Effect.gen(function* () {
    const minted = yield* mintAdminKey({ instanceName: "demo", instanceSecret: SECRET });
    // Same shape as generate_key's: version, nonce, 8-byte body, tag.
    expect(Redacted.value(minted)).toHaveLength(Redacted.value(GENERATED_BY_CONVEX).length);
    const claims = yield* openAdminKey(minted, SECRET);
    expect(claims.instanceName).toBe("demo");
    expect(claims.memberId).toBe(0n);
    const wrong = yield* openAdminKey(minted, OTHER_SECRET).pipe(Effect.flip);
    expect(wrong._tag).toBe("InvalidAdminKey");
  }),
  unit,
);

test(
  "the secret is not in errors",
  Effect.gen(function* () {
    const secret = "not-hex-and-secret";
    const error = yield* mintAdminKey({
      instanceName: "demo",
      instanceSecret: Redacted.make(secret),
    }).pipe(Effect.flip);
    expect(error._tag).toBe("InvalidInstanceSecret");
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
  }),
  unit,
);

const CONTAINER = "alchemy-convex-admin-key-test";

const docker = (...args: string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    return (yield* spawner.string(
      ChildProcess.make("docker", args, { stdin: "ignore", stderr: "ignore" }),
    )).trim();
  });

/** The pinned backend image, on a free local port, under the test secret. */
const localBackend = Effect.acquireRelease(
  Effect.gen(function* () {
    yield* docker("rm", "-f", CONTAINER).pipe(Effect.ignore);
    yield* docker(
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-p",
      "127.0.0.1::3210",
      "-e",
      "INSTANCE_NAME=demo",
      "-e",
      `INSTANCE_SECRET=${Redacted.value(SECRET)}`,
      BACKEND_IMAGE,
    );
    const address = (yield* docker("port", CONTAINER, "3210")).split("\n")[0]!;
    return `http://${address}`;
  }),
  () => docker("rm", "-f", CONTAINER).pipe(Effect.ignore),
);

test(
  "the backend image accepts a minted key",
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* localBackend;
      const http = yield* HttpClient.HttpClient;
      yield* http.get(`${url}/version`).pipe(
        Effect.flatMap((response) =>
          response.status === 200 ? Effect.void : Effect.fail(`status ${response.status}`),
        ),
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 60 }),
      );
      const statusWith = (adminKey: Redacted.Redacted<string>) =>
        http
          .get(`${url}/api/list_environment_variables`, {
            headers: { authorization: `Convex ${Redacted.value(adminKey)}` },
          })
          .pipe(Effect.map((response) => response.status));

      const minted = yield* mintAdminKey({ instanceName: "demo", instanceSecret: SECRET });
      expect(yield* statusWith(minted)).toBe(200);
      const foreign = yield* mintAdminKey({ instanceName: "demo", instanceSecret: OTHER_SECRET });
      expect(yield* statusWith(foreign)).toBe(401);
    }),
  ),
  { ...options, exclusive: "docker:convex-admin-key-test" },
);
