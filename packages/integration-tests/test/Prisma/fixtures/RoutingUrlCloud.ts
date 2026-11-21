import { CustomDomain, CustomDomainProvider } from "@alchemy.run/prisma/CustomDomain";
import { RoutingUrlProvider, RoutingUrlResources } from "@alchemy.run/prisma/RoutingUrl";
import * as Test from "@alchemy.run/test/Alchemy";
import { Retry } from "@distilled.cloud/prisma";
import { Unowned } from "alchemy/AdoptPolicy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as DeployRetry from "alchemy/DeployRetry";
import * as DNS from "alchemy/DNS/Adapter";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  AuthoritativeRecordCheck,
  type ExpectedRecord,
  type ExpectedSwitchboardDns,
  type RecordVisibility,
  SwitchboardDnsCheck,
  type SwitchboardDnsVisibility,
  type SwitchboardCheckOptions,
  type CheckOptions,
} from "../../../../prisma/src/internal/AuthoritativeDns.ts";
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
} from "./FakeManagementApi.ts";

// Prisma's RoutingUrl, domain ownership and custom domain routes for one
// service, over the fake Management API, and an in-memory DNS host.

export const HOSTNAME = "api.example.com";
export const TXT = {
  type: "TXT",
  name: `_prisma-verification.${HOSTNAME}`,
  value: `prisma-verification=${"a".repeat(64)}`,
  ttl: 300,
};

export const service = (id: string) => ({
  id,
  type: "app",
  url: `https://api.prisma.test/v1/services/${id}`,
  name: id,
  region: { id: "us-east-1", name: "us-east-1" },
  projectId: "proj-1",
  branchId: id === "svc-no-branch" ? null : "br-1",
  latestDeploymentId: null,
  appEndpointDomain: id === "svc-no-endpoint" ? "" : `${id}.us-east-1.prisma.build`,
  createdAt: WIRE_CREATED_AT,
  logicalId: null,
});

export type Condition = "met" | "unmet" | "unknown";

export interface HeldBy {
  workspaceId: string | null;
  projectId: string | null;
  serviceId: string | null;
  message: string | null;
}

export const routingUrl = (
  id: string,
  options: {
    hostname?: string;
    serviceId?: string;
    logicalId?: string | null;
    status?: "pending" | "active";
    customDomainId?: string;
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
    state: (active ? "active" : "not_verified") as string,
    conditions: {
      ownershipVerified: met(active),
      servicePresent: "met" as Condition,
      liveDeployment: "met" as Condition,
      dnsPointsAtSwitchboard: met(active),
      customDomainBound: met(active),
      certificateActive: met(active),
    },
    firstUnmetCondition: (active ? null : "ownershipVerified") as string | null,
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
    heldBy: null as HeldBy | null,
    customDomain:
      options.customDomainId === undefined
        ? null
        : {
            id: options.customDomainId,
            status: "active",
            failureReason: null as string | null,
            certExpiresAt: null,
            lastSeenAt: WIRE_CREATED_AT,
            certificateRetryRequestedAt: null,
            certificateIssuanceStuck: false,
          },
    customDomainSyncError: null as string | null,
    switchboardDns: null,
    setupUrl: active ? null : `https://console.prisma.test/urls/${id}`,
    createdAt: WIRE_CREATED_AT,
    updatedAt: WIRE_CREATED_AT,
  };
};

export type WireRoutingUrl = ReturnType<typeof routingUrl>;

/** A custom domain as `/v1/services/{id}/domains` and `/v1/domains/{id}` return it. */
export const customDomain = (id: string, hostname: string, serviceId = "svc-1") => ({
  id,
  type: "custom-domain",
  url: `https://api.prisma.test/v1/domains/${id}`,
  hostname,
  appId: serviceId,
  computeServiceId: serviceId,
  status: "active",
  foundryStatus: "active",
  failureReason: null,
  failureCategory: null,
  certExpiresAt: null,
  createdAt: WIRE_CREATED_AT,
  updatedAt: WIRE_CREATED_AT,
  dnsRecords: [
    {
      type: "CNAME",
      name: hostname,
      value: "switchboard.us-east-1.prisma.build",
      ttl: null,
    },
  ],
});

export type WireCustomDomain = ReturnType<typeof customDomain>;

export interface CloudState {
  /** What the authoritative nameservers show for the new hostname's switchboard DNS. */
  dns: SwitchboardDnsVisibility;
  /** What the switchboard DNS check was asked. */
  checked: Array<[ExpectedSwitchboardDns, SwitchboardCheckOptions]>;
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
  /** Whether each TXT check waited for the record. */
  txtAttempts: Array<CheckOptions["attempts"]>;
  /** The options each TXT check was called with. */
  txtOptions: CheckOptions[];
  /** The DNS host's records when Prisma received a PATCH. */
  zoneAtPatch: DNS.DnsRecord[] | undefined;
  /**
   * How Prisma moves a saved row on when it is written, checked or read. By
   * default Prisma looks DNS up only on a write or a check, and serves a
   * pending row at once when the DNS host has published both its records.
   */
  progress: (row: WireRoutingUrl, zone: Zone, event: PrismaEvent) => WireRoutingUrl;
  /** Whether Prisma makes the next create's row and then loses its reply behind a 502. */
  loseCreateReply: boolean;
  /** How many TXT checks had run when Prisma received a PATCH. */
  txtCheckedAtPatch: number | undefined;
  /**
   * Requests, as `METHOD /path`, that Prisma answers once with `status`
   * (429 by default) and `Retry-After` seconds.
   */
  throttle: Array<{ route: string; retryAfter: number; status?: number }>;
  /** How many TXT checks had run when Prisma received a `/check`. */
  txtCheckedAtCheck: number | undefined;
}

/** One DNS host's records, as the test DNS adapter publishes them. */
export interface Zone {
  records: DNS.DnsRecord[];
  /** Records the DNS host removed. */
  removed: DNS.DnsRecord[];
  /** How many times the DNS host was asked to publish. */
  publishes: number;
  /** The host options each alias and record set was declared with. */
  options: Array<{ method: "alias" | "records"; options: DNS.DnsZone["options"] }>;
}

export const sameRecord = (a: DNS.DnsRecord) => (b: DNS.DnsRecord) =>
  a.name === b.name && a.type === b.type && a.value === b.value;

/** What makes Prisma look at a row: a create or update, a `/check`, or a read. */
export type PrismaEvent = "write" | "check" | "read";

/** The row as Prisma shows it once it serves. */
export const served = (row: WireRoutingUrl): WireRoutingUrl => ({
  ...routingUrl(row.id, {
    hostname: row.hostname,
    serviceId: row.serviceId,
    logicalId: row.logicalId,
    status: "active",
  }),
  customDomain: row.customDomain,
});

/** Whether the DNS host has published both of the row's records. */
export const published = (row: WireRoutingUrl, zone: Zone) =>
  recordsFor(row.hostname).every((record) => zone.records.some(sameRecord(record)));

/**
 * Prisma looks a pending row's DNS up when it is written or checked, and
 * serves it then if both records are published. A read changes nothing.
 */
export const looksOnWrite = (row: WireRoutingUrl, zone: Zone, event: PrismaEvent) =>
  event !== "read" && row.status === "pending" && published(row, zone) ? served(row) : row;

export const makeUrlCloud = () => {
  const rows = new Map<string, WireRoutingUrl>();
  const domains = new Map<string, WireCustomDomain>();
  const zone: Zone = { records: [], removed: [], publishes: 0, options: [] };
  const state: CloudState = {
    dns: { visibility: "absent", cname: "absent" },
    checked: [],
    ownership: undefined,
    ownershipOn: "exact",
    refusal: undefined,
    fromZone: false,
    txt: undefined,
    txtChecked: [],
    txtAttempts: [],
    txtOptions: [],
    zoneAtPatch: undefined,
    progress: looksOnWrite,
    throttle: [],
    loseCreateReply: false,
    txtCheckedAtPatch: undefined,
    txtCheckedAtCheck: undefined,
  };
  let next = 0;
  const progressed = (row: WireRoutingUrl, event: PrismaEvent) => {
    const moved = state.progress(row, zone, event);
    rows.set(moved.id, moved);
    return moved;
  };
  const fake: FakeManagementApi = makeFakeManagementApi((request) => {
    const path = request.pathname;
    const body = request.bodyJson as Record<string, unknown> | undefined;
    const throttled = state.throttle.find((each) => each.route === `${request.method} ${path}`);
    if (throttled) {
      state.throttle = state.throttle.filter((each) => each !== throttled);
      return new Response(
        JSON.stringify({ error: { code: "rate-limited", message: "Too many requests" } }),
        {
          status: throttled.status ?? 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(throttled.retryAfter),
          },
        },
      );
    }
    const domainsMatch = /^\/v1\/services\/([^/]+)\/domains$/.exec(path);
    if (domainsMatch) {
      const serviceId = domainsMatch[1]!;
      if (request.method === "GET") {
        return page(Array.from(domains.values()).filter((domain) => domain.appId === serviceId));
      }
      if (request.method === "POST") {
        // Prisma records each custom domain it creates as a RoutingUrl.
        const created = customDomain(`dom-${++next}`, String(body?.hostname), serviceId);
        domains.set(created.id, created);
        const recorded = routingUrl(`url-${++next}`, {
          hostname: created.hostname,
          serviceId,
          logicalId: null,
          status: "active",
          customDomainId: created.id,
        });
        rows.set(recorded.id, recorded);
        return data(created, { status: 201 });
      }
    }
    const domainMatch = /^\/v1\/domains\/([^/]+)$/.exec(path);
    if (domainMatch) {
      const domain = domains.get(domainMatch[1]!);
      if (domain === undefined) return notFound("Custom domain not found");
      if (request.method === "GET") return data(domain);
      if (request.method === "DELETE") {
        // Deleting a custom domain deletes the RoutingUrl that holds it.
        domains.delete(domain.id);
        for (const row of rows.values()) {
          if (row.customDomain?.id === domain.id) rows.delete(row.id);
        }
        return noContent();
      }
    }
    const serviceUrlsMatch = /^\/v1\/services\/([^/]+)\/urls$/.exec(path);
    if (serviceUrlsMatch && request.method === "GET") {
      return json(Array.from(rows.values()).filter((row) => row.serviceId === serviceUrlsMatch[1]));
    }
    const serviceMatch = /^\/v1\/services\/([^/]+)(\/urls)?$/.exec(path);
    if (serviceMatch && request.method === "GET" && !serviceMatch[2]) {
      return data(service(serviceMatch[1]!));
    }
    if (serviceMatch?.[2] && request.method === "POST") {
      if (state.refusal) return state.refusal;
      const logicalId = (body?.logicalId as string | undefined) ?? null;
      const onService = [...rows.values()].filter((row) => row.serviceId === serviceMatch[1]);
      if (onService.length >= 3) {
        return failure(409, "quota-exceeded", "The service has reached its hostname quota.");
      }
      if (logicalId !== null && [...rows.values()].some((row) => row.logicalId === logicalId)) {
        return failure(409, "logical-id-taken", "Another live RoutingUrl has this logicalId.");
      }
      const created = progressed(
        routingUrl(`url-${++next}`, {
          hostname: String(body?.hostname),
          serviceId: serviceMatch[1],
          logicalId,
        }),
        "write",
      );
      if (state.loseCreateReply) {
        state.loseCreateReply = false;
        return failure(502, "bad-gateway", "Bad gateway");
      }
      return data(created, { status: 201 });
    }
    if (path === "/v1/projects/proj-1/branches/br-1/urls") {
      const logicalId = new URLSearchParams(request.search).get("logicalId");
      return json(
        Array.from(rows.values()).filter(
          (row) => logicalId === null || row.logicalId === logicalId,
        ),
      );
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
    const checkMatch = /^\/v1\/urls\/([^/]+)\/check$/.exec(path);
    if (checkMatch && request.method === "POST") {
      const row = rows.get(checkMatch[1]!);
      state.txtCheckedAtCheck = state.txtChecked.length;
      return row === undefined ? notFound("RoutingUrl not found") : data(progressed(row, "check"));
    }
    const urlMatch = /^\/v1\/urls\/([^/]+)$/.exec(path);
    if (urlMatch) {
      const row = rows.get(urlMatch[1]!);
      if (row === undefined) return notFound("RoutingUrl not found");
      if (request.method === "GET") return data(progressed(row, "read"));
      if (request.method === "DELETE") {
        rows.delete(row.id);
        return noContent();
      }
      if (request.method === "PATCH") {
        if (state.refusal) return state.refusal;
        state.zoneAtPatch = [...zone.records];
        state.txtCheckedAtPatch = state.txtChecked.length;
        const hostname = (body?.hostname as string | undefined) ?? row.hostname;
        const updated = {
          ...routingUrl(row.id, {
            hostname,
            serviceId: (body?.serviceId as string | undefined) ?? row.serviceId,
            logicalId:
              body && "logicalId" in body ? (body.logicalId as string | null) : row.logicalId,
            status: hostname === row.hostname ? (row.status as "pending" | "active") : "pending",
          }),
          // Prisma changes only the fields it is given; a new hostname loses the custom domain.
          customDomain: hostname === row.hostname ? row.customDomain : null,
        };
        return data(progressed(updated, "write"));
      }
    }
    return unhandled(request);
  });
  const reset = (options: Partial<CloudState> = {}, ...initial: WireRoutingUrl[]) => {
    rows.clear();
    domains.clear();
    next = 0;
    Object.assign(zone, { records: [], removed: [], publishes: 0, options: [] });
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
        txtAttempts: [],
        txtOptions: [],
        zoneAtPatch: undefined,
        progress: looksOnWrite,
        throttle: [],
        loseCreateReply: false,
        txtCheckedAtPatch: undefined,
        txtCheckedAtCheck: undefined,
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
  return { fake, rows, domains, state, zone, dnsSeen, txtSeen, reset, routes };
};

export const json = (value: unknown) =>
  new Response(JSON.stringify({ data: value, pagination: { hasMore: false, nextCursor: null } }), {
    headers: { "content-type": "application/json" },
  });

export type UrlCloud = ReturnType<typeof makeUrlCloud>;

export class TestPrismaProviders extends Provider.ProviderCollection<TestPrismaProviders>()(
  "Prisma",
) {}

export interface DnsRecords extends Resource<
  "Test.DnsRecords",
  { records: DNS.DnsRecord[] },
  { records: DNS.DnsRecord[] }
> {}
export const DnsRecords = Resource<DnsRecords>("Test.DnsRecords");

/** A CNAME at `name`, which, like Cloudflare's alias records, deletes every CNAME at its name. */
export interface DnsAlias extends Resource<
  "Test.DnsAlias",
  { name: string; value: string },
  { name: string; value: string }
> {}
export const DnsAlias = Resource<DnsAlias>("Test.DnsAlias");

export const TEST_DNS: DNS.DnsConfig = { type: "Test.DNS" };

/** A DNS host whose records live in the cloud's `zone`. */
export const testDns = (zone: Zone) =>
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
    Provider.succeed(DnsAlias, {
      // As Cloudflare's alias records do, a CNAME already at the name that
      // this alias has no state for is reported as not owned by the stack.
      read: ({ output, olds }) =>
        Effect.sync(() => {
          if (output !== undefined) return output;
          const existing = zone.records.find(
            (record) => record.type === "CNAME" && record.name === olds?.name,
          );
          return existing === undefined
            ? undefined
            : Unowned({ name: existing.name, value: existing.value });
        }),
      reconcile: ({ news, output }) =>
        Effect.sync(() => {
          const atName = (name: string) => (record: DNS.DnsRecord) =>
            record.type === "CNAME" && record.name === name;
          const wanted: DNS.DnsRecord = { name: news.name, type: "CNAME", value: news.value };
          const stale = zone.records.filter(
            (record) =>
              (output !== undefined && output.name !== news.name && atName(output.name)(record)) ||
              (atName(news.name)(record) && !sameRecord(wanted)(record)),
          );
          zone.removed.push(...stale);
          zone.records = zone.records.filter((record) => !stale.includes(record));
          if (!zone.records.some(sameRecord(wanted))) zone.records.push(wanted);
          return { name: news.name, value: news.value };
        }),
      delete: ({ output }) =>
        Effect.sync(() => {
          const atName = (record: DNS.DnsRecord) =>
            record.type === "CNAME" && record.name === output.name;
          zone.removed.push(...zone.records.filter(atName));
          zone.records = zone.records.filter((record) => !atName(record));
        }),
    }),
    DNS.adapterLayer<Provider.Provider<DnsRecords> | Provider.Provider<DnsAlias>>(TEST_DNS.type, {
      alias: (id, { name, target, options }) =>
        "hostname" in target && target.hostname !== undefined
          ? Effect.suspend(() => {
              zone.options.push({ method: "alias", options });
              return DnsAlias(`${id}-CNAME`, { name, value: target.hostname });
            })
          : Effect.die("unexpected address alias"),
      aliasSet: () => Effect.die("unexpected aliasSet"),
      records: (id, { records, options }) =>
        Effect.suspend(() => {
          zone.options.push({ method: "records", options });
          return DnsRecords(id, { records });
        }),
    }),
  );

export interface AppRef extends Resource<
  "Test.AppRef",
  {},
  { appId: string; appEndpointDomain: string }
> {}
export const AppRef = Resource<AppRef>("Test.AppRef");

export const testFor = (cloud: UrlCloud, options: { dev?: boolean } = {}) =>
  Test.make({
    ...(options.dev ? { dev: true, sidecar: false } : {}),
    providers: Layer.effect(
      TestPrismaProviders,
      Provider.collection([...RoutingUrlResources, CustomDomain]),
    ).pipe(
      Layer.provideMerge(Layer.mergeAll(RoutingUrlProvider(), CustomDomainProvider())),
      Layer.provide(
        Layer.succeed(AuthoritativeRecordCheck, (expected, options) =>
          Effect.sync(() => {
            cloud.state.txtChecked.push(expected);
            cloud.state.txtAttempts.push(options.attempts);
            cloud.state.txtOptions.push(options);
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
          reconcile: () =>
            Effect.succeed({ appId: "svc-1", appEndpointDomain: "svc-1.us-east-1.prisma.build" }),
          delete: () => Effect.void,
        }),
      ),
      Layer.provide(
        Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
      ),
      Layer.provideMerge(Layer.succeed(Retry.Retry, DeployRetry.policy)),
      Layer.provideMerge(cloud.fake.layer),
    ),
  });

export const recordsFor = (hostname: string): DNS.DnsRecord[] => [
  { name: `_prisma-verification.${hostname}`, type: "TXT", value: TXT.value },
  { name: hostname, type: "CNAME", value: "switchboard.us-east-1.prisma.build" },
];
