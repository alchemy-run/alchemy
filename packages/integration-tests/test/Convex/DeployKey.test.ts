import * as Convex from "@alchemy.run/convex";
import { fromDeployment } from "@alchemy.run/convex/Credentials";
import { findStoredKey } from "@alchemy.run/convex/internal/keys";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as deployments from "@distilled.cloud/convex/deployment";
import * as management from "@distilled.cloud/convex/management";
import { adopt } from "alchemy/AdoptPolicy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { testName } from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });
const provider = test.provider;
const options = {
  tags: ["provider:convex", "provider:convex:deploykey", "live"],
  timeout: 180_000,
};

const ENV_ACTIONS = ["deployment:env:view", "deployment:env:write"];

const app = (name: string, props: Omit<Convex.DeployKeyProps, "deployment"> = {}) =>
  Effect.gen(function* () {
    const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
    const deployment = yield* Convex.Deployment("Deployment", { project, type: "preview" });
    const key = yield* Convex.DeployKey("Key", { deployment, ...props });
    return { deployment, key };
  });

const start = Effect.fn(function* (
  stack: { destroy: () => Effect.Effect<void, any, never> },
  suffix: string,
) {
  yield* stack.destroy();
  const name = yield* testName(suffix);
  return name;
});

const works = (url: string, key: Redacted.Redacted<string>) =>
  deployments.listEnvironmentVariables({}).pipe(
    Effect.provide(fromDeployment({ url, token: key })),
    Effect.as(true),
    Effect.catchTag(["Unauthorized", "MalformedAccessToken", "BadDeployKey"], () =>
      Effect.succeed(false),
    ),
  );

provider(
  "value authenticates against the deployment",
  (stack) =>
    Effect.gen(function* () {
      const name = yield* start(stack, "key-auth");
      const { deployment, key } = yield* stack.deploy(app(name));
      expect(Redacted.isRedacted(key.value)).toBe(true);
      expect(yield* works(deployment.url, key.value)).toBe(true);
      yield* stack.destroy();
    }),
  options,
);

provider(
  "redeploy keeps the same value",
  (stack) =>
    Effect.gen(function* () {
      const name = yield* start(stack, "key-keep");
      const first = yield* stack.deploy(app(name));
      const second = yield* stack.deploy(app(name));
      expect(Redacted.value(second.key.value)).toBe(Redacted.value(first.key.value));
      yield* stack.destroy();
    }),
  options,
);

provider(
  "changing allowedActions replaces it and revokes the old key",
  (stack) =>
    Effect.gen(function* () {
      const name = yield* start(stack, "key-replace");
      const first = yield* stack.deploy(app(name, { allowedActions: ENV_ACTIONS }));
      const second = yield* stack.deploy(
        app(name, { allowedActions: [...ENV_ACTIONS, "deployment:deploy"] }),
      );

      expect(second.key.keyId).not.toBe(first.key.keyId);
      expect(yield* works(second.deployment.url, second.key.value)).toBe(true);
      expect(yield* works(first.deployment.url, first.key.value)).toBe(false);
      yield* stack.destroy();
    }),
  options,
);

provider(
  "adopting rotates the key",
  (stack) =>
    Effect.gen(function* () {
      const name = yield* start(stack, "key-adopt");
      const keyName = `${name}-adopted`;
      const base = yield* stack.deploy(app(name, { name: `${keyName}-base` }));
      const { deployKey: foreign } = yield* management.createDeployKey({
        deploymentName: base.deployment.deploymentName,
        name: keyName,
      });

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          const { deployment } = yield* app(name, { name: `${keyName}-base` });
          const key = yield* Convex.DeployKey("Adopted", { deployment, name: keyName }).pipe(
            adopt(true),
          );
          return { deployment, key };
        }),
      );

      expect(Redacted.value(adopted.key.value)).not.toBe(Redacted.value(foreign));
      expect(yield* works(adopted.deployment.url, adopted.key.value)).toBe(true);
      expect(yield* works(adopted.deployment.url, foreign)).toBe(false);
      yield* stack.destroy();
    }),
  options,
);

provider(
  "value is absent from plan output",
  (stack) =>
    Effect.gen(function* () {
      const name = yield* start(stack, "key-plan");
      const { key } = yield* stack.deploy(app(name));
      const plan = yield* stack.plan(app(name));
      expect(JSON.stringify(plan)).not.toContain(Redacted.value(key.value));
      yield* stack.destroy();
    }),
  options,
);

provider(
  "replacing a named key leaves a working key",
  (stack) =>
    Effect.gen(function* () {
      const name = yield* start(stack, "key-named");
      const keyName = `${name}-named`;
      const first = yield* stack.deploy(app(name, { name: keyName, allowedActions: ENV_ACTIONS }));
      const second = yield* stack.deploy(
        app(name, { name: keyName, allowedActions: [...ENV_ACTIONS, "deployment:deploy"] }),
      );
      expect(yield* works(second.deployment.url, second.key.value)).toBe(true);
      expect(yield* works(first.deployment.url, first.key.value)).toBe(false);

      // Later deploys see the real key, so the state stays honest.
      const third = yield* stack.deploy(
        app(name, { name: keyName, allowedActions: [...ENV_ACTIONS, "deployment:deploy"] }),
      );
      expect(Redacted.value(third.key.value)).toBe(Redacted.value(second.key.value));
      yield* stack.destroy();
    }),
  options,
);

provider(
  "updating the deployment keeps its keys",
  (stack) =>
    Effect.gen(function* () {
      const name = yield* start(stack, "key-update");
      const keyed = (deletionProtection: boolean) =>
        Effect.gen(function* () {
          const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
          const deployment = yield* Convex.Deployment("Deployment", {
            project,
            type: "preview",
            deletionProtection,
          });
          const key = yield* Convex.DeployKey("Key", { deployment });
          return { deployment, key };
        });
      const first = yield* stack.deploy(keyed(true));
      const second = yield* stack.deploy(keyed(false));
      expect(Redacted.value(second.key.value)).toBe(Redacted.value(first.key.value));
      expect(second.key.keyId).toBe(first.key.keyId);
      expect(yield* works(second.deployment.url, second.key.value)).toBe(true);
      yield* stack.destroy();
    }),
  options,
);

provider(
  "a repeated name is stored and deleted exactly",
  (stack) =>
    Effect.gen(function* () {
      const name = yield* start(stack, "key-repeat");
      const keyName = `${name}-repeat`;
      const first = yield* stack.deploy(app(name, { name: `${keyName}-base` }));
      const deploymentName = first.deployment.deploymentName;
      yield* management.createDeployKey({ deploymentName, name: keyName });

      const withKey = (keep: boolean) =>
        Effect.gen(function* () {
          const { deployment } = yield* app(name, { name: `${keyName}-base` });
          if (keep) {
            yield* Convex.DeployKey("Repeat", { deployment, name: keyName }).pipe(adopt(true));
          }
        });
      yield* stack.deploy(withKey(true));
      yield* stack.deploy(withKey(false));

      const names = (yield* management.listDeployKeys({ deploymentName })).map((key) => key.name);
      expect(
        names.filter((stored) => stored.startsWith(keyName) && !stored.endsWith("-base")),
      ).toEqual([]);
      yield* stack.destroy();
    }),
  options,
);

provider(
  "delete survives a deployment that is already gone",
  (stack) =>
    Effect.gen(function* () {
      const name = yield* start(stack, "key-gone");
      const { deployment } = yield* stack.deploy(app(name));
      yield* management.deleteDeployment({ deploymentName: deployment.deploymentName });

      const destroyed = yield* stack.destroy().pipe(Effect.result);
      expect(Result.isSuccess(destroyed)).toBe(true);
    }),
  options,
);

test.provider(
  "findStoredKey finds the suffixed name Convex gives a repeated key",
  () =>
    Effect.sync(() => {
      const key = (name: string, creationTime: number) => ({ name, creationTime });
      expect(findStoredKey([key("a", 1), key("b", 2)], "b")?.name).toBe("b");
      const repeated = "deploy (43a710ee-e480-4946-9efa-eca2338fd72a)";
      expect(findStoredKey([key("deploy", 1), key(repeated, 2)], "deploy")?.name).toBe(repeated);
      expect(findStoredKey([key("deploy-2", 1)], "deploy")).toBeUndefined();
      expect(findStoredKey([], "deploy")).toBeUndefined();
    }),
  { tags: ["unit", "provider:convex", "local"] },
);
