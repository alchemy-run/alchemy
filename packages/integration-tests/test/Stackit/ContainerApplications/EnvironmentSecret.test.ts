import * as Stackit from "@alchemy.run/stackit";
import { removeSecretKeys } from "@alchemy.run/stackit/ContainerApplications/internal";
import { expect } from "@alchemy.run/test";
import * as sca from "@distilled.cloud/stackit/sca";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitTags } from "../helpers.ts";
import {
  EXAMPLE_IMAGE,
  expectApplicationGone,
  noApplications,
  secretKeys,
  sharedEnvironment,
} from "./helpers.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("containerapplications", "environmentsecret"),
  timeout: 300_000,
} as const;

test.provider(
  "create, update in place, replace on a new key, and remove on destroy",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* sharedEnvironment;
      yield* stack.destroy();

      const secret = (key: string, value: string) =>
        Stackit.ContainerApplications.EnvironmentSecret("Lifecycle", {
          environmentId: scope.environmentId,
          key,
          value: Redacted.make(value),
        });

      const created = yield* stack.deploy(secret("alchemy-test-lifecycle", "one"));
      expect(created.key).toEqual("alchemy-test-lifecycle");
      expect(created.consumers).toEqual([]);
      expect(yield* secretKeys(scope)).toContain("alchemy-test-lifecycle");
      // A secret's value never reaches attributes.
      expect(JSON.stringify(created)).not.toContain("one");

      const unchanged = yield* stack.plan(secret("alchemy-test-lifecycle", "one"));
      expect(unchanged.resources.Lifecycle).toMatchObject({ action: "noop" });

      const changed = yield* stack.plan(secret("alchemy-test-lifecycle", "two"));
      expect(changed.resources.Lifecycle).toMatchObject({ action: "update" });
      const updated = yield* stack.deploy(secret("alchemy-test-lifecycle", "two"));
      expect(updated.key).toEqual("alchemy-test-lifecycle");

      const replaced = yield* stack.deploy(secret("alchemy-test-lifecycle-2", "two"));
      expect(replaced.key).toEqual("alchemy-test-lifecycle-2");
      const keys = yield* secretKeys(scope);
      expect(keys).toContain("alchemy-test-lifecycle-2");
      expect(keys).not.toContain("alchemy-test-lifecycle");

      yield* stack.destroy();
      expect(yield* secretKeys(scope)).not.toContain("alchemy-test-lifecycle-2");
    }).pipe(logLevel),
  options,
);

test.provider(
  "a write keeps the environment's other secrets",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* sharedEnvironment;
      yield* stack.destroy();

      const deployed = Effect.gen(function* () {
        const first = yield* Stackit.ContainerApplications.EnvironmentSecret("First", {
          environmentId: scope.environmentId,
          key: "alchemy-test-first",
          value: Redacted.make("one"),
        });
        const second = yield* Stackit.ContainerApplications.EnvironmentSecret("Second", {
          environmentId: scope.environmentId,
          key: "alchemy-test-second",
          value: Redacted.make("two"),
        });
        return { first: first.key, second: second.key };
      });
      yield* stack.deploy(deployed);

      const keys = yield* secretKeys(scope);
      expect(keys).toContain("alchemy-test-first");
      expect(keys).toContain("alchemy-test-second");

      yield* stack.destroy();
      const left = yield* secretKeys(scope);
      expect(left).not.toContain("alchemy-test-first");
      expect(left).not.toContain("alchemy-test-second");
    }).pipe(logLevel),
  options,
);

test.provider(
  "a key already in the environment is refused without adoption",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* sharedEnvironment;
      yield* stack.destroy();
      const key = "alchemy-test-foreign";
      yield* Effect.acquireUseRelease(
        sca.updateEnvironmentSecrets({ ...scope, secrets: [{ key, value: "theirs" }] }),
        () =>
          Effect.gen(function* () {
            const error = yield* stack
              .deploy(
                Stackit.ContainerApplications.EnvironmentSecret("Foreign", {
                  environmentId: scope.environmentId,
                  key,
                  value: "ours",
                }),
              )
              .pipe(Effect.flip);
            expect(error._tag).toEqual("OwnedBySomeoneElse");
            expect(yield* secretKeys(scope)).toContain(key);
          }),
        () => removeSecretKeys(scope, [key]).pipe(Effect.ignore),
      );
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(noApplications)(
  "a secret someone else's application uses stops the destroy",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* sharedEnvironment;
      yield* stack.destroy();
      const key = "alchemy-test-in-use";

      yield* stack.deploy(
        Stackit.ContainerApplications.EnvironmentSecret("InUse", {
          environmentId: scope.environmentId,
          key,
          value: "theirs",
        }),
      );

      const created = yield* sca.createApplication({
        ...scope,
        displayName: "alchemy-test-secret-consumer",
        containers: [
          {
            name: "app",
            image: EXAMPLE_IMAGE,
            environmentVariables: [
              { key: "VALUE", origin: "ENV_FROM_SOURCE_TYPE_SECRET", value: key },
            ],
          },
        ],
        scaling: { type: "SCALING_TYPE_MANUAL", manualScaling: { instances: 1 } },
      });
      const applicationId = created.id!;

      yield* Effect.gen(function* () {
        const error = yield* stack.destroy().pipe(Effect.flip);
        expect(error._tag).toEqual("Stackit.ContainerApplications.EnvironmentSecretInUse");
        expect(yield* secretKeys(scope)).toContain(key);
      }).pipe(
        Effect.ensuring(sca.deleteApplication({ ...scope, applicationId }).pipe(Effect.ignore)),
      );
      yield* expectApplicationGone(scope, applicationId);

      yield* stack.destroy();
      expect(yield* secretKeys(scope)).not.toContain(key);
    }).pipe(logLevel),
  { ...options, timeout: 900_000 },
);
