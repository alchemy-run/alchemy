import { resolve4 } from "node:dns/promises";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import * as Prisma from "@alchemy.run/prisma";
import {
  RoutingUrl,
  type RoutingUrlHostnameChangeRefused,
  RoutingUrlProvider,
  RoutingUrlResources,
} from "@alchemy.run/prisma/RoutingUrl";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { createUrlCheck, getUrl } from "@distilled.cloud/prisma/management";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as DNS from "alchemy/DNS/Adapter";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import {
  AuthoritativeRecordCheck,
  type ExpectedRecord,
  type ExpectedSwitchboardDns,
  type RecordVisibility,
  SwitchboardDnsCheck,
  type SwitchboardDnsVisibility,
  type SwitchboardWaitOptions,
} from "../../../prisma/src/internal/AuthoritativeDns.ts";
import { switchboardTarget } from "../../../prisma/src/internal/Switchboard.ts";
import { cloneFixture } from "../Cloudflare/Utils/Fixture.ts";
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
import { failureOf as failuresOf } from "./fixtures/Live.ts";

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
  appEndpointDomain: id === "svc-no-endpoint" ? "" : `${id}.us-east-1.prisma.build`,
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
  /** What the authoritative nameservers show for the new hostname's switchboard DNS. */
  dns: SwitchboardDnsVisibility;
  /** What the switchboard DNS check was asked. */
  checked: Array<[ExpectedSwitchboardDns, SwitchboardWaitOptions]>;
  /** Status of the workspace's domain ownership for the new hostname, if any. */
  ownership: "verified" | "unverified" | undefined;
  /** Whether that domain ownership is for the exact hostname or its wildcard. */
  ownershipOn: "exact" | "wildcard";
  /** A Prisma refusal the next create or update answers with. */
  refusal: Response | undefined;
  /** Read the switchboard DNS and the TXT from the records the DNS host publishes. */
  fromZone: boolean;
  /** What the authoritative nameservers show for the new hostname's TXT; overrides the zone. */
  txt: RecordVisibility | undefined;
  /** The TXT records the ownership check was asked about. */
  txtChecked: ExpectedRecord[];
  /** The DNS host's records when Prisma received a PATCH. */
  zoneAtPatch: DNS.DnsRecord[] | undefined;
}

/** One DNS host's records, as the test DNS adapter publishes them. */
interface Zone {
  records: DNS.DnsRecord[];
  /** Records the DNS host removed. */
  removed: DNS.DnsRecord[];
  /** How many times the DNS host was asked to publish. */
  publishes: number;
}

const sameRecord = (a: DNS.DnsRecord) => (b: DNS.DnsRecord) =>
  a.name === b.name && a.type === b.type && a.value === b.value;

const makeUrlCloud = () => {
  const rows = new Map<string, WireRoutingUrl>();
  const zone: Zone = { records: [], removed: [], publishes: 0 };
  const state: CloudState = {
    dns: { visibility: "absent", cname: "absent" },
    checked: [],
    ownership: undefined,
    ownershipOn: "exact",
    refusal: undefined,
    fromZone: false,
    txt: undefined,
    txtChecked: [],
    zoneAtPatch: undefined,
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
      const ownership = state.ownership;
      return page(
        ownership && domain.startsWith("*.") === (state.ownershipOn === "wildcard")
          ? [
              {
                id: "do-1",
                type: "domainOwnership",
                workspaceId: "ws-1",
                domain,
                verification: TXT,
                status: ownership,
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
        state.zoneAtPatch = [...zone.records];
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
    Object.assign(zone, { records: [], removed: [], publishes: 0 });
    for (const row of initial) rows.set(row.id, row);
    Object.assign(
      state,
      {
        dns: { visibility: "absent", cname: "absent" },
        checked: [],
        ownership: undefined,
        ownershipOn: "exact",
        refusal: undefined,
        fromZone: false,
        txt: undefined,
        txtChecked: [],
        zoneAtPatch: undefined,
      },
      options,
    );
    fake.captured.length = 0;
  };
  const routes = () => routesOf(fake.captured);
  const dnsSeen = (expected: ExpectedSwitchboardDns): SwitchboardDnsVisibility =>
    zone.records.some(
      sameRecord({ name: expected.name, type: "CNAME", value: expected.switchboard }),
    )
      ? { visibility: "seen", cname: "seen" }
      : { visibility: "absent", cname: "absent" };
  const txtSeen = (expected: ExpectedRecord): RecordVisibility =>
    state.txt ??
    (state.fromZone &&
    zone.records.some(sameRecord({ name: expected.name, type: "TXT", value: expected.value ?? "" }))
      ? "seen"
      : "absent");
  return { fake, rows, state, zone, dnsSeen, txtSeen, reset, routes };
};

const json = (value: unknown) =>
  new Response(JSON.stringify({ data: value, pagination: { hasMore: false, nextCursor: null } }), {
    headers: { "content-type": "application/json" },
  });

type UrlCloud = ReturnType<typeof makeUrlCloud>;

class TestPrismaProviders extends Provider.ProviderCollection<TestPrismaProviders>()("Prisma") {}

interface DnsRecords extends Resource<
  "Test.DnsRecords",
  { records: DNS.DnsRecord[] },
  { records: DNS.DnsRecord[] }
> {}
const DnsRecords = Resource<DnsRecords>("Test.DnsRecords");

const TEST_DNS: DNS.DnsConfig = { type: "Test.DNS" };

/** A DNS host whose records live in the cloud's `zone`. */
const testDns = (zone: Zone) =>
  Layer.mergeAll(
    Provider.succeed(DnsRecords, {
      reconcile: ({ news, output }) =>
        Effect.sync(() => {
          zone.publishes++;
          const stale = (output?.records ?? []).filter(
            (record) => !news.records.some(sameRecord(record)),
          );
          zone.removed.push(...stale);
          zone.records = [
            ...zone.records.filter((record) => !stale.some(sameRecord(record))),
            ...news.records.filter((record) => !zone.records.some(sameRecord(record))),
          ];
          return { records: news.records };
        }),
      delete: ({ output }) =>
        Effect.sync(() => {
          zone.removed.push(...output.records);
          zone.records = zone.records.filter((record) => !output.records.some(sameRecord(record)));
        }),
    }),
    DNS.adapterLayer(TEST_DNS.type, {
      alias: () => Effect.die("unexpected alias"),
      aliasSet: () => Effect.die("unexpected aliasSet"),
      records: (id, { records }) => DnsRecords(id, { records }),
    }),
  );

interface AppRef extends Resource<"Test.AppRef", {}, { appId: string }> {}
const AppRef = Resource<AppRef>("Test.AppRef");

const testFor = (cloud: UrlCloud, options: { dev?: boolean } = {}) =>
  Test.make({
    ...(options.dev ? { dev: true, sidecar: false } : {}),
    providers: Layer.effect(
      TestPrismaProviders,
      Provider.collection([...RoutingUrlResources]),
    ).pipe(
      Layer.provideMerge(RoutingUrlProvider()),
      Layer.provide(
        Layer.succeed(AuthoritativeRecordCheck, (expected) =>
          Effect.sync(() => {
            cloud.state.txtChecked.push(expected);
            return cloud.txtSeen(expected);
          }),
        ),
      ),
      Layer.provide(
        Layer.succeed(SwitchboardDnsCheck, (expected, options) =>
          Effect.sync(() => {
            cloud.state.checked.push([expected, options]);
            return cloud.state.fromZone ? cloud.dnsSeen(expected) : cloud.state.dns;
          }),
        ),
      ),
      Layer.merge(testDns(cloud.zone)),
      Layer.merge(
        Provider.succeed(AppRef, {
          reconcile: () => Effect.succeed({ appId: "svc-1" }),
          delete: () => Effect.void,
        }),
      ),
      Layer.provide(
        Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
      ),
      Layer.provideMerge(cloud.fake.layer),
    ),
  });

const urlStack = (hostname = HOSTNAME) => RoutingUrl("Url", { app: "svc-1", hostname });

const dnsStack = (hostname = HOSTNAME) =>
  RoutingUrl("Url", { app: "svc-1", hostname, dns: TEST_DNS });

const recordsFor = (hostname: string): DNS.DnsRecord[] => [
  { name: `_prisma-verification.${hostname}`, type: "TXT", value: TXT.value },
  { name: hostname, type: "CNAME", value: "switchboard.us-east-1.prisma.build" },
];

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => (Result.isFailure(result) ? String(result.failure) : undefined)),
  );

const refusalOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  failuresOf(effect).pipe(
    Effect.map(({ errors }) =>
      errors.find((error): error is RoutingUrlHostnameChangeRefused =>
        Predicate.isTagged(error, "RoutingUrlHostnameChangeRefused"),
      ),
    ),
  );

const SWITCHBOARD = "switchboard.us-east-1.prisma.build";

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
      expect(lifecycle.zone.publishes).toBe(0);
      expect(lifecycle.routes().some((route) => route.includes("domain-ownerships"))).toBe(false);

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

const ownershipWrites = (cloud: UrlCloud) =>
  cloud.routes().filter((route) => route.includes("domain-ownerships") && !route.startsWith("GET"));

const withDns = makeUrlCloud();
testFor(withDns).test.provider(
  "with dns, publishes the TXT and CNAME, keeps them once the row is active, and destroy removes them",
  (stack) =>
    Effect.gen(function* () {
      withDns.reset();
      yield* stack.destroy();

      const url = yield* stack.deploy(dnsStack());

      expect(withDns.zone.records).toEqual(recordsFor(HOSTNAME));
      expect(url.logicalId).toBe("Url");
      expect(url.status).toBe("pending");
      const create = withDns.fake.captured.find((request) => request.method === "POST");
      expect(create?.bodyJson).toEqual({ hostname: HOSTNAME, logicalId: "Url" });
      expect(ownershipWrites(withDns)).toEqual([]);

      withDns.rows.set(url.routingUrlId, routingUrl(url.routingUrlId, { status: "active" }));
      withDns.fake.captured.length = 0;
      yield* stack.deploy(dnsStack());

      expect(withDns.zone.records).toEqual(recordsFor(HOSTNAME));
      expect(withDns.zone.removed).toEqual([]);
      expect(withDns.zone.publishes).toBe(1);
      expect(PATCHES(withDns)).toEqual([]);
      expect(ownershipWrites(withDns)).toEqual([]);

      withDns.fake.captured.length = 0;
      yield* stack.destroy();
      expect(withDns.routes()).toContain(`DELETE /v1/urls/${url.routingUrlId}`);
      expect(withDns.routes().some((route) => route.includes("domain-ownerships"))).toBe(false);
      expect(withDns.zone.records).toEqual([]);
      expect(withDns.rows.size).toBe(0);
    }),
  { tags },
);

const dnsChange = makeUrlCloud();
testFor(dnsChange).test.provider(
  "with dns, a hostname change publishes the new records, passes on the TXT, and removes the old records after the PATCH",
  (stack) =>
    Effect.gen(function* () {
      dnsChange.reset({ fromZone: true }, routingUrl("url-1", { status: "active" }));
      yield* stack.destroy();
      const serving = yield* stack.deploy(dnsStack());
      expect(serving.status).toBe("active");
      expect(serving.records).toEqual([]);
      expect(dnsChange.zone.records).toEqual(recordsFor(HOSTNAME));

      dnsChange.fake.captured.length = 0;
      const url = yield* stack.deploy(dnsStack("new.example.com"));

      expect(url.hostname).toBe("new.example.com");
      expect(PATCHES(dnsChange)).toEqual(["PATCH /v1/urls/url-1"]);
      expect(dnsChange.state.txtChecked).toEqual([
        { type: "TXT", name: "_prisma-verification.new.example.com", value: TXT.value },
      ]);
      expect(dnsChange.state.checked.map(([expected]) => expected.name)).toEqual([
        "new.example.com",
      ]);
      expect(dnsChange.state.zoneAtPatch).toEqual([
        ...recordsFor(HOSTNAME),
        ...recordsFor("new.example.com"),
      ]);
      expect(dnsChange.zone.records).toEqual(recordsFor("new.example.com"));
      expect(dnsChange.zone.removed).toEqual(recordsFor(HOSTNAME));
      expect(ownershipWrites(dnsChange)).toEqual([]);

      yield* stack.destroy();
      expect(dnsChange.zone.records).toEqual([]);
    }),
  { tags },
);

const dnsRefused = makeUrlCloud();
testFor(dnsRefused).test.provider(
  "with dns, a refused hostname change leaves the serving hostname's records published",
  (stack) =>
    Effect.gen(function* () {
      dnsRefused.reset({ fromZone: true }, routingUrl("url-1", { status: "active" }));
      yield* stack.destroy();
      yield* stack.deploy(dnsStack());

      dnsRefused.state.txt = "absent";
      dnsRefused.fake.captured.length = 0;
      const refusal = yield* refusalOf(stack.deploy(dnsStack("new.example.com")));

      expect(refusal?.ownershipDns).toBe("absent");
      expect(PATCHES(dnsRefused)).toEqual([]);
      expect(dnsRefused.rows.get("url-1")?.hostname).toBe(HOSTNAME);
      expect(dnsRefused.zone.records).toEqual([
        ...recordsFor(HOSTNAME),
        ...recordsFor("new.example.com"),
      ]);
      expect(dnsRefused.zone.removed).toEqual([]);

      dnsRefused.state.txt = undefined;
      yield* stack.destroy();
      expect(dnsRefused.zone.records).toEqual([]);
    }),
  { tags },
);

const addDns = makeUrlCloud();
testFor(addDns).test.provider(
  "adding dns to a deployed RoutingUrl keeps its row",
  (stack) =>
    Effect.gen(function* () {
      addDns.reset();
      yield* stack.destroy();
      const before = yield* stack.deploy(urlStack());

      addDns.fake.captured.length = 0;
      const after = yield* stack.deploy(dnsStack());

      expect(after.routingUrlId).toBe(before.routingUrlId);
      expect(PATCHES(addDns)).toEqual([]);
      expect(addDns.routes().some((route) => route.startsWith("DELETE /v1/urls"))).toBe(false);
      expect(addDns.routes().some((route) => route.startsWith("POST"))).toBe(false);
      expect(addDns.zone.records).toEqual(recordsFor(HOSTNAME));

      yield* stack.destroy();
    }),
  { tags },
);

const appOutput = makeUrlCloud();
testFor(appOutput).test.provider(
  "with dns, takes the app id from another resource's output on every deploy",
  (stack) =>
    Effect.gen(function* () {
      appOutput.reset();
      yield* stack.destroy();
      const program = Effect.gen(function* () {
        const app = yield* AppRef("Api", {});
        return yield* RoutingUrl("Url", { app: app.appId, hostname: HOSTNAME, dns: TEST_DNS });
      });

      yield* stack.deploy(program);
      const url = yield* stack.deploy(program);

      expect(url.serviceId).toBe("svc-1");
      expect(appOutput.zone.records).toEqual(recordsFor(HOSTNAME));

      yield* stack.destroy();
    }),
  { tags },
);

const unpublishable = makeUrlCloud();
testFor(unpublishable).test.provider(
  "with dns, refuses a wildcard or an app with no endpoint before publishing anything",
  (stack) =>
    Effect.gen(function* () {
      unpublishable.reset();
      yield* stack.destroy();

      const wildcard = yield* failureOf(stack.deploy(dnsStack("*.example.com")));
      expect(wildcard).toContain("RoutingUrlInvalidHostname");

      const endpointless = yield* failureOf(
        stack.deploy(
          RoutingUrl("Url", { app: "svc-no-endpoint", hostname: HOSTNAME, dns: TEST_DNS }),
        ),
      );
      expect(endpointless).toContain("RoutingUrlOperationFailed");
      expect(endpointless).toContain("svc-no-endpoint");

      expect(unpublishable.zone.publishes).toBe(0);
      expect(unpublishable.routes().some((route) => route.startsWith("POST"))).toBe(false);

      yield* stack.destroy();
    }),
  { tags },
);

const inDev = makeUrlCloud();
testFor(inDev, { dev: true }).test.provider(
  "with dns, publishes nothing under alchemy dev",
  (stack) =>
    Effect.gen(function* () {
      inDev.reset();
      yield* stack.destroy();

      const url = yield* stack.deploy(dnsStack());

      expect(url.routingUrlId).toContain("dev:");
      expect(inDev.zone.publishes).toBe(0);
      expect(inDev.routes()).toEqual([]);

      yield* stack.destroy();
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
      const refusal = yield* refusalOf(stack.deploy(urlStack("new.example.com")));

      expect(refusal?.switchboardDns).toBe("absent");
      expect(refusal?.ownershipDns).toBe("absent");
      expect(refusal?.records).toEqual([
        { type: "TXT", name: "_prisma-verification.new.example.com", value: TXT.value },
        { type: "CNAME", name: "new.example.com", value: SWITCHBOARD },
      ]);
      expect(refusal?.message).toContain("ALIAS, ANAME or flattened CNAME");
      expect(refusal?.message).toContain(
        "not every authoritative nameserver answers TXT _prisma-verification.new.example.com",
      );
      expect(refusedChange.state.checked).toEqual([
        [
          { name: "new.example.com", switchboard: SWITCHBOARD },
          { margin: "if-unseen", nameservers: "name", attempts: "once" },
        ],
      ]);
      expect(PATCHES(refusedChange)).toEqual([]);
      expect(refusedChange.rows.get("url-1")?.hostname).toBe(HOSTNAME);

      yield* stack.destroy();
    }),
  { tags },
);

const txtProof = makeUrlCloud();
testFor(txtProof).test.provider(
  "changes an active row's exact hostname with no domain ownership once its TXT and CNAME are seen",
  (stack) =>
    Effect.gen(function* () {
      txtProof.reset({}, routingUrl("url-1", { status: "active" }));
      yield* stack.destroy();
      yield* stack.deploy(urlStack());

      Object.assign(txtProof.state, { txt: "seen", dns: { visibility: "seen", cname: "seen" } });
      const url = yield* stack.deploy(urlStack("new.example.com"));

      expect(url.hostname).toBe("new.example.com");
      expect(PATCHES(txtProof)).toEqual(["PATCH /v1/urls/url-1"]);
      expect(txtProof.state.txtChecked.map((record) => record.name)).toEqual([
        "_prisma-verification.new.example.com",
      ]);
      expect(txtProof.state.checked.map(([, options]) => options.attempts)).toEqual(["until-seen"]);

      yield* stack.destroy();
    }),
  { tags },
);

const txtMissing = makeUrlCloud();
testFor(txtMissing).test.provider(
  "refuses an exact hostname with no domain ownership while its TXT is absent or unchecked",
  (stack) =>
    Effect.gen(function* () {
      txtMissing.reset({}, routingUrl("url-1", { status: "active" }));
      yield* stack.destroy();
      yield* stack.deploy(urlStack());

      txtMissing.fake.captured.length = 0;
      Object.assign(txtMissing.state, {
        txt: "absent",
        dns: { visibility: "seen", cname: "seen" },
      });
      const absent = yield* refusalOf(stack.deploy(urlStack("new.example.com")));

      expect(absent?.ownershipDns).toBe("absent");
      expect(absent?.records).toEqual([
        { type: "TXT", name: "_prisma-verification.new.example.com", value: TXT.value },
      ]);
      expect(absent?.message).toContain(
        `Publish TXT _prisma-verification.new.example.com = ${TXT.value}, then redeploy.`,
      );

      txtMissing.state.txt = "unknown";
      const unknown = yield* refusalOf(stack.deploy(urlStack("new.example.com")));

      expect(unknown?.ownershipDns).toBe("unknown");
      expect(unknown?.message).toContain("could not be checked from this machine");
      expect(PATCHES(txtMissing)).toEqual([]);
      expect(txtMissing.rows.get("url-1")?.hostname).toBe(HOSTNAME);

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
      allowedChange.state.dns = { visibility: "seen", cname: "seen" };
      const url = yield* stack.deploy(urlStack("new.example.com"));

      expect(url.hostname).toBe("new.example.com");
      expect(PATCHES(allowedChange)).toEqual(["PATCH /v1/urls/url-1"]);
      expect(allowedChange.state.checked.map(([, options]) => options.attempts)).toEqual([
        "until-seen",
      ]);

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
      unchecked.state.dns = { visibility: "unknown", cname: "unknown" };
      const refusal = yield* refusalOf(stack.deploy(urlStack("new.example.com")));

      expect(refusal?.switchboardDns).toBe("unknown");
      expect(refusal?.records).toEqual([]);
      expect(refusal?.message).toContain("could not be checked from this machine");
      expect(refusal?.message).not.toContain("Publish");
      expect(PATCHES(unchecked)).toEqual([]);

      unchecked.state.dns = { visibility: "unknown", cname: "absent" };
      const noCname = yield* refusalOf(stack.deploy(urlStack("new.example.com")));

      expect(noCname?.switchboardDns).toBe("unknown");
      expect(noCname?.records).toEqual([
        { type: "CNAME", name: "new.example.com", value: SWITCHBOARD },
      ]);
      expect(noCname?.message).toContain(`has no CNAME to ${SWITCHBOARD}`);
      expect(noCname?.message).toContain("could not be checked from this machine");
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
        dns: { visibility: "seen", cname: "seen" },
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

const flattenedApex = makeUrlCloud();
testFor(flattenedApex).test.provider(
  "accepts a hostname whose A or AAAA answers include a switchboard address, with no CNAME",
  (stack) =>
    Effect.gen(function* () {
      flattenedApex.reset({}, routingUrl("url-1", { status: "active" }));
      yield* stack.destroy();
      yield* stack.deploy(urlStack());

      Object.assign(flattenedApex.state, {
        ownership: "verified",
        dns: { visibility: "seen", cname: "absent" },
      });
      const url = yield* stack.deploy(urlStack("example.org"));

      expect(url.hostname).toBe("example.org");
      expect(PATCHES(flattenedApex)).toEqual(["PATCH /v1/urls/url-1"]);

      yield* stack.destroy();
    }),
  { tags },
);

const unroutedApex = makeUrlCloud();
testFor(unroutedApex).test.provider(
  "refuses an apex with no record pointing at the switchboard, naming the CNAME and its apex forms",
  (stack) =>
    Effect.gen(function* () {
      unroutedApex.reset({}, routingUrl("url-1", { status: "active" }));
      yield* stack.destroy();
      yield* stack.deploy(urlStack());

      unroutedApex.fake.captured.length = 0;
      Object.assign(unroutedApex.state, {
        ownership: "verified",
        dns: { visibility: "absent", cname: "absent" },
      });
      const refusal = yield* refusalOf(stack.deploy(urlStack("example.org")));

      expect(refusal?.records).toEqual([
        { type: "CNAME", name: "example.org", value: SWITCHBOARD },
      ]);
      expect(refusal?.message).toContain(
        `Publish CNAME example.org = ${SWITCHBOARD}, then redeploy. A hostname that cannot have a CNAME, such as a zone apex, can use an ALIAS, ANAME or flattened CNAME instead.`,
      );
      expect(PATCHES(unroutedApex)).toEqual([]);
      expect(unroutedApex.rows.get("url-1")?.hostname).toBe(HOSTNAME);

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

const ZONE = "alchemy-test-2.us";

/** Asks Prisma to check the RoutingUrl until it is `active`, at most 5 minutes. */
const checkUntilActive = (id: string) =>
  createUrlCheck({ id }).pipe(
    Effect.map(({ data }) => data),
    Effect.tap((data) =>
      Effect.logInfo(`RoutingUrl ${data.status}; first unmet: ${data.firstUnmetCondition}`),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (data) => data.status === "active",
      times: 30,
    }),
  );

const liveDns = Test.make({
  providers: Layer.mergeAll(Prisma.providers(), Cloudflare.providers()),
});

/**
 * The test zone's apex already serves other tests, so the address path a
 * zone apex takes (A records holding the switchboard's addresses, as an
 * ALIAS, ANAME or flattened CNAME gives) is exercised on a subdomain.
 */
liveDns.test.provider.skipIf(process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS !== "true")(
  "changes a serving hostname to one whose A records hold the switchboard's addresses, after refusing it without them",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zone = yield* findZoneByName({ accountId, name: ZONE });
      if (!zone) return yield* Effect.die(new Error(`zone "${ZONE}" not found`));
      const base = `prisma-url-${stack.stage.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.${ZONE}`;
      const first = `a.${base}`;
      const second = `b.${base}`;
      const cwd = yield* cloneFixture(
        pathe.resolve(import.meta.dirname, "../Cloudflare/Website/staticsite-fixture"),
        {
          prefix: "alchemy-prisma-routing-url-",
          tempRoot: pathe.resolve(import.meta.dirname, "../../.tmp"),
          entries: ["src", "build.sh"],
        },
      );

      const urlStack = (hostname: string, addresses: ReadonlyArray<string> = []) =>
        Effect.gen(function* () {
          const project = yield* Prisma.Project("Project", { createDatabase: false });
          const site = yield* Prisma.Website.StaticSite("Site", {
            cwd,
            command: "bash build.sh",
            shell: true,
            outdir: "dist",
            project,
          });
          yield* Prisma.DomainOwnership("Ownership", {
            project,
            domain: `*.${base}`,
            dns: Cloudflare.DNS.Adapter(),
          });
          yield* Cloudflare.DNS.Record("FirstAlias", {
            zoneId: zone.id,
            name: first,
            type: "CNAME",
            content: Output.map(site.compute!.appEndpointDomain, (endpoint) =>
              switchboardTarget(endpoint),
            ),
            proxied: false,
          });
          for (const [index, address] of addresses.entries()) {
            yield* Cloudflare.DNS.Record(`SecondAddress${index}`, {
              zoneId: zone.id,
              name: second,
              type: "A",
              content: address,
              proxied: false,
            });
          }
          const url = yield* Prisma.RoutingUrl("Url", { app: site.compute!, hostname });
          return { site, url };
        });

      const { site, url } = yield* stack.deploy(urlStack(first));
      expect((yield* checkUntilActive(url.routingUrlId)).status).toBe("active");

      const refused = yield* refusalOf(stack.deploy(urlStack(second)));
      expect(refused?.switchboardDns).toBe("absent");
      expect(refused?.records.map((record) => record.type)).toEqual(["CNAME"]);
      expect((yield* getUrl({ id: url.routingUrlId })).data.hostname).toBe(first);

      const switchboard = switchboardTarget(site.compute!.appEndpointDomain);
      const addresses = yield* Effect.tryPromise(() => resolve4(switchboard)).pipe(Effect.orDie);
      const moved = yield* stack.deploy(urlStack(second, addresses));
      expect(moved.url.hostname).toBe(second);
      expect((yield* getUrl({ id: url.routingUrlId })).data.hostname).toBe(second);
      const serving = yield* checkUntilActive(url.routingUrlId);
      expect(serving.firstUnmetCondition).not.toBe("dnsPointsAtSwitchboard");
      expect(serving.status).toBe("active");

      yield* stack.destroy();
      expect(
        yield* getUrl({ id: url.routingUrlId }).pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        ),
      ).toBe("gone");
    }),
  {
    tags: [
      "live",
      "provider:prisma",
      "provider:prisma:routingurl",
      "provider:prisma:domainownership",
      "provider:cloudflare",
      "provider:cloudflare:dns",
    ],
    timeout: 900_000,
  },
);
