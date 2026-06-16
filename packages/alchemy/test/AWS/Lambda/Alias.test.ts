import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const timeoutHandlerPath = new URL("./timeout-handler.ts", import.meta.url)
  .pathname;

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create, update, list, delete alias",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = ({
        envVersion,
        alias,
      }: {
        envVersion: string;
        alias?: {
          functionVersion: string;
          description?: string;
          routingConfig?: Lambda.AliasRoutingConfiguration;
        };
      }) =>
        Effect.gen(function* () {
          const fn = yield* AWS.Lambda.Function<{}>()("AliasFn", {
            main: timeoutHandlerPath,
            handler: "handler",
            isExternal: true,
            url: false,
            env: {
              VERSION: envVersion,
            },
          });

          const live = alias
            ? yield* AWS.Lambda.Alias("LiveAlias", {
                functionName: fn.functionName,
                functionVersion: alias.functionVersion,
                aliasName: "live",
                description: alias.description,
                routingConfig: alias.routingConfig,
              })
            : undefined;

          return { fn, live };
        });

      const initial = yield* stack.deploy(program({ envVersion: "1" }));
      const version1 = yield* publishVersion(
        initial.fn.functionName,
        "version 1",
      );

      const created = yield* stack.deploy(
        program({
          envVersion: "1",
          alias: {
            functionVersion: version1,
            description: "live v1",
          },
        }),
      );
      const createdAlias = created.live!;

      expect(createdAlias.aliasName).toBe("live");
      expect(createdAlias.functionVersion).toBe(version1);
      expect(createdAlias.invokeArn).toContain(createdAlias.aliasArn);

      const liveV1 = yield* Lambda.getAlias({
        FunctionName: created.fn.functionName,
        Name: "live",
      });
      expect(liveV1.FunctionVersion).toBe(version1);
      expect(liveV1.Description).toBe("live v1");

      const updatedFunction = yield* stack.deploy(
        program({
          envVersion: "2",
          alias: {
            functionVersion: version1,
            description: "live v1",
          },
        }),
      );
      const version2 = yield* publishVersion(
        updatedFunction.fn.functionName,
        "version 2",
      );

      const updated = yield* stack.deploy(
        program({
          envVersion: "2",
          alias: {
            functionVersion: version2,
            description: "weighted live",
            routingConfig: {
              AdditionalVersionWeights: {
                [version1]: 0.25,
              },
            },
          },
        }),
      );
      const updatedAlias = updated.live!;

      expect(updatedAlias.aliasArn).toBe(createdAlias.aliasArn);
      expect(updatedAlias.functionVersion).toBe(version2);
      expect(updatedAlias.description).toBe("weighted live");
      expect(updatedAlias.routingConfig).toEqual({
        AdditionalVersionWeights: {
          [version1]: 0.25,
        },
      });

      const cleared = yield* stack.deploy(
        program({
          envVersion: "2",
          alias: {
            functionVersion: version2,
          },
        }),
      );
      const clearedAlias = cleared.live!;

      expect(clearedAlias.aliasArn).toBe(createdAlias.aliasArn);
      expect(clearedAlias.functionVersion).toBe(version2);
      expect(clearedAlias.description).toBeUndefined();
      expect(clearedAlias.routingConfig).toBeUndefined();

      const provider = yield* Provider.findProvider(AWS.Lambda.Alias);
      const aliases = yield* provider.list();
      expect(
        aliases.some(
          (alias) =>
            alias.functionName === updated.fn.functionName &&
            alias.aliasName === "live",
        ),
      ).toBe(true);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

const publishVersion = Effect.fn(function* (
  functionName: string,
  description: string,
) {
  const config = yield* Lambda.publishVersion({
    FunctionName: functionName,
    Description: description,
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ResourceConflictException",
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
    Effect.filterOrFail(
      (config) => config.Version !== undefined,
      () => new Error("Published Lambda version was missing Version."),
    ),
  );
  return config.Version!;
});
