import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as service from "@distilled.cloud/clickhouse-cloud/service";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

const getEndpoint = (serviceId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    return yield* service.getServiceQueryEndpoint({ organizationId, serviceId }).pipe(
      Effect.map(({ result }) => result),
      Effect.catchTag("NotFound", () => Effect.undefined),
    );
  });

const declare = (origins: string[]) =>
  Effect.gen(function* () {
    const serviceId = yield* testServiceId;
    const role = yield* ClickHouseCloud.RoleManagement.Role("QueryEndpointCaller", {
      policies: [
        {
          allowDeny: "ALLOW",
          permissions: ["control-plane:service:view"],
          resources: [Output.interpolate`instance/${serviceId}`],
        },
      ],
    });
    const key = yield* ClickHouseCloud.ApiKeys.ApiKey("QueryEndpointKey", {
      assignedRoleIds: [role.roleId],
    });
    const endpoint = yield* ClickHouseCloud.Service.QueryEndpoint("QueryEndpoint", {
      serviceId,
      roles: ["sql_console_read_only"],
      apiKeyIds: [key.id],
      allowedOrigins: origins,
    });
    return { key, endpoint };
  });

test.provider.skipIf(needsService)(
  "enable the query endpoint for a key, change its origins and role in place, switch it off",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);

      const first = yield* stack.deploy(declare(["https://a.example.com"]));
      const observed = yield* getEndpoint(first.endpoint.serviceId);
      expect(observed?.openApiKeys).toEqual([first.key.id]);
      expect(observed?.roles).toEqual(["sql_console_read_only"]);
      expect(observed?.allowedOrigins).toEqual("https://a.example.com");

      const second = yield* stack.deploy(
        declare(["https://a.example.com", "https://b.example.com"]),
      );
      expect(second.endpoint.endpointId).toEqual(first.endpoint.endpointId);
      expect(
        (yield* getEndpoint(first.endpoint.serviceId))?.allowedOrigins?.split(",").sort(),
      ).toEqual(["https://a.example.com", "https://b.example.com"]);

      yield* stack.destroy();
      expect(yield* getEndpoint(first.endpoint.serviceId)).toBeUndefined();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 900_000 },
);
