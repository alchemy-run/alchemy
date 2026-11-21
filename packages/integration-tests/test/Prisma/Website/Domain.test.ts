import { resolve4, resolveNs, Resolver } from "node:dns/promises";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import * as Prisma from "@alchemy.run/prisma";
import type { Compute } from "@alchemy.run/prisma/Compute";
import { CustomDomain } from "@alchemy.run/prisma/CustomDomain";
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
import * as DNS from "alchemy/DNS/Adapter";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { DomainVerification } from "../../../../prisma/src/internal/DomainVerification.ts";
import { switchboardTarget } from "../../../../prisma/src/internal/Switchboard.ts";
import {
  RELEASED_ALIAS_ID,
  RELEASED_CUSTOM_DOMAIN_ID,
  WEBSITE_ROUTING_URL_ID,
  websiteDomain,
} from "../../../../prisma/src/internal/WebsiteDomain.ts";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { checkOnceThenPollUntilActive } from "../fixtures/Live.ts";
import {
  AppRef,
  makeUrlCloud,
  recordsFor,
  routingUrl,
  TEST_DNS,
  testFor,
  type UrlCloud,
} from "../fixtures/RoutingUrlCloud.ts";

const SITE_HOST = "app.example.com";
const unitTags = [
  "unit",
  "provider:prisma",
  "provider:prisma:website",
  "provider:prisma:routingurl",
];

/** The site's custom hostname, wired as `Prisma.Website` does. */
const siteDomain = (domain: WebsiteDomain) =>
  Effect.gen(function* () {
    const app = yield* AppRef("App", {});
    return yield* websiteDomain(domain, app as unknown as Compute).pipe(Namespace.push("Site"));
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

const domainsRoutes = (cloud: UrlCloud) =>
  cloud.routes().filter((route) => / \/v1\/(services\/[^/]+\/)?domains/.test(route));
const ownershipWrites = (cloud: UrlCloud) =>
  cloud.routes().filter((route) => route.includes("domain-ownerships") && !route.startsWith("GET"));
const byName = (records: ReadonlyArray<DNS.DnsRecord>) =>
  [...records].sort((a, b) => `${a.name}${a.type}`.localeCompare(`${b.name}${b.type}`));

const withDns = makeUrlCloud();
testFor(withDns).test.provider(
  "a site with domain and dns publishes its TXT and CNAME and deploys once its RoutingUrl serves",
  (stack) =>
    Effect.gen(function* () {
      withDns.reset({ fromZone: true });
      yield* stack.destroy();

      const url = yield* stack.deploy(siteDomain({ name: SITE_HOST, dns: TEST_DNS }));

      expect(url.status).toBe("active");
      expect(url.logicalId).toBe(`Site/${WEBSITE_ROUTING_URL_ID}`);
      expect(byName(withDns.zone.records)).toEqual(byName(recordsFor(SITE_HOST)));
      expect(domainsRoutes(withDns)).toEqual([]);
      expect(ownershipWrites(withDns)).toEqual([]);

      yield* stack.destroy();
      expect(withDns.zone.records).toEqual([]);
      expect(withDns.rows.size).toBe(0);
    }),
  { tags: unitTags },
);

const plain = makeUrlCloud();
testFor(plain).test.provider(
  "a site with a plain domain saves a pending RoutingUrl and publishes nothing",
  (stack) =>
    Effect.gen(function* () {
      plain.reset();
      yield* stack.destroy();

      const url = yield* stack.deploy(siteDomain(SITE_HOST));

      expect(url.status).toBe("pending");
      expect(url.records.map((record) => record.type)).toEqual(["TXT", "CNAME"]);
      expect(plain.zone.publishes).toBe(0);
      expect(plain.zone.records).toEqual([]);
      expect(domainsRoutes(plain)).toEqual([]);

      yield* stack.destroy();
    }),
  { tags: unitTags },
);

const upgrade = makeUrlCloud();
testFor(upgrade).test.provider(
  "a site deployed by the released Alchemy keeps one row and its records through the upgrade",
  (stack) =>
    Effect.gen(function* () {
      upgrade.reset();
      yield* stack.destroy();
      const domain = { name: SITE_HOST, dns: TEST_DNS };
      yield* stack.deploy(releasedSiteDomain(domain));
      const [recorded] = Array.from(upgrade.rows.values());
      const [customDomain] = Array.from(upgrade.domains.keys());
      expect(recorded?.logicalId).toBe(null);
      expect(upgrade.zone.records).toEqual([recordsFor(SITE_HOST)[1]]);

      upgrade.fake.captured.length = 0;
      const url = yield* stack.deploy(siteDomain(domain));

      expect(url.routingUrlId).toBe(recorded?.id);
      expect(Array.from(upgrade.rows.keys())).toEqual([recorded?.id]);
      expect(upgrade.rows.get(recorded!.id)?.logicalId).toBe(`Site/${WEBSITE_ROUTING_URL_ID}`);
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
      const url = yield* stack.deploy(siteDomain(SITE_HOST));

      expect(url.routingUrlId).toBe(recorded?.id);
      expect(Array.from(plainUpgrade.rows.keys())).toEqual([recorded?.id]);
      expect(plainUpgrade.domains.size).toBe(1);
      expect(plainUpgrade.routes().filter((route) => route.startsWith("DELETE"))).toEqual([]);

      yield* stack.destroy();
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
      const url = yield* stack.deploy(siteDomain({ name: SITE_HOST, dns: TEST_DNS }));
      siteChange.rows.set(
        url.routingUrlId,
        routingUrl(url.routingUrlId, {
          status: "active",
          logicalId: `Site/${WEBSITE_ROUTING_URL_ID}`,
          hostname: SITE_HOST,
        }),
      );

      siteChange.state.txt = "absent";
      siteChange.fake.captured.length = 0;
      const refused = yield* stack
        .deploy(siteDomain({ name: "new.example.com", dns: TEST_DNS }))
        .pipe(Effect.flip);

      expect(String(refused)).toContain("RoutingUrlHostnameChangeRefused");
      expect(siteChange.routes().some((route) => route.startsWith("PATCH"))).toBe(false);
      expect(siteChange.zone.records).toEqual(expect.arrayContaining(recordsFor(SITE_HOST)));
      expect(siteChange.zone.removed).toEqual([]);

      siteChange.state.txt = undefined;
      const moved = yield* stack.deploy(siteDomain({ name: "new.example.com", dns: TEST_DNS }));
      expect(moved.hostname).toBe("new.example.com");
      expect(byName(siteChange.zone.records)).toEqual(byName(recordsFor("new.example.com")));

      yield* stack.destroy();
      expect(siteChange.zone.records).toEqual([]);
    }),
  { tags: unitTags },
);

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
          return yield* RoutingUrl(WEBSITE_ROUTING_URL_ID, {
            app: app.appId,
            hostname: SITE_HOST,
            dns: TEST_DNS,
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

      expect(proxied.zone.options.map(({ method }) => method).sort()).toEqual(["alias", "records"]);
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
const HOSTNAME = `prisma-dns.${ZONE}`;
const MARKER = "StaticSite fixture v1";

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../Cloudflare/Website/staticsite-fixture",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

class CnameNotPublished extends Data.TaggedError("CnameNotPublished")<{
  readonly server: string;
  readonly name: string;
}> {}

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

/** Wait until every authoritative nameserver of the zone answers each CNAME. */
const waitForAuthoritativeCnames = (records: ReadonlyArray<{ name: string; value: string }>) =>
  Effect.gen(function* () {
    const nameServers = yield* Effect.tryPromise(() => resolveNs(ZONE)).pipe(Effect.orDie);
    const servers = (yield* Effect.forEach(nameServers, (ns) =>
      Effect.tryPromise(() => resolve4(ns)).pipe(Effect.orDie),
    )).flat();
    yield* Effect.forEach(servers, (server) =>
      Effect.forEach(records, (record) =>
        Effect.gen(function* () {
          const resolver = yield* Effect.sync(() => {
            const r = new Resolver();
            r.setServers([server]);
            return r;
          });
          const answers = yield* Effect.tryPromise(() => resolver.resolveCname(record.name)).pipe(
            Effect.orElseSucceed(() => [] as string[]),
          );
          if (!answers.some((answer) => trimDot(answer) === trimDot(record.value))) {
            return yield* Effect.fail(new CnameNotPublished({ server, name: record.name }));
          }
        }).pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 })),
      ),
    );
  });

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
      // Prisma created this domain ownership for the RoutingUrl; the stack does
      // not own it, so destroy leaves it.
      const ownerships = (yield* getWorkspaceDomainOwnerships({ workspaceId, domain: HOSTNAME }))
        .data;
      expect(
        ownerships.filter((ownership) => ownership.domain === HOSTNAME).map((o) => o.status),
      ).toEqual(["verified"]);
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
      yield* waitForAuthoritativeCnames(domain.records.filter((record) => record.type === "CNAME"));
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
            domain: { name: hostname, dns: Cloudflare.DNS.Adapter() },
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
