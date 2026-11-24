import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import * as Prisma from "@alchemy.run/prisma";
import type { Compute } from "@alchemy.run/prisma/Compute";
import { CustomDomain } from "@alchemy.run/prisma/CustomDomain";
import { DomainOwnership } from "@alchemy.run/prisma/DomainOwnership";
import { RoutingUrl } from "@alchemy.run/prisma/RoutingUrl";
import type { WebsiteDomain } from "@alchemy.run/prisma/Website/FrameworkSite";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import {
  getDomainOwnership,
  getDomain,
  getProject,
  getServiceUrls,
  getWorkspaceDomainOwnerships,
  getService,
  getUrl,
} from "@distilled.cloud/prisma/management";
import { adopt } from "alchemy/AdoptPolicy";
import * as DNS from "alchemy/DNS/Adapter";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { ResourceLike } from "alchemy/Resource";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { DomainVerification } from "../../../../prisma/src/internal/DomainVerification.ts";
import { switchboardTarget } from "../../../../prisma/src/internal/Switchboard.ts";
import {
  RELEASED_ALIAS_ID,
  RELEASED_CUSTOM_DOMAIN_ID,
  WEBSITE_DOMAIN_OWNERSHIP_ID,
  WEBSITE_ROUTING_URL_ID,
  websiteDomain,
} from "../../../../prisma/src/internal/WebsiteDomain.ts";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { checkOnceThenPollUntilActive, waitForAuthoritativeCnames } from "../fixtures/Live.ts";
import {
  AppRef,
  cnameFor,
  makeUrlCloud,
  recordsFor,
  TEST_DNS,
  testFor,
  txtFor,
  type UrlCloud,
} from "../fixtures/RoutingUrlCloud.ts";

const SITE_HOST = "app.example.com";
const PROJECT = "proj-1";
const unitTags = [
  "unit",
  "provider:prisma",
  "provider:prisma:website",
  "provider:prisma:routingurl",
  "provider:prisma:domainownership",
];

/** The site's custom hostname, wired as `Prisma.Website` does. */
const siteDomain = (domain: WebsiteDomain) =>
  Effect.gen(function* () {
    const app = yield* AppRef("App", {});
    return yield* websiteDomain(domain, app as unknown as Compute, PROJECT).pipe(
      Namespace.push("Site"),
    );
  });

/** What the released Alchemy declared for a site's custom hostname. */
const releasedSiteDomain = (domain: WebsiteDomain) =>
  Effect.gen(function* () {
    const app = yield* AppRef("App", {});
    return yield* Effect.gen(function* () {
      const name = typeof domain === "string" ? domain : domain.name;
      const routing =
        typeof domain === "object" && domain.dns
          ? yield* (yield* DNS.resolve(domain.dns)).alias(RELEASED_ALIAS_ID, {
              name,
              target: { hostname: Output.map(app.appEndpointDomain, switchboardTarget) },
            })
          : undefined;
      return yield* CustomDomain(RELEASED_CUSTOM_DOMAIN_ID, {
        app: app.appId,
        hostname:
          routing === undefined ? name : Output.map(Output.of(routing as ResourceLike), () => name),
      });
    }).pipe(Namespace.push("Site"));
  });

const sharedOwnership = (domain: string, dns = true) =>
  DomainOwnership("Example", { project: PROJECT, domain, ...(dns ? { dns: TEST_DNS } : {}) });

const domainsRoutes = (cloud: UrlCloud) =>
  cloud.routes().filter((route) => / \/v1\/(services\/[^/]+\/)?domains/.test(route));
const ownershipWrites = (cloud: UrlCloud) =>
  cloud.routes().filter((route) => route.includes("domain-ownerships") && !route.startsWith("GET"));
const writes = (cloud: UrlCloud) => cloud.routes().filter((route) => !route.startsWith("GET"));
const OWNERSHIP_CREATE = "POST /v1/workspaces/ws-1/domain-ownerships";
const URL_CREATE = "POST /v1/services/svc-1/urls";
const byName = (records: ReadonlyArray<DNS.DnsRecord>) =>
  [...records].sort((a, b) => `${a.name}${a.type}`.localeCompare(`${b.name}${b.type}`));
const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined)),
  );
const warningsOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const warnings: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(message));
    });
    const result = yield* effect.pipe(Effect.provide(Logger.layer([logger])));
    return { result, warnings };
  });

const withDns = makeUrlCloud();
testFor(withDns).test.provider(
  "a site with domain and dns declares its domain ownership, publishes its TXT and CNAME, and saves the domain ownership before the RoutingUrl",
  (stack) =>
    Effect.gen(function* () {
      withDns.reset({ fromZone: true });
      yield* stack.destroy();
      withDns.state.throttle = [{ route: OWNERSHIP_CREATE, retryAfter: 1 }];

      const { url, ownership } = yield* stack.deploy(
        siteDomain({ name: SITE_HOST, dns: TEST_DNS }),
      );

      expect(url.status).toBe("active");
      expect(url.logicalId).toBe(`Site.${WEBSITE_ROUTING_URL_ID}`);
      expect(ownership.domain).toBe(SITE_HOST);
      expect(ownership.status).toBe("verified");
      expect([...withDns.ownerships.keys()]).toEqual([ownership.domainOwnershipId]);
      expect(byName(withDns.zone.records)).toEqual(byName(recordsFor(SITE_HOST)));
      expect(withDns.state.atOwnershipCreate.map(({ txtPublished }) => txtPublished)).toEqual([
        true,
      ]);
      const routes = withDns.routes();
      expect(routes.filter((route) => route === OWNERSHIP_CREATE)).toHaveLength(2);
      expect(routes.lastIndexOf(OWNERSHIP_CREATE)).toBeLessThan(routes.indexOf(URL_CREATE));
      expect(domainsRoutes(withDns)).toEqual([]);

      withDns.fake.captured.length = 0;
      yield* stack.deploy(siteDomain({ name: SITE_HOST, dns: TEST_DNS }));
      expect(writes(withDns)).toEqual([]);

      yield* stack.destroy();
      expect(withDns.zone.records).toEqual([]);
      expect(withDns.rows.size).toBe(0);
      expect(withDns.ownerships.size).toBe(0);
    }),
  { tags: unitTags },
);

const plain = makeUrlCloud();
testFor(plain).test.provider(
  "a site with a plain domain declares its domain ownership and a pending RoutingUrl, and publishes nothing",
  (stack) =>
    Effect.gen(function* () {
      plain.reset();
      yield* stack.destroy();
      plain.state.throttle = [{ route: OWNERSHIP_CREATE, retryAfter: 1 }];

      const { url, ownership } = yield* stack.deploy(siteDomain(SITE_HOST));

      expect(url.status).toBe("pending");
      expect(url.state).toBe("not_verified");
      expect(url.records.map((record) => record.type)).toEqual(["TXT", "CNAME"]);
      expect(ownership.status).toBe("unverified");
      const routes = plain.routes();
      expect(routes.lastIndexOf(OWNERSHIP_CREATE)).toBeLessThan(routes.indexOf(URL_CREATE));
      expect(plain.zone.publishes).toBe(0);
      expect(plain.zone.records).toEqual([]);
      expect(domainsRoutes(plain)).toEqual([]);

      yield* stack.destroy();
      expect(plain.ownerships.size).toBe(0);
    }),
  { tags: unitTags },
);

const shared = makeUrlCloud();
testFor(shared).test.provider(
  "sites given a domain ownership from the stack declare none of their own, and destroying them leaves it",
  (stack) =>
    Effect.gen(function* () {
      shared.reset({ fromZone: true });
      yield* stack.destroy();
      shared.state.throttle = [{ route: OWNERSHIP_CREATE, retryAfter: 1 }];
      const sites = Effect.gen(function* () {
        const example = yield* sharedOwnership("*.example.com");
        const app = yield* AppRef("App", {});
        const web = yield* websiteDomain(
          { name: SITE_HOST, dns: TEST_DNS, ownership: example },
          app as unknown as Compute,
          PROJECT,
        ).pipe(Namespace.push("Web"));
        const docs = yield* websiteDomain(
          { name: "docs.example.com", dns: TEST_DNS, ownership: example },
          app as unknown as Compute,
          PROJECT,
        ).pipe(Namespace.push("Docs"));
        return { example, web, docs };
      });

      const { example, web, docs } = yield* stack.deploy(sites);

      expect([...shared.ownerships.keys()]).toEqual([example.domainOwnershipId]);
      expect(web.ownership.domainOwnershipId).toBe(example.domainOwnershipId);
      expect(docs.url.status).toBe("active");
      expect(byName(shared.zone.records)).toEqual(
        byName([txtFor("*.example.com"), cnameFor(SITE_HOST), cnameFor("docs.example.com")]),
      );
      const routes = shared.routes();
      expect(routes.filter((route) => route === OWNERSHIP_CREATE)).toHaveLength(2);
      expect(routes.lastIndexOf(OWNERSHIP_CREATE)).toBeLessThan(routes.indexOf(URL_CREATE));

      yield* stack.deploy(sharedOwnership("*.example.com"));
      expect([...shared.ownerships.keys()]).toEqual([example.domainOwnershipId]);
      expect(shared.zone.records).toEqual([txtFor("*.example.com")]);
      expect(shared.rows.size).toBe(0);

      yield* stack.destroy();
      expect(shared.ownerships.size).toBe(0);
    }),
  { tags: unitTags },
);

const lookedUp = makeUrlCloud();
testFor(lookedUp).test.provider(
  "a site given a looked-up domain ownership writes no domain ownership and no TXT, and destroying it leaves the row",
  (stack) =>
    Effect.gen(function* () {
      lookedUp.reset({ fromZone: true });
      lookedUp.seedOwnership("*.example.com", "verified", "do-console");
      yield* stack.destroy();
      const site = siteDomain({
        name: SITE_HOST,
        dns: TEST_DNS,
        ownership: DomainOwnership.lookup({ project: PROJECT, domain: "*.example.com" }),
      });

      const { url, ownership } = yield* stack.deploy(site);

      expect(ownership.domainOwnershipId).toBe("do-console");
      expect(url.status).toBe("active");
      expect(ownershipWrites(lookedUp)).toEqual([]);
      expect(lookedUp.zone.records).toEqual([cnameFor(SITE_HOST)]);

      yield* stack.destroy();
      expect([...lookedUp.ownerships.keys()]).toEqual(["do-console"]);
      expect(lookedUp.rows.size).toBe(0);
    }),
  { tags: unitTags },
);

const mismatchedLookup = makeUrlCloud();
testFor(mismatchedLookup).test.provider(
  "a site whose looked-up domain ownership does not cover its hostname stops before any write",
  (stack) =>
    Effect.gen(function* () {
      mismatchedLookup.reset({ fromZone: true });
      mismatchedLookup.seedOwnership("example.com", "verified", "do-apex");
      yield* stack.destroy();

      const failure = yield* failureOf(
        stack.deploy(
          siteDomain({
            name: SITE_HOST,
            dns: TEST_DNS,
            ownership: DomainOwnership.lookup({ project: PROJECT, domain: "example.com" }),
          }),
        ),
      );

      expect(failure).toContain("WebsiteDomainOwnershipMismatch");
      expect(failure).toContain("a wildcard does not cover its apex");
      expect(writes(mismatchedLookup)).toEqual([]);
      expect(mismatchedLookup.zone.publishes).toBe(0);

      yield* stack.destroy();
    }),
  { tags: unitTags },
);

const mismatchedShared = makeUrlCloud();
testFor(mismatchedShared).test.provider(
  "a site whose domain ownership from the stack does not cover its hostname stops before its CNAME and RoutingUrl are written",
  (stack) =>
    Effect.gen(function* () {
      mismatchedShared.reset({ fromZone: true });
      yield* stack.destroy();

      const failure = yield* failureOf(
        stack.deploy(
          Effect.gen(function* () {
            const other = yield* sharedOwnership("*.other.com");
            return yield* siteDomain({ name: SITE_HOST, dns: TEST_DNS, ownership: other });
          }),
        ),
      );

      expect(failure).toContain("WebsiteDomainOwnershipMismatch");
      expect(mismatchedShared.routes()).not.toContain(URL_CREATE);
      expect(mismatchedShared.zone.records).toEqual([txtFor("*.other.com")]);

      yield* stack.destroy();
      expect(mismatchedShared.zone.records).toEqual([]);
    }),
  { tags: unitTags },
);

const apex = makeUrlCloud();
testFor(apex).test.provider(
  "an apex site given an apex domain ownership without dns, next to a wildcard with dns, leaves the shared TXT to the wildcard",
  (stack) =>
    Effect.gen(function* () {
      apex.reset({ fromZone: true });
      yield* stack.destroy();
      const wildcard = DomainOwnership("Wildcard", {
        project: PROJECT,
        domain: "*.example.com",
        dns: TEST_DNS,
      });

      const { site } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* wildcard;
          const apexOwnership = yield* DomainOwnership("Apex", {
            project: PROJECT,
            domain: "example.com",
          });
          const site = yield* siteDomain({
            name: "example.com",
            dns: TEST_DNS,
            ownership: apexOwnership,
          });
          return { site };
        }),
      );

      expect(site.url.hostname).toBe("example.com");
      expect(apex.zone.records.filter((record) => record.type === "TXT")).toEqual([
        txtFor("example.com"),
      ]);

      yield* stack.deploy(wildcard);
      expect(apex.zone.records).toEqual([txtFor("*.example.com")]);
      expect(apex.zone.removed.filter((record) => record.type === "TXT")).toEqual([]);

      yield* stack.destroy();
      expect(apex.zone.records).toEqual([]);
    }),
  { tags: unitTags },
);

const switched = makeUrlCloud();
testFor(switched).test.provider(
  "a serving site switched to a verified wildcard and back keeps serving, and leaves the expected rows and records",
  (stack) =>
    Effect.gen(function* () {
      switched.reset({ fromZone: true });
      yield* stack.destroy();
      const standalone = siteDomain({ name: SITE_HOST, dns: TEST_DNS });
      const own = yield* stack.deploy(standalone);
      expect(own.url.status).toBe("active");

      const onWildcard = yield* stack.deploy(
        Effect.gen(function* () {
          const example = yield* sharedOwnership("*.example.com");
          return yield* siteDomain({ name: SITE_HOST, dns: TEST_DNS, ownership: example });
        }),
      );

      expect([...switched.ownerships.keys()]).toEqual([onWildcard.ownership.domainOwnershipId]);
      expect(byName(switched.zone.records)).toEqual(
        byName([txtFor("*.example.com"), cnameFor(SITE_HOST)]),
      );
      expect(switched.rows.get(own.url.routingUrlId)?.status).toBe("active");

      const back = yield* stack.deploy(
        Effect.gen(function* () {
          yield* sharedOwnership("*.example.com");
          return yield* siteDomain({ name: SITE_HOST, dns: TEST_DNS });
        }),
      );

      expect([...switched.ownerships.keys()].sort()).toEqual(
        [onWildcard.ownership.domainOwnershipId, back.ownership.domainOwnershipId].sort(),
      );
      expect(byName(switched.zone.records)).toEqual(
        byName([txtFor("*.example.com"), ...recordsFor(SITE_HOST)]),
      );
      expect(switched.rows.get(own.url.routingUrlId)?.status).toBe("active");

      yield* stack.destroy();
      expect(switched.ownerships.size).toBe(0);
      expect(switched.zone.records).toEqual([]);
    }),
  { tags: unitTags },
);

const unverified = makeUrlCloud();
testFor(unverified).test.provider(
  "a serving site switched to an unverified domain ownership warns once, and stops serving once its own is deleted",
  (stack) =>
    Effect.gen(function* () {
      unverified.reset({ fromZone: true });
      yield* stack.destroy();
      const own = yield* stack.deploy(siteDomain({ name: SITE_HOST, dns: TEST_DNS }));
      unverified.seedOwnership("*.example.com", "unverified", "do-console");

      const { warnings } = yield* warningsOf(
        stack.deploy(
          siteDomain({
            name: SITE_HOST,
            dns: TEST_DNS,
            ownership: DomainOwnership.lookup({ project: PROJECT, domain: "*.example.com" }),
          }),
        ),
      );

      expect(warnings).toEqual([
        `The domain ownership of '*.example.com' is unverified, so '${SITE_HOST}' serves only once Prisma verifies it.`,
      ]);
      expect([...unverified.ownerships.keys()]).toEqual(["do-console"]);
      expect(unverified.rows.get(own.url.routingUrlId)?.status).toBe("pending");
      expect(unverified.zone.records).toEqual([cnameFor(SITE_HOST)]);

      yield* stack.destroy();
    }),
  { tags: unitTags },
);

for (const withRecords of [true, false]) {
  const domain: WebsiteDomain = withRecords ? { name: SITE_HOST, dns: TEST_DNS } : SITE_HOST;
  const how = withRecords ? "with dns" : "without dns";

  const refused = makeUrlCloud();
  testFor(refused).test.provider(
    `${how}, a released site whose workspace has a domain ownership for its hostname is refused while planning, and deploys with it looked up`,
    (stack) =>
      Effect.gen(function* () {
        refused.reset({ fromZone: true });
        yield* stack.destroy();
        yield* stack.deploy(releasedSiteDomain(domain));
        refused.seedOwnership(SITE_HOST, "verified", "do-backfill");
        const [customDomain] = Array.from(refused.domains.keys());

        refused.fake.captured.length = 0;
        const failure = yield* failureOf(stack.deploy(siteDomain(domain)));

        expect(failure).toContain("Cannot adopt resource");
        expect(failure).toContain(
          withRecords ? "(Prisma.DomainVerification)" : "(Prisma.DomainOwnership)",
        );
        expect(writes(refused)).toEqual([]);
        expect(refused.domains.has(customDomain!)).toBe(true);

        const looked = yield* stack.deploy(
          siteDomain({
            name: SITE_HOST,
            ...(withRecords ? { dns: TEST_DNS } : {}),
            ownership: DomainOwnership.lookup({ project: PROJECT, domain: SITE_HOST }),
          }),
        );
        expect(looked.ownership.domainOwnershipId).toBe("do-backfill");
        expect(ownershipWrites(refused)).toEqual([]);

        yield* stack.destroy();
        expect([...refused.ownerships.keys()]).toEqual(["do-backfill"]);
      }),
    { tags: unitTags },
  );

  const adopted = makeUrlCloud();
  testFor(adopted).test.provider(
    `${how}, a released site adopted with adopt(true) on the site takes the existing domain ownership, and destroying it deletes the row`,
    (stack) =>
      Effect.gen(function* () {
        adopted.reset({ fromZone: true });
        yield* stack.destroy();
        yield* stack.deploy(releasedSiteDomain(domain));
        adopted.seedOwnership(SITE_HOST, "verified", "do-backfill");

        const taken = yield* stack.deploy(siteDomain(domain).pipe(adopt(true)));

        expect(taken.ownership.domainOwnershipId).toBe("do-backfill");
        expect(adopted.routes()).not.toContain(OWNERSHIP_CREATE);

        yield* stack.deploy(siteDomain(domain));
        yield* stack.destroy();
        expect(adopted.routes()).toContain("DELETE /v1/domain-ownerships/do-backfill");
        expect(adopted.ownerships.size).toBe(0);
      }),
    { tags: unitTags },
  );
}

const upgrade = makeUrlCloud();
testFor(upgrade).test.provider(
  "a site deployed by the released Alchemy keeps one row and its CNAME through the upgrade",
  (stack) =>
    Effect.gen(function* () {
      upgrade.reset();
      yield* stack.destroy();
      const domain = { name: SITE_HOST, dns: TEST_DNS };
      yield* stack.deploy(releasedSiteDomain(domain));
      const [recorded] = Array.from(upgrade.rows.values());
      const [customDomain] = Array.from(upgrade.domains.keys());
      expect(recorded?.logicalId).toBe(null);
      expect(upgrade.zone.records).toEqual([cnameFor(SITE_HOST)]);

      upgrade.fake.captured.length = 0;
      const { url } = yield* stack.deploy(siteDomain(domain));

      expect(url.routingUrlId).toBe(recorded?.id);
      expect(Array.from(upgrade.rows.keys())).toEqual([recorded?.id]);
      expect(upgrade.rows.get(recorded!.id)?.logicalId).toBe(`Site.${WEBSITE_ROUTING_URL_ID}`);
      expect(upgrade.domains.has(customDomain!)).toBe(true);
      expect(upgrade.routes().filter((route) => route.startsWith("DELETE"))).toEqual([]);
      expect(byName(upgrade.zone.records)).toEqual(byName(recordsFor(SITE_HOST)));
      expect(upgrade.zone.removed).toEqual([]);

      yield* stack.destroy();
      expect(upgrade.zone.records).toEqual([]);
    }),
  { tags: unitTags },
);

const plainUpgrade = makeUrlCloud();
testFor(plainUpgrade).test.provider(
  "a site with a plain domain keeps its one row through the upgrade",
  (stack) =>
    Effect.gen(function* () {
      plainUpgrade.reset();
      yield* stack.destroy();
      yield* stack.deploy(releasedSiteDomain(SITE_HOST));
      const [recorded] = Array.from(plainUpgrade.rows.values());

      plainUpgrade.fake.captured.length = 0;
      const { url } = yield* stack.deploy(siteDomain(SITE_HOST));

      expect(url.routingUrlId).toBe(recorded?.id);
      expect(Array.from(plainUpgrade.rows.keys())).toEqual([recorded?.id]);
      expect(plainUpgrade.domains.size).toBe(1);
      expect(plainUpgrade.routes().filter((route) => route.startsWith("DELETE"))).toEqual([]);

      yield* stack.destroy();
    }),
  { tags: unitTags },
);

const hostnameChange = makeUrlCloud();
testFor(hostnameChange).test.provider(
  "a serving site's hostname change passes in one deploy, with the new TXT in place at the update and the old domain ownership deleted after it",
  (stack) =>
    Effect.gen(function* () {
      hostnameChange.reset({ fromZone: true });
      yield* stack.destroy();
      const first = yield* stack.deploy(siteDomain({ name: SITE_HOST, dns: TEST_DNS }));
      expect(first.url.status).toBe("active");

      hostnameChange.fake.captured.length = 0;
      hostnameChange.state.throttle = [{ route: OWNERSHIP_CREATE, retryAfter: 1 }];
      const moved = yield* stack.deploy(siteDomain({ name: "new.example.com", dns: TEST_DNS }));

      expect(moved.url.routingUrlId).toBe(first.url.routingUrlId);
      expect(moved.url.hostname).toBe("new.example.com");
      expect(moved.ownership.domain).toBe("new.example.com");
      expect(hostnameChange.state.zoneAtPatch).toEqual(
        expect.arrayContaining([txtFor("new.example.com"), cnameFor("new.example.com")]),
      );
      const routes = hostnameChange.routes();
      const patch = routes.indexOf(`PATCH /v1/urls/${first.url.routingUrlId}`);
      expect(patch).toBeGreaterThanOrEqual(0);
      expect(routes.lastIndexOf(OWNERSHIP_CREATE)).toBeLessThan(patch);
      expect(
        routes.indexOf(`DELETE /v1/domain-ownerships/${first.ownership.domainOwnershipId}`),
      ).toBeGreaterThan(patch);
      expect([...hostnameChange.ownerships.keys()]).toEqual([moved.ownership.domainOwnershipId]);
      expect(byName(hostnameChange.zone.records)).toEqual(byName(recordsFor("new.example.com")));

      yield* stack.destroy();
      expect(hostnameChange.zone.records).toEqual([]);
      expect(hostnameChange.ownerships.size).toBe(0);
    }),
  { tags: unitTags },
);

const siteChange = makeUrlCloud();
testFor(siteChange).test.provider(
  "a refused hostname change with dns leaves the serving hostname's records published",
  (stack) =>
    Effect.gen(function* () {
      siteChange.reset({ fromZone: true });
      yield* stack.destroy();
      yield* stack.deploy(siteDomain({ name: SITE_HOST, dns: TEST_DNS }));

      siteChange.state.txt = "absent";
      siteChange.state.verifiesAs = "unverified";
      siteChange.fake.captured.length = 0;
      const refused = yield* stack
        .deploy(siteDomain({ name: "new.example.com", dns: TEST_DNS }))
        .pipe(Effect.flip);

      expect(String(refused)).toContain("RoutingUrlHostnameChangeRefused");
      expect(siteChange.routes().some((route) => route.startsWith("PATCH"))).toBe(false);
      expect(siteChange.zone.records).toEqual(expect.arrayContaining(recordsFor(SITE_HOST)));
      expect(siteChange.zone.removed).toEqual([]);

      siteChange.state.txt = undefined;
      siteChange.state.verifiesAs = undefined;
      const moved = yield* stack.deploy(siteDomain({ name: "new.example.com", dns: TEST_DNS }));
      expect(moved.url.hostname).toBe("new.example.com");
      expect(byName(siteChange.zone.records)).toEqual(byName(recordsFor("new.example.com")));

      yield* stack.destroy();
      expect(siteChange.zone.records).toEqual([]);
    }),
  { tags: unitTags },
);

for (const retained of [true, false]) {
  const movedOut = makeUrlCloud();
  testFor(movedOut).test.provider(
    retained
      ? "a site's own domain ownership moves to the stack, keeping its row, after one deploy of the site with RemovalPolicy.retain()"
      : "a site's own domain ownership adopted by the stack without RemovalPolicy.retain() is deleted after the adoption",
    (stack) =>
      Effect.gen(function* () {
        movedOut.reset({ fromZone: true });
        yield* stack.destroy();
        const standalone = siteDomain({ name: SITE_HOST, dns: TEST_DNS });
        const own = yield* stack.deploy(standalone);
        if (retained) yield* stack.deploy(standalone.pipe(RemovalPolicy.retain()));

        yield* stack.deploy(
          Effect.gen(function* () {
            const moved = yield* sharedOwnership(SITE_HOST).pipe(adopt(true));
            return yield* siteDomain({ name: SITE_HOST, dns: TEST_DNS, ownership: moved });
          }),
        );

        if (retained) {
          expect([...movedOut.ownerships.keys()]).toEqual([own.ownership.domainOwnershipId]);
          expect(byName(movedOut.zone.records)).toEqual(byName(recordsFor(SITE_HOST)));
          expect(movedOut.rows.get(own.url.routingUrlId)?.status).toBe("active");
        } else {
          expect(movedOut.routes()).toContain(
            `DELETE /v1/domain-ownerships/${own.ownership.domainOwnershipId}`,
          );
          expect(movedOut.ownerships.size).toBe(0);
        }

        yield* stack.destroy();
        expect(movedOut.ownerships.size).toBe(0);
        expect(movedOut.rows.size).toBe(0);
        expect(movedOut.zone.records).toEqual([]);
      }),
    { tags: unitTags },
  );
}

const aliasDropped = makeUrlCloud();
testFor(aliasDropped).test.provider(
  "a later release that stops declaring the alias keeps the CNAME published",
  (stack) =>
    Effect.gen(function* () {
      aliasDropped.reset({ fromZone: true });
      yield* stack.destroy();
      yield* stack.deploy(siteDomain({ name: SITE_HOST, dns: TEST_DNS }));

      yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* AppRef("App", {});
          return yield* Effect.gen(function* () {
            yield* DomainOwnership(WEBSITE_DOMAIN_OWNERSHIP_ID, {
              project: PROJECT,
              domain: SITE_HOST,
              dns: TEST_DNS,
            });
            return yield* RoutingUrl(WEBSITE_ROUTING_URL_ID, {
              app: app.appId,
              hostname: SITE_HOST,
              dns: TEST_DNS,
            });
          }).pipe(Namespace.push("Site"));
        }),
      );

      expect(byName(aliasDropped.zone.records)).toEqual(byName(recordsFor(SITE_HOST)));
      expect(aliasDropped.zone.removed).toEqual([]);

      yield* stack.destroy();
      expect(aliasDropped.zone.records).toEqual([]);
    }),
  { tags: unitTags },
);

const proxied = makeUrlCloud();
testFor(proxied).test.provider(
  "a site publishes its records DNS-only when the DNS host is set to proxy aliases",
  (stack) =>
    Effect.gen(function* () {
      proxied.reset({ fromZone: true });
      yield* stack.destroy();

      yield* stack.deploy(
        siteDomain({ name: SITE_HOST, dns: { ...TEST_DNS, options: { proxied: true } } }),
      );

      expect(proxied.zone.options.map(({ method }) => method).sort()).toEqual([
        "alias",
        "records",
        "records",
      ]);
      // `records` is always DNS-only by the adapter contract; the alias is
      // declared without `proxied`.
      const alias = proxied.zone.options.find(({ method }) => method === "alias");
      expect(alias?.options?.proxied).toBe(undefined);

      yield* stack.destroy();
    }),
  { tags: unitTags },
);

const notTakenOver = makeUrlCloud();
testFor(notTakenOver).test.provider(
  "a CustomDomain whose row no RoutingUrl took over is still deleted",
  (stack) =>
    Effect.gen(function* () {
      notTakenOver.reset();
      yield* stack.destroy();
      yield* stack.deploy(releasedSiteDomain(SITE_HOST));
      const [customDomain] = Array.from(notTakenOver.domains.keys());

      yield* stack.destroy();

      expect(notTakenOver.routes()).toContain(`DELETE /v1/domains/${customDomain}`);
      expect(notTakenOver.domains.size).toBe(0);
      expect(notTakenOver.rows.size).toBe(0);
    }),
  { tags: unitTags },
);

const { test } = Test.make({
  providers: Layer.mergeAll(Prisma.providers(), Cloudflare.providers()),
});

const ZONE = "alchemy-test-2.us";
const MARKER = "StaticSite fixture v1";

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../Cloudflare/Website/staticsite-fixture",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

class SiteNotServing extends Data.TaggedError("SiteNotServing")<{
  readonly status: number;
}> {}

const trimDot = (value: string) => value.replace(/\.$/, "").toLowerCase();

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: ZONE });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${ZONE}" not found`));
  }
  return zone.id;
});

/** Every Cloudflare record at or below `hostname`. */
const recordsUnder = (zoneId: string, hostname: string) =>
  dns.listRecords.items({ zoneId, name: { endswith: hostname } }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).filter(
        (record) =>
          trimDot(record.name) === hostname || trimDot(record.name).endsWith(`.${hostname}`),
      ),
    ),
  );

const routingUrlGone = (id: string) =>
  getUrl({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

/** The app's regional switchboard, the CNAME target Prisma verifies. */
const switchboardOf = (appEndpointDomain: string | undefined) =>
  `switchboard${(appEndpointDomain ?? "").slice((appEndpointDomain ?? "").indexOf("."))}`;

test.provider.skipIf(process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS !== "true")(
  "Cloudflare DNS publishes a site's TXT and CNAME; the hostname activates and serves HTTPS",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const HOSTNAME = `prisma-dns-${stack.stage.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.${ZONE}`;
      const zoneId = yield* resolveZoneId;
      const cwd = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-prisma-dns-",
        tempRoot,
        entries: ["src", "build.sh"],
      });

      const site = yield* stack.deploy(
        Prisma.Website.StaticSite("Site", {
          cwd,
          command: "bash build.sh",
          shell: true,
          outdir: "dist",
          domain: { name: HOSTNAME, dns: Cloudflare.DNS.Adapter() },
        }),
      );
      expect(site.url).toBe(`https://${HOSTNAME}`);
      const domain = site.domain!;
      const projectId = typeof site.project === "string" ? site.project : site.project!.projectId;
      expect(domain.hostname).toBe(HOSTNAME);
      expect(domain.serviceId).toBe(site.compute!.appId);

      const switchboard = switchboardOf(site.compute!.appEndpointDomain);
      const all = yield* recordsUnder(zoneId, HOSTNAME);
      expect(
        all
          .map((record) => ({
            name: trimDot(record.name),
            type: record.type,
            value:
              record.type === "TXT"
                ? (record.content ?? "").replaceAll('"', "")
                : trimDot(record.content ?? ""),
          }))
          .sort((a, b) => a.type.localeCompare(b.type)),
      ).toEqual([
        { name: HOSTNAME, type: "CNAME", value: switchboard },
        {
          name: `_prisma-verification.${HOSTNAME}`,
          type: "TXT",
          value: expect.stringMatching(/^prisma-verification=[0-9a-f]{64}$/),
        },
      ]);
      expect(all.every((record) => record.proxied !== true)).toBe(true);

      expect(domain.status).toBe("active");
      expect(site.domainOwnership!.domain).toBe(HOSTNAME);

      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(`https://${HOSTNAME}/`).pipe(
        Effect.flatMap(
          (res): Effect.Effect<string, HttpClientError.HttpClientError | SiteNotServing> =>
            res.status === 200 ? res.text : Effect.fail(new SiteNotServing({ status: res.status })),
        ),
        Effect.timeout("10 seconds"),
        Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
      );
      expect(body).toContain(MARKER);

      // Read before destroy deletes the project the lookup goes through.
      const workspaceId = (yield* getProject({ id: projectId })).data.workspace.id;
      yield* stack.destroy();

      expect(yield* recordsUnder(zoneId, HOSTNAME)).toEqual([]);
      expect(yield* routingUrlGone(domain.routingUrlId)).toBe("gone");
      // The site declared this domain ownership, so destroy deletes it.
      const ownerships = (yield* getWorkspaceDomainOwnerships({ workspaceId, domain: HOSTNAME }))
        .data;
      expect(ownerships.filter((ownership) => ownership.domain === HOSTNAME)).toEqual([]);
      expect(
        yield* getProject({ id: projectId }).pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        ),
      ).toBe("gone");
    }),
  {
    tags: [
      "provider:prisma",
      "provider:prisma:routingurl",
      "provider:prisma:website",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "live",
    ],
    timeout: 900_000,
  },
);

test.provider.skipIf(process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS !== "true")(
  "a site with a plain domain on a non-default Branch deploys pending and serves once its records are published",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneId = yield* resolveZoneId;
      const hostname = `prisma-preview-${stack.stage.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.${ZONE}`;
      const cwd = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-prisma-preview-dns-",
        tempRoot,
        entries: ["src", "build.sh"],
      });

      const branchStack = Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const branch = yield* Prisma.Branch("Preview", { project, gitName: "preview" });
        return { project, branch };
      });
      // The Branch exists before the site resolves it by git name.
      yield* stack.deploy(branchStack);

      const siteStack = (records: ReadonlyArray<{ type: string; name: string; value: string }>) =>
        Effect.gen(function* () {
          const { project, branch } = yield* branchStack;
          const site = yield* Prisma.Website.StaticSite("Site", {
            cwd,
            command: "bash build.sh",
            shell: true,
            outdir: "dist",
            project,
            branchGitName: "preview",
            domain: hostname,
          });
          for (const record of records) {
            yield* Cloudflare.DNS.Record(`Domain${record.type}`, {
              zoneId,
              name: record.name,
              type: record.type === "TXT" ? "TXT" : "CNAME",
              content: record.value,
              ...(record.type === "TXT" ? {} : { proxied: false }),
            });
          }
          return { project, branch, site };
        });

      // DNS is not ready: the deploy still succeeds and names the records.
      const pending = yield* stack.deploy(siteStack([]));
      const domain = pending.site.domain!;
      expect(domain.status).toBe("pending");
      expect(domain.records.map((record) => record.type).sort()).toEqual(["CNAME", "TXT"]);
      expect(pending.branch.isDefault).toBe(false);
      const app = yield* getService({ serviceId: pending.site.compute!.appId });
      expect(app.data.branchId).toBe(pending.branch.branchId);

      yield* stack.deploy(siteStack(domain.records));
      yield* waitForAuthoritativeCnames(
        ZONE,
        domain.records.filter((record) => record.type === "CNAME"),
      );
      expect((yield* checkOnceThenPollUntilActive(domain.routingUrlId)).status).toBe("active");

      yield* stack.destroy();

      expect(yield* routingUrlGone(domain.routingUrlId)).toBe("gone");
      expect(
        yield* getProject({ id: pending.project.projectId }).pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        ),
      ).toBe("gone");
      expect(yield* recordsUnder(zoneId, hostname)).toEqual([]);
    }),
  {
    tags: [
      "provider:prisma",
      "provider:prisma:routingurl",
      "provider:prisma:branch",
      "provider:prisma:website",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "live",
    ],
    timeout: 900_000,
  },
);

test.provider.skipIf(process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS !== "true")(
  "a site deployed with the released domain wiring keeps one row and its records through the upgrade",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneId = yield* resolveZoneId;
      const hostname = `prisma-upgrade-${stack.stage.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.${ZONE}`;
      const cwd = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-prisma-upgrade-",
        tempRoot,
        entries: ["src", "build.sh"],
      });
      const siteProps = { cwd, command: "bash build.sh", shell: true, outdir: "dist" };
      // Prisma has required the ownership TXT for a new custom domain since
      // 2026-10-24; it stays declared in both deploys, outside the site.
      const ownershipTxt = (site: Prisma.Website.Website) =>
        Effect.gen(function* () {
          const verification = yield* DomainVerification("Verification", {
            project: site.project as Prisma.Project,
            domain: hostname,
          });
          return yield* Cloudflare.DNS.Record("OwnershipTxt", {
            zoneId,
            name: verification.recordName,
            type: "TXT",
            content: verification.recordValue,
          });
        });

      // What the released Alchemy declared for `domain: { name, dns }`.
      const released = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Prisma.Website.StaticSite("Site", siteProps);
          const txt = yield* ownershipTxt(site);
          const compute = site.compute!;
          return yield* Effect.gen(function* () {
            const alias = yield* (yield* DNS.resolve(Cloudflare.DNS.Adapter())).alias(
              RELEASED_ALIAS_ID,
              {
                name: hostname,
                target: { hostname: Output.map(compute.appEndpointDomain, switchboardTarget) },
              },
            );
            const customDomain = yield* CustomDomain(RELEASED_CUSTOM_DOMAIN_ID, {
              app: compute,
              hostname: Output.map(
                Output.all(Output.of(alias as ResourceLike), Output.of(txt as ResourceLike)),
                () => hostname,
              ),
            });
            return { site, customDomain };
          }).pipe(Namespace.push("Site"));
        }),
      );
      const appId = released.site.compute!.appId;
      const rowsFor = getServiceUrls({ serviceId: appId }).pipe(
        Effect.map(({ data }) => data.filter((row) => trimDot(row.hostname) === hostname)),
      );
      const [recorded] = yield* rowsFor;
      expect(recorded?.logicalId).toBe(null);

      const upgraded = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Prisma.Website.StaticSite("Site", {
            ...siteProps,
            domain: {
              name: hostname,
              dns: Cloudflare.DNS.Adapter(),
              ownership: Prisma.DomainOwnership.lookup({
                project: { projectId: released.site.compute!.projectId },
                domain: hostname,
              }),
            },
          });
          yield* ownershipTxt(site);
          return site;
        }),
      );

      expect(upgraded.domain!.routingUrlId).toBe(recorded!.id);
      expect((yield* rowsFor).map((row) => row.id)).toEqual([recorded!.id]);
      expect(
        (yield* getDomain({ domainId: released.customDomain.customDomainId })).data.hostname,
      ).toBe(hostname);
      const published = yield* recordsUnder(zoneId, hostname);
      expect(published.map((record) => record.type).sort()).toEqual(["CNAME", "TXT"]);

      yield* stack.destroy();
      expect(yield* routingUrlGone(recorded!.id)).toBe("gone");
      expect(yield* recordsUnder(zoneId, hostname)).toEqual([]);
    }),
  {
    tags: [
      "provider:prisma",
      "provider:prisma:routingurl",
      "provider:prisma:customdomain",
      "provider:prisma:website",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "live",
    ],
    timeout: 900_000,
  },
);

test.provider.skipIf(process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS !== "true")(
  "Prisma.DomainOwnership proves a hostname that a CustomDomain then attaches",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneId = yield* resolveZoneId;
      const hostname = `prisma-owned-${stack.stage.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.${ZONE}`;
      const cwd = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-prisma-ownership-",
        tempRoot,
        entries: ["src", "build.sh"],
      });

      const { project, site, ownership, domain } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Prisma.Project("Project", { createDatabase: false });
          const site = yield* Prisma.Website.StaticSite("Site", {
            cwd,
            command: "bash build.sh",
            shell: true,
            outdir: "dist",
            project,
          });
          const ownership = yield* Prisma.DomainOwnership("Ownership", {
            project,
            domain: hostname,
            dns: Cloudflare.DNS.Adapter(),
          });
          yield* Cloudflare.DNS.Record("DomainAlias", {
            zoneId,
            name: hostname,
            type: "CNAME",
            content: Output.map(site.compute!.appEndpointDomain, switchboardOf),
            proxied: false,
          });
          const domain = yield* Prisma.CustomDomain("Domain", {
            app: site.compute!,
            hostname,
            ownership,
          });
          return { project, site, ownership, domain };
        }),
      );

      expect(ownership.domain).toBe(hostname);
      expect(ownership.recordName).toBe(`_prisma-verification.${hostname}`);
      expect(ownership.recordValue).toMatch(/^prisma-verification=[0-9a-f]{64}$/);
      const recorded = yield* getDomainOwnership({
        domainOwnershipId: ownership.domainOwnershipId,
      });
      expect(recorded.data.domain).toBe(hostname);
      expect(recorded.data.workspaceId).toBe(project.workspaceId);
      expect(ownership.status).toBe("verified");
      expect(recorded.data.status).toBe("verified");

      const published = yield* dns.listRecords
        .items({ zoneId, name: { exact: ownership.recordName } })
        .pipe(Stream.runCollect);
      expect(Array.from(published).map((record) => record.content?.replaceAll('"', ""))).toEqual([
        ownership.recordValue,
      ]);

      const registered = yield* getDomain({ domainId: domain.customDomainId });
      expect(registered.data.appId).toBe(site.compute!.appId);
      expect(trimDot(registered.data.hostname)).toBe(hostname);

      // Redeploying unchanged proves nothing again.
      const plan = yield* stack.plan(
        Effect.gen(function* () {
          const project = yield* Prisma.Project("Project", { createDatabase: false });
          const site = yield* Prisma.Website.StaticSite("Site", {
            cwd,
            command: "bash build.sh",
            shell: true,
            outdir: "dist",
            project,
          });
          const ownership = yield* Prisma.DomainOwnership("Ownership", {
            project,
            domain: hostname,
            dns: Cloudflare.DNS.Adapter(),
          });
          yield* Cloudflare.DNS.Record("DomainAlias", {
            zoneId,
            name: hostname,
            type: "CNAME",
            content: Output.map(site.compute!.appEndpointDomain, switchboardOf),
            proxied: false,
          });
          yield* Prisma.CustomDomain("Domain", { app: site.compute!, hostname, ownership });
        }),
      );
      expect(plan.resources["Ownership/Ownership"]?.action).toBe("noop");

      yield* stack.destroy();

      expect(
        yield* getDomainOwnership({ domainOwnershipId: ownership.domainOwnershipId }).pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        ),
      ).toBe("gone");
      expect(
        yield* getDomain({ domainId: domain.customDomainId }).pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        ),
      ).toBe("gone");
      const leftover = yield* Effect.forEach([hostname, ownership.recordName], (name) =>
        dns.listRecords.items({ zoneId, name: { exact: name } }).pipe(Stream.runCollect),
      );
      expect(leftover.flatMap((records) => Array.from(records))).toEqual([]);
    }),
  {
    tags: [
      "provider:prisma",
      "provider:prisma:customdomain",
      "provider:prisma:domainownership",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "live",
    ],
    timeout: 900_000,
  },
);
