import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as qae from "@distilled.cloud/clickhouse-cloud/query_api_endpoints";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

const getEndpoint = (serviceId: string, endpointId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    return yield* qae
      .getQueryApiEndpoint({ organizationId, serviceId, endpointId })
      .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
  });

const declare = (sql: string, origins: string[]) =>
  Effect.gen(function* () {
    const serviceId = yield* testServiceId;
    const role = yield* ClickHouseCloud.RoleManagement.Role("EndpointCaller", {
      policies: [
        {
          allowDeny: "ALLOW",
          permissions: ["control-plane:service:view-query-api-endpoints"],
          resources: [Output.interpolate`instance/${serviceId}`],
        },
      ],
    });
    const key = yield* ClickHouseCloud.ApiKeys.ApiKey("EndpointKey", {
      assignedRoleIds: [role.roleId],
    });
    const endpoint = yield* ClickHouseCloud.QueryApiEndpoints.QueryApiEndpoint("Numbers", {
      serviceId,
      database: "default",
      sql,
      parameters: { n: "2" },
      roles: ["default_role"],
      apiKeyIds: [key.id],
      allowedOrigins: origins,
    });
    return { key, endpoint };
  });

test.provider.skipIf(needsService)(
  "create a Query API endpoint, run it with an allowed key, change its SQL in place, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);

      const first = yield* stack.deploy(
        declare("SELECT number FROM system.numbers LIMIT {n:UInt8}", []),
      );
      expect(first.endpoint.url).toMatch(/^https:\/\//);
      expect(first.endpoint.apiKeyIds).toEqual([first.key.id]);
      const observed = yield* getEndpoint(first.endpoint.serviceId, first.endpoint.endpointId);
      expect(observed?.ownerType).toEqual("queryApiEndpoint");

      // The allowed key runs it at the URL the API hands back.
      const auth = btoa(`${first.key.keyId}:${Redacted.value(first.key.keySecret)}`);
      const run = (n: number) =>
        Effect.promise(() =>
          fetch(`${first.endpoint.url}?format=JSONEachRow`, {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
            body: JSON.stringify({ queryVariables: { n } }),
          }).then(async (res) => ({ status: res.status, body: await res.text() })),
        );
      const ran = yield* run(3);
      expect(ran.status).toEqual(200);
      expect(
        ran.body
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([{ number: 0 }, { number: 1 }, { number: 2 }]);

      const second = yield* stack.deploy(
        declare("SELECT number * 10 AS tens FROM system.numbers LIMIT {n:UInt8}", [
          "https://app.example.com",
        ]),
      );
      expect(second.endpoint.endpointId).toEqual(first.endpoint.endpointId);
      const afterUpdate = yield* getEndpoint(first.endpoint.serviceId, first.endpoint.endpointId);
      expect(afterUpdate?.sql).toEqual(
        "SELECT number * 10 AS tens FROM system.numbers LIMIT {n:UInt8}",
      );
      expect(afterUpdate?.allowedOrigins).toEqual(["https://app.example.com"]);

      yield* stack.destroy();
      expect(
        yield* getEndpoint(first.endpoint.serviceId, first.endpoint.endpointId),
      ).toBeUndefined();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 900_000 },
);
