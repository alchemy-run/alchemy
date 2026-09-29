/**
 * `domain.dns` on Prisma websites, deployed for real: a StaticSite whose
 * custom hostname is published through `Cloudflare.DNS.Adapter()`. Asserts
 * Cloudflare holds exactly the records `Prisma.CustomDomain.dnsRecords`
 * reports, Prisma activates the domain and serves HTTPS on it, and destroy
 * removes both the records and the Prisma domain.
 *
 * The website's implicit Project attaches the App to the project's current
 * default branch, which Prisma requires for custom domains. Prisma verifies
 * the hostname's CNAME on registration, so the composite publishes it first.
 */
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Prisma from "@/Prisma/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { getDomain, getProject } from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { resolve4, resolveNs, Resolver } from "node:dns/promises";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";

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

class DomainNotActive extends Data.TaggedError("DomainNotActive")<{
  readonly status: string;
  readonly foundryStatus: string;
  readonly failureReason: string | null;
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

/** Every Cloudflare record at or below the hostname. */
const recordsUnder = (zoneId: string) =>
  dns.listRecords.items({ zoneId, name: { endswith: HOSTNAME } }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).filter(
        (record) =>
          trimDot(record.name) === HOSTNAME ||
          trimDot(record.name).endsWith(`.${HOSTNAME}`),
      ),
    ),
  );

const byKey = <T extends { name: string; type: string; value: string }>(
  records: ReadonlyArray<T>,
) =>
  [...records].sort((a, b) =>
    `${a.name}|${a.type}|${a.value}`.localeCompare(
      `${b.name}|${b.type}|${b.value}`,
    ),
  );

/** Wait until every authoritative nameserver of the zone answers each CNAME. */
const waitForAuthoritativeCnames = (
  records: ReadonlyArray<{ name: string; value: string }>,
) =>
  Effect.gen(function* () {
    const nameServers = yield* Effect.tryPromise(() => resolveNs(ZONE)).pipe(
      Effect.orDie,
    );
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
          const answers = yield* Effect.tryPromise(() =>
            resolver.resolveCname(record.name),
          ).pipe(Effect.orElseSucceed(() => [] as string[]));
          if (
            !answers.some((answer) => trimDot(answer) === trimDot(record.value))
          ) {
            return yield* Effect.fail(
              new CnameNotPublished({ server, name: record.name }),
            );
          }
        }).pipe(
          Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 }),
        ),
      ),
    );
  });

test.provider.skipIf(process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS !== "true")(
  "Cloudflare DNS publishes Prisma's records; the hostname activates and serves HTTPS",
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
      const projectId =
        typeof site.project === "string"
          ? site.project
          : site.project!.projectId;
      expect(domain.hostname).toBe(HOSTNAME);
      expect(domain.appId).toBe(site.compute!.appId);
      // The routing CNAME to the app's regional switchboard, published
      // before Prisma registered (and verified) the hostname.
      expect(
        domain.dnsRecords.some(
          (record) =>
            record.type === "CNAME" &&
            trimDot(record.name) === HOSTNAME &&
            /^switchboard\.[a-z0-9-]+\.prisma\.build$/.test(
              trimDot(record.value),
            ),
        ),
      ).toBe(true);

      // Cloudflare holds exactly the records the CustomDomain reports, DNS-only.
      const records = yield* recordsUnder(zoneId);
      expect(
        byKey(
          records.map((record) => ({
            name: trimDot(record.name),
            type: record.type,
            value: trimDot(record.content ?? ""),
          })),
        ),
      ).toEqual(
        byKey(
          domain.dnsRecords.map((record) => ({
            name: trimDot(record.name),
            type: record.type,
            value: trimDot(record.value),
          })),
        ),
      );
      expect(records.every((record) => record.proxied !== true)).toBe(true);

      // ...and those are the records Prisma's live API reports.
      const registered = yield* getDomain({ domainId: domain.customDomainId });
      expect(registered.data.hostname).toBe(HOSTNAME);
      expect(
        byKey(
          registered.data.dnsRecords.map((record) => ({
            name: trimDot(record.name),
            type: record.type,
            value: trimDot(record.value),
          })),
        ),
      ).toEqual(
        byKey(
          domain.dnsRecords.map((record) => ({
            name: trimDot(record.name),
            type: record.type,
            value: trimDot(record.value),
          })),
        ),
      );

      yield* waitForAuthoritativeCnames(domain.dnsRecords);

      const active = yield* getDomain({
        domainId: domain.customDomainId,
      }).pipe(
        Effect.flatMap(({ data }) =>
          data.status === "active"
            ? Effect.succeed(data)
            : Effect.fail(
                new DomainNotActive({
                  status: data.status,
                  foundryStatus: data.foundryStatus,
                  failureReason: data.failureReason,
                }),
              ),
        ),
        Effect.tapError((error) =>
          Effect.logInfo("Prisma domain pending", error),
        ),
        Effect.retry({
          while: (error) => error._tag === "DomainNotActive",
          schedule: Schedule.spaced("10 seconds"),
          times: 30,
        }),
      );
      expect(active.status).toBe("active");

      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(`https://${HOSTNAME}/`).pipe(
        Effect.flatMap(
          (
            res,
          ): Effect.Effect<
            string,
            HttpClientError.HttpClientError | SiteNotServing
          > =>
            res.status === 200
              ? res.text
              : Effect.fail(new SiteNotServing({ status: res.status })),
        ),
        Effect.timeout("10 seconds"),
        Effect.tapError((error) =>
          Effect.logInfo(
            `https://${HOSTNAME} not serving yet: ${error._tag === "SiteNotServing" ? `HTTP ${error.status}` : error.message}`,
          ),
        ),
        Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
      );
      expect(body).toContain(MARKER);

      yield* stack.destroy();

      expect(yield* recordsUnder(zoneId)).toEqual([]);
      expect(
        yield* getDomain({ domainId: domain.customDomainId }).pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        ),
      ).toBe("gone");
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
      "provider:prisma:customdomain",
      "provider:prisma:website",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "live",
    ],
    timeout: 900_000,
  },
);
