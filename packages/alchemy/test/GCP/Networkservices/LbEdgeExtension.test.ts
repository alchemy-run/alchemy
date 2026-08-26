import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const waitUntilGone = (name: string) =>
  networkservices.getProjectsLocationsLbEdgeExtensions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsLbEdgeExtensions on a missing extension fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = process.env.GOOGLE_PROJECT_ID ?? "";
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsLbEdgeExtensions({
          name: `projects/${project}/locations/global/lbEdgeExtensions/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete an lb edge extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const plugin = yield* GCP.Networkservices.WasmPlugin("EdgePlugin", {
            location: "global",
            description: "edge wasm",
          });
          const map = yield* GCP.Compute.UrlMap("EdgeMap", {
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.com",
              stripQuery: false,
            },
          });
          const proxy = yield* GCP.Compute.TargetHttpProxy("EdgeProxy", {
            urlMap: map.urlMapName,
          });
          const rule = yield* GCP.Compute.GlobalForwardingRule("EdgeFr", {
            target: proxy.selfLink.as<string>(),
            portRange: "80",
            loadBalancingScheme: "EXTERNAL_MANAGED",
          });
          return yield* GCP.Networkservices.LbEdgeExtension("Edge", {
            location: "global",
            description: "lb edge a",
            labels: { env: "test" },
            loadBalancingScheme: "EXTERNAL_MANAGED",
            forwardingRules: [rule.selfLink.as<string>()],
            extensionChains: [
              {
                name: "chain1",
                matchCondition: { celExpression: "true" },
                extensions: [
                  {
                    name: "ext1",
                    service: plugin.name,
                    supportedEvents: ["REQUEST_HEADERS"],
                  },
                ],
              },
            ],
          });
        }),
      );

      expect(created.name).toContain("/lbEdgeExtensions/");
      expect(created.lbEdgeExtensionId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.description).toEqual("lb edge a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networkservices.getProjectsLocationsLbEdgeExtensions({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("lb edge a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const plugin = yield* GCP.Networkservices.WasmPlugin("EdgePlugin", {
            location: "global",
            description: "edge wasm",
          });
          const map = yield* GCP.Compute.UrlMap("EdgeMap", {
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.com",
              stripQuery: false,
            },
          });
          const proxy = yield* GCP.Compute.TargetHttpProxy("EdgeProxy", {
            urlMap: map.urlMapName,
          });
          const rule = yield* GCP.Compute.GlobalForwardingRule("EdgeFr", {
            target: proxy.selfLink.as<string>(),
            portRange: "80",
            loadBalancingScheme: "EXTERNAL_MANAGED",
          });
          return yield* GCP.Networkservices.LbEdgeExtension("Edge", {
            lbEdgeExtensionId: created.lbEdgeExtensionId,
            location: "global",
            description: "lb edge b",
            labels: { env: "prod", role: "edge" },
            loadBalancingScheme: "EXTERNAL_MANAGED",
            forwardingRules: [rule.selfLink.as<string>()],
            extensionChains: [
              {
                name: "chain1",
                matchCondition: { celExpression: "true" },
                extensions: [
                  {
                    name: "ext1",
                    service: plugin.name,
                    failOpen: true,
                    supportedEvents: ["REQUEST_HEADERS"],
                  },
                ],
              },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("lb edge b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "edge" });

      const refetched =
        yield* networkservices.getProjectsLocationsLbEdgeExtensions({
          name: created.name,
        });
      expect(refetched.description).toEqual("lb edge b");
      expect(refetched.labels?.env).toEqual("prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
