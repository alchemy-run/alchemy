import * as Convex from "@alchemy.run/convex";
import { pushCommand } from "@alchemy.run/convex/Functions";
import { findConvexCli } from "@alchemy.run/convex/internal/cli";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as management from "@distilled.cloud/convex/management";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { scratchApp, testName } from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });
const options = { timeout: 300_000 };

const app = (
  name: string,
  rootDir: string,
  env?: Record<string, string | Redacted.Redacted<string>>,
  deployment: Omit<Convex.DeploymentProps, "project"> = { type: "preview" },
) =>
  Effect.gen(function* () {
    const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
    const target = yield* Convex.Deployment("Deployment", { project, ...deployment });
    yield* Convex.Functions("Functions", { deployment: target, rootDir, env });
    return { deployment: target };
  });

const client = (url: string) => new ConvexHttpClient(url);

const hello = (url: string) => Effect.tryPromise(() => client(url).query(anyApi.hello!.get!, {}));

const pushAction = (plan: { resources: Record<string, any> }) =>
  Object.values(plan.resources).find((entry) => entry.resource.Type === "Command.Exec")?.action;

test.provider(
  "pushes functions and a query returns data",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("functions-push");
      const rootDir = yield* scratchApp("functions-push");
      const { deployment } = yield* stack.deploy(app(name, rootDir));
      expect(yield* hello(deployment.url)).toBe("hello from the fixture");
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "env is set before push",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("functions-env");
      const rootDir = yield* scratchApp("functions-env");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(rootDir, "convex/auth.config.ts"),
        `export default { providers: [{ domain: process.env.AUTH_DOMAIN, applicationID: "convex" }] };\n`,
      );

      const missing = yield* stack.deploy(app(name, rootDir)).pipe(Effect.result);
      expect(Result.isFailure(missing)).toBe(true);

      const { deployment } = yield* stack.deploy(
        app(name, rootDir, { AUTH_DOMAIN: "https://accounts.google.com" }),
      );
      expect(yield* hello(deployment.url)).toBe("hello from the fixture");
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "deleting a variable the auth config reads fails with its typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("functions-auth");
      const rootDir = yield* scratchApp("functions-auth");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(rootDir, "convex/auth.config.ts"),
        `export default { providers: [{ domain: process.env.AUTH_DOMAIN, applicationID: "convex" }] };\n`,
      );
      yield* stack.deploy(app(name, rootDir, { AUTH_DOMAIN: "https://accounts.google.com" }));

      const refused = yield* stack.deploy(app(name, rootDir)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) {
        expect((refused.failure as { _tag: string })._tag).toBe(
          "AuthConfigMissingEnvironmentVariable",
        );
      }
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "unchanged folder does not redeploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("functions-memo");
      const rootDir = yield* scratchApp("functions-memo");
      yield* stack.deploy(app(name, rootDir));
      expect(pushAction(yield* stack.plan(app(name, rootDir)))).toBe("noop");
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "changing a file redeploys",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("functions-change");
      const rootDir = yield* scratchApp("functions-change");
      yield* stack.deploy(app(name, rootDir));

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(rootDir, "convex/hello.ts"),
        `import { queryGeneric } from "convex/server";\n\nexport const get = queryGeneric({ args: {}, handler: async () => "changed" });\n`,
      );
      expect(pushAction(yield* stack.plan(app(name, rootDir)))).toBe("update");

      const { deployment } = yield* stack.deploy(app(name, rootDir));
      expect(yield* hello(deployment.url)).toBe("changed");
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "expired preview is re-pushed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("functions-expired");
      const rootDir = yield* scratchApp("functions-expired");
      const first = yield* stack.deploy(app(name, rootDir));
      yield* management.deleteDeployment({ deploymentName: first.deployment.deploymentName });

      const second = yield* stack.deploy(app(name, rootDir));
      expect(second.deployment.url).not.toBe(first.deployment.url);
      expect(yield* hello(second.deployment.url)).toBe("hello from the fixture");
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "a failed push keeps the key out of the error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("functions-broken");
      const rootDir = yield* scratchApp("functions-broken");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(rootDir, "convex/hello.ts");
      yield* fs.writeFileString(
        file,
        `${yield* fs.readFileString(file)}import "./does-not-exist";\n`,
      );

      const failed = yield* stack.deploy(app(name, rootDir)).pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      if (Result.isFailure(failed)) {
        const text = `${String(failed.failure)} ${JSON.stringify(failed.failure)}`;
        expect(text).toContain("does-not-exist");
        expect(text).not.toMatch(/\|ey[A-Za-z0-9_-]{10,}/);
      }
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "a paused deployment refuses a call, and resuming keeps the data",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("functions-pause");
      const rootDir = yield* scratchApp("functions-pause");
      const { deployment } = yield* stack.deploy(app(name, rootDir));
      const url = deployment.url;
      yield* Effect.tryPromise(() => client(url).mutation(anyApi.messages!.add!, { body: "kept" }));

      yield* stack.deploy(app(name, rootDir, undefined, { type: "preview", paused: true }));
      const refused = yield* hello(url).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);

      yield* stack.deploy(app(name, rootDir, undefined, { type: "preview", paused: false }));
      const rows = yield* Effect.tryPromise(() => client(url).query(anyApi.messages!.list!, {}));
      expect(rows.map((row: { body: string }) => row.body)).toEqual(["kept"]);
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "a transfer keeps stored rows",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("functions-move");
      const rootDir = yield* scratchApp("functions-move");
      const moved = (target: "A" | "B") =>
        Effect.gen(function* () {
          const a = yield* Convex.Project("A", { name: `${name}-a` }).pipe(RemovalPolicy.destroy());
          const b = yield* Convex.Project("B", { name: `${name}-b` }).pipe(RemovalPolicy.destroy());
          const deployment = yield* Convex.Deployment("Deployment", {
            project: target === "A" ? a : b,
            type: "dev",
          });
          yield* Convex.Functions("Functions", { deployment, rootDir });
          return { b, deployment };
        });

      const before = yield* stack.deploy(moved("A"));
      yield* Effect.tryPromise(() =>
        client(before.deployment.url).mutation(anyApi.messages!.add!, { body: "kept" }),
      );

      const after = yield* stack.deploy(moved("B"));
      expect(after.deployment.projectId).toBe(after.b.projectId);
      const rows = yield* Effect.tryPromise(() =>
        client(after.deployment.url).query(anyApi.messages!.list!, {}),
      );
      expect(rows.map((row: { body: string }) => row.body)).toEqual(["kept"]);
      yield* stack.destroy();
    }),
  options,
);

test.provider("findConvexCli finds the binary in a parent folder, or names rootDir", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "convex-cli-" });
    const empty = yield* findConvexCli(dir).pipe(Effect.flip);
    expect(empty._tag).toBe("ConvexCliNotFound");
    expect(empty.message).toContain(dir);

    const bin = path.join(dir, "node_modules/.bin");
    const rootDir = path.join(dir, "packages/backend");
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.makeDirectory(rootDir, { recursive: true });
    yield* fs.writeFileString(path.join(bin, "convex"), "");
    expect(yield* findConvexCli(rootDir)).toBe(path.join(bin, "convex"));
    expect(yield* pushCommand(rootDir)).toBe(`"../../node_modules/.bin/convex" deploy --yes`);
  }),
);

test.provider("a project with no convex CLI fails at the push, not when the stack is read", () =>
  Effect.gen(function* () {
    const command = yield* pushCommand("/nonexistent/app");
    expect(command).toContain("exit 127");
    expect(command).toContain("Add convex");
  }),
);
