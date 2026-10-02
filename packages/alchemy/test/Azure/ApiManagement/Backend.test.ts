import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getBackend = (
  resourceGroupName: string,
  serviceName: string,
  backendId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetBackend({
      subscriptionId,
      resourceGroupName,
      serviceName,
      backendId,
    }),
  );

const program = (backend?: {
  name: string;
  url: string;
  description: string;
  validateCertificateChain: boolean;
}) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const created = backend
      ? yield* Azure.ApiManagement.Backend("Httpbin", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: backend.name,
          url: backend.url,
          protocol: "http",
          description: backend.description,
          credentials: { header: { "x-test": ["alchemy"] } },
          tls: {
            validateCertificateChain: backend.validateCertificateChain,
            validateCertificateName: true,
          },
        })
      : undefined;
    return { group, service, backend: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete a backend",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({
          name: "httpbin",
          url: "https://httpbin.org",
          description: "httpbin",
          validateCertificateChain: true,
        }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.backend?.backendName).toEqual("httpbin");
      expect(first.backend?.type).toEqual("Single");
      const observed = yield* getBackend(rg, svc, "httpbin");
      expect(observed.properties?.url).toEqual("https://httpbin.org");
      expect(observed.properties?.protocol).toEqual("http");
      expect(observed.properties?.credentials?.header?.["x-test"]).toEqual([
        "alchemy",
      ]);

      // In-place update: URL, description, and TLS validation.
      yield* stack.deploy(
        program({
          name: "httpbin",
          url: "https://httpbin.org/anything",
          description: "httpbin anything",
          validateCertificateChain: false,
        }),
      );
      const updated = yield* getBackend(rg, svc, "httpbin");
      expect(updated.properties?.url).toEqual("https://httpbin.org/anything");
      expect(updated.properties?.description).toEqual("httpbin anything");
      expect(updated.properties?.tls?.validateCertificateChain).toEqual(false);

      // Replacement: a new identifier creates a new backend.
      const replaced = yield* stack.deploy(
        program({
          name: "httpbin-v2",
          url: "https://httpbin.org/anything",
          description: "httpbin anything",
          validateCertificateChain: false,
        }),
      );
      expect(replaced.backend?.backendName).toEqual("httpbin-v2");
      expect(
        (yield* getBackend(rg, svc, "httpbin-v2")).properties?.url,
      ).toEqual("https://httpbin.org/anything");
      expect(yield* untilGone(getBackend(rg, svc, "httpbin"))).toEqual("gone");

      // Removing the backend deletes it while the service stays.
      yield* stack.deploy(program());
      expect(yield* untilGone(getBackend(rg, svc, "httpbin-v2"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
