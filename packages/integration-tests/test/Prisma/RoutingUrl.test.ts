import * as Prisma from "@alchemy.run/prisma";
import { RoutingUrl, RoutingUrlProvider } from "@alchemy.run/prisma/RoutingUrl";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getUrl } from "@distilled.cloud/prisma/management";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import {
  AuthoritativeRecordCheck,
  type RecordVisibility,
} from "../../../prisma/src/internal/AuthoritativeDns.ts";
import {
  data,
  failure,
  type FakeManagementApi,
  makeFakeManagementApi,
  noContent,
  notFound,
  page,
  routesOf,
  unhandled,
  WIRE_CREATED_AT,
  wireProject,
} from "./fixtures/FakeManagementApi.ts";

const HOSTNAME = "api.example.com";
const TXT = {
  type: "TXT",
  name: `_prisma-verification.${HOSTNAME}`,
  value: `prisma-verification=${"a".repeat(64)}`,
  ttl: 300,
};

const service = (id: string) => ({
  id,
  type: "app",
  url: `https://api.prisma.test/v1/services/${id}`,
  name: id,
  region: { id: "us-east-1", name: "us-east-1" },
  projectId: "proj-1",
  branchId: "br-1",
  latestDeploymentId: null,
  appEndpointDomain: `${id}.us-east-1.prisma.build`,
  createdAt: WIRE_CREATED_AT,
  logicalId: null,
});

type Condition = "met" | "unmet" | "unknown";

const routingUrl = (
  id: string,
  options: {
    hostname?: string;
    serviceId?: string;
    logicalId?: string | null;
    status?: "pending" | "active";
  } = {},
) => {
  const hostname = options.hostname ?? HOSTNAME;
  const active = options.status === "active";
  const met = (value: boolean): Condition => (value ? "met" : "unmet");
  return {
    id,
    type: "routingUrl",
    branchId: "br-1",
    serviceId: options.serviceId ?? "svc-1",
    hostname,
    logicalId: options.logicalId === undefined ? "Url" : options.logicalId,
    status: active ? "active" : "pending",
    conditions: {
      ownershipVerified: met(active),
      servicePresent: "met" as Condition,
      liveDeployment: "met" as Condition,
      dnsPointsAtSwitchboard: met(active),
      customDomainBound: met(active),
      certificateActive: met(active),
    },
    firstUnmetCondition: active ? null : "ownershipVerified",
    ownershipExpiry: null,
    records: active
      ? []
      : [
          { condition: "ownershipVerified", ...TXT, name: `_prisma-verification.${hostname}` },
          {
            condition: "dnsPointsAtSwitchboard",
            type: "CNAME",
            name: hostname,
            value: "switchboard.us-east-1.prisma.build",
            ttl: 300,
          },
        ],
    heldBy: null,
    customDomain: null,
    customDomainSyncError: null,
    switchboardDns: null,
    setupUrl: active ? null : `https://console.prisma.test/urls/${id}`,
    createdAt: WIRE_CREATED_AT,
    updatedAt: WIRE_CREATED_AT,
  };
};

type WireRoutingUrl = ReturnType<typeof routingUrl>;

interface CloudState {
  /** What the authoritative nameservers report for the new hostname's CNAME. */
  cname: RecordVisibility;
  /** Status of the workspace's domain ownership for the new hostname, if any. */
  ownership: "verified" | "unverified" | undefined;
  /** Whether that domain ownership is for the exact hostname or its wildcard. */
  ownershipOn: "exact" | "wildcard";
  /** A Prisma refusal the next create or update answers with. */
  refusal: Response | undefined;
}

const makeUrlCloud = () => {
  const rows = new Map<string, WireRoutingUrl>();
  const state: CloudState = {
    cname: "absent",
    ownership: undefined,
    ownershipOn: "exact",
    refusal: undefined,
  };
  let next = 0;
  const fake: FakeManagementApi = makeFakeManagementApi((request) => {
    const path = request.pathname;
    const body = request.bodyJson as Record<string, unknown> | undefined;
    const serviceMatch = /^\/v1\/services\/([^/]+)(\/urls)?$/.exec(path);
    if (serviceMatch && request.method === "GET" && !serviceMatch[2]) {
      return data(service(serviceMatch[1]!));
    }
    if (serviceMatch?.[2] && request.method === "POST") {
      if (state.refusal) return state.refusal;
      const created = routingUrl(`url-${++next}`, {
        hostname: String(body?.hostname),
        serviceId: serviceMatch[1],
        logicalId: (body?.logicalId as string | undefined) ?? null,
      });
      rows.set(created.id, created);
      return data(created, { status: 201 });
    }
    if (path === "/v1/projects/proj-1/branches/br-1/urls") {
      return json(Array.from(rows.values()));
    }
    if (path === "/v1/projects/proj-1") {
      return data(wireProject({ id: "proj-1", workspaceId: "ws-1" }));
    }
    if (path === "/v1/workspaces/ws-1/domain-ownerships/verification") {
      return data({
        ...TXT,
        name: `_prisma-verification.${new URLSearchParams(request.search).get("domain")}`,
      });
    }
    if (path === "/v1/workspaces/ws-1/domain-ownerships") {
      const domain = new URLSearchParams(request.search).get("domain") ?? "";
      return page(
        state.ownership && domain.startsWith("*.") === (state.ownershipOn === "wildcard")
          ? [
              {
                id: "do-1",
                type: "domainOwnership",
                workspaceId: "ws-1",
                domain,
                verification: TXT,
                status: state.ownership,
                expiresAt: null,
                verificationRecordLastSeenAt: null,
                verificationRecordPresent: null,
                verificationRecordSyncError: null,
                createdAt: WIRE_CREATED_AT,
              },
            ]
          : [],
      );
    }
    const urlMatch = /^\/v1\/urls\/([^/]+)$/.exec(path);
    if (urlMatch) {
      const row = rows.get(urlMatch[1]!);
      if (row === undefined) return notFound("RoutingUrl not found");
      if (request.method === "GET") return data(row);
      if (request.method === "DELETE") {
        rows.delete(row.id);
        return noContent();
      }
      if (request.method === "PATCH") {
        if (state.refusal) return state.refusal;
        const hostname = (body?.hostname as string | undefined) ?? row.hostname;
        const updated = {
          ...routingUrl(row.id, {
            hostname,
            serviceId: (body?.serviceId as string | undefined) ?? row.serviceId,
            logicalId:
              body && "logicalId" in body ? (body.logicalId as string | null) : row.logicalId,
            status: hostname === row.hostname ? (row.status as "pending" | "active") : "pending",
          }),
        };
        rows.set(row.id, updated);
        return data(updated);
      }
    }
    return unhandled(request);
  });
  const reset = (options: Partial<CloudState> = {}, ...initial: WireRoutingUrl[]) => {
    rows.clear();
    next = 0;
    for (const row of initial) rows.set(row.id, row);
    Object.assign(
      state,
      { cname: "absent", ownership: undefined, ownershipOn: "exact", refusal: undefined },
      options,
    );
    fake.captured.length = 0;
  };
  const routes = () => routesOf(fake.captured);
  return { fake, rows, state, reset, routes };
};

const json = (value: unknown) =>
  new Response(JSON.stringify({ data: value, pagination: { hasMore: false, nextCursor: null } }), {
    headers: { "content-type": "application/json" },
  });

type UrlCloud = ReturnType<typeof makeUrlCloud>;

class TestPrismaProviders extends Provider.ProviderCollection<TestPrismaProviders>()("Prisma") {}

const testFor = (cloud: UrlCloud) =>
  Test.make({
    providers: Layer.effect(TestPrismaProviders, Provider.collection([RoutingUrl])).pipe(
      Layer.provideMerge(RoutingUrlProvider()),
      Layer.provide(
        Layer.succeed(AuthoritativeRecordCheck, () => Effect.succeed(cloud.state.cname)),
      ),
      Layer.provide(
        Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
      ),
      Layer.provideMerge(cloud.fake.layer),
    ),
  });

const urlStack = (hostname = HOSTNAME) => RoutingUrl("Url", { app: "svc-1", hostname });

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => (Result.isFailure(result) ? String(result.failure) : undefined)),
  );

const PATCHES = (cloud: UrlCloud) => cloud.routes().filter((route) => route.startsWith("PATCH"));
const tags = ["unit", "provider:prisma", "provider:prisma:routingurl"];

const lifecycle = makeUrlCloud();
testFor(lifecycle).test.provider(
  "saves a hostname with no DNS, redeploys without a PATCH, and destroy deletes only the row",
  (stack) =>
    Effect.gen(function* () {
      lifecycle.reset();
      yield* stack.destroy();

      const url = yield* stack.deploy(urlStack());

      expect(url.status).toBe("pending");
      expect(url.logicalId).toBe("Url");
      expect(url.firstUnmetCondition).toBe("ownershipVerified");
      expect(url.conditions.ownershipVerified).toBe("unmet");
      expect(url.records.map((record) => record.type)).toEqual(["TXT", "CNAME"]);
      expect(url.setupUrl).toContain(url.routingUrlId);
      const create = lifecycle.fake.captured.find((request) => request.method === "POST");
      expect(create?.bodyJson).toEqual({ hostname: HOSTNAME, logicalId: "Url" });

      lifecycle.fake.captured.length = 0;
      yield* stack.deploy(urlStack());
      expect(PATCHES(lifecycle)).toEqual([]);

      lifecycle.fake.captured.length = 0;
      yield* stack.destroy();
      expect(lifecycle.routes()).toContain(`DELETE /v1/urls/${url.routingUrlId}`);
      expect(lifecycle.routes().some((route) => route.includes("domain-ownerships"))).toBe(false);
      expect(lifecycle.rows.size).toBe(0);
    }),
  { tags },
);

const byLogicalId = makeUrlCloud();
testFor(byLogicalId).test.provider(
  "updates a row found by logicalId in place",
  (stack) =>
    Effect.gen(function* () {
      byLogicalId.reset({}, routingUrl("url-existing", { hostname: "old.example.com" }));
      yield* stack.destroy();

      const url = yield* stack.deploy(urlStack());

      expect(url.routingUrlId).toBe("url-existing");
      expect(url.hostname).toBe(HOSTNAME);
      expect(byLogicalId.routes()).toEqual(expect.arrayContaining(["PATCH /v1/urls/url-existing"]));
      expect(byLogicalId.routes().some((route) => route.startsWith("POST"))).toBe(false);

      yield* stack.destroy();
    }),
  { tags },
);

const backfilled = makeUrlCloud();
testFor(backfilled).test.provider(
  "adopts a row with no logicalId on the same service and hostname by writing its logicalId",
  (stack) =>
    Effect.gen(function* () {
      backfilled.reset({}, routingUrl("url-backfill", { logicalId: null, status: "active" }));
      yield* stack.destroy();

      const url = yield* stack.deploy(urlStack());

      expect(url.routingUrlId).toBe("url-backfill");
      expect(url.logicalId).toBe("Url");
      const patch = backfilled.fake.captured.find((request) => request.method === "PATCH");
      expect(patch?.bodyJson).toEqual({ logicalId: "Url" });

      yield* stack.destroy();
    }),
  { tags },
);

const taken = makeUrlCloud();
testFor(taken).test.provider(
  "fails, naming the row, when another row on the Branch has the hostname",
  (stack) =>
    Effect.gen(function* () {
      taken.reset({}, routingUrl("url-other", { serviceId: "svc-2", logicalId: "other" }));
      yield* stack.destroy();

      const failure = yield* failureOf(stack.deploy(urlStack()));

      expect(failure).toContain("RoutingUrlHostnameTaken");
      expect(failure).toContain("url-other");
      expect(taken.routes().some((route) => route.startsWith("POST"))).toBe(false);

      taken.reset();
      yield* stack.destroy();
    }),
  { tags },
);

const refusedChange = makeUrlCloud();
testFor(refusedChange).test.provider(
  "refuses a hostname change on an active row before any PATCH when the new hostname cannot serve",
  (stack) =>
    Effect.gen(function* () {
      refusedChange.reset({}, routingUrl("url-1", { status: "active" }));
      yield* stack.destroy();
      yield* stack.deploy(urlStack());

      refusedChange.fake.captured.length = 0;
      refusedChange.state.ownership = "unverified";
      const failure = yield* failureOf(stack.deploy(urlStack("new.example.com")));

      expect(failure).toContain("RoutingUrlHostnameChangeRefused");
      expect(failure).toContain("_prisma-verification.new.example.com");
      expect(failure).toContain("switchboard.us-east-1.prisma.build");
      expect(PATCHES(refusedChange)).toEqual([]);
      expect(refusedChange.rows.get("url-1")?.hostname).toBe(HOSTNAME);

      yield* stack.destroy();
    }),
  { tags },
);

const allowedChange = makeUrlCloud();
testFor(allowedChange).test.provider(
  "changes an active row's hostname once the new one has a verified domain ownership and its CNAME",
  (stack) =>
    Effect.gen(function* () {
      allowedChange.reset({}, routingUrl("url-1", { status: "active" }));
      yield* stack.destroy();
      yield* stack.deploy(urlStack());

      allowedChange.state.ownership = "verified";
      allowedChange.state.cname = "seen";
      const url = yield* stack.deploy(urlStack("new.example.com"));

      expect(url.hostname).toBe("new.example.com");
      expect(PATCHES(allowedChange)).toEqual(["PATCH /v1/urls/url-1"]);

      yield* stack.destroy();
    }),
  { tags },
);

const unchecked = makeUrlCloud();
testFor(unchecked).test.provider(
  "refuses a hostname change it could not check, without asking to publish the CNAME",
  (stack) =>
    Effect.gen(function* () {
      unchecked.reset({}, routingUrl("url-1", { status: "active" }));
      yield* stack.destroy();
      yield* stack.deploy(urlStack());

      unchecked.fake.captured.length = 0;
      unchecked.state.ownership = "verified";
      unchecked.state.cname = "unknown";
      const failure = yield* failureOf(stack.deploy(urlStack("new.example.com")));

      expect(failure).toContain("RoutingUrlHostnameChangeRefused");
      expect(failure).toContain("could not be checked from this machine");
      expect(failure).not.toContain("Publish");
      expect(PATCHES(unchecked)).toEqual([]);

      yield* stack.destroy();
    }),
  { tags },
);

const wildcard = makeUrlCloud();
testFor(wildcard).test.provider(
  "accepts a verified wildcard domain ownership as covering the new hostname",
  (stack) =>
    Effect.gen(function* () {
      wildcard.reset({}, routingUrl("url-1", { status: "active" }));
      yield* stack.destroy();
      yield* stack.deploy(urlStack());

      Object.assign(wildcard.state, {
        ownership: "verified",
        ownershipOn: "wildcard",
        cname: "seen",
      });
      const url = yield* stack.deploy(urlStack("new.example.com"));

      expect(url.hostname).toBe("new.example.com");
      expect(wildcard.routes()).toContain("GET /v1/workspaces/ws-1/domain-ownerships");
      expect(PATCHES(wildcard)).toEqual(["PATCH /v1/urls/url-1"]);

      yield* stack.destroy();
    }),
  { tags },
);

const pendingChange = makeUrlCloud();
testFor(pendingChange).test.provider(
  "changes a pending row's hostname without checking it",
  (stack) =>
    Effect.gen(function* () {
      pendingChange.reset({}, routingUrl("url-1"));
      yield* stack.destroy();
      yield* stack.deploy(urlStack());

      pendingChange.fake.captured.length = 0;
      const url = yield* stack.deploy(urlStack("new.example.com"));

      expect(url.hostname).toBe("new.example.com");
      expect(PATCHES(pendingChange)).toEqual(["PATCH /v1/urls/url-1"]);
      expect(pendingChange.routes().some((route) => route.includes("domain-ownerships"))).toBe(
        false,
      );

      yield* stack.destroy();
    }),
  { tags },
);

const refusals = makeUrlCloud();
testFor(refusals).test.provider(
  "turns Prisma's 409 and 422 refusals into typed errors",
  (stack) =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<[Response, string]> = [
        [
          failure(409, "quota-exceeded", "Quota exceeded for custom_domains_per_service"),
          "RoutingUrlQuotaExceeded",
        ],
        [
          failure(
            409,
            "client-error",
            'A RoutingUrl with logicalId "Url" already exists on this branch',
          ),
          "RoutingUrlLogicalIdTaken",
        ],
        [
          failure(
            422,
            "validation-error",
            "*.example.com is not a hostname such as shop.example.com.",
          ),
          "RoutingUrlInvalidHostname",
        ],
        [
          failure(422, "validation-error", "The service must be on the RoutingUrl's Branch."),
          "RoutingUrlServiceOnAnotherBranch",
        ],
      ];
      for (const [response, tag] of cases) {
        refusals.reset({ refusal: response });
        yield* stack.destroy();
        const message = yield* failureOf(stack.deploy(urlStack()));
        expect(message).toContain(tag);
      }

      refusals.reset();
      yield* stack.destroy();
    }),
  { tags },
);

const live = Test.make({ providers: Prisma.providers() });

live.test.provider.skipIf(process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS !== "true")(
  "saves a RoutingUrl for a hostname with no DNS and deletes it on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const hostname = `routing-url-${stack.stage.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.example.com`;

      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Prisma.Project("Project", { createDatabase: false });
          const app = yield* Prisma.App("Web", { project });
          const url = yield* Prisma.RoutingUrl("Url", { app, hostname });
          return { url };
        }),
      );

      expect(url.status).toBe("pending");
      expect(url.hostname).toBe(hostname);
      expect(url.records.map((record) => record.type).sort()).toEqual(["CNAME", "TXT"]);
      const observed = yield* getUrl({ id: url.routingUrlId });
      expect(observed.data.logicalId).toBe(url.logicalId);

      yield* stack.destroy();
      expect(
        yield* getUrl({ id: url.routingUrlId }).pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        ),
      ).toBe("gone");
    }),
  {
    tags: ["live", "provider:prisma", "provider:prisma:routingurl", "provider:prisma:app"],
    timeout: 300_000,
  },
);
