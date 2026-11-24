import * as Prisma from "@alchemy.run/prisma";
import { DomainOwnership } from "@alchemy.run/prisma/DomainOwnership";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Retry } from "@distilled.cloud/prisma";
import { getProject, getWorkspaceDomainOwnerships } from "@distilled.cloud/prisma/management";
import { adopt } from "alchemy/AdoptPolicy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as DeployRetry from "alchemy/DeployRetry";
import * as DNS from "alchemy/DNS/Adapter";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { ResourceLike } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import {
  AuthoritativeRecordCheck,
  type RecordVisibility,
  type CheckOptions,
} from "../../../prisma/src/internal/AuthoritativeDns.ts";
import type { ProjectReference } from "../../../prisma/src/internal/DomainOwnership.ts";
import {
  DomainOwnershipRow,
  DomainOwnershipRowProvider,
} from "../../../prisma/src/internal/DomainOwnershipRow.ts";
import { DomainVerification } from "../../../prisma/src/internal/DomainVerification.ts";
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
} from "./fixtures/FakeManagementApi.ts";
import { failureOf as failuresOf } from "./fixtures/Live.ts";
import {
  HOSTNAME as URL_HOSTNAME,
  makeUrlCloud,
  TEST_DNS,
  testFor as urlTestFor,
  txtFor,
} from "./fixtures/RoutingUrlCloud.ts";
import { onTestClock } from "./fixtures/TestClock.ts";

const HOSTNAME = "app.example.com";
const RECORD = {
  type: "TXT",
  name: `_prisma-verification.${HOSTNAME}`,
  value: `prisma-verification=${"a".repeat(64)}`,
  ttl: 300,
};

type Status = "unverified" | "verified" | "expiring";

const ownership = (id: string, status: Status, workspaceId = "ws-1") => ({
  id,
  type: "domainOwnership",
  workspaceId,
  domain: HOSTNAME,
  verification: RECORD,
  status,
  expiresAt: status === "expiring" ? "2026-12-01T00:00:00.000Z" : null,
  verificationRecordLastSeenAt: status === "unverified" ? null : "2026-11-06T00:00:00.000Z",
  verificationRecordPresent: status === "unverified" ? null : status === "verified",
  verificationRecordSyncError: null,
  createdAt: WIRE_CREATED_AT,
});

type WireOwnership = ReturnType<typeof ownership>;

interface CloudState {
  /** What the authoritative nameservers report for the record. */
  visibility: RecordVisibility;
  /** The status the verify route reports. */
  verifiesAs: Status;
  /** A row only the create returns, as if another stack created it the moment before. */
  unlisted: WireOwnership | undefined;
  /** Whether every verify request fails with a 503. */
  verifyFails: boolean;
  /** The options the record check was last called with. */
  checkedWith: CheckOptions | undefined;
  /**
   * Answers the next creates give, in order: `503` after creating the row, as
   * when Prisma processed the request but the reply was lost; `429` without
   * creating it.
   */
  createFailures: Array<503 | 429>;
}

/** Workspaces' domain ownerships, served over the Management API routes. */
const makeOwnershipCloud = () => {
  const rows = new Map<string, WireOwnership>();
  const state: CloudState = {
    visibility: "absent",
    verifiesAs: "verified",
    unlisted: undefined,
    verifyFails: false,
    checkedWith: undefined,
    createFailures: [],
  };
  const fake: FakeManagementApi = makeFakeManagementApi((request) => {
    const path = request.pathname;
    const workspace = /^\/v1\/workspaces\/([^/]+)\/domain-ownerships(\/verification)?$/.exec(path);
    if (workspace?.[2]) return data(RECORD);
    if (workspace) {
      const workspaceId = workspace[1]!;
      const inWorkspace = Array.from(rows.values()).filter(
        (row) => row.workspaceId === workspaceId,
      );
      const createdId = workspaceId === "ws-1" ? "do-created" : `do-created-${workspaceId}`;
      if (request.method === "GET") return page(inWorkspace);
      if (request.method === "POST") {
        const injected = state.createFailures.shift();
        if (injected === 429) return failure(429, "rate-limited", "Too many requests");
        if (injected === 503) {
          const processed = ownership(createdId, "unverified", workspaceId);
          rows.set(processed.id, processed);
          return failure(503, "service-unavailable", "Service unavailable");
        }
        const existing = state.unlisted ?? inWorkspace[0];
        if (existing) {
          rows.set(existing.id, existing);
          state.unlisted = undefined;
          return data(existing);
        }
        const created = ownership(createdId, "unverified", workspaceId);
        rows.set(created.id, created);
        return data(created, { status: 201 });
      }
    }
    const [, , , id, action] = path.split("/");
    if (path.startsWith("/v1/domain-ownerships/") && id !== undefined) {
      const row = rows.get(id);
      if (row === undefined) return notFound("Domain ownership not found.");
      if (action === "verify" && request.method === "POST") {
        if (state.verifyFails) return failure(503, "service-unavailable", "Service unavailable");
        const checked = { ...row, status: state.verifiesAs };
        rows.set(id, checked);
        return data(checked);
      }
      if (action === undefined && request.method === "GET") return data(row);
      if (action === undefined && request.method === "DELETE") {
        rows.delete(id);
        return noContent();
      }
    }
    return unhandled(request);
  });
  const reset = (options: Partial<CloudState> = {}, ...initial: WireOwnership[]) => {
    rows.clear();
    for (const row of initial) rows.set(row.id, row);
    Object.assign(state, {
      visibility: "absent",
      verifiesAs: "verified",
      unlisted: undefined,
      verifyFails: false,
      checkedWith: undefined,
      createFailures: [],
    });
    Object.assign(state, options);
    fake.captured.length = 0;
  };
  const routes = () => routesOf(fake.captured);
  const deleted = () => routes().some((route) => route.startsWith("DELETE"));
  return { fake, rows, state, reset, routes, deleted };
};

type OwnershipCloud = ReturnType<typeof makeOwnershipCloud>;

class TestPrismaProviders extends Provider.ProviderCollection<TestPrismaProviders>()("Prisma") {}

const testFor = (cloud: OwnershipCloud, adopt = false) =>
  Test.make({
    adopt,
    providers: Layer.effect(TestPrismaProviders, Provider.collection([DomainOwnershipRow])).pipe(
      Layer.provideMerge(DomainOwnershipRowProvider()),
      Layer.provide(
        Layer.succeed(AuthoritativeRecordCheck, (_record, options) =>
          Effect.sync(() => {
            cloud.state.checkedWith = options;
            return cloud.state.visibility;
          }),
        ),
      ),
      Layer.provide(
        Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
      ),
      // The policy every deploy installs, which retries 5xx and transport
      // failures.
      Layer.provideMerge(Layer.succeed(Retry.Retry, DeployRetry.policy)),
      Layer.provideMerge(cloud.fake.layer),
    ),
  });

const project = (projectId: string, workspaceId = "ws-1"): ProjectReference =>
  ({ projectId, workspaceId }) as ProjectReference;

const ownershipStack = (projectId = "proj-1", workspaceId = "ws-1") =>
  DomainOwnership("Ownership", { project: project(projectId, workspaceId), domain: HOSTNAME });

const CREATE = "POST /v1/workspaces/ws-1/domain-ownerships";
const LIST = "GET /v1/workspaces/ws-1/domain-ownerships";
const VERIFIES = (cloud: OwnershipCloud) =>
  cloud.routes().filter((route) => route.endsWith("/verify"));
const tags = ["unit", "provider:prisma", "provider:prisma:domainownership"];

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => (Result.isFailure(result) ? String(result.failure) : undefined)),
  );

const created = makeOwnershipCloud();
testFor(created).test.provider(
  "without dns, creates the domain ownership with no TXT record anywhere and succeeds unverified, with the record in the attributes",
  (stack) =>
    Effect.gen(function* () {
      created.reset();
      yield* stack.destroy();

      const ownership = yield* stack.deploy(ownershipStack());

      expect(ownership.domainOwnershipId).toBe("do-created");
      expect(ownership.status).toBe("unverified");
      expect(ownership.recordName).toBe(RECORD.name);
      expect(ownership.recordValue).toBe(RECORD.value);
      expect(created.state.checkedWith).toBe(undefined);
      expect(created.routes().filter((route) => route === CREATE)).toEqual([CREATE]);
      expect(created.routes().filter((route) => route === LIST)).toEqual([LIST, LIST]);
      expect(VERIFIES(created)).toEqual([]);

      yield* stack.destroy();
      expect(created.rows.size).toBe(0);
    }),
  { tags },
);

const lostReply = makeOwnershipCloud();
testFor(lostReply).test.provider(
  "resends a create whose reply was lost, and owns the row the resend returns",
  (stack) =>
    Effect.gen(function* () {
      lostReply.reset({ createFailures: [503] });
      yield* stack.destroy();

      const ownership = yield* stack.deploy(ownershipStack());

      expect(ownership.domainOwnershipId).toBe("do-created");
      expect(lostReply.routes().filter((route) => route === CREATE)).toEqual([CREATE, CREATE]);

      yield* stack.destroy();
      expect(lostReply.routes()).toContain("DELETE /v1/domain-ownerships/do-created");
    }),
  { tags },
);

const throttled = makeOwnershipCloud();
testFor(throttled).test.provider(
  "resends a create Prisma throttled, and owns the row it then creates",
  (stack) =>
    Effect.gen(function* () {
      throttled.reset({ createFailures: [429] });
      yield* stack.destroy();

      const ownership = yield* stack.deploy(ownershipStack());

      expect(ownership.domainOwnershipId).toBe("do-created");
      expect(throttled.routes().filter((route) => route === CREATE)).toEqual([CREATE, CREATE]);

      yield* stack.destroy();
    }),
  { tags },
);

const returned = makeOwnershipCloud();
testFor(returned).test.provider(
  "owns a verified domain ownership the create returns",
  (stack) =>
    Effect.gen(function* () {
      returned.reset({ unlisted: ownership("do-raced", "verified") });
      yield* stack.destroy();

      const proved = yield* stack.deploy(ownershipStack());

      expect(proved.domainOwnershipId).toBe("do-raced");
      expect(proved.status).toBe("verified");
      expect(returned.routes()).toContain(CREATE);

      yield* stack.destroy();
      expect(returned.routes()).toContain("DELETE /v1/domain-ownerships/do-raced");
    }),
  { tags },
);

for (const status of ["unverified", "verified", "expiring"] as const) {
  const foreign = makeOwnershipCloud();
  testFor(foreign).test.provider(
    `refuses a domain ownership it did not record without --adopt, while it is ${status}`,
    (stack) =>
      Effect.gen(function* () {
        foreign.reset({}, ownership("do-1", status));
        yield* stack.destroy();

        const failure = yield* failureOf(stack.deploy(ownershipStack()));

        expect(failure).toContain("Cannot adopt resource");
        expect(foreign.routes().some((route) => route.startsWith("POST"))).toBe(false);
        expect(foreign.deleted()).toBe(false);

        foreign.reset();
        yield* stack.destroy();
      }),
    { tags },
  );
}

const adoptedUnverified = makeOwnershipCloud();
testFor(adoptedUnverified, true).test.provider(
  "with --adopt, takes an unverified domain ownership and sends exactly one verify request",
  (stack) =>
    Effect.gen(function* () {
      adoptedUnverified.reset({ verifiesAs: "unverified" }, ownership("do-1", "unverified"));
      yield* stack.destroy();

      const taken = yield* stack.deploy(ownershipStack());

      expect(taken.domainOwnershipId).toBe("do-1");
      expect(taken.status).toBe("unverified");
      expect(adoptedUnverified.routes()).not.toContain(CREATE);
      expect(VERIFIES(adoptedUnverified)).toEqual(["POST /v1/domain-ownerships/do-1/verify"]);

      yield* stack.destroy();
      expect(adoptedUnverified.routes()).toContain("DELETE /v1/domain-ownerships/do-1");
    }),
  { tags },
);

const adoptedInCode = makeOwnershipCloud();
testFor(adoptedInCode).test.provider(
  "adopt(true) takes a verified domain ownership without --adopt",
  (stack) =>
    Effect.gen(function* () {
      adoptedInCode.reset({}, ownership("do-1", "verified"));
      yield* stack.destroy();

      const taken = yield* stack.deploy(ownershipStack().pipe(adopt(true)));

      expect(taken.domainOwnershipId).toBe("do-1");
      expect(adoptedInCode.routes().some((route) => route.startsWith("POST"))).toBe(false);

      yield* stack.destroy();
      expect(adoptedInCode.routes()).toContain("DELETE /v1/domain-ownerships/do-1");
    }),
  { tags },
);

const verifyFails = makeOwnershipCloud();
testFor(verifyFails, true).test.provider(
  "a verify request that keeps failing is given up, and the deploy reports the row as read",
  (stack) =>
    Effect.gen(function* () {
      verifyFails.reset({ verifyFails: true }, ownership("do-1", "unverified"));
      yield* stack.destroy();

      const deployed = yield* onTestClock(stack.deploy(ownershipStack()));

      expect(Result.isSuccess(deployed) && deployed.success.status).toBe("unverified");
      expect(VERIFIES(verifyFails)).toHaveLength(DeployRetry.MAX_RETRIES + 1);
      expect(verifyFails.deleted()).toBe(false);

      verifyFails.reset();
      yield* stack.destroy();
    }),
  { tags },
);

const replaced = makeOwnershipCloud();
testFor(replaced).test.provider(
  "takes and records the row found by domain when the stored id is gone",
  (stack) =>
    Effect.gen(function* () {
      replaced.reset();
      yield* stack.destroy();
      const first = yield* stack.deploy(ownershipStack());
      expect(first.domainOwnershipId).toBe("do-created");

      // The row is replaced out of band; a changed project makes the deploy
      // reconcile from the stored id.
      replaced.reset({}, ownership("do-2", "verified"));
      const second = yield* stack.deploy(ownershipStack("proj-2"));

      expect(second.domainOwnershipId).toBe("do-2");
      expect(replaced.routes()).toContain("GET /v1/domain-ownerships/do-created");
      expect(replaced.routes().some((route) => route.startsWith("POST"))).toBe(false);
      expect(replaced.deleted()).toBe(false);

      yield* stack.destroy();
      expect(replaced.routes()).toContain("DELETE /v1/domain-ownerships/do-2");
    }),
  { tags },
);

const moved = makeOwnershipCloud();
testFor(moved).test.provider(
  "deletes the recorded row when the project moves to another workspace, and records the new one",
  (stack) =>
    Effect.gen(function* () {
      moved.reset();
      yield* stack.destroy();
      const first = yield* stack.deploy(ownershipStack());
      expect(first.workspaceId).toBe("ws-1");

      const second = yield* stack.deploy(ownershipStack("proj-2", "ws-2"));

      expect(second.domainOwnershipId).toBe("do-created-ws-2");
      expect(second.workspaceId).toBe("ws-2");
      expect([...moved.rows.keys()]).toEqual(["do-created-ws-2"]);
      expect(moved.routes()).toContain("DELETE /v1/domain-ownerships/do-created");

      yield* stack.destroy();
      expect(moved.rows.size).toBe(0);
    }),
  { tags },
);

const expiring = makeOwnershipCloud();
testFor(expiring, true).test.provider(
  "reports an expiring domain ownership as expiring, and deletes nothing",
  (stack) =>
    Effect.gen(function* () {
      expiring.reset({ verifiesAs: "expiring" }, ownership("do-1", "expiring"));
      yield* stack.destroy();

      const taken = yield* stack.deploy(ownershipStack());

      expect(taken.status).toBe("expiring");
      expect(VERIFIES(expiring)).toEqual(["POST /v1/domain-ownerships/do-1/verify"]);
      expect(expiring.deleted()).toBe(false);

      expiring.reset();
      yield* stack.destroy();
    }),
  { tags },
);

const dnsStack = (props: { project?: string | ProjectReference } = {}) =>
  DomainOwnership("Ownership", {
    project: props.project ?? "proj-1",
    domain: URL_HOSTNAME,
    dns: TEST_DNS,
  });

const OWNERSHIP_VERIFIES = (cloud: ReturnType<typeof makeUrlCloud>) =>
  cloud.routes().filter((route) => /^POST \/v1\/domain-ownerships\/[^/]+\/verify$/.test(route));

const withDns = makeUrlCloud();
urlTestFor(withDns).test.provider(
  "with dns, publishes the record and sees it at the nameservers before Prisma creates the row, so the create verifies it",
  (stack) =>
    Effect.gen(function* () {
      withDns.reset({ fromZone: true });
      yield* stack.destroy();

      const ownership = yield* stack.deploy(dnsStack());

      expect(ownership.status).toBe("verified");
      expect(withDns.zone.records).toEqual([txtFor(URL_HOSTNAME)]);
      expect(
        withDns.state.atOwnershipCreate.map(({ txtPublished, txtChecks }) => ({
          txtPublished,
          txtChecks,
        })),
      ).toEqual([{ txtPublished: true, txtChecks: 1 }]);
      expect(withDns.state.txtOptions).toEqual([
        {
          margin: "always",
          nameservers: "parent",
          attempts: "until-seen",
          waitFor: Duration.minutes(3),
        },
      ]);
      expect(OWNERSHIP_VERIFIES(withDns)).toEqual([]);

      withDns.fake.captured.length = 0;
      yield* stack.deploy(dnsStack());
      expect(withDns.routes().some((route) => !route.startsWith("GET"))).toBe(false);

      yield* stack.destroy();
      expect(withDns.ownerships.size).toBe(0);
      expect(withDns.zone.records).toEqual([]);
    }),
  { tags },
);

const recordAbsent = makeUrlCloud();
urlTestFor(recordAbsent).test.provider(
  "with dns, saves the row unverified and sends no verify request when the record never reaches the nameservers",
  (stack) =>
    Effect.gen(function* () {
      recordAbsent.reset({ txt: "absent", verifiesAs: "unverified" });
      yield* stack.destroy();

      const ownership = yield* stack.deploy(dnsStack());

      expect(ownership.status).toBe("unverified");
      expect(recordAbsent.ownerships.size).toBe(1);
      expect(OWNERSHIP_VERIFIES(recordAbsent)).toEqual([]);

      yield* stack.destroy();
    }),
  { tags },
);

const neverVerified = makeUrlCloud();
urlTestFor(neverVerified).test.provider(
  "with dns, succeeds unverified after 7 verify requests when Prisma does not verify, and a later deploy needs no --adopt",
  (stack) =>
    Effect.gen(function* () {
      neverVerified.reset({ fromZone: true, verifiesAs: "unverified" });
      yield* stack.destroy();

      const deployed = yield* onTestClock(stack.deploy(dnsStack()));

      expect(Result.isSuccess(deployed) && deployed.success.status).toBe("unverified");
      expect(OWNERSHIP_VERIFIES(neverVerified)).toHaveLength(7);
      expect(neverVerified.ownerships.size).toBe(1);

      neverVerified.state.verifiesAs = undefined;
      neverVerified.fake.captured.length = 0;
      const changed = yield* stack.deploy(
        dnsStack({ project: { projectId: "proj-1", workspaceId: "ws-1" } as ProjectReference }),
      );

      expect(changed.domainOwnershipId).toBe([...neverVerified.ownerships.keys()][0]);
      expect(neverVerified.routes()).not.toContain(CREATE);

      yield* stack.destroy();
      expect(neverVerified.ownerships.size).toBe(0);
    }),
  { tags, timeout: 60_000 },
);

const refusedBeforeDns = makeUrlCloud();
urlTestFor(refusedBeforeDns).test.provider(
  "with dns, a domain ownership refused for want of --adopt publishes no record",
  (stack) =>
    Effect.gen(function* () {
      refusedBeforeDns.reset({ fromZone: true });
      refusedBeforeDns.seedOwnership(URL_HOSTNAME, "verified");
      yield* stack.destroy();

      const failure = yield* failureOf(stack.deploy(dnsStack()));

      expect(failure).toContain("Cannot adopt resource");
      expect(failure).toContain("Prisma.DomainVerification");
      expect(refusedBeforeDns.zone.publishes).toBe(0);
      expect(refusedBeforeDns.routes().some((route) => !route.startsWith("GET"))).toBe(false);

      refusedBeforeDns.reset();
      yield* stack.destroy();
    }),
  { tags },
);

const retained = makeUrlCloud();
urlTestFor(retained).test.provider(
  "with dns and RemovalPolicy.retain(), destroy keeps the row and the record",
  (stack) =>
    Effect.gen(function* () {
      retained.reset({ fromZone: true });
      yield* stack.destroy();

      yield* stack.deploy(dnsStack().pipe(RemovalPolicy.retain()));
      yield* stack.destroy();

      expect(retained.ownerships.size).toBe(1);
      expect(retained.zone.records).toEqual([txtFor(URL_HOSTNAME)]);
    }),
  { tags },
);

const inDev = makeUrlCloud();
urlTestFor(inDev, { dev: true }).test.provider(
  "with dns, publishes nothing under alchemy dev",
  (stack) =>
    Effect.gen(function* () {
      inDev.reset();
      yield* stack.destroy();

      const ownership = yield* stack.deploy(dnsStack());

      expect(ownership.domainOwnershipId).toContain("dev:");
      expect(inDev.zone.publishes).toBe(0);
      expect(inDev.routes()).toEqual([]);

      yield* stack.destroy();
    }),
  { tags },
);

const publishedBeforeRow = Effect.gen(function* () {
  const verification = yield* DomainVerification("Verification", {
    project: "proj-1",
    domain: URL_HOSTNAME,
  });
  const published = yield* (yield* DNS.resolve(TEST_DNS)).records("Record", {
    records: Output.map(
      Output.all(verification.recordName, verification.recordValue),
      ([name, value]): DNS.DnsRecord[] => [{ name, type: "TXT", value }],
    ),
  });
  return yield* DomainOwnershipRow("Ownership", {
    project: "proj-1",
    domain: Output.map(Output.of(published as ResourceLike), () => URL_HOSTNAME),
  });
}).pipe(Namespace.push("Ownership"));

const upgraded = makeUrlCloud();
urlTestFor(upgraded).test.provider(
  "with dns, a verified row recorded without publishesRecord redeploys with no write",
  (stack) =>
    Effect.gen(function* () {
      upgraded.reset({ fromZone: true });
      yield* stack.destroy();
      yield* stack.deploy(publishedBeforeRow);
      upgraded.ownerships.set("do-1", { ...upgraded.ownerships.get("do-1")!, status: "verified" });

      upgraded.fake.captured.length = 0;
      const publishes = upgraded.zone.publishes;
      const ownership = yield* stack.deploy(dnsStack());

      expect(ownership.status).toBe("verified");
      expect(upgraded.zone.publishes).toBe(publishes);
      expect(
        upgraded
          .routes()
          .some((route) => route.includes("domain-ownerships") && !route.startsWith("GET")),
      ).toBe(false);

      yield* stack.destroy();
    }),
  { tags },
);

for (const status of [429, 503]) {
  const verifyRefused = makeUrlCloud();
  urlTestFor(verifyRefused).test.provider(
    `with dns, gives up a verify request that keeps failing with ${status}, succeeds unverified, and an unchanged redeploy sends no write`,
    (stack) =>
      Effect.gen(function* () {
        verifyRefused.reset({
          fromZone: true,
          verifiesAs: "unverified",
          throttle: Array.from({ length: 20 }, () => ({
            route: "POST /v1/domain-ownerships/do-1/verify",
            retryAfter: 0,
            status,
          })),
        });
        yield* stack.destroy();

        const deployed = yield* onTestClock(stack.deploy(dnsStack()));

        expect(Result.isSuccess(deployed) && deployed.success.status).toBe("unverified");
        expect(verifyRefused.state.throttle).toHaveLength(20 - (DeployRetry.MAX_RETRIES + 1));

        verifyRefused.state.throttle = [];
        verifyRefused.fake.captured.length = 0;
        yield* stack.deploy(dnsStack());
        expect(verifyRefused.routes().some((route) => !route.startsWith("GET"))).toBe(false);

        yield* stack.destroy();
      }),
    { tags, timeout: 60_000 },
  );
}

const deletedMidDeploy = makeUrlCloud();
urlTestFor(deletedMidDeploy).test.provider(
  "with dns, a row deleted before its verify fails the deploy with how to recover, and the redeploy creates it again",
  (stack) =>
    Effect.gen(function* () {
      deletedMidDeploy.reset({
        fromZone: true,
        verifiesAs: "unverified",
        throttle: [{ route: "POST /v1/domain-ownerships/do-1/verify", retryAfter: 0, status: 404 }],
      });
      yield* stack.destroy();

      const failure = yield* failureOf(stack.deploy(dnsStack()));
      expect(failure).toContain("was deleted during the deploy. Redeploy to create it again.");

      deletedMidDeploy.ownerships.clear();
      deletedMidDeploy.state.verifiesAs = undefined;
      const ownership = yield* stack.deploy(dnsStack());

      expect(ownership.status).toBe("verified");
      expect([...deletedMidDeploy.ownerships.keys()]).toEqual([ownership.domainOwnershipId]);

      yield* stack.destroy();
      expect(deletedMidDeploy.ownerships.size).toBe(0);
    }),
  { tags },
);

const live = Test.make({ providers: Prisma.providers() });

live.test.provider(
  "saves a domain ownership unverified with the record to publish while the TXT record is absent, and destroy deletes it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const domain = `do-absent-${stack.stage.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.example.com`;
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Prisma.Project("Project", { createDatabase: false });
          const ownership = yield* Prisma.DomainOwnership("Ownership", { project, domain });
          return { project, ownership };
        }),
      );
      const workspaceId = (yield* getProject({ id: deployed.project.projectId })).data.workspace.id;

      expect(deployed.ownership.status).toBe("unverified");
      expect(deployed.ownership.recordName).toBe(`_prisma-verification.${domain}`);
      expect(deployed.ownership.recordValue).toMatch(/^prisma-verification=[0-9a-f]{64}$/);
      const saved = (yield* getWorkspaceDomainOwnerships({ workspaceId, domain })).data;
      expect(saved.filter((row) => row.domain === domain).map((row) => row.id)).toEqual([
        deployed.ownership.domainOwnershipId,
      ]);

      yield* stack.destroy();
      const left = (yield* getWorkspaceDomainOwnerships({ workspaceId, domain })).data;
      expect(left.filter((row) => row.domain === domain)).toEqual([]);
    }),
  {
    tags: ["live", "provider:prisma", "provider:prisma:domainownership", "provider:prisma:project"],
    timeout: 300_000,
  },
);
