import * as Convex from "@alchemy.run/convex";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as management from "@distilled.cloud/convex/management";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { convexCli, testName } from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });
const provider = test.provider;
const options = { timeout: 180_000 };

const app = (name: string) =>
  Effect.gen(function* () {
    const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
    const key = yield* Convex.PreviewDeployKey("Key", { project });
    return { project, key };
  });

const start = Effect.fn(function* (
  stack: { destroy: () => Effect.Effect<void, any, never> },
  suffix: string,
) {
  yield* stack.destroy();
  const name = yield* testName(suffix);
  return name;
});

provider(
  "creates a preview through the key",
  (stack) =>
    Effect.gen(function* () {
      const name = yield* start(stack, "preview-key");
      const { project, key } = yield* stack.deploy(app(name));

      const result = yield* convexCli(["deploy", "--preview-create", "via-key"], {
        CONVEX_DEPLOY_KEY: Redacted.value(key.value),
      });
      expect(result.code).toBe(0);
      expect(result.output).not.toContain(Redacted.value(key.value));

      const previews = yield* management.listDeployments({
        projectId: project.projectId,
        deploymentType: "preview",
      });
      expect(
        previews.map((item) => (item.kind === "cloud" ? item.reference : undefined)),
      ).toContain("preview/via-key");

      yield* stack.destroy();
    }),
  options,
);

provider(
  "redeploy keeps the value",
  (stack) =>
    Effect.gen(function* () {
      const name = yield* start(stack, "preview-key-keep");
      const first = yield* stack.deploy(app(name));
      const second = yield* stack.deploy(app(name));
      expect(Redacted.value(second.key.value)).toBe(Redacted.value(first.key.value));
      yield* stack.destroy();
    }),
  options,
);

provider(
  "destroy revokes it",
  (stack) =>
    Effect.gen(function* () {
      const name = yield* start(stack, "preview-key-revoke");
      const { project, key } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.retain());
          const key = yield* Convex.PreviewDeployKey("Key", { project });
          return { project, key };
        }),
      );
      expect(
        (yield* management.listPreviewDeployKeys({ projectId: project.projectId })).items.map(
          (k) => k.name,
        ),
      ).toEqual([key.name]);

      yield* stack.destroy();
      expect(
        (yield* management.listPreviewDeployKeys({ projectId: project.projectId })).items,
      ).toEqual([]);
      yield* management.deleteProject({ projectId: project.projectId });
    }),
  options,
);

provider(
  "replacing a named key leaves a working key",
  (stack) =>
    Effect.gen(function* () {
      const name = yield* start(stack, "preview-replace");
      const keyName = `${name}-named`;
      const named = (expiresAt?: number) =>
        Effect.gen(function* () {
          const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
          const key = yield* Convex.PreviewDeployKey("Key", {
            project,
            name: keyName,
            expiresAt,
          });
          return { project, key };
        });
      const first = yield* stack.deploy(named());
      const second = yield* stack.deploy(named(4_102_444_800_000));
      expect(Redacted.value(second.key.value)).not.toBe(Redacted.value(first.key.value));

      const { items } = yield* management.listPreviewDeployKeys({
        projectId: first.project.projectId,
      });
      expect(items.map((item) => item.name)).toEqual([second.key.name]);
      yield* stack.destroy();
    }),
  options,
);
