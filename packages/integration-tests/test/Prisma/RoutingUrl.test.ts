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
  type WaitOptions,
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
import {
  AppRef,
  HOSTNAME,
  makeUrlCloud,
  recordsFor,
  routingUrl,
  TEST_DNS,
  testFor,
  TXT,
  type UrlCloud,
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
      expect(dnsChange.state.txtAttempts).toEqual(["until-seen"]);
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
