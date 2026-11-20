import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Provider from "alchemy/Provider";
import { isResourceState, State, type ResourceState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const timeoutHandlerPath = fileURLToPath(new URL("./timeout-handler.ts", import.meta.url));

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create, update, list, replace, delete alias",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = ({
        envVersion,
        alias,
      }: {
        envVersion: string;
        alias?: {
          aliasName: string;
          description?: string;
          routingConfig?: Lambda.AliasRoutingConfiguration;
          provisionedConcurrentExecutions?: number;
        };
      }) =>
        Effect.gen(function* () {
          const fn = yield* AWS.Lambda.Function("AliasFn", {
            main: timeoutHandlerPath,
            handler: "handler",
            isExternal: true,
            functionUrl: false,
            env: {
              VERSION: envVersion,
            },
          });

          const version = yield* AWS.Lambda.Version("AliasVersion", {
            function: fn,
          });

          const live = alias
            ? yield* AWS.Lambda.Alias("LiveAlias", {
                version,
                aliasName: alias.aliasName,
                description: alias.description,
                routingConfig: alias.routingConfig,
                provisionedConcurrentExecutions: alias.provisionedConcurrentExecutions,
              })
            : undefined;

          return { fn, version, live };
        });

      const initial = yield* stack.deploy(program({ envVersion: "1" }));
      const version1 = initial.version.version;

      // --- create ---
      const created = yield* stack.deploy(
        program({
          envVersion: "1",
          alias: {
            aliasName: "live",
            description: "live v1",
            provisionedConcurrentExecutions: 1,
          },
        }),
      );
      const createdAlias = created.live!;

      expect(createdAlias.aliasName).toBe("live");
      expect(createdAlias.functionVersion).toBe(version1);
      expect(createdAlias.invokeArn).toContain(createdAlias.aliasArn);

      // Assert the alias actually exists in the cloud.
      const liveV1 = yield* getAliasOrUndefined(created.fn.functionName, "live");
      expect(liveV1).toBeDefined();
      expect(liveV1!.AliasArn).toBe(createdAlias.aliasArn);
      expect(liveV1!.FunctionVersion).toBe(version1);
      expect(liveV1!.Description).toBe("live v1");
      expect(liveV1!.RoutingConfig?.AdditionalVersionWeights ?? {}).toEqual({});
      const provisionedV1 = yield* getProvisionedConcurrencyOrUndefined(
        created.fn.functionName,
        "live",
      );
      expect(provisionedV1?.Status).toBe("READY");
      expect(provisionedV1?.RequestedProvisionedConcurrentExecutions).toBe(1);
      expect(provisionedV1?.AllocatedProvisionedConcurrentExecutions).toBe(1);

      // --- crash before the Version reference resolved ---
      // An interrupted first create persists the Version reference as missing
      // (it was still an unresolved Output at checkpoint time). The recovery
      // read finds nothing to recover instead of crashing (#2002), and the
      // re-driven create converges on the same alias.
      const state = yield* yield* State;
      const fqns = yield* state.list({ stack: stack.name, stage: stack.stage });
      const rows = yield* Effect.forEach(fqns, (fqn) =>
        state
          .get({ stack: stack.name, stage: stack.stage, fqn })
          .pipe(Effect.map((row) => ({ fqn, row }))),
      );
      const aliasRow = rows.find(
        (row): row is { fqn: string; row: ResourceState } =>
          isResourceState(row.row) && row.row.resourceType === "AWS.Lambda.Alias",
      );
      if (!aliasRow?.row.props) {
        return yield* Effect.die(
          new Error("no persisted AWS.Lambda.Alias props found after deploy"),
        );
      }
      yield* state.set({
        stack: stack.name,
        stage: stack.stage,
        fqn: aliasRow.fqn,
        value: {
          ...aliasRow.row,
          props: { ...aliasRow.row.props, version: undefined },
          status: "creating",
          attr: undefined,
        },
      });
      const recovered = yield* stack.deploy(
        program({
          envVersion: "1",
          alias: {
            aliasName: "live",
            description: "live v1",
            provisionedConcurrentExecutions: 1,
          },
        }),
      );
      expect(recovered.live!.aliasArn).toBe(createdAlias.aliasArn);
      expect(recovered.live!.functionVersion).toBe(version1);

      // --- update (function version with the same capacity) ---
      const targetUpdated = yield* stack.deploy(
        program({
          envVersion: "2",
          alias: {
            aliasName: "live",
            description: "live v2",
            provisionedConcurrentExecutions: 1,
          },
        }),
      );
      const version2 = targetUpdated.version.version;
      expect(targetUpdated.live!.aliasArn).toBe(createdAlias.aliasArn);
      expect(targetUpdated.live!.functionVersion).toBe(version2);
      const provisionedTargetUpdated = yield* getProvisionedConcurrencyOrUndefined(
        targetUpdated.fn.functionName,
        "live",
      );
      expect(provisionedTargetUpdated?.Status).toBe("READY");
      expect(provisionedTargetUpdated?.RequestedProvisionedConcurrentExecutions).toBe(1);
      expect(provisionedTargetUpdated?.AllocatedProvisionedConcurrentExecutions).toBe(1);

      // --- update (capacity + weighted routing + description) ---
      const updated = yield* stack.deploy(
        program({
          envVersion: "2",
          alias: {
            aliasName: "live",
            description: "weighted live",
            provisionedConcurrentExecutions: 2,
            routingConfig: {
              AdditionalVersionWeights: {
                [version1]: 0.25,
              },
            },
          },
        }),
      );
      const updatedAlias = updated.live!;

      // Updating in place must keep the same ARN (not a replacement).
      expect(updatedAlias.aliasArn).toBe(createdAlias.aliasArn);
      expect(updatedAlias.functionVersion).toBe(version2);
      expect(updatedAlias.description).toBe("weighted live");
      expect(updatedAlias.routingConfig).toEqual({
        AdditionalVersionWeights: {
          [version1]: 0.25,
        },
      });

      // Assert the cloud reflects the update.
      const liveV2 = yield* getAliasOrUndefined(updated.fn.functionName, "live");
      expect(liveV2).toBeDefined();
      expect(liveV2!.AliasArn).toBe(createdAlias.aliasArn);
      expect(liveV2!.FunctionVersion).toBe(version2);
      expect(liveV2!.Description).toBe("weighted live");
      expect(liveV2!.RoutingConfig?.AdditionalVersionWeights).toEqual({
        [version1]: 0.25,
      });
      const provisionedV2 = yield* getProvisionedConcurrencyOrUndefined(
        updated.fn.functionName,
        "live",
      );
      expect(provisionedV2?.Status).toBe("READY");
      expect(provisionedV2?.RequestedProvisionedConcurrentExecutions).toBe(2);
      expect(provisionedV2?.AllocatedProvisionedConcurrentExecutions).toBe(2);

      // --- update (clear description + routing) ---
      // Remove the allocation out of band first. The provider must treat the
      // already-absent configuration as an idempotent managed removal.
      yield* Lambda.deleteProvisionedConcurrencyConfig({
        FunctionName: updated.fn.functionName,
        Qualifier: "live",
      }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
      yield* waitForProvisionedConcurrencyAbsent(updated.fn.functionName, "live");
      const cleared = yield* stack.deploy(
        program({
          envVersion: "2",
          alias: {
            aliasName: "live",
          },
        }),
      );
      const clearedAlias = cleared.live!;

      expect(clearedAlias.aliasArn).toBe(createdAlias.aliasArn);
      expect(clearedAlias.functionVersion).toBe(version2);
      expect(clearedAlias.description).toBeUndefined();
      expect(clearedAlias.routingConfig).toBeUndefined();

      // Assert the cloud cleared description and routing.
      const liveCleared = yield* getAliasOrUndefined(cleared.fn.functionName, "live");
      expect(liveCleared).toBeDefined();
      expect(liveCleared!.Description ?? "").toBe("");
      expect(liveCleared!.RoutingConfig?.AdditionalVersionWeights ?? {}).toEqual({});
      yield* waitForProvisionedConcurrencyAbsent(cleared.fn.functionName, "live");

      // --- replace (rename the alias) ---
      // The provider's `diff` flags an aliasName change as a replacement, so a
      // brand new alias is created and the old one deleted.
      const replaced = yield* stack.deploy(
        program({
          envVersion: "2",
          alias: {
            aliasName: "stable",
            description: "renamed",
          },
        }),
      );
      const replacedAlias = replaced.live!;

      expect(replacedAlias.aliasName).toBe("stable");
      // A replacement must mint a new ARN.
      expect(replacedAlias.aliasArn).not.toBe(createdAlias.aliasArn);
      expect(replacedAlias.functionVersion).toBe(version2);
      expect(replacedAlias.description).toBe("renamed");

      // The new alias exists in the cloud...
      const stableAlias = yield* getAliasOrUndefined(replaced.fn.functionName, "stable");
      expect(stableAlias).toBeDefined();
      expect(stableAlias!.AliasArn).toBe(replacedAlias.aliasArn);
      expect(stableAlias!.FunctionVersion).toBe(version2);
      expect(stableAlias!.Description).toBe("renamed");

      // ...and the old one was deleted as part of the replacement.
      const oldLive = yield* getAliasOrUndefined(replaced.fn.functionName, "live");
      expect(oldLive).toBeUndefined();

      // --- list ---
      const provider = yield* Provider.findProvider(AWS.Lambda.Alias);
      const aliases = yield* provider.list();
      expect(
        aliases.some(
          (alias) =>
            alias.functionName === replaced.fn.functionName && alias.aliasName === "stable",
        ),
      ).toBe(true);

      // --- delete ---
      yield* stack.destroy();

      const afterDestroy = yield* getAliasOrUndefined(replaced.fn.functionName, "stable");
      expect(afterDestroy).toBeUndefined();

      // ...and the host function itself is gone (bounded retry to ride out
      // delete propagation).
      yield* Lambda.getFunction({
        FunctionName: replaced.fn.functionName,
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(new Error(`Function ${replaced.fn.functionName} still exists`)),
        ),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.retry({
          schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
        }),
      );
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { tags: ["provider:aws", "provider:aws:lambda", "live"] },
);

test.provider(
  "rejects zero provisioned concurrency with InvalidAliasProps",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            const fn = yield* AWS.Lambda.Function("InvalidAliasFn", {
              main: timeoutHandlerPath,
              handler: "handler",
              isExternal: true,
              functionUrl: false,
            });
            const version = yield* AWS.Lambda.Version("InvalidAliasVersion", {
              function: fn,
            });
            yield* AWS.Lambda.Alias("InvalidAlias", {
              version,
              aliasName: "invalid",
              provisionedConcurrentExecutions: 0,
            });
          }),
        ),
      );
      expect(error._tag).toBe("InvalidAliasProps");
      yield* stack.destroy();
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { tags: ["provider:aws", "provider:aws:lambda", "live"] },
);

test.provider(
  "preserves external provisioned concurrency through alias adoption and update",
  (stack) => {
    let externalFunctionName: string | undefined;
    const cleanup = Effect.gen(function* () {
      if (externalFunctionName !== undefined) {
        yield* Lambda.deleteProvisionedConcurrencyConfig({
          FunctionName: externalFunctionName,
          Qualifier: "external",
        }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
        yield* waitForProvisionedConcurrencyAbsent(externalFunctionName, "external");
      }
      yield* stack.destroy();
    }).pipe(Effect.ignore);
    return Effect.gen(function* () {
      yield* stack.destroy();
      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          const functionResource = yield* AWS.Lambda.Function("AdoptedAliasFn", {
            main: timeoutHandlerPath,
            handler: "handler",
            isExternal: true,
            functionUrl: false,
          });
          const version = yield* AWS.Lambda.Version("AdoptedAliasVersion", {
            function: functionResource,
          });
          return { functionResource, version };
        }),
      );
      const functionName = fn.functionResource.functionName;
      externalFunctionName = functionName;
      const versionNumber = fn.version.version;
      yield* Lambda.createAlias({
        FunctionName: functionName,
        Name: "external",
        FunctionVersion: versionNumber,
      });
      yield* Lambda.putProvisionedConcurrencyConfig({
        FunctionName: functionName,
        Qualifier: "external",
        ProvisionedConcurrentExecutions: 1,
      });
      const external = yield* waitForProvisionedConcurrencyReady(functionName, "external");
      expect(external.RequestedProvisionedConcurrentExecutions).toBe(1);

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          const functionResource = yield* AWS.Lambda.Function("AdoptedAliasFn", {
            main: timeoutHandlerPath,
            handler: "handler",
            isExternal: true,
            functionUrl: false,
          });
          const version = yield* AWS.Lambda.Version("AdoptedAliasVersion", {
            function: functionResource,
          });
          const alias = yield* AWS.Lambda.Alias("AdoptedAlias", {
            version,
            aliasName: "external",
            description: "adopted",
          });
          return { alias };
        }),
      );
      expect(adopted.alias.provisionedConcurrentExecutions).toBe(1);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const functionResource = yield* AWS.Lambda.Function("AdoptedAliasFn", {
            main: timeoutHandlerPath,
            handler: "handler",
            isExternal: true,
            functionUrl: false,
          });
          const version = yield* AWS.Lambda.Version("AdoptedAliasVersion", {
            function: functionResource,
          });
          const alias = yield* AWS.Lambda.Alias("AdoptedAlias", {
            version,
            aliasName: "external",
            description: "updated without ownership",
          });
          return { alias };
        }),
      );
      expect(updated.alias.description).toBe("updated without ownership");
      expect(updated.alias.provisionedConcurrentExecutions).toBe(1);
      const preserved = yield* getProvisionedConcurrencyOrUndefined(functionName, "external");
      expect(preserved?.Status).toBe("READY");
      expect(preserved?.RequestedProvisionedConcurrentExecutions).toBe(1);

      yield* Lambda.deleteProvisionedConcurrencyConfig({
        FunctionName: functionName,
        Qualifier: "external",
      }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
      yield* waitForProvisionedConcurrencyAbsent(functionName, "external");
      yield* stack.destroy();
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => cleanup),
    );
  },
  { tags: ["provider:aws", "provider:aws:lambda", "live"] },
);

const getAliasOrUndefined = Effect.fn(function* (functionName: string, name: string) {
  return yield* Lambda.getAlias({
    FunctionName: functionName,
    Name: name,
  }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)));
});

const getProvisionedConcurrencyOrUndefined = Effect.fn(function* (
  functionName: string,
  qualifier: string,
) {
  return yield* Lambda.getProvisionedConcurrencyConfig({
    FunctionName: functionName,
    Qualifier: qualifier,
  }).pipe(
    Effect.catchTag(
      ["ProvisionedConcurrencyConfigNotFoundException", "ResourceNotFoundException"],
      () => Effect.succeed(undefined),
    ),
  );
});

const waitForProvisionedConcurrencyAbsent = Effect.fn(function* (
  functionName: string,
  qualifier: string,
) {
  return yield* getProvisionedConcurrencyOrUndefined(functionName, qualifier).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (config) => config === undefined,
      times: 45,
    }),
  );
});

const waitForProvisionedConcurrencyReady = Effect.fn(function* (
  functionName: string,
  qualifier: string,
) {
  const config = yield* getProvisionedConcurrencyOrUndefined(functionName, qualifier).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (current) => current?.Status === "READY" || current?.Status === "FAILED",
      times: 45,
    }),
  );
  expect(config?.Status).toBe("READY");
  return config!;
});
