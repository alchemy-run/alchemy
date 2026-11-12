import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as service from "@distilled.cloud/clickhouse-cloud/service";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// JWT providers need the Enterprise tier. Set CLICKHOUSE_CLOUD_TEST_ENTERPRISE=1
// on an Enterprise organization.
const enterprise = !!process.env.CLICKHOUSE_CLOUD_TEST_ENTERPRISE;

const declare = (audience: string) =>
  Effect.gen(function* () {
    const serviceId = yield* testServiceId;
    return yield* ClickHouseCloud.Service.JwtProvider("GitHubActions", {
      serviceId,
      name: "alchemy-github-actions",
      issuer: "https://token.actions.githubusercontent.com",
      audience,
      jwksUrl: "https://token.actions.githubusercontent.com/.well-known/jwks",
    });
  });

test.provider.skipIf(needsService || enterprise)(
  "below Enterprise the deploy fails with FeatureUnavailable",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const error = yield* stack.deploy(declare("alchemy")).pipe(Effect.flip);
      expect(error._tag).toEqual("FeatureUnavailable");
      expect(error.message).toEqual(
        "FORBIDDEN: Cannot use JWT authentication providers in SCALE pricing package",
      );
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);

test.provider.skipIf(needsService || !enterprise)(
  "add a JWT provider, change its audience in place, remove it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const organizationId = yield* ClickHouseCloud.organizationId;
      const first = yield* stack.deploy(declare("alchemy"));
      const second = yield* stack.deploy(declare("alchemy-2"));
      expect(second.name).toEqual(first.name);
      const observed = yield* service.getJwtProvider({
        organizationId,
        serviceId: first.serviceId,
        jwtProviderName: first.name,
      });
      expect(observed.result?.audience).toEqual("alchemy-2");
      yield* stack.destroy();
      const gone = yield* service
        .getJwtProvider({ organizationId, serviceId: first.serviceId, jwtProviderName: first.name })
        .pipe(Effect.flip);
      expect(gone._tag).toEqual("NotFound");
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 900_000 },
);
