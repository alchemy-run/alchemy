import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { suitePartition } from "./suiteProject.ts";

const { test } = Test.make({ providers: Railway.providers() });

const resources = Effect.gen(function* () {
  const { project, environment } = yield* suitePartition;
  const api = yield* Railway.Service("Api", {
    project,
    environment,
    image: "hashicorp/http-echo",
    port: 5678,
  });
  const network = yield* Railway.PrivateNetwork("Mesh", { environment });
  return { project, environment, api, network };
});

const withEndpoint = (name: string) =>
  Effect.gen(function* () {
    const base = yield* resources;
    const endpoint = yield* Railway.PrivateNetworkEndpoint("ApiDns", {
      network: base.network,
      service: base.api,
      name,
    });
    return { ...base, endpoint };
  });

test.provider(
  "create, rename, and delete a private network endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(withEndpoint("api"));
      expect(created.network.networkId).toMatch(/^\d+$/);
      expect(created.network.projectId).toEqual(created.project.projectId);
      expect(created.network.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.endpoint.serviceId).toEqual(created.api.serviceId);
      expect(created.endpoint.privateNetworkId).toEqual(
        created.network.publicId,
      );
      expect(created.endpoint.dnsName.split(".")[0]).toBe("api");

      const again = yield* railway.privateNetworkCreateOrGet({
        input: {
          environmentId: created.network.environmentId,
          projectId: created.project.projectId,
          name: created.network.name,
          tags: ["alchemy"],
        },
      });
      expect(again.publicId).toEqual(created.network.publicId);
      const endpointAgain = yield* railway.privateNetworkEndpointCreateOrGet({
        input: {
          environmentId: created.environment.environmentId,
          privateNetworkId: created.network.publicId,
          serviceId: created.api.serviceId,
          serviceName: "api",
          tags: ["alchemy"],
        },
      });
      expect(endpointAgain.publicId).toEqual(created.endpoint.publicId);

      const provider = yield* Provider.findProvider(Railway.PrivateNetwork);
      const listed = yield* provider.list();
      expect(
        listed.find((row) => row.publicId === created.network.publicId),
      ).toBeDefined();

      const noop = yield* stack.deploy(withEndpoint("api"));
      expect(noop.endpoint.publicId).toEqual(created.endpoint.publicId);
      expect(noop.endpoint.dnsName).toEqual(created.endpoint.dnsName);

      const renamed = yield* stack.deploy(withEndpoint("gateway"));
      expect(renamed.endpoint.publicId).toEqual(created.endpoint.publicId);
      expect(renamed.endpoint.dnsName.split(".")[0]).toBe("gateway");
      const live = yield* railway.privateNetworkEndpoint({
        environmentId: created.environment.environmentId,
        privateNetworkId: created.network.publicId,
        serviceId: created.api.serviceId,
      });
      expect(live?.dnsName).toEqual(renamed.endpoint.dnsName);

      yield* stack.destroy();
      const gone = yield* railway
        .privateNetworkEndpoint({
          environmentId: created.environment.environmentId,
          privateNetworkId: created.network.publicId,
          serviceId: created.api.serviceId,
        })
        .pipe(
          Effect.map((row) => row == null || row.syncStatus === "DELETED"),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            times: 10,
            until: (gone) => gone,
          }),
        );
      expect(gone).toBe(true);
      const networks = yield* railway
        .privateNetworks({ environmentId: created.environment.environmentId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed([])));
      expect(networks.filter((network) => network.deletedAt == null)).toEqual(
        [],
      );
    }),
  { timeout: 120_000 },
);
