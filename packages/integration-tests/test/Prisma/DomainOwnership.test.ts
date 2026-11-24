import * as Prisma from "@alchemy.run/prisma";
import { DomainOwnership } from "@alchemy.run/prisma/DomainOwnership";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Retry } from "@distilled.cloud/prisma";
import { getProject, getWorkspaceDomainOwnerships } from "@distilled.cloud/prisma/management";
import { adopt } from "alchemy/AdoptPolicy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as DeployRetry from "alchemy/DeployRetry";
import type * as DNSAdapter from "alchemy/DNS/Adapter";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
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
import {
  DomainVerification,
  DomainVerificationProvider,
} from "../../../prisma/src/internal/DomainVerification.ts";
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
  DnsRecords,
  HOSTNAME as URL_HOSTNAME,
  makeUrlCloud,
  OTHER_WORKSPACE_TXT_VALUE,
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
    providers: Layer.effect(
      TestPrismaProviders,
      Provider.collection([DomainVerification, DomainOwnershipRow]),
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(DomainVerificationProvider(), DomainOwnershipRowProvider()),
      ),
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
        expect(failure).toContain("(Prisma.DomainOwnership)");
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
  "fails with how to move it, and deletes nothing, when the project moves to another workspace",
  (stack) =>
    Effect.gen(function* () {
      moved.reset();
      yield* stack.destroy();
      const first = yield* stack.deploy(ownershipStack());
      expect(first.workspaceId).toBe("ws-1");

      moved.fake.captured.length = 0;
      const failure = yield* failureOf(stack.deploy(ownershipStack("proj-2", "ws-2")));

      expect(failure).toContain(
        `The domain ownership of '${HOSTNAME}' belongs to workspace 'ws-1', but the project is now in workspace 'ws-2'. A domain ownership belongs to a workspace and does not move with a project. Point project back to a project in workspace 'ws-1', or remove this Prisma.DomainOwnership from the stack and deploy, which deletes it from workspace 'ws-1' unless it is retained, then declare it again.`,
      );
      expect([...moved.rows.keys()]).toEqual(["do-created"]);
      expect(moved.routes().some((route) => !route.startsWith("GET"))).toBe(false);

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

const dnsStack = (
  props: { project?: string | ProjectReference; domain?: string; dns?: boolean } = {},
) =>
  DomainOwnership("Ownership", {
    project: props.project ?? "proj-1",
    domain: props.domain ?? URL_HOSTNAME,
    ...(props.dns === false ? {} : { dns: TEST_DNS }),
  });

const WARNED_RECORD = `TXT ${txtFor(URL_HOSTNAME).name} = ${txtFor(URL_HOSTNAME).value}`;
const unverifiedWarning = (domain: string) =>
  `The domain ownership of '${domain}' is unverified: it does not make hostnames it covers serve until Prisma finds ${WARNED_RECORD}, unless another verified domain ownership covers them.`;
const expiringWarning = (domain: string) =>
  `The domain ownership of '${domain}' is expiring. Of the hostnames it covers, those that already serve keep serving until Prisma lapses it after 2026-12-01T00:00:00.000Z, and none starts serving, unless ${WARNED_RECORD} is published or another verified domain ownership covers them.`;
const warningsOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const warnings: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(message));
    });
    const result = yield* effect.pipe(Effect.provide(Logger.layer([logger])));
    return { result, warnings };
  });

const NOT_GET = (cloud: ReturnType<typeof makeUrlCloud>) =>
  cloud.routes().filter((route) => !route.startsWith("GET"));

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
      const changed = yield* stack.deploy(dnsStack({ project: project("proj-1") }));

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

for (const how of ["--adopt", "adopt(true)"] as const) {
  const adoptedWithDns = makeUrlCloud();
  urlTestFor(adoptedWithDns, { adopt: how === "--adopt" }).test.provider(
    `with dns and ${how}, takes an unverified domain ownership, publishes its record and verifies it`,
    (stack) =>
      Effect.gen(function* () {
        adoptedWithDns.reset({ fromZone: true });
        adoptedWithDns.seedOwnership(URL_HOSTNAME, "unverified", "do-1");
        yield* stack.destroy();

        const taken = yield* stack.deploy(
          how === "--adopt" ? dnsStack() : dnsStack().pipe(adopt(true)),
        );

        expect(taken.domainOwnershipId).toBe("do-1");
        expect(taken.status).toBe("verified");
        expect(adoptedWithDns.zone.records).toEqual([txtFor(URL_HOSTNAME)]);
        expect(adoptedWithDns.zone.publishes).toBe(1);
        expect(adoptedWithDns.routes()).not.toContain(CREATE);

        yield* stack.destroy();
        expect(adoptedWithDns.ownerships.size).toBe(0);
        expect(adoptedWithDns.zone.records).toEqual([]);
      }),
    { tags },
  );
}

const OTHER_HOSTNAME = "other.example.com";

const renamed = makeUrlCloud();
urlTestFor(renamed).test.provider(
  "with dns, a domain change deletes the old domain ownership and its record, and publishes the new one",
  (stack) =>
    Effect.gen(function* () {
      renamed.reset({ fromZone: true });
      yield* stack.destroy();
      const first = yield* stack.deploy(dnsStack());

      const second = yield* stack.deploy(dnsStack({ domain: OTHER_HOSTNAME }));

      expect(second.domain).toBe(OTHER_HOSTNAME);
      expect(second.status).toBe("verified");
      expect([...renamed.ownerships.keys()]).toEqual([second.domainOwnershipId]);
      expect(renamed.routes()).toContain(`DELETE /v1/domain-ownerships/${first.domainOwnershipId}`);
      expect(renamed.zone.records).toEqual([txtFor(OTHER_HOSTNAME)]);
      expect(renamed.zone.publishes).toBe(2);

      yield* stack.destroy();
      expect(renamed.ownerships.size).toBe(0);
      expect(renamed.zone.records).toEqual([]);
    }),
  { tags },
);

const renamedOntoForeign = makeUrlCloud();
urlTestFor(renamedOntoForeign).test.provider(
  "with dns, a domain change onto a domain ownership the stack did not record is refused before any publish",
  (stack) =>
    Effect.gen(function* () {
      renamedOntoForeign.reset({ fromZone: true });
      yield* stack.destroy();
      const first = yield* stack.deploy(dnsStack());
      renamedOntoForeign.seedOwnership(OTHER_HOSTNAME, "verified", "do-foreign");

      renamedOntoForeign.fake.captured.length = 0;
      const publishes = renamedOntoForeign.zone.publishes;
      const failure = yield* failureOf(stack.deploy(dnsStack({ domain: OTHER_HOSTNAME })));

      expect(failure).toContain("Cannot replace resource");
      expect(failure).toContain("Prisma.DomainVerification");
      expect(renamedOntoForeign.zone.publishes).toBe(publishes);
      expect(renamedOntoForeign.zone.records).toEqual([txtFor(URL_HOSTNAME)]);
      expect(NOT_GET(renamedOntoForeign)).toEqual([]);
      expect([...renamedOntoForeign.ownerships.keys()].sort()).toEqual(
        [first.domainOwnershipId, "do-foreign"].sort(),
      );

      renamedOntoForeign.ownerships.delete("do-foreign");
      yield* stack.destroy();
      expect(renamedOntoForeign.ownerships.size).toBe(0);
      expect(renamedOntoForeign.zone.records).toEqual([]);
    }),
  { tags },
);

const dnsAdded = makeUrlCloud();
urlTestFor(dnsAdded).test.provider(
  "adding dns to a deployed domain ownership publishes its record and verifies it, with no --adopt",
  (stack) =>
    Effect.gen(function* () {
      dnsAdded.reset({ fromZone: true });
      yield* stack.destroy();
      const first = yield* stack.deploy(dnsStack({ dns: false }));
      expect(first.status).toBe("unverified");
      expect(dnsAdded.zone.publishes).toBe(0);

      const second = yield* stack.deploy(dnsStack());

      expect(second.domainOwnershipId).toBe(first.domainOwnershipId);
      expect(second.status).toBe("verified");
      expect(dnsAdded.zone.records).toEqual([txtFor(URL_HOSTNAME)]);
      expect(dnsAdded.zone.publishes).toBe(1);

      yield* stack.destroy();
      expect(dnsAdded.ownerships.size).toBe(0);
      expect(dnsAdded.zone.records).toEqual([]);
    }),
  { tags },
);

const dnsReadded = makeUrlCloud();
urlTestFor(dnsReadded).test.provider(
  "removing dns deletes the record, and adding it back publishes it again, with no --adopt",
  (stack) =>
    Effect.gen(function* () {
      dnsReadded.reset({ fromZone: true });
      yield* stack.destroy();
      const first = yield* stack.deploy(dnsStack());

      yield* stack.deploy(dnsStack({ dns: false }));
      expect(dnsReadded.zone.records).toEqual([]);

      const third = yield* stack.deploy(dnsStack());

      expect(third.domainOwnershipId).toBe(first.domainOwnershipId);
      expect(dnsReadded.zone.records).toEqual([txtFor(URL_HOSTNAME)]);
      expect(dnsReadded.zone.publishes).toBe(2);

      yield* stack.destroy();
      expect(dnsReadded.ownerships.size).toBe(0);
      expect(dnsReadded.zone.records).toEqual([]);
    }),
  { tags },
);

const wildcardOverApex = makeUrlCloud();
urlTestFor(wildcardOverApex).test.provider(
  "with dns, a wildcard is refused while a domain ownership of its apex that the stack did not record shares the record, and nothing is published",
  (stack) =>
    Effect.gen(function* () {
      wildcardOverApex.reset({ fromZone: true });
      wildcardOverApex.seedOwnership("example.com", "verified", "do-apex");
      yield* stack.destroy();

      const failure = yield* failureOf(stack.deploy(dnsStack({ domain: "*.example.com" })));

      expect(failure).toContain("Cannot adopt resource");
      expect(failure).toContain("Prisma.DomainVerification");
      expect(wildcardOverApex.zone.publishes).toBe(0);
      expect(NOT_GET(wildcardOverApex)).toEqual([]);
      expect([...wildcardOverApex.ownerships.keys()]).toEqual(["do-apex"]);

      wildcardOverApex.reset();
      yield* stack.destroy();
    }),
  { tags },
);

const apexToWildcard = makeUrlCloud();
urlTestFor(apexToWildcard).test.provider(
  "with dns, a change from an apex to its wildcard is not refused by the stack's own apex row, and keeps the one record",
  (stack) =>
    Effect.gen(function* () {
      apexToWildcard.reset({ fromZone: true });
      yield* stack.destroy();
      const first = yield* stack.deploy(dnsStack({ domain: "example.com" }));

      const second = yield* stack.deploy(dnsStack({ domain: "*.example.com" }));

      expect(second.domain).toBe("*.example.com");
      expect(second.status).toBe("verified");
      expect([...apexToWildcard.ownerships.keys()]).toEqual([second.domainOwnershipId]);
      expect(apexToWildcard.routes()).toContain(
        `DELETE /v1/domain-ownerships/${first.domainOwnershipId}`,
      );
      expect(apexToWildcard.zone.records).toEqual([txtFor("example.com")]);

      yield* stack.destroy();
      expect(apexToWildcard.ownerships.size).toBe(0);
      expect(apexToWildcard.zone.records).toEqual([]);
    }),
  { tags },
);

const wildcardWithoutDns = makeUrlCloud();
urlTestFor(wildcardWithoutDns).test.provider(
  "without dns, a wildcard deploys with no --adopt while a domain ownership of its apex that the stack did not record exists",
  (stack) =>
    Effect.gen(function* () {
      wildcardWithoutDns.reset({ fromZone: true });
      wildcardWithoutDns.seedOwnership("example.com", "verified", "do-apex");
      yield* stack.destroy();

      const wildcard = yield* stack.deploy(dnsStack({ domain: "*.example.com", dns: false }));

      expect(wildcard.domain).toBe("*.example.com");
      expect([...wildcardWithoutDns.ownerships.keys()].sort()).toEqual(
        ["do-apex", wildcard.domainOwnershipId].sort(),
      );
      expect(wildcardWithoutDns.zone.publishes).toBe(0);

      yield* stack.destroy();
      expect([...wildcardWithoutDns.ownerships.keys()]).toEqual(["do-apex"]);
    }),
  { tags },
);

const movedWithDns = makeUrlCloud();
urlTestFor(movedWithDns).test.provider(
  "with dns, moving the project to another workspace fails before publishing anything again",
  (stack) =>
    Effect.gen(function* () {
      movedWithDns.reset({ fromZone: true });
      yield* stack.destroy();
      const first = yield* stack.deploy(dnsStack());
      expect(first.workspaceId).toBe("ws-1");

      movedWithDns.fake.captured.length = 0;
      const publishes = movedWithDns.zone.publishes;
      const failure = yield* failureOf(
        stack.deploy(dnsStack({ project: project("proj-2", "ws-2") })),
      );

      expect(failure).toContain(
        `The domain ownership of '${URL_HOSTNAME}' belongs to workspace 'ws-1', but the project is now in workspace 'ws-2'.`,
      );
      expect(movedWithDns.zone.publishes).toBe(publishes);
      expect(movedWithDns.zone.records).toEqual([txtFor(URL_HOSTNAME)]);
      expect(
        movedWithDns.zone.records.some((record) => record.value === OTHER_WORKSPACE_TXT_VALUE),
      ).toBe(false);
      expect(NOT_GET(movedWithDns)).toEqual([]);
      expect([...movedWithDns.ownerships.keys()]).toEqual([first.domainOwnershipId]);

      yield* stack.deploy(Effect.void);

      expect(movedWithDns.routes()).toContain(
        `DELETE /v1/domain-ownerships/${first.domainOwnershipId}`,
      );
      expect(movedWithDns.ownerships.size).toBe(0);
      expect(movedWithDns.zone.records).toEqual([]);
    }),
  { tags },
);

const renamedRetained = makeUrlCloud();
urlTestFor(renamedRetained).test.provider(
  "with dns and RemovalPolicy.retain(), a domain change keeps the old domain ownership and its record",
  (stack) =>
    Effect.gen(function* () {
      renamedRetained.reset({ fromZone: true });
      yield* stack.destroy();
      const first = yield* stack.deploy(dnsStack().pipe(RemovalPolicy.retain()));

      const second = yield* stack.deploy(
        dnsStack({ domain: OTHER_HOSTNAME }).pipe(RemovalPolicy.retain()),
      );

      expect([...renamedRetained.ownerships.keys()].sort()).toEqual(
        [first.domainOwnershipId, second.domainOwnershipId].sort(),
      );
      expect(renamedRetained.zone.records).toEqual(
        expect.arrayContaining([txtFor(URL_HOSTNAME), txtFor(OTHER_HOSTNAME)]),
      );
      expect(renamedRetained.zone.records).toHaveLength(2);

      yield* stack.destroy();
      renamedRetained.reset();
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

for (const status of [429, 503]) {
  const verifyRefused = makeUrlCloud();
  urlTestFor(verifyRefused).test.provider(
    `with dns, gives up a verify request that keeps failing with ${status}, succeeds unverified, and an unchanged redeploy sends one verify request and no other write`,
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
        expect(NOT_GET(verifyRefused)).toEqual(["POST /v1/domain-ownerships/do-1/verify"]);

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

for (const withRecord of [false, true]) {
  const reread = makeUrlCloud();
  urlTestFor(reread).test.provider(
    `${withRecord ? "with dns" : "without dns"}, an unverified row is read on each deploy, checks its record once without waiting, asks Prisma to verify only once the record is seen, and warns while unverified`,
    (stack) =>
      Effect.gen(function* () {
        reread.reset({ txt: "absent", verifiesAs: "unverified" });
        yield* stack.destroy();
        const program = dnsStack({ dns: withRecord });
        const first = yield* warningsOf(stack.deploy(program));
        expect(first.result.status).toBe("unverified");
        expect(first.warnings).toEqual([unverifiedWarning(URL_HOSTNAME)]);
        const id = first.result.domainOwnershipId;

        reread.fake.captured.length = 0;
        const absent = yield* warningsOf(stack.deploy(program));
        expect(absent.result.status).toBe("unverified");
        expect(absent.warnings).toEqual([unverifiedWarning(URL_HOSTNAME)]);
        expect(NOT_GET(reread)).toEqual([]);
        expect(reread.state.txtOptions.at(-1)).toEqual({
          margin: "always",
          nameservers: "parent",
          attempts: "once",
        });

        reread.state.txt = "seen";
        reread.state.verifiesAs = "verified";
        reread.fake.captured.length = 0;
        const seen = yield* warningsOf(stack.deploy(program));
        expect(seen.result.status).toBe("verified");
        expect(seen.warnings).toEqual([]);
        expect(NOT_GET(reread)).toEqual([`POST /v1/domain-ownerships/${id}/verify`]);

        reread.fake.captured.length = 0;
        yield* stack.deploy(program);
        expect(reread.routes()).toEqual([]);

        yield* stack.destroy();
      }),
    { tags },
  );
}

const expiringRow = makeUrlCloud();
urlTestFor(expiringRow, { adopt: true }).test.provider(
  "an expiring row warns once on each deploy, with Prisma's rule for an expiring domain ownership",
  (stack) =>
    Effect.gen(function* () {
      expiringRow.reset({ txt: "absent", verifiesAs: "expiring" });
      expiringRow.seedOwnership(URL_HOSTNAME, "expiring", "do-backfill");
      yield* stack.destroy();
      const program = dnsStack({ dns: false });

      const first = yield* warningsOf(stack.deploy(program));
      expect(first.warnings).toEqual([expiringWarning(URL_HOSTNAME)]);
      const again = yield* warningsOf(stack.deploy(program));
      expect(again.warnings).toEqual([expiringWarning(URL_HOSTNAME)]);

      yield* stack.destroy();
    }),
  { tags },
);

const replacedByAdmin = makeUrlCloud();
urlTestFor(replacedByAdmin).test.provider(
  "an unverified row an Admin deleted is found again or created with a new id, and a resource that reads its id sees the new one",
  (stack) =>
    Effect.gen(function* () {
      replacedByAdmin.reset({ verifiesAs: "unverified" });
      yield* stack.destroy();
      const program = Effect.gen(function* () {
        const ownership = yield* dnsStack({ dns: false });
        yield* DnsRecords("IdProbe", {
          records: Output.map(ownership.domainOwnershipId, (id): DNSAdapter.DnsRecord[] => [
            { name: "probe.example.com", type: "TXT", value: id },
          ]),
        });
        return ownership;
      });
      const first = yield* stack.deploy(program);

      replacedByAdmin.ownerships.delete(first.domainOwnershipId);
      const second = yield* stack.deploy(program);

      expect(second.domainOwnershipId).not.toBe(first.domainOwnershipId);
      expect(replacedByAdmin.zone.records.map((record) => record.value)).toEqual([
        second.domainOwnershipId,
      ]);

      yield* stack.destroy();
    }),
  { tags },
);

/** A record whose value reports what `found` resolved to, so a deploy shows the lookup's attributes. */
const lookupProbe = (found: DomainOwnership) =>
  DnsRecords("Probe", {
    records: Output.map(
      Output.all(found.recordName, found.domainOwnershipId, found.domain, found.status),
      ([name, id, domain, status]): DNSAdapter.DnsRecord[] => [
        { name, type: "TXT", value: `${id} ${domain} ${status}` },
      ],
    ),
  });

const lookupTags = [...tags, "provider:prisma:lookup"];

const lookedUp = makeUrlCloud();
urlTestFor(lookedUp).test.provider(
  "lookup finds a domain ownership made in the Console by its exact domain and writes nothing to Prisma",
  (stack) =>
    Effect.gen(function* () {
      lookedUp.reset();
      lookedUp.seedOwnership("*.example.com", "verified", "do-console");
      lookedUp.seedOwnership("example.com", "unverified", "do-apex");
      yield* stack.destroy();

      yield* stack.deploy(
        lookupProbe(DomainOwnership.lookup({ project: "proj-1", domain: "*.Example.com." })),
      );

      expect(lookedUp.zone.records).toEqual([
        {
          name: "_prisma-verification.example.com",
          type: "TXT",
          value: "do-console *.example.com verified",
        },
      ]);
      expect(NOT_GET(lookedUp)).toEqual([]);

      yield* stack.destroy();
      expect([...lookedUp.ownerships.keys()].sort()).toEqual(["do-apex", "do-console"]);
    }),
  { tags: lookupTags },
);

const lookedUpInDev = makeUrlCloud();
urlTestFor(lookedUpInDev, { dev: true }).test.provider(
  "lookup asks Prisma under alchemy dev too",
  (stack) =>
    Effect.gen(function* () {
      lookedUpInDev.reset();
      lookedUpInDev.seedOwnership("*.example.com", "verified", "do-console");
      yield* stack.destroy();

      yield* stack.deploy(
        lookupProbe(DomainOwnership.lookup({ project: "proj-1", domain: "*.example.com" })),
      );

      expect(lookedUpInDev.zone.records.map((record) => record.value)).toEqual([
        "do-console *.example.com verified",
      ]);
      expect(lookedUpInDev.routes()).toContain(LIST);

      yield* stack.destroy();
    }),
  { tags: lookupTags },
);

const lookedUpMissing = makeUrlCloud();
urlTestFor(lookedUpMissing).test.provider(
  "lookup of a domain ownership that does not exist fails the deploy with LookupNotFoundError",
  (stack) =>
    Effect.gen(function* () {
      lookedUpMissing.reset();
      lookedUpMissing.seedOwnership("*.example.com", "verified", "do-console");
      yield* stack.destroy();

      const exit = yield* Effect.exit(
        stack.deploy(
          lookupProbe(DomainOwnership.lookup({ project: "proj-1", domain: "app.example.com" })),
        ),
      );

      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("LookupNotFoundError");
      expect(NOT_GET(lookedUpMissing)).toEqual([]);

      yield* stack.destroy();
    }),
  { tags: lookupTags },
);

const lookedUpManaged = makeUrlCloud();
urlTestFor(lookedUpManaged).test.provider(
  "lookup of a domain ownership this stack manages fails the deploy with LookupOfManagedResourceError",
  (stack) =>
    Effect.gen(function* () {
      lookedUpManaged.reset({ fromZone: true });
      yield* stack.destroy();
      yield* stack.deploy(dnsStack());

      lookedUpManaged.fake.captured.length = 0;
      const exit = yield* Effect.exit(
        stack.deploy(
          Effect.gen(function* () {
            yield* dnsStack();
            return yield* lookupProbe(
              DomainOwnership.lookup({ project: "proj-1", domain: URL_HOSTNAME }),
            );
          }),
        ),
      );

      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
        "LookupOfManagedResourceError",
      );
      expect(NOT_GET(lookedUpManaged)).toEqual([]);

      yield* stack.destroy();
      expect(lookedUpManaged.ownerships.size).toBe(0);
    }),
  { tags: lookupTags },
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
