import * as Convex from "@alchemy.run/convex";
import { fromDeployment } from "@alchemy.run/convex/Credentials";
import { mintAdminKey } from "@alchemy.run/convex/internal/adminKey";
import * as Docker from "@alchemy.run/docker";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as deployments from "@distilled.cloud/convex/deployment";
import { adopt } from "alchemy/AdoptPolicy";
import * as Output from "alchemy/Output";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { findAvailablePort } from "../Docker/Runtime.ts";
import { BACKEND_IMAGE } from "./aws/support.ts";
import { scratchApp } from "./support.ts";

// A self-hosted backend in Docker, so the push path runs on this machine with
// no cloud account: the CLI runner, variable ordering, rollback and ownership.

const { test } = Test.make({
  providers: Layer.mergeAll(Convex.providers(), Docker.providers()),
});

const options = {
  tags: ["local", "provider:convex", "provider:convex:functions"],
  timeout: 300_000,
};

const INSTANCE_NAME = "alchemy-push-test";
/** A fixed test secret: 32 bytes, hex. */
const INSTANCE_SECRET = Redacted.make(
  "4361726c4d6172784361726c4d6172784361726c4d6172784361726c4d617278",
);

interface Backend {
  readonly url: string;
  readonly adminKey: Redacted.Redacted<string>;
  readonly port: number;
}

const makeBackend = Effect.gen(function* () {
  const port = yield* findAvailablePort();
  const adminKey = yield* mintAdminKey({
    instanceName: INSTANCE_NAME,
    instanceSecret: INSTANCE_SECRET,
  });
  return { url: `http://127.0.0.1:${port}`, adminKey, port } satisfies Backend;
});

const app = (
  suffix: string,
  backend: Backend,
  functions?: {
    rootDir: string;
    env?: Record<string, string | Redacted.Redacted<string>>;
    adopting?: boolean;
  },
) =>
  Effect.gen(function* () {
    const container = yield* Docker.Container("Backend", {
      name: `alchemy-test-convex-push-${suffix}`,
      image: BACKEND_IMAGE,
      environment: { INSTANCE_NAME, INSTANCE_SECRET },
      ports: [{ external: backend.port, internal: 3210 }],
      start: true,
    });
    if (functions !== undefined) {
      yield* Convex.Functions("Functions", {
        // Through the container, so the push waits for it and destroy removes
        // the variables before the container goes.
        backend: {
          url: Output.map(container.id, () => backend.url),
          adminKey: backend.adminKey,
        },
        rootDir: functions.rootDir,
        env: functions.env,
      }).pipe(adopt(functions.adopting ?? false));
    }
  });

/** Deploys the container alone, and waits for the backend to answer. */
const startBackend = (
  stack: { deploy: (program: ReturnType<typeof app>) => Effect.Effect<unknown, unknown> },
  suffix: string,
  backend: Backend,
) =>
  Effect.gen(function* () {
    yield* stack.deploy(app(suffix, backend));
    const client = yield* HttpClient.HttpClient;
    yield* client.get(`${backend.url}/version`).pipe(
      Effect.flatMap((response) =>
        response.status === 200 ? Effect.void : Effect.fail(new Error(`${response.status}`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 60 }),
    );
  });

const variables = (backend: Backend) =>
  deployments.listEnvironmentVariables({}).pipe(
    Effect.provide(fromDeployment({ url: backend.url, token: backend.adminKey })),
    Effect.map((response) => response.environmentVariables),
  );

const hello = (backend: Backend) =>
  Effect.tryPromise(() => new ConvexHttpClient(backend.url).query(anyApi.hello!.get!, {}));

const READS_AUTH_DOMAIN = `export default { providers: [{ domain: process.env.AUTH_DOMAIN, applicationID: "convex" }] };\n`;

const breakApp = Effect.fn(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(rootDir, "convex/hello.ts");
  yield* fs.writeFileString(file, `${yield* fs.readFileString(file)}import "./does-not-exist";\n`);
});

test.provider(
  "pushes to a self-hosted backend and a query answers",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const backend = yield* makeBackend;
      const rootDir = yield* scratchApp("selfhosted-push");
      yield* startBackend(stack, "push", backend);
      yield* stack.deploy(app("push", backend, { rootDir, env: { MODE: "one" } }));
      expect(yield* hello(backend)).toBe("hello from the fixture");
      expect((yield* variables(backend)).MODE).toBe("one");
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "one deploy stops reading a variable and drops it (self-hosted)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const backend = yield* makeBackend;
      const rootDir = yield* scratchApp("selfhosted-drop");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const authConfig = path.join(rootDir, "convex/auth.config.ts");
      yield* fs.writeFileString(authConfig, READS_AUTH_DOMAIN);
      yield* startBackend(stack, "drop", backend);
      yield* stack.deploy(
        app("drop", backend, { rootDir, env: { AUTH_DOMAIN: "https://accounts.google.com" } }),
      );

      yield* fs.writeFileString(authConfig, "export default { providers: [] };\n");
      yield* stack.deploy(app("drop", backend, { rootDir }));
      expect(yield* variables(backend)).not.toHaveProperty("AUTH_DOMAIN");
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "a failed push puts the variables back (self-hosted)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const backend = yield* makeBackend;
      const rootDir = yield* scratchApp("selfhosted-rollback");
      yield* startBackend(stack, "rollback", backend);
      yield* stack.deploy(app("rollback", backend, { rootDir, env: { MODE: "one" } }));

      yield* breakApp(rootDir);
      const secret = "s3cr3t-value-123";
      const failed = yield* stack
        .deploy(
          app("rollback", backend, {
            rootDir,
            env: { MODE: "two", TOKEN: Redacted.make(secret) },
          }),
        )
        .pipe(Effect.flip);
      expect(failed).toMatchObject({ _tag: "CodePushFailed" });
      const text = `${String(failed)} ${JSON.stringify(failed)}`;
      expect(text).toContain("does-not-exist");
      expect(text).not.toContain(secret);
      expect(text).not.toContain(Redacted.value(backend.adminKey).split("|")[1]);
      const after = yield* variables(backend);
      expect(after.MODE).toBe("one");
      expect(after).not.toHaveProperty("TOKEN");
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "a variable set by hand is not overwritten without adopt (self-hosted)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const backend = yield* makeBackend;
      const rootDir = yield* scratchApp("selfhosted-foreign");
      yield* startBackend(stack, "foreign", backend);
      yield* stack.deploy(app("foreign", backend, { rootDir }));
      yield* deployments
        .updateEnvironmentVariables({ changes: [{ name: "HAND", value: "theirs" }] })
        .pipe(Effect.provide(fromDeployment({ url: backend.url, token: backend.adminKey })));

      const refused = yield* stack
        .deploy(app("foreign", backend, { rootDir, env: { HAND: "ours" } }))
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "VariablesOwnedBySomeoneElse", names: ["HAND"] });
      expect((yield* variables(backend)).HAND).toBe("theirs");

      yield* stack.deploy(
        app("foreign", backend, { rootDir, env: { HAND: "ours" }, adopting: true }),
      );
      expect((yield* variables(backend)).HAND).toBe("ours");
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "a .env.local selecting another backend does not redirect the push",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const backend = yield* makeBackend;
      const rootDir = yield* scratchApp("selfhosted-env-local");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(rootDir, ".env.local"),
        "CONVEX_SELF_HOSTED_URL=http://127.0.0.1:9\nCONVEX_SELF_HOSTED_ADMIN_KEY=wrong|00\n",
      );
      yield* startBackend(stack, "env-local", backend);
      yield* stack.deploy(app("env-local", backend, { rootDir }));
      expect(yield* hello(backend)).toBe("hello from the fixture");
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "an unchanged app plans no push (self-hosted)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const backend = yield* makeBackend;
      const rootDir = yield* scratchApp("selfhosted-memo");
      yield* startBackend(stack, "memo", backend);
      yield* stack.deploy(app("memo", backend, { rootDir, env: { MODE: "one" } }));
      const plan = yield* stack.plan(app("memo", backend, { rootDir, env: { MODE: "one" } }));
      const action = Object.values(plan.resources).find(
        (entry: any) => entry.resource.Type === "Convex.Functions",
      )?.action;
      expect(action).toBe("noop");
      yield* stack.destroy();
    }),
  options,
);
