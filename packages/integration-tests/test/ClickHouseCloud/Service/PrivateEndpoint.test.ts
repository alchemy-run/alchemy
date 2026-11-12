import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import * as service from "@distilled.cloud/clickhouse-cloud/service";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// ClickHouse registers an endpoint ID without checking that the cloud
// endpoint exists, so a well-formed ID nobody owns proves the lifecycle
// without an AWS account (nothing can connect through it).
const ENDPOINT_ID = "vpce-0a1c4e3e5700000a1";

const declare = (description: string) =>
  Effect.gen(function* () {
    const serviceId = yield* testServiceId;
    return yield* ClickHouseCloud.Service.PrivateEndpoint("Endpoint", {
      serviceId,
      endpointId: ENDPOINT_ID,
      description,
    });
  });

/** Where the endpoint is listed: on the service, and in the organization. */
const listed = (serviceId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    const svc = yield* service.getService({ organizationId, serviceId });
    const org = yield* organization.getOrganization({ organizationId });
    return {
      onService: (svc.result?.privateEndpointIds ?? []).includes(ENDPOINT_ID),
      inOrganization: (org.result?.privateEndpoints ?? []).some((e) => e.id === ENDPOINT_ID),
    };
  });

test.provider.skipIf(needsService)(
  "allow a private endpoint on a service, replace it on a new description, unregister it on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const first = yield* stack.deploy(declare("alchemy test"));
      expect(first.endpointId).toEqual(ENDPOINT_ID);
      expect(first.registered).toBe(true);
      expect(first.endpointServiceId).toMatch(/^com\.amazonaws\.vpce\.us-east-1\.vpce-svc-/);
      expect(yield* listed(first.serviceId)).toEqual({ onService: true, inOrganization: true });

      // Delete first, then register again with the new description.
      const second = yield* stack.deploy(declare("alchemy test, renamed"));
      expect(second.registered).toBe(true);
      expect(yield* listed(first.serviceId)).toEqual({ onService: true, inOrganization: true });

      yield* stack.destroy();
      expect(yield* listed(first.serviceId)).toEqual({ onService: false, inOrganization: false });
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 300_000 },
);
