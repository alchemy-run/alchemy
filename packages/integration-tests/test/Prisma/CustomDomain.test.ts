import { CustomDomain, CustomDomainProvider } from "@alchemy.run/prisma/CustomDomain";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import {
  data,
  makeFakeManagementApi,
  page,
  routesOf,
  unhandled,
  WIRE_CREATED_AT,
} from "./fixtures/FakeManagementApi.ts";

const raced = {
  id: "domain-raced",
  type: "custom-domain",
  url: "https://api.prisma.test/v1/domains/domain-raced",
  hostname: "api.custom.test",
  appId: "service-1",
  computeServiceId: "service-1",
  status: "pending_dns",
  foundryStatus: "pending",
  failureReason: null,
  failureCategory: null,
  certExpiresAt: null,
  createdAt: WIRE_CREATED_AT,
  updatedAt: WIRE_CREATED_AT,
  dnsRecords: [],
};

// Another actor registers the hostname between the lookup and the create, so
// the create answers 200 with that domain.
let registered = false;
const fake = makeFakeManagementApi((request) => {
  if (request.pathname === "/v1/services/service-1/domains") {
    if (request.method === "GET") return page(registered ? [raced] : []);
    if (request.method === "POST") {
      registered = true;
      return data(raced, { status: 200 });
    }
  }
  return unhandled(request);
});

class TestPrismaProviders extends Provider.ProviderCollection<TestPrismaProviders>()("Prisma") {}

const { test } = Test.make({
  providers: Layer.effect(TestPrismaProviders, Provider.collection([CustomDomain])).pipe(
    Layer.provideMerge(CustomDomainProvider()),
    Layer.provide(
      Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
    ),
    Layer.provideMerge(fake.layer),
  ),
});

test.provider(
  "routes a 200 custom-domain create race through explicit adoption",
  (stack) =>
    Effect.gen(function* () {
      registered = false;
      fake.captured.length = 0;
      yield* stack.destroy();
      const domain = CustomDomain("Domain", { app: "service-1", hostname: raced.hostname });

      const raceResult = yield* stack.deploy(domain).pipe(Effect.result);
      expect(Result.isFailure(raceResult)).toBe(true);
      if (Result.isFailure(raceResult)) {
        expect(String(raceResult.failure)).toContain("explicit adoption");
      }
      expect(routesOf(fake.captured)).toContain("POST /v1/services/service-1/domains");

      const redeploy = yield* stack.deploy(domain).pipe(Effect.result);
      expect(Result.isFailure(redeploy)).toBe(true);
      if (Result.isFailure(redeploy)) {
        expect(String(redeploy.failure)).toContain("OwnedBySomeoneElse");
      }

      registered = false;
      yield* stack.destroy();
    }),
  { tags: ["local", "provider:prisma", "provider:prisma:customdomain"] },
);
