import * as Convex from "@alchemy.run/convex";
import { fromDeployment } from "@alchemy.run/convex/Credentials";
import { EnvironmentVariables } from "@alchemy.run/convex/EnvironmentVariables";
import { envChanges, envHash } from "@alchemy.run/convex/internal/env";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as convex from "@distilled.cloud/convex/convex";
import * as deployments from "@distilled.cloud/convex/deployment";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { testName } from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });
const options = { timeout: 180_000 };

const app = (name: string, env: Record<string, string | Redacted.Redacted<string>>) =>
  Effect.gen(function* () {
    const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
    const deployment = yield* Convex.Deployment("Deployment", { project, type: "preview" });
    const key = yield* Convex.DeployKey("Key", { deployment });
    const variables = yield* EnvironmentVariables("Env", {
      url: deployment.url,
      token: key.value,
      env,
    });
    return { deployment, key, variables };
  });

const on = (url: string, token: Redacted.Redacted<string>) =>
  Effect.provide(fromDeployment({ url, token }));

const variables = (url: string, token: Redacted.Redacted<string>) =>
  deployments.listEnvironmentVariables({}).pipe(
    on(url, token),
    Effect.map((result) => result.environmentVariables),
  );

const row = (plan: { resources: Record<string, any> }) =>
  Object.values(plan.resources).find(
    (entry) => entry.resource.Type === "Convex.EnvironmentVariables",
  );

test.provider(
  "sets, updates and removes managed variables",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("env-sync");
      const first = yield* stack.deploy(app(name, { A: "1", B: "2" }));
      const read = () => variables(first.deployment.url, first.key.value);
      expect(yield* read()).toEqual({ A: "1", B: "2" });

      yield* stack.deploy(app(name, { A: "3" }));
      expect(yield* read()).toEqual({ A: "3" });

      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "keeps a variable set by hand",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("env-hand");
      const first = yield* stack.deploy(app(name, { A: "1" }));
      yield* deployments
        .updateEnvironmentVariables({ changes: [{ name: "HAND", value: "kept" }] })
        .pipe(on(first.deployment.url, first.key.value));

      yield* stack.deploy(app(name, { A: "2" }));
      yield* stack.deploy(app(name, {}));
      expect(yield* variables(first.deployment.url, first.key.value)).toEqual({ HAND: "kept" });

      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "redeploy with no change plans nothing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("env-noop");
      yield* stack.deploy(app(name, { A: "1", SECRET: Redacted.make("hidden") }));
      const plan = yield* stack.plan(app(name, { A: "1", SECRET: Redacted.make("hidden") }));
      expect(row(plan)?.action).toBe("noop");
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "Redacted value stays out of plan output",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("env-redacted");
      const value = "a-value-that-must-not-appear";
      yield* stack.deploy(app(name, { SECRET: Redacted.make(value) }));
      const plan = yield* stack.plan(app(name, { SECRET: Redacted.make(`${value}-changed`) }));
      expect(row(plan)?.action).toBe("update");
      expect(JSON.stringify(plan)).not.toContain(value);
      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "delete tolerates a deployment that is already gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("env-gone");
      const { deployment } = yield* stack.deploy(app(name, { A: "1" }));
      yield* convex.deleteDeployment({ deployment_name: deployment.deploymentName });

      const destroyed = yield* stack.destroy().pipe(Effect.result);
      expect(Result.isSuccess(destroyed)).toBe(true);
    }),
  options,
);

test.provider("envChanges sets, deletes managed names, and leaves the rest", () =>
  Effect.sync(() => {
    expect(envChanges({ A: "1" }, { A: "2" }, ["A"])).toEqual([{ name: "A", value: "2" }]);
    expect(envChanges({}, { A: "1" }, [])).toEqual([{ name: "A", value: "1" }]);
    expect(envChanges({ A: "1", B: "2" }, { A: "1" }, ["A", "B"])).toEqual([
      { name: "B", value: null },
    ]);
    expect(envChanges({ HAND: "x" }, {}, [])).toEqual([]);
    expect(envChanges({ A: "1" }, { A: "1" }, ["A"])).toEqual([]);
    expect(envChanges({}, {}, ["A"])).toEqual([]);
  }),
);

test.provider("envHash ignores order and depends on values and key", () =>
  Effect.sync(() => {
    expect(envHash({ A: "1", B: "2" }, "key")).toBe(envHash({ B: "2", A: "1" }, "key"));
    expect(envHash({ A: "1" }, "key")).not.toBe(envHash({ A: "2" }, "key"));
    expect(envHash({ A: "1" }, "key")).not.toBe(envHash({ A: "1" }, "other"));
    expect(envHash({ AB: "C" }, "key")).not.toBe(envHash({ A: "BC" }, "key"));
  }),
);
