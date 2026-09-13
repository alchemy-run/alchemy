import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Path from "node:path";
import { App } from "./fixtures/local-app.ts";
import EffectWorker from "./fixtures/local-effect-worker.ts";
const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

test.provider(
  "offline flags evaluate native and Effect bindings, targeting, types, updates and deletion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const comparisons: Array<[string, unknown, unknown]> = [
        ["equals", "US", "US"],
        ["not_equals", "US", "CA"],
        ["greater_than", 18, 21],
        ["less_than", 30, 21],
        ["greater_than_or_equals", 21, 21],
        ["less_than_or_equals", 21, 21],
        ["contains", "@cloudflare", "user@cloudflare.com"],
        ["starts_with", "/api", "/api/v2"],
        ["ends_with", ".dev", "example.dev"],
        ["in", ["US", "CA"], "CA"],
        ["not_in", ["US", "CA"], "UK"],
      ];
      const deploy = (revision: string, enabled: boolean, include = true) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* App;
            if (include) {
              yield* Cloudflare.Flagship.Flag("Enabled", {
                appId: app.appId,
                key: "enabled",
                enabled,
                defaultVariation: "off",
                variations: { off: false, on: true },
                rules: [
                  {
                    priority: 1,
                    conditions: [
                      {
                        attribute: "plan",
                        operator: "equals",
                        value: "enterprise",
                      },
                    ],
                    serveVariation: "on",
                  },
                ],
              });
              for (const [operator, expected] of comparisons)
                yield* Cloudflare.Flagship.Flag(`Compare-${operator}`, {
                  appId: app.appId,
                  key: operator,
                  defaultVariation: "off",
                  variations: { off: false, on: true },
                  rules: [
                    {
                      priority: 1,
                      conditions: [
                        {
                          attribute: "value",
                          operator:
                            operator as Cloudflare.Flagship.FlagConditionOperator,
                          value: expected,
                        },
                      ],
                      serveVariation: "on",
                    },
                  ],
                });
              yield* Cloudflare.Flagship.Flag("Nested", {
                appId: app.appId,
                key: "nested",
                defaultVariation: "off",
                variations: { off: false, on: true },
                rules: [
                  {
                    priority: 1,
                    conditions: [
                      {
                        logicalOperator: "AND",
                        clauses: [
                          {
                            attribute: "age",
                            operator: "greater_than_or_equals",
                            value: 18,
                          },
                          {
                            logicalOperator: "OR",
                            clauses: [
                              {
                                attribute: "country",
                                operator: "equals",
                                value: "US",
                              },
                              {
                                attribute: "country",
                                operator: "equals",
                                value: "CA",
                              },
                            ],
                          },
                        ],
                      },
                    ],
                    serveVariation: "on",
                  },
                ],
              });
              yield* Cloudflare.Flagship.Flag("Date", {
                appId: app.appId,
                key: "date",
                defaultVariation: "off",
                variations: { off: false, on: true },
                rules: [
                  {
                    priority: 1,
                    conditions: [
                      {
                        attribute: "date",
                        operator: "less_than",
                        value: "2026-01-01T00:00:00Z",
                      },
                    ],
                    serveVariation: "on",
                  },
                ],
              });
              yield* Cloudflare.Flagship.Flag("Split", {
                appId: app.appId,
                key: "split",
                defaultVariation: "default",
                variations: { default: "fallback", a: "A", b: "B" },
                rules: [
                  {
                    priority: 2,
                    conditions: [],
                    serveVariation: "b",
                    rollout: { percentage: 100 },
                  },
                  {
                    priority: 0,
                    conditions: [],
                    serveVariation: "default",
                    rollout: { percentage: 0 },
                  },
                  {
                    priority: 1,
                    conditions: [],
                    serveVariation: "a",
                    rollout: { percentage: 50 },
                  },
                ],
              });
              yield* Cloudflare.Flagship.Flag("String", {
                appId: app.appId,
                key: "string",
                defaultVariation: "v",
                variations: { v: "hello" },
              });
              yield* Cloudflare.Flagship.Flag("Number", {
                appId: app.appId,
                key: "number",
                defaultVariation: "v",
                variations: { v: 42 },
              });
              yield* Cloudflare.Flagship.Flag("Object", {
                appId: app.appId,
                key: "object",
                defaultVariation: "v",
                variations: { v: { nested: [1, 2] } },
              });
            }
            const worker = yield* Cloudflare.Worker("OfflineFlagsWorker", {
              main: Path.resolve(
                import.meta.dirname,
                "fixtures/local-worker.ts",
              ),
              env: { FLAGS: App, REVISION: revision },
            });
            const effectWorker = yield* EffectWorker;
            return { app, worker, effectWorker };
          }),
        );
      const first = yield* deploy("one", true);
      const evaluate = (
        url: string,
        method: string,
        key: string,
        fallback: unknown,
        context?: unknown,
      ) =>
        Effect.promise(async () => {
          const response = await fetch(url, {
            method: "POST",
            body: JSON.stringify({ method, key, fallback, context }),
          });
          expect(response.status).toBe(200);
          return response.json() as Promise<any>;
        });
      const details = (key: string, context?: unknown) =>
        evaluate(first.worker.url!, "getBooleanDetails", key, false, context);
      expect(first.app.appId.startsWith("dev:")).toBe(true);
      expect(yield* details("enabled", { plan: "enterprise" })).toMatchObject({
        value: true,
        reason: "TARGETING_MATCH",
        variant: "on",
      });
      expect(yield* details("enabled")).toMatchObject({
        value: false,
        reason: "DEFAULT",
      });
      for (const [operator, , value] of comparisons) {
        expect(yield* details(operator, { value })).toMatchObject({
          value: true,
          reason: "TARGETING_MATCH",
        });
        expect(yield* details(operator)).toMatchObject({
          value: false,
          reason: "DEFAULT",
        });
      }
      expect(
        yield* details("nested", { age: 20, country: "CA" }),
      ).toMatchObject({ value: true });
      expect(
        yield* details("nested", { age: 17, country: "CA" }),
      ).toMatchObject({ value: false });
      expect(
        yield* details("date", { date: "2025-12-31T20:00:00-02:00" }),
      ).toMatchObject({ value: true });
      expect(
        yield* evaluate(
          first.worker.url!,
          "getStringValue",
          "string",
          "fallback",
        ),
      ).toBe("hello");
      expect(
        yield* evaluate(first.worker.url!, "getNumberValue", "number", 0),
      ).toBe(42);
      expect(
        yield* evaluate(first.worker.url!, "getObjectValue", "object", {}),
      ).toEqual({ nested: [1, 2] });
      expect(
        yield* evaluate(first.worker.url!, "getNumberDetails", "number", 0),
      ).toMatchObject({ value: 42, reason: "DEFAULT" });
      expect(
        yield* evaluate(first.worker.url!, "getObjectDetails", "object", {}),
      ).toMatchObject({ value: { nested: [1, 2] }, reason: "DEFAULT" });
      expect(yield* evaluate(first.worker.url!, "get", "object", null)).toEqual(
        { nested: [1, 2] },
      );
      expect(yield* details("string")).toMatchObject({
        value: false,
        reason: "ERROR",
        errorCode: "TYPE_MISMATCH",
      });
      expect(yield* details("missing")).toMatchObject({
        value: false,
        errorCode: "FLAG_NOT_FOUND",
      });
      expect(yield* details("enabled", { nested: {} })).toMatchObject({
        value: false,
        errorCode: "INVALID_CONTEXT",
      });
      const split = yield* evaluate(
        first.worker.url!,
        "getStringDetails",
        "split",
        "fallback",
        { targetingKey: "user-42" },
      );
      expect(split.reason).toBe("SPLIT");
      expect(["A", "B"]).toContain(split.value);
      expect(
        yield* evaluate(
          first.worker.url!,
          "getStringDetails",
          "split",
          "fallback",
          { targetingKey: "user-42" },
        ),
      ).toEqual(split);
      const effectResult = yield* Effect.promise(async () =>
        (await fetch(first.effectWorker.url!)).json(),
      );
      expect(effectResult).toMatchObject({
        value: true,
        reason: "TARGETING_MATCH",
      });
      const unchangedWorker = yield* deploy("one", false);
      expect(unchangedWorker.worker.url).toBe(first.worker.url);
      expect(yield* details("enabled", { plan: "enterprise" })).toMatchObject({
        value: false,
        reason: "DISABLED",
      });
      const second = yield* deploy("two", false);
      expect(second.app.appId).toBe(first.app.appId);
      expect(
        yield* evaluate(
          second.worker.url!,
          "getBooleanValue",
          "enabled",
          true,
          { plan: "enterprise" },
        ),
      ).toBe(false);
      expect(
        yield* evaluate(
          second.worker.url!,
          "getBooleanDetails",
          "enabled",
          true,
          { plan: "enterprise" },
        ),
      ).toMatchObject({ value: false, reason: "DISABLED" });
      expect(
        yield* evaluate(
          second.worker.url!,
          "getStringDetails",
          "split",
          "fallback",
          { targetingKey: "user-42" },
        ),
      ).toEqual(split);
      const third = yield* deploy("three", true, false);
      expect(
        yield* evaluate(
          third.worker.url!,
          "getBooleanDetails",
          "enabled",
          false,
        ),
      ).toMatchObject({ errorCode: "FLAG_NOT_FOUND" });
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "offline Action reads local persisted flags and full attribute targeting",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Cloudflare.Flagship.App("ActionApp", {});
          const flag = yield* Cloudflare.Flagship.Flag("ActionFlag", {
            appId: app.appId,
            key: "action",
            defaultVariation: "off",
            variations: { off: false, on: true },
            rules: [
              {
                priority: 1,
                conditions: [
                  { attribute: "country", operator: "equals", value: "CA" },
                ],
                serveVariation: "on",
              },
            ],
          });
          const Read = Action(
            "OfflineRead",
            Effect.gen(function* () {
              const flags = yield* Cloudflare.Flagship.ReadFlags(app);
              return Effect.fn(function* (_: { key: string }) {
                const details = yield* flags.getBooleanDetails(
                  "action",
                  false,
                  { country: "CA" },
                );
                const raw = yield* flags.raw;
                return {
                  details,
                  raw: yield* Effect.promise(() =>
                    raw.getBooleanValue("action", false, { country: "CA" }),
                  ),
                };
              });
            }).pipe(Effect.provide(Cloudflare.Flagship.ReadFlagsLocal)),
          );
          return yield* Read({ key: flag.key });
        }),
      );
      expect(result.details).toMatchObject({
        value: true,
        reason: "TARGETING_MATCH",
      });
      expect(result.raw).toBe(true);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
