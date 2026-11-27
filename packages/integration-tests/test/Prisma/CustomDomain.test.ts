import { CustomDomain, CustomDomainProvider } from "@alchemy.run/prisma/CustomDomain";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Retry } from "@distilled.cloud/prisma";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as DeployRetry from "alchemy/DeployRetry";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import {
  AuthoritativeRecordCheck,
  type ExpectedRecord,
  type CheckOptions,
} from "../../../prisma/src/internal/AuthoritativeDns.ts";
import {
  data,
  failure,
  makeFakeManagementApi,
  noContent,
  notFound,
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

// The domains Prisma has registered on service-1. The create answers 200, as
// it does for a hostname another actor registered the moment before.
const cloud = {
  registered: [] as Array<typeof raced>,
  registeredDuringDnsWait: undefined as typeof raced | undefined,
  /** Answers the next creates give, in order, before the row: `429` registers nothing; `400` registers nothing, while another actor registers the hostname. */
  createFailures: [] as Array<429 | "dns-not-configured-while-registered">,
};
const fake = makeFakeManagementApi((request) => {
  if (request.pathname === "/v1/services/service-1/domains") {
    if (request.method === "GET") return page(cloud.registered);
    if (request.method === "POST") {
      const injected = cloud.createFailures.shift();
      if (injected === 429) return failure(429, "rate-limited", "Too many requests");
      if (injected === "dns-not-configured-while-registered") {
        cloud.registered = [raced];
        return failure(400, "bad_request", "DNS is not configured for this hostname");
      }
      cloud.registered = [raced];
      return data(raced, { status: 200 });
    }
  }
  if (request.pathname === "/v1/services/service-1/urls" && request.method === "GET") {
    return page([]);
  }
  if (request.pathname === `/v1/domains/${raced.id}`) {
    if (cloud.registered.length === 0) return notFound("Domain not found.");
    if (request.method === "GET") return data(raced);
    if (request.method === "DELETE") {
      cloud.registered = [];
      return noContent();
    }
  }
  return unhandled(request);
});

const checked: Array<[ExpectedRecord, CheckOptions]> = [];

class TestPrismaProviders extends Provider.ProviderCollection<TestPrismaProviders>()("Prisma") {}

const { test } = Test.make({
  providers: Layer.effect(TestPrismaProviders, Provider.collection([CustomDomain])).pipe(
    Layer.provideMerge(CustomDomainProvider()),
    Layer.provide(
      Layer.succeed(AuthoritativeRecordCheck, (record, options) =>
        Effect.sync(() => {
          checked.push([record, options]);
          if (cloud.registeredDuringDnsWait) cloud.registered = [cloud.registeredDuringDnsWait];
          return "unknown" as const;
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
    ),
    Layer.provideMerge(fake.layer),
  ),
});

const resetCloud = (options: Partial<typeof cloud> = {}) => {
  cloud.registered = [];
  cloud.registeredDuringDnsWait = undefined;
  cloud.createFailures = [];
  Object.assign(cloud, options);
  fake.captured.length = 0;
  checked.length = 0;
};

test.provider(
  "refuses a custom domain registered during the DNS wait, and sends no create",
  (stack) =>
    Effect.gen(function* () {
      resetCloud({ registeredDuringDnsWait: raced });
      yield* stack.destroy();

      const result = yield* stack
        .deploy(CustomDomain("Domain", { app: "service-1", hostname: raced.hostname }))
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("already exists");
        expect(String(result.failure)).toContain("explicit adoption");
      }
      expect(routesOf(fake.captured)).not.toContain("POST /v1/services/service-1/domains");

      resetCloud();
      yield* stack.destroy();
    }),
  { tags: ["unit", "provider:prisma", "provider:prisma:customdomain"] },
);

test.provider(
  "owns the custom domain the create returns",
  (stack) =>
    Effect.gen(function* () {
      resetCloud();
      yield* stack.destroy();

      const domain = yield* stack.deploy(
        CustomDomain("Domain", { app: "service-1", hostname: raced.hostname }),
      );

      expect(domain.customDomainId).toBe(raced.id);
      expect(checked).toEqual([
        [
          { type: "CNAME", name: raced.hostname },
          { margin: "if-unseen", nameservers: "parent" },
        ],
      ]);

      yield* stack.destroy();
      expect(routesOf(fake.captured)).toContain(`DELETE /v1/domains/${raced.id}`);
    }),
  { tags: ["unit", "provider:prisma", "provider:prisma:customdomain"] },
);

const CREATE = "POST /v1/services/service-1/domains";
const tags = ["unit", "provider:prisma", "provider:prisma:customdomain"];

test.provider(
  "refuses a custom domain registered before the deploy, without --adopt, and sends no create",
  (stack) =>
    Effect.gen(function* () {
      resetCloud();
      yield* stack.destroy();
      cloud.registered = [raced];

      const result = yield* stack
        .deploy(CustomDomain("Domain", { app: "service-1", hostname: raced.hostname }))
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("Cannot adopt resource");
      }
      expect(routesOf(fake.captured)).not.toContain(CREATE);

      resetCloud();
      yield* stack.destroy();
    }),
  { tags },
);

test.provider(
  "looks again before each create Prisma refused for DNS, and refuses a custom domain registered in between",
  (stack) =>
    Effect.gen(function* () {
      resetCloud({ createFailures: ["dns-not-configured-while-registered"] });
      yield* stack.destroy();

      const result = yield* stack
        .deploy(CustomDomain("Domain", { app: "service-1", hostname: raced.hostname }))
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("already exists");
      }
      expect(routesOf(fake.captured).filter((route) => route === CREATE)).toEqual([CREATE]);

      resetCloud();
      yield* stack.destroy();
    }),
  { tags, timeout: 60_000 },
);

test.provider(
  "resends a create Prisma throttled, and owns the custom domain it then returns",
  (stack) =>
    Effect.gen(function* () {
      resetCloud({ createFailures: [429] });
      yield* stack.destroy();

      const domain = yield* stack.deploy(
        CustomDomain("Domain", { app: "service-1", hostname: raced.hostname }),
      );

      expect(domain.customDomainId).toBe(raced.id);
      expect(routesOf(fake.captured).filter((route) => route === CREATE)).toEqual([CREATE, CREATE]);

      yield* stack.destroy();
      expect(routesOf(fake.captured)).toContain(`DELETE /v1/domains/${raced.id}`);
    }),
  { tags, timeout: 60_000 },
);

// Prisma processes the create but the reply is lost behind a 503.
let created = false;
const lostReplyFake = makeFakeManagementApi((request) => {
  if (request.pathname === "/v1/services/service-1/domains") {
    if (request.method === "GET") return page(created ? [raced] : []);
    if (request.method === "POST") {
      created = true;
      return failure(503, "service-unavailable", "Service unavailable");
    }
  }
  return unhandled(request);
});

const lostReply = Test.make({
  providers: Layer.effect(TestPrismaProviders, Provider.collection([CustomDomain])).pipe(
    Layer.provideMerge(CustomDomainProvider()),
    Layer.provide(Layer.succeed(AuthoritativeRecordCheck, () => Effect.succeed("seen" as const))),
    Layer.provide(
      Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
    ),
    // The policy every deploy installs, which retries 5xx and transport
    // failures; the create must still not be sent twice.
    Layer.provideMerge(Layer.succeed(Retry.Retry, DeployRetry.policy)),
    Layer.provideMerge(lostReplyFake.layer),
  ),
});

lostReply.test.provider(
  "does not resend a create Prisma may have processed",
  (stack) =>
    Effect.gen(function* () {
      created = false;
      lostReplyFake.captured.length = 0;
      yield* stack.destroy();

      const result = yield* stack
        .deploy(CustomDomain("Domain", { app: "service-1", hostname: raced.hostname }))
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(
        routesOf(lostReplyFake.captured).filter(
          (route) => route === "POST /v1/services/service-1/domains",
        ),
      ).toEqual(["POST /v1/services/service-1/domains"]);

      created = false;
      yield* stack.destroy();
    }),
  { tags: ["unit", "provider:prisma", "provider:prisma:customdomain"] },
);
