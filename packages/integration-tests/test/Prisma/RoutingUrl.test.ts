import { resolve4 } from "node:dns/promises";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import * as Prisma from "@alchemy.run/prisma";
import {
  RoutingUrl,
  RoutingUrlCertificateLimitReached,
  type RoutingUrlHostnameChangeRefused,
  RoutingUrlHostnameTaken,
  RoutingUrlInvalidHostname,
  RoutingUrlLogicalIdTaken,
  RoutingUrlNotActive,
  RoutingUrlOperationFailed,
  RoutingUrlQuotaExceeded,
  RoutingUrlRecordsNotSeen,
  RoutingUrlServiceNotOnABranch,
  RoutingUrlServiceOnAnotherBranch,
} from "@alchemy.run/prisma/RoutingUrl";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  createServiceUrl,
  deleteDomainOwnership,
  deleteUrl,
  getProject,
  getUrl,
  getWorkspaceDomainOwnerships,
  updateUrl,
} from "@distilled.cloud/prisma/management";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as DNS from "alchemy/DNS/Adapter";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as pathe from "pathe";
import {
  AuthoritativeRecordCheck,
  type ExpectedRecord,
  type ExpectedSwitchboardDns,
  type RecordVisibility,
  SwitchboardDnsCheck,
  type SwitchboardDnsVisibility,
  type SwitchboardCheckOptions,
  type CheckOptions,
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
import {
  checkOnceThenPollUntilActive,
  expectGone,
  expectProjectGone,
  failureOf as failuresOf,
  forgetState,
  pollUntilActive,
} from "./fixtures/Live.ts";
import {
  AppRef,
  HOSTNAME,
  makeUrlCloud,
  recordsFor,
  routingUrl,
  type PrismaEvent,
  published,
  served,
  TEST_DNS,
  testFor,
  TXT,
  type UrlCloud,
  type WireRoutingUrl,
  type Zone,
} from "./fixtures/RoutingUrlCloud.ts";

const urlStack = (hostname = HOSTNAME) => RoutingUrl("Url", { app: "svc-1", hostname });

const dnsStack = (hostname = HOSTNAME) =>
  RoutingUrl("Url", { app: "svc-1", hostname, dns: TEST_DNS });

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

const ownershipWrites = (cloud: UrlCloud) =>
  cloud.routes().filter((route) => route.includes("domain-ownerships") && !route.startsWith("GET"));

const withDns = makeUrlCloud();
testFor(withDns).test.provider(
  "with dns, publishes the TXT and CNAME, waits for them before the create, returns once the row is active, and destroy removes them",
  (stack) =>
    Effect.gen(function* () {
      withDns.reset({ fromZone: true });
      yield* stack.destroy();

      const url = yield* stack.deploy(dnsStack());

      expect(withDns.zone.records).toEqual(recordsFor(HOSTNAME));
      expect(url.logicalId).toBe("Url");
      expect(url.status).toBe("active");
      const create = withDns.fake.captured.find((request) => request.method === "POST");
      expect(create?.bodyJson).toEqual({ hostname: HOSTNAME, logicalId: "Url" });
      expect(ownershipWrites(withDns)).toEqual([]);
      expect(withDns.state.txtChecked).toEqual([
        { type: "TXT", name: `_prisma-verification.${HOSTNAME}`, value: TXT.value },
      ]);
      expect(withDns.state.txtAttempts).toEqual(["until-seen"]);
      expect(
        withDns.state.checked.map(([expected, options]) => [expected.name, options.attempts]),
      ).toEqual([[HOSTNAME, "until-seen"]]);

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

const URL_READS = (cloud: UrlCloud) =>
  cloud.routes().filter((route) => /^GET \/v1\/urls\/[^/]+$/.test(route));

/**
 * Runs `deploy` on the test clock, moving it 10 seconds at a time until the
 * deploy finishes.
 */
const onTestClock = <A, E, R>(deploy: Effect.Effect<A, E, R>, clock = { steps: 0 }) =>
  Effect.gen(function* () {
    const fiber = yield* deploy.pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    yield* TestClock.withLive(Effect.sleep("5 millis")).pipe(
      Effect.andThen(TestClock.adjust("10 seconds")),
      Effect.andThen(
        Effect.sync(() => {
          clock.steps++;
        }),
      ),
      Effect.repeat({ until: () => fiber.pollUnsafe() !== undefined, times: 200 }),
    );
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer()));

/** A pending row whose certificate Prisma is issuing. */
const issuing = (row: WireRoutingUrl, customDomainSyncError: string | null = null) => ({
  ...row,
  conditions: {
    ...row.conditions,
    ownershipVerified: "met" as const,
    dnsPointsAtSwitchboard: "met" as const,
    customDomainBound: "met" as const,
  },
  firstUnmetCondition: "certificateActive",
  records: [],
  customDomain: {
    id: `dom-${row.id}`,
    status: "provisioning",
    failureReason: null,
    certExpiresAt: null,
    lastSeenAt: WIRE_CREATED_AT,
    certificateRetryRequestedAt: null,
    certificateIssuanceStuck: false,
  },
  customDomainSyncError,
});

/**
 * Prisma orders the certificate when it sees the records on a write or a
 * check, and the certificate is active from the `reads`-th read on.
 */
const certificateAfterReads = (reads: number) => {
  let read = 0;
  return (row: WireRoutingUrl, zone: Zone, event: PrismaEvent): WireRoutingUrl => {
    if (row.status === "active") return row;
    if (event !== "read") return published(row, zone) ? issuing(row) : row;
    return row.customDomain !== null && ++read >= reads ? served(row) : row;
  };
};

const CERTIFICATE_LIMIT_ERROR =
  "The workspace has reached its hourly limit of 10 new certificates. The limit resets at 2026-11-21T01:00:00.000Z.";

const CHECKS = (cloud: UrlCloud) => cloud.routes().filter((route) => route.endsWith("/check"));

const expectDestroyed = (cloud: UrlCloud) =>
  Effect.sync(() => {
    expect(cloud.rows.size).toBe(0);
    expect(cloud.zone.records).toEqual([]);
  });

const slowCertificate = makeUrlCloud();
testFor(slowCertificate).test.provider(
  "with dns, polls the RoutingUrl until Prisma serves it",
  (stack) =>
    Effect.gen(function* () {
      slowCertificate.reset({ fromZone: true, progress: certificateAfterReads(3) });
      yield* stack.destroy();

      const deployed = yield* onTestClock(stack.deploy(dnsStack()));

      expect(Result.isSuccess(deployed) && deployed.success.status).toBe("active");
      expect(URL_READS(slowCertificate).length).toBe(3);
      expect(slowCertificate.routes().filter((route) => route.startsWith("POST"))).toHaveLength(1);
      expect(CHECKS(slowCertificate)).toEqual([]);

      yield* stack.destroy();
    }),
  { tags },
);

const missedDns = makeUrlCloud();
testFor(missedDns).test.provider(
  "with dns, checks once when Prisma missed the records at the create, then polls",
  (stack) =>
    Effect.gen(function* () {
      let looks = 0;
      const missesFirstLook = certificateAfterReads(2);
      missedDns.reset({
        fromZone: true,
        progress: (row, zone, event) =>
          event === "write" && looks++ === 0 ? row : missesFirstLook(row, zone, event),
      });
      yield* stack.destroy();

      const deployed = yield* onTestClock(stack.deploy(dnsStack()));

      expect(Result.isSuccess(deployed) && deployed.success.status).toBe("active");
      expect(CHECKS(missedDns)).toEqual(["POST /v1/urls/url-1/check"]);
      expect(URL_READS(missedDns).length).toBe(2);

      yield* stack.destroy();
    }),
  { tags },
);

const throttled = makeUrlCloud();
testFor(throttled).test.provider(
  "with dns, waits as long as Prisma's Retry-After asks on the create and on every poll",
  (stack) =>
    Effect.gen(function* () {
      const clock = { steps: 0 };
      const polledAt: number[] = [];
      const progress = certificateAfterReads(1);
      throttled.reset({
        fromZone: true,
        progress: (row, zone, event) => {
          polledAt.push(clock.steps);
          return progress(row, zone, event);
        },
        throttle: [
          { route: "POST /v1/services/svc-1/urls", retryAfter: 1 },
          { route: "GET /v1/urls/url-1", retryAfter: 40 },
        ],
      });
      yield* stack.destroy();

      const deployed = yield* onTestClock(stack.deploy(dnsStack()), clock);

      expect(Result.isSuccess(deployed) && deployed.success.status).toBe("active");
      expect(throttled.routes().filter((route) => route.startsWith("POST"))).toHaveLength(2);
      expect(throttled.rows.size).toBe(1);
      expect(URL_READS(throttled)).toHaveLength(2);
      // One 10-second poll interval, then the 40 seconds Prisma asked for.
      expect(polledAt[1]! - polledAt[0]!).toBeGreaterThanOrEqual(5);

      yield* stack.destroy();
    }),
  { tags },
);

const lostCreateReply = makeUrlCloud();
testFor(lostCreateReply).test.provider(
  "with dns, a create Prisma made before its reply was lost continues with that row",
  (stack) =>
    Effect.gen(function* () {
      lostCreateReply.reset({ fromZone: true, loseCreateReply: true });
      yield* stack.destroy();

      const url = yield* stack.deploy(dnsStack());

      expect(url.status).toBe("active");
      expect(lostCreateReply.routes().filter((route) => route.startsWith("POST"))).toHaveLength(2);
      expect(lostCreateReply.rows.size).toBe(1);
      expect(url.routingUrlId).toBe([...lostCreateReply.rows.keys()][0]);

      yield* stack.destroy();
      yield* expectDestroyed(lostCreateReply);
    }),
  { tags },
);

const recordsNotSeen = makeUrlCloud();
testFor(recordsNotSeen).test.provider(
  "with dns, refuses to save the RoutingUrl while a published record is absent at the nameservers",
  (stack) =>
    Effect.gen(function* () {
      recordsNotSeen.reset({ txt: "absent", dns: { visibility: "seen", cname: "seen" } });
      yield* stack.destroy();

      const { errors } = yield* failuresOf(stack.deploy(dnsStack()));

      const error = errors.find(
        (each): each is RoutingUrlRecordsNotSeen => each instanceof RoutingUrlRecordsNotSeen,
      );
      expect(error?.records).toEqual([
        { type: "TXT", name: `_prisma-verification.${HOSTNAME}`, value: TXT.value },
      ]);
      expect(error?.message).toContain("Nothing was saved in Prisma");
      expect(recordsNotSeen.routes().some((route) => route.startsWith("POST"))).toBe(false);

      recordsNotSeen.state.txt = "unknown";
      recordsNotSeen.state.dns = { visibility: "unknown", cname: "unknown" };
      const url = yield* stack.deploy(dnsStack());
      expect(url.status).toBe("active");

      yield* stack.destroy();
      yield* expectDestroyed(recordsNotSeen);
    }),
  { tags },
);

const neverServes = makeUrlCloud();
testFor(neverServes).test.provider(
  "with dns, fails with the first unmet condition and Prisma's error when the hostname does not serve in time, and the next deploy finds the same row",
  (stack) =>
    Effect.gen(function* () {
      neverServes.reset({
        fromZone: true,
        progress: (row) => issuing(row, "Foundry did not answer"),
      });
      yield* stack.destroy();

      const timedOut = yield* onTestClock(failuresOf(stack.deploy(dnsStack())));

      const error = timedOut.pipe(
        Result.map(({ errors }) =>
          errors.find((each): each is RoutingUrlNotActive => each instanceof RoutingUrlNotActive),
        ),
        Result.getOrUndefined,
      );
      expect(error?.firstUnmetCondition).toBe("certificateActive");
      expect(error?.customDomainSyncError).toBe("Foundry did not answer");
      expect(error?.heldBy).toBe(null);
      expect(error?.certificateFailure).toBe(null);
      expect(error?.message).toContain(
        "did not become active within 6 minutes: its first unmet condition is certificateActive",
      );
      expect(error?.message).toContain('Prisma reports: "Foundry did not answer"');
      expect(error?.message).toContain("redeploy to wait again");
      expect(URL_READS(neverServes).length).toBe(36);
      expect(CHECKS(neverServes)).toEqual([]);
      const [saved] = neverServes.rows.keys();

      neverServes.state.progress = certificateAfterReads(1);
      neverServes.fake.captured.length = 0;
      const url = yield* onTestClock(stack.deploy(dnsStack()));

      expect(Result.isSuccess(url) && url.success.routingUrlId).toBe(saved);
      expect(Result.isSuccess(url) && url.success.status).toBe("active");
      expect(neverServes.rows.size).toBe(1);
      expect(neverServes.routes().some((route) => route.startsWith("POST"))).toBe(false);
      expect(PATCHES(neverServes)).toEqual([]);

      yield* stack.destroy();
      yield* expectDestroyed(neverServes);
    }),
  { tags },
);

const destroyAfterTimeout = makeUrlCloud();
testFor(destroyAfterTimeout).test.provider(
  "with dns, destroy after a wait that ran out deletes the row and the records",
  (stack) =>
    Effect.gen(function* () {
      destroyAfterTimeout.reset({ fromZone: true, progress: (row) => issuing(row) });
      yield* stack.destroy();

      const timedOut = yield* onTestClock(failuresOf(stack.deploy(dnsStack())));
      expect(Result.isSuccess(timedOut)).toBe(true);
      expect(destroyAfterTimeout.rows.size).toBe(1);

      yield* stack.destroy();
      yield* expectDestroyed(destroyAfterTimeout);
    }),
  { tags },
);

const failedCertificate = makeUrlCloud();
testFor(failedCertificate).test.provider(
  "with dns, fails at once when the certificate failed, and does not retry it",
  (stack) =>
    Effect.gen(function* () {
      failedCertificate.reset({
        fromZone: true,
        progress: (row) => {
          const ordered = issuing(row);
          return {
            ...ordered,
            customDomain: {
              ...ordered.customDomain,
              status: "failed",
              failureReason: "CAA record forbids the issuer",
            },
          };
        },
      });
      yield* stack.destroy();

      const result = yield* onTestClock(failuresOf(stack.deploy(dnsStack())));

      const error = result.pipe(
        Result.map(({ errors }) =>
          errors.find((each): each is RoutingUrlNotActive => each instanceof RoutingUrlNotActive),
        ),
        Result.getOrUndefined,
      );
      expect(error?.certificateFailure).toBe("CAA record forbids the issuer");
      expect(error?.message).toContain("CAA record forbids the issuer");
      expect(error?.message).toContain("A redeploy does not retry it");
      expect(error?.message).toContain("https://console.prisma.test/urls/url-1");
      expect(error?.message).toContain("counts toward the workspace's hourly limit");
      expect(URL_READS(failedCertificate)).toEqual([]);
      expect(CHECKS(failedCertificate)).toEqual([]);

      yield* stack.destroy();
      yield* expectDestroyed(failedCertificate);
    }),
  { tags },
);

const certificateLimit = makeUrlCloud();
testFor(certificateLimit).test.provider(
  "with dns, fails at once when the workspace reached its hourly limit of new certificates",
  (stack) =>
    Effect.gen(function* () {
      certificateLimit.reset({
        fromZone: true,
        progress: (row) => ({
          ...row,
          firstUnmetCondition: "customDomainBound",
          customDomainSyncError: CERTIFICATE_LIMIT_ERROR,
        }),
      });
      yield* stack.destroy();

      const result = yield* onTestClock(failuresOf(stack.deploy(dnsStack())));

      const error = result.pipe(
        Result.map(({ errors }) =>
          errors.find(
            (each): each is RoutingUrlCertificateLimitReached =>
              each instanceof RoutingUrlCertificateLimitReached,
          ),
        ),
        Result.getOrUndefined,
      );
      expect(error?.limit).toBe(10);
      expect(error?.resetAt).toBe("2026-11-21T01:00:00.000Z");
      expect(error?.message).toContain("hourly limit of 10 new certificates");
      expect(error?.message).toContain("resets at 2026-11-21T01:00:00.000Z");
      expect(error?.message).toContain("Prisma continues on its own");
      expect(error?.message).toContain("a redeploy after then waits");
      expect(URL_READS(certificateLimit)).toEqual([]);
      expect(CHECKS(certificateLimit)).toEqual([]);

      yield* stack.destroy();
      yield* expectDestroyed(certificateLimit);
    }),
  { tags },
);

const heldElsewhere = makeUrlCloud();
testFor(heldElsewhere).test.provider(
  "with dns, fails at once when a RoutingUrl in another workspace holds the hostname",
  (stack) =>
    Effect.gen(function* () {
      const heldBy = {
        workspaceId: null,
        projectId: null,
        serviceId: null,
        message: "held by another workspace",
      };
      heldElsewhere.reset({
        fromZone: true,
        progress: (row) => ({ ...row, firstUnmetCondition: "customDomainBound", heldBy }),
      });
      yield* stack.destroy();

      const result = yield* onTestClock(failuresOf(stack.deploy(dnsStack())));

      const error = result.pipe(
        Result.map(({ errors }) =>
          errors.find((each): each is RoutingUrlNotActive => each instanceof RoutingUrlNotActive),
        ),
        Result.getOrUndefined,
      );
      expect(error?.heldBy).toEqual(heldBy);
      expect(error?.message).toContain("is held by another workspace");
      expect(URL_READS(heldElsewhere)).toEqual([]);
      expect(CHECKS(heldElsewhere)).toEqual([]);

      yield* stack.destroy();
      yield* expectDestroyed(heldElsewhere);
    }),
  { tags },
);

const pendingChange = makeUrlCloud();
testFor(pendingChange).test.provider(
  "with dns, waits for the new hostname's records before changing the hostname of a pending row",
  (stack) =>
    Effect.gen(function* () {
      pendingChange.reset({ fromZone: true }, routingUrl("url-1"));
      yield* stack.destroy();

      const url = yield* stack.deploy(dnsStack("new.example.com"));

      expect(url.routingUrlId).toBe("url-1");
      expect(url.status).toBe("active");
      expect(PATCHES(pendingChange)).toEqual(["PATCH /v1/urls/url-1"]);
      expect(pendingChange.state.txtChecked).toEqual([
        { type: "TXT", name: "_prisma-verification.new.example.com", value: TXT.value },
      ]);
      expect(pendingChange.state.txtAttempts).toEqual(["until-seen"]);
      expect(pendingChange.state.txtCheckedAtPatch).toBe(1);
      expect(
        pendingChange.state.checked.map(([expected, options]) => [expected.name, options.attempts]),
      ).toEqual([["new.example.com", "until-seen"]]);

      yield* stack.destroy();
    }),
  { tags },
);

const servedThenPending = makeUrlCloud();
testFor(servedThenPending).test.provider(
  "with dns, a hostname that served once and reads pending later does not wait or fail a redeploy",
  (stack) =>
    Effect.gen(function* () {
      servedThenPending.reset({ fromZone: true });
      yield* stack.destroy();
      const served = yield* stack.deploy(dnsStack());
      expect(served.status).toBe("active");

      servedThenPending.rows.set(served.routingUrlId, routingUrl(served.routingUrlId));
      servedThenPending.state.progress = (row) => row;
      servedThenPending.fake.captured.length = 0;
      const redeployed = yield* onTestClock(
        stack.deploy(
          RoutingUrl("Url", {
            app: "svc-1",
            hostname: HOSTNAME,
            logicalId: "Renamed",
            dns: TEST_DNS,
          }),
        ),
      );
      const url = Result.getOrThrow(redeployed);

      expect(PATCHES(servedThenPending)).toEqual([`PATCH /v1/urls/${served.routingUrlId}`]);
      expect(url.status).toBe("pending");
      expect(URL_READS(servedThenPending)).toEqual([`GET /v1/urls/${served.routingUrlId}`]);
      expect(CHECKS(servedThenPending)).toEqual([]);

      yield* stack.destroy();
    }),
  { tags },
);

const dnsChange = makeUrlCloud();
testFor(dnsChange).test.provider(
  "with dns, a hostname change goes through because the new hostname's TXT is seen, and the old records are removed after the PATCH",
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
      expect(dnsChange.state.txtOptions).toEqual([
        {
          margin: "if-unseen",
          nameservers: "name",
          serversOf: "new.example.com",
          attempts: "until-seen",
        },
      ]);
      expect(dnsChange.state.checked.map(([, options]) => options)).toEqual([
        { margin: "if-unseen", nameservers: "name", attempts: "until-seen" },
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

      expect(refusal?.ownership).toBe("absent");
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

const similarNames = makeUrlCloud();
testFor(similarNames).test.provider(
  "with dns, keeps separate records for hostnames that differ only in where a dot and a hyphen are",
  (stack) =>
    Effect.gen(function* () {
      similarNames.reset(
        { fromZone: true },
        routingUrl("url-1", { status: "active", hostname: "a-b.example.com" }),
      );
      yield* stack.destroy();
      yield* stack.deploy(dnsStack("a-b.example.com"));

      similarNames.state.txt = "absent";
      const refusal = yield* refusalOf(stack.deploy(dnsStack("a.b-example.com")));

      expect(refusal?.ownership).toBe("absent");
      expect(similarNames.zone.records).toEqual([
        ...recordsFor("a-b.example.com"),
        ...recordsFor("a.b-example.com"),
      ]);
      expect(similarNames.zone.removed).toEqual([]);

      similarNames.state.txt = undefined;
      yield* stack.destroy();
    }),
  { tags },
);

const addDns = makeUrlCloud();
testFor(addDns).test.provider(
  "adding dns to a deployed pending RoutingUrl keeps its row, checks it once and waits for it",
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
      expect(addDns.routes().filter((route) => route.startsWith("POST"))).toEqual([
        `POST /v1/urls/${before.routingUrlId}/check`,
      ]);
      expect(after.status).toBe("active");
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
      appOutput.reset({ fromZone: true });
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
  "with dns, refuses a hostname it cannot publish, an app with no endpoint or on no Branch before publishing anything",
  (stack) =>
    Effect.gen(function* () {
      unpublishable.reset();
      yield* stack.destroy();

      for (const hostname of ["*.example.com", "api.example.com/path", "a__b.example.com"]) {
        expect(yield* failureOf(stack.deploy(dnsStack(hostname)))).toContain(
          "RoutingUrlInvalidHostname",
        );
      }

      const outputHostname = yield* failureOf(
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* AppRef("App", {});
            return yield* RoutingUrl("Url", { app: "svc-1", hostname: app.appId, dns: TEST_DNS });
          }),
        ),
      );
      expect(outputHostname).toContain("RoutingUrlInvalidProps");

      const branchless = yield* failureOf(
        stack.deploy(
          RoutingUrl("Url", { app: "svc-no-branch", hostname: HOSTNAME, dns: TEST_DNS }),
        ),
      );
      expect(branchless).toContain("RoutingUrlServiceNotOnABranch");

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

const noBranch = makeUrlCloud();
testFor(noBranch).test.provider(
  "refuses a service on no Branch before asking Prisma to create the RoutingUrl",
  (stack) =>
    Effect.gen(function* () {
      noBranch.reset();
      yield* stack.destroy();

      const { errors } = yield* failuresOf(
        stack.deploy(RoutingUrl("Url", { app: "svc-no-branch", hostname: HOSTNAME })),
      );

      expect(errors.some((error) => error instanceof RoutingUrlServiceNotOnABranch)).toBe(true);
      expect(noBranch.routes().some((route) => route.startsWith("POST"))).toBe(false);

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
      expect(refusal?.ownership).toBe("absent");
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
      expect(txtProof.state.txtAttempts).toEqual(["once"]);
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

      expect(absent?.ownership).toBe("absent");
      expect(absent?.records).toEqual([
        { type: "TXT", name: "_prisma-verification.new.example.com", value: TXT.value },
      ]);
      expect(absent?.message).toContain(
        `Publish TXT _prisma-verification.new.example.com = ${TXT.value}, then redeploy.`,
      );

      txtMissing.state.txt = "unknown";
      const unknown = yield* refusalOf(stack.deploy(urlStack("new.example.com")));

      expect(unknown?.ownership).toBe("unknown");
      expect(txtMissing.state.txtAttempts).toEqual(["once", "once"]);
      expect(txtMissing.state.checked.map(([, options]) => options.attempts)).toEqual([
        "once",
        "once",
      ]);
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

/** Prisma's refusals, by the error code it sends; the message is arbitrary on purpose. */
const refusalCases: ReadonlyArray<{
  operation: "create" | "update";
  status: 409 | 422;
  code: string;
  expected: { new (...args: never[]): { readonly _tag: string } };
}> = [
  { operation: "create", status: 409, code: "quota-exceeded", expected: RoutingUrlQuotaExceeded },
  {
    operation: "create",
    status: 409,
    code: "logical-id-taken",
    expected: RoutingUrlLogicalIdTaken,
  },
  {
    operation: "create",
    status: 422,
    code: "service-not-on-a-branch",
    expected: RoutingUrlServiceNotOnABranch,
  },
  {
    operation: "create",
    status: 409,
    code: "some-new-conflict",
    expected: RoutingUrlOperationFailed,
  },
  {
    operation: "create",
    status: 422,
    code: "validation-error",
    expected: RoutingUrlOperationFailed,
  },
  { operation: "update", status: 409, code: "quota-exceeded", expected: RoutingUrlQuotaExceeded },
  {
    operation: "update",
    status: 409,
    code: "logical-id-taken",
    expected: RoutingUrlLogicalIdTaken,
  },
  {
    operation: "update",
    status: 422,
    code: "invalid-hostname",
    expected: RoutingUrlInvalidHostname,
  },
  {
    operation: "update",
    status: 422,
    code: "service-on-another-branch",
    expected: RoutingUrlServiceOnAnotherBranch,
  },
  {
    operation: "update",
    status: 409,
    code: "some-new-conflict",
    expected: RoutingUrlOperationFailed,
  },
  {
    operation: "update",
    status: 422,
    code: "validation-error",
    expected: RoutingUrlOperationFailed,
  },
];

for (const { operation, status, code, expected } of refusalCases) {
  const cloud = makeUrlCloud();
  testFor(cloud).test.provider(
    `turns Prisma's ${status} ${code} on ${operation} into ${expected.name}`,
    (stack) =>
      Effect.gen(function* () {
        const refusal = failure(status, code, "arbitrary text 4711");
        cloud.reset(
          operation === "create" ? { refusal } : {},
          ...(operation === "create" ? [] : [routingUrl("url-1")]),
        );
        yield* stack.destroy();
        cloud.state.refusal = refusal;

        const { errors } = yield* failuresOf(
          stack.deploy(urlStack(operation === "create" ? HOSTNAME : "new.example.com")),
        );

        expect(errors.some((error) => error instanceof expected)).toBe(true);
        expect(
          cloud
            .routes()
            .some((route) => route.startsWith(operation === "create" ? "POST" : "PATCH")),
        ).toBe(true);

        cloud.reset();
        yield* stack.destroy();
      }),
    { tags },
  );
}

const live = Test.make({ providers: Prisma.providers() });

const liveTags = [
  "live",
  "provider:prisma",
  "provider:prisma:routingurl",
  "provider:prisma:app",
  "provider:prisma:project",
];

/** A hostname under `example.com` that is unique to this test and stage. */
const liveHostname = (stack: Test.ScratchStack, label: string) =>
  `${label}-${stack.stage.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.example.com`;

const observeUrl = (id: string) => getUrl({ id }).pipe(Effect.map(({ data }) => data));

const expectUrlGone = (id: string) =>
  expectGone(
    getUrl({ id }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

/** The domain ownerships Prisma holds for exactly `domain`. */
const ownershipsFor = (projectId: string, domain: string) =>
  Effect.gen(function* () {
    const workspaceId = (yield* getProject({ id: projectId })).data.workspace.id;
    const { data } = yield* getWorkspaceDomainOwnerships({ workspaceId, domain });
    return { workspaceId, ownerships: data.filter((row) => row.domain === domain) };
  });

/** Delete the domain ownerships Prisma created for this test's hostnames. */
const deleteOwnerships = (workspaceId: string, domains: ReadonlyArray<string>) =>
  Effect.forEach(domains, (domain) =>
    getWorkspaceDomainOwnerships({ workspaceId, domain }).pipe(
      Effect.flatMap(({ data }) =>
        Effect.forEach(
          data.filter((row) => row.domain === domain),
          (row) =>
            deleteDomainOwnership({ domainOwnershipId: row.id }).pipe(
              Effect.catchTag("NotFound", () => Effect.void),
            ),
        ),
      ),
    ),
  );

const twoApps = Effect.gen(function* () {
  const project = yield* Prisma.Project("Project", { createDatabase: false });
  const web = yield* Prisma.App("Web", { project });
  const admin = yield* Prisma.App("Admin", { project });
  return { project, web, admin };
});

live.test.provider(
  "saves a RoutingUrl with no DNS, redeploys without an update, moves it to another App, and destroy deletes it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const hostname = liveHostname(stack, "rul-life");
      const declare = (app: "web" | "admin") =>
        Effect.gen(function* () {
          const apps = yield* twoApps;
          const url = yield* Prisma.RoutingUrl("Url", { app: apps[app], hostname });
          return { ...apps, url };
        });

      const first = yield* stack.deploy(declare("web"));
      const created = yield* observeUrl(first.url.routingUrlId);
      expect(created.status).toBe("pending");
      expect(created.hostname).toBe(hostname);
      expect(created.serviceId).toBe(first.web.appId);
      expect(created.logicalId).toBe("Url");
      expect(created.firstUnmetCondition).not.toBe(null);
      expect(created.records.map((record) => record.type).sort()).toEqual(["CNAME", "TXT"]);

      yield* stack.deploy(declare("web"));
      expect((yield* observeUrl(first.url.routingUrlId)).updatedAt).toBe(created.updatedAt);

      const moved = yield* stack.deploy(declare("admin"));
      expect(moved.url.routingUrlId).toBe(first.url.routingUrlId);
      const observed = yield* observeUrl(first.url.routingUrlId);
      expect(observed.serviceId).toBe(first.admin.appId);
      expect(observed.hostname).toBe(hostname);

      const { workspaceId, ownerships } = yield* ownershipsFor(first.project.projectId, hostname);
      // Prisma creates an unverified domain ownership for the exact hostname.
      expect(ownerships.map((row) => row.status)).toEqual(["unverified"]);
      yield* stack.destroy();
      yield* expectUrlGone(first.url.routingUrlId);
      yield* expectProjectGone(first.project.projectId);
      // Prisma created a domain ownership for the hostname; the resource leaves it.
      const left = (yield* getWorkspaceDomainOwnerships({ workspaceId, domain: hostname })).data;
      expect(left.map((row) => row.id)).toEqual(ownerships.map((row) => row.id));
      yield* deleteOwnerships(workspaceId, [hostname]);
    }),
  { tags: liveTags, timeout: 300_000 },
);

live.test.provider(
  "changes a pending RoutingUrl's hostname in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const before = liveHostname(stack, "rul-before");
      const after = liveHostname(stack, "rul-after");
      const declare = (hostname: string) =>
        Effect.gen(function* () {
          const project = yield* Prisma.Project("Project", { createDatabase: false });
          const app = yield* Prisma.App("Web", { project });
          const url = yield* Prisma.RoutingUrl("Url", { app, hostname });
          return { project, url };
        });

      const first = yield* stack.deploy(declare(before));
      const second = yield* stack.deploy(declare(after));

      expect(second.url.routingUrlId).toBe(first.url.routingUrlId);
      const observed = yield* observeUrl(first.url.routingUrlId);
      expect(observed.hostname).toBe(after);
      expect(observed.status).toBe("pending");

      const { workspaceId } = yield* ownershipsFor(first.project.projectId, after);
      yield* stack.destroy();
      yield* expectUrlGone(first.url.routingUrlId);
      yield* deleteOwnerships(workspaceId, [before, after]);
    }),
  { tags: liveTags, timeout: 300_000 },
);

live.test.provider(
  "finds its own row again after losing its state, and refuses another App's row with the same logicalId without --adopt",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const hostname = liveHostname(stack, "rul-own");
      const otherHostname = liveHostname(stack, "rul-other-stage");
      const declare = Effect.gen(function* () {
        const apps = yield* twoApps;
        const url = yield* Prisma.RoutingUrl("Url", { app: apps.web, hostname });
        return { ...apps, url };
      });

      const first = yield* stack.deploy(declare);
      const { workspaceId } = yield* ownershipsFor(first.project.projectId, hostname);
      yield* forgetState(stack, "Url");
      const found = yield* stack.deploy(declare);
      expect(found.url.routingUrlId).toBe(first.url.routingUrlId);

      // Another stage of this stack on the same Branch: its own App, its own
      // hostname, the same resource path.
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* twoApps;
        }),
      );
      const otherStage = (yield* createServiceUrl({
        serviceId: first.admin.appId,
        hostname: otherHostname,
        logicalId: "Url",
      })).data;

      const refused = yield* failuresOf(
        stack.deploy(
          Effect.gen(function* () {
            const apps = yield* twoApps;
            return yield* Prisma.RoutingUrl("Url", { app: apps.web, hostname });
          }),
        ),
      );
      expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);
      const untouched = yield* observeUrl(otherStage.id);
      expect(untouched.serviceId).toBe(first.admin.appId);
      expect(untouched.hostname).toBe(otherHostname);

      yield* deleteUrl({ id: otherStage.id });
      yield* stack.destroy();
      yield* deleteOwnerships(workspaceId, [hostname, otherHostname]);
    }),
  { tags: liveTags, timeout: 300_000 },
);

live.test.provider(
  "turns Prisma's real refusals into typed errors",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const hostname = liveHostname(stack, "rul-refused");
      const second = liveHostname(stack, "rul-refused-2");
      const { project, web, admin, url } = yield* stack.deploy(
        Effect.gen(function* () {
          const apps = yield* twoApps;
          const url = yield* Prisma.RoutingUrl("Url", { app: apps.web, hostname });
          return { ...apps, url };
        }),
      );
      const { workspaceId } = yield* ownershipsFor(project.projectId, hostname);
      const tagOf = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        );

      // Through the resource: Prisma's 422 for a hostname it refuses.
      const invalid = yield* failuresOf(
        stack.deploy(
          Effect.gen(function* () {
            const apps = yield* twoApps;
            yield* Prisma.RoutingUrl("Url", { app: apps.web, hostname });
            return yield* Prisma.RoutingUrl("Wildcard", {
              app: apps.admin,
              hostname: `*.${hostname}`,
            });
          }),
        ),
      );
      expect(invalid.errors.some((error) => error instanceof RoutingUrlInvalidHostname)).toBe(true);

      // Through the resource: another row on the Branch has the hostname.
      const taken = yield* failuresOf(
        stack.deploy(
          Effect.gen(function* () {
            const apps = yield* twoApps;
            yield* Prisma.RoutingUrl("Url", { app: apps.web, hostname });
            return yield* Prisma.RoutingUrl("Copy", { app: apps.admin, hostname });
          }),
        ),
      );
      expect(taken.errors.some((error) => error instanceof RoutingUrlHostnameTaken)).toBe(true);

      // Prisma's own answers, read through the SDK, match the generated errors.
      expect(
        yield* tagOf(
          createServiceUrl({ serviceId: admin.appId, hostname: second, logicalId: "Url" }),
        ),
      ).toBe("RoutingUrlLogicalIdTaken");
      expect(
        yield* tagOf(createServiceUrl({ serviceId: admin.appId, hostname: `*.${second}` })),
      ).toBe("RoutingUrlInvalidHostname");
      expect(yield* tagOf(updateUrl({ id: url.routingUrlId, hostname: `*.${second}` }))).toBe(
        "RoutingUrlInvalidHostname",
      );
      const other = (yield* createServiceUrl({
        serviceId: admin.appId,
        hostname: second,
        logicalId: "Other",
      })).data;
      expect(yield* tagOf(updateUrl({ id: other.id, logicalId: "Url" }))).toBe(
        "RoutingUrlLogicalIdTaken",
      );
      yield* deleteUrl({ id: other.id });
      expect(web.appId).not.toBe(admin.appId);

      yield* stack.destroy();
      yield* expectUrlGone(url.routingUrlId);
      yield* deleteOwnerships(workspaceId, [hostname, second]);
    }),
  { tags: liveTags, timeout: 300_000 },
);

const ZONE = "alchemy-test-2.us";

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
      // The CNAME is published in the same deploy, possibly after Prisma first looked.
      expect((yield* checkOnceThenPollUntilActive(url.routingUrlId)).status).toBe("active");

      const refused = yield* refusalOf(stack.deploy(urlStack(second)));
      expect(refused?.switchboardDns).toBe("absent");
      expect(refused?.records.map((record) => record.type)).toEqual(["CNAME"]);
      expect((yield* getUrl({ id: url.routingUrlId })).data.hostname).toBe(first);

      const switchboard = switchboardTarget(site.compute!.appEndpointDomain);
      const addresses = yield* Effect.tryPromise(() => resolve4(switchboard)).pipe(Effect.orDie);
      const moved = yield* stack.deploy(urlStack(second, addresses));
      expect(moved.url.hostname).toBe(second);
      expect((yield* getUrl({ id: url.routingUrlId })).data.hostname).toBe(second);
      // The change was saved only once the new records were seen.
      const serving = yield* pollUntilActive(url.routingUrlId);
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
