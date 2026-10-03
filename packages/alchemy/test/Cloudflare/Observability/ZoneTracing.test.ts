import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as zones from "@distilled.cloud/cloudflare/zones";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// Known baseline: Cloudflare's default settings and an empty ruleset.
const resetBaseline = (zoneId: string) =>
  Effect.all([
    zones.deleteObservabilityTracingSettings({ zoneId }),
    zones.deleteObservabilityTracingRule({ zoneId }),
  ]);

describe.sequential(
  "ZoneTracing",
  {
    tags: ["provider:cloudflare", "provider:cloudflare:zone", "live"],
  },
  () => {
    test.provider(
      "enables tracing, updates it in place, and resets it on destroy",
      (stack) =>
        Effect.gen(function* () {
          const zoneId = yield* resolveZoneId;

          yield* stack.destroy();
          yield* resetBaseline(zoneId);
          const defaults = yield* zones.getObservabilityTracingSettings({
            zoneId,
          });

          const created = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Observability.ZoneTracing("Tracing", {
                zoneId,
                samplingRatio: 0.25,
              });
            }),
          );

          expect(created.zoneId).toEqual(zoneId);
          expect(created.enabled).toEqual(true);
          expect(created.samplingRatio).toEqual(0.25);

          const live = yield* zones.getObservabilityTracingSettings({
            zoneId,
          });
          expect(live.enabled).toEqual(true);
          expect(live.samplingRatio).toEqual(0.25);

          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Observability.ZoneTracing("Tracing", {
                zoneId,
                samplingRatio: 0.5,
                persist: false,
                propagationPolicy: "reject",
              });
            }),
          );

          expect(updated.samplingRatio).toEqual(0.5);
          expect(updated.persist).toEqual(false);
          expect(updated.propagationPolicy).toEqual("reject");

          const liveUpdated = yield* zones.getObservabilityTracingSettings({
            zoneId,
          });
          expect(liveUpdated.samplingRatio).toEqual(0.5);
          expect(liveUpdated.persist).toEqual(false);

          yield* stack.destroy();

          const reset = yield* zones.getObservabilityTracingSettings({
            zoneId,
          });
          expect(reset).toEqual(defaults);
        }).pipe(logLevel),
    );

    test.provider("converges out-of-band drift on the next deploy", (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* resetBaseline(zoneId);

        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Observability.ZoneTracing("Tracing", {
              zoneId,
              samplingRatio: 0.1,
            });
          }),
        );

        yield* zones.updateObservabilityTracingSettings({
          zoneId,
          enabled: false,
          samplingRatio: 0.9,
        });

        const converged = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Observability.ZoneTracing("Tracing", {
              zoneId,
              samplingRatio: 0.1,
              forwardContext: false,
            });
          }),
        );
        expect(converged.enabled).toEqual(true);
        expect(converged.samplingRatio).toEqual(0.1);

        const live = yield* zones.getObservabilityTracingSettings({
          zoneId,
        });
        expect(live.enabled).toEqual(true);
        expect(live.samplingRatio).toEqual(0.1);

        yield* stack.destroy();
      }).pipe(logLevel),
    );

    test.provider(
      "replaces the trace rules in order and deletes them on destroy",
      (stack) =>
        Effect.gen(function* () {
          const zoneId = yield* resolveZoneId;

          yield* stack.destroy();
          yield* resetBaseline(zoneId);

          const created = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Observability.ZoneTracingRules(
                "TraceRules",
                {
                  zoneId,
                  rules: [
                    {
                      description: "api",
                      expression: 'starts_with(http.request.uri.path, "/api/")',
                      samplingRatio: 1,
                    },
                    {
                      expression:
                        'starts_with(http.request.uri.path, "/assets/")',
                      samplingRatio: 0,
                      enabled: false,
                    },
                  ],
                },
              );
            }),
          );

          expect(created.rules).toEqual([
            {
              description: "api",
              expression: 'starts_with(http.request.uri.path, "/api/")',
              samplingRatio: 1,
              enabled: true,
            },
            {
              description: "",
              expression: 'starts_with(http.request.uri.path, "/assets/")',
              samplingRatio: 0,
              enabled: false,
            },
          ]);

          const live = yield* zones.getObservabilityTracingRule({ zoneId });
          expect(live.rules.map((rule) => rule.description)).toEqual([
            "api",
            "",
          ]);

          // Reordering is a change: the first matching rule wins.
          const reordered = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Observability.ZoneTracingRules(
                "TraceRules",
                {
                  zoneId,
                  rules: [
                    {
                      expression:
                        'starts_with(http.request.uri.path, "/assets/")',
                      samplingRatio: 0,
                      enabled: false,
                    },
                    {
                      description: "api",
                      expression: 'starts_with(http.request.uri.path, "/api/")',
                      samplingRatio: 0.5,
                    },
                  ],
                },
              );
            }),
          );
          expect(reordered.rules.map((rule) => rule.samplingRatio)).toEqual([
            0, 0.5,
          ]);

          const liveReordered = yield* zones.getObservabilityTracingRule({
            zoneId,
          });
          expect(
            liveReordered.rules.map(
              (rule) => rule.actionParameters.samplingRatio,
            ),
          ).toEqual([0, 0.5]);

          yield* stack.destroy();

          const gone = yield* zones.getObservabilityTracingRule({ zoneId });
          expect(gone.rules).toEqual([]);
        }).pipe(logLevel),
    );
  },
);
