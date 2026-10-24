import * as Azure from "@alchemy.run/azure";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { basicV2Service, logLevel, subscriptionId, tags } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfig = (resourceGroupName: string, serviceName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetPortalConfig({
      subscriptionId,
      resourceGroupName,
      serviceName,
      portalConfigId: "default",
    }),
  );

const program = (config?: { origin: string; csp: "enabled" | "reportOnly" }) =>
  Effect.gen(function* () {
    const { group, service } = yield* basicV2Service;
    const created = config
      ? yield* Azure.ApiManagement.PortalConfig("Portal", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          signin: { require: true },
          cors: { allowedOrigins: [config.origin] },
          csp: { mode: config.csp, allowedSources: ["*.example.com"] },
        })
      : undefined;
    return { group, service, config: created };
  });

// The developer portal configuration needs a tier with a portal (not
// Consumption). A BasicV2 service bills ~$0.21/h and takes 5-15+ minutes
// to create: est. ~$0.10 and ~25 minutes per run. Replacement needs a
// second service and is not covered.
test.provider.skipIf(!runExpensive)(
  "configure, update, and reset the developer portal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ origin: "https://one.example.com", csp: "reportOnly" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.config?.portalConfigName).toEqual("default");
      const observed = yield* getConfig(rg, svc);
      expect(observed.properties?.signin?.require).toEqual(true);
      expect(observed.properties?.cors?.allowedOrigins).toEqual(["https://one.example.com"]);
      expect(observed.properties?.csp?.mode).toEqual("reportOnly");

      // In-place update of CORS and CSP.
      yield* stack.deploy(program({ origin: "https://two.example.com", csp: "enabled" }));
      const updated = yield* getConfig(rg, svc);
      expect(updated.properties?.cors?.allowedOrigins).toEqual(["https://two.example.com"]);
      expect(updated.properties?.csp?.mode).toEqual("enabled");

      // Removing the resource restores the defaults.
      yield* stack.deploy(program());
      const reset = yield* getConfig(rg, svc);
      expect(reset.properties?.signin?.require).toEqual(false);
      expect(reset.properties?.cors?.allowedOrigins).toEqual([]);
      expect(reset.properties?.csp?.mode).toEqual("disabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
