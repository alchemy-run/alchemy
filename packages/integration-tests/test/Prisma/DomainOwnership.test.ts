import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import {
  AuthoritativeRecordCheck,
  type RecordVisibility,
} from "../../../prisma/src/internal/AuthoritativeDns.ts";
import type { ProjectReference } from "../../../prisma/src/internal/DomainOwnership.ts";
import {
  DomainOwnershipProof,
  DomainOwnershipProofProvider,
} from "../../../prisma/src/internal/DomainOwnershipProof.ts";
import {
  data,
  type FakeManagementApi,
  makeFakeManagementApi,
  noContent,
  notFound,
  page,
  routesOf,
  unhandled,
  WIRE_CREATED_AT,
} from "./fixtures/FakeManagementApi.ts";

const HOSTNAME = "app.example.com";
const RECORD = {
  type: "TXT",
  name: `_prisma-verification.${HOSTNAME}`,
  value: `prisma-verification=${"a".repeat(64)}`,
  ttl: 300,
};

type Status = "unverified" | "verified" | "expiring";

const ownership = (id: string, status: Status) => ({
  id,
  type: "domainOwnership",
  workspaceId: "ws-1",
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
  /** A row the list route does not show yet, as if it appeared mid-deploy. */
  unlisted: WireOwnership | undefined;
}

/** One workspace's domain ownerships, served over the Management API routes. */
const makeOwnershipCloud = () => {
  const rows = new Map<string, WireOwnership>();
  const state: CloudState = { visibility: "absent", verifiesAs: "verified", unlisted: undefined };
  const fake: FakeManagementApi = makeFakeManagementApi((request) => {
    const path = request.pathname;
    if (path === "/v1/workspaces/ws-1/domain-ownerships/verification") {
      return data(RECORD);
    }
    if (path === "/v1/workspaces/ws-1/domain-ownerships") {
      if (request.method === "GET") return page(Array.from(rows.values()));
      if (request.method === "POST") {
        const existing = state.unlisted ?? Array.from(rows.values())[0];
        if (existing) {
          rows.set(existing.id, existing);
          state.unlisted = undefined;
          return data(existing);
        }
        const created = ownership("do-created", "unverified");
        rows.set(created.id, created);
        return data(created, { status: 201 });
      }
    }
    const [, , , id, action] = path.split("/");
    if (path.startsWith("/v1/domain-ownerships/") && id !== undefined) {
      const row = rows.get(id);
      if (row === undefined) return notFound("Domain ownership not found.");
      if (action === "verify" && request.method === "POST") {
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
    Object.assign(state, { visibility: "absent", verifiesAs: "verified", unlisted: undefined });
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
    providers: Layer.effect(TestPrismaProviders, Provider.collection([DomainOwnershipProof])).pipe(
      Layer.provideMerge(DomainOwnershipProofProvider()),
      Layer.provide(
        Layer.succeed(AuthoritativeRecordCheck, () => Effect.succeed(cloud.state.visibility)),
      ),
      Layer.provide(
        Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
      ),
      Layer.provideMerge(cloud.fake.layer),
    ),
  });

const project = (projectId: string): ProjectReference =>
  ({ projectId, workspaceId: "ws-1" }) as ProjectReference;

const ownershipStack = (projectId = "proj-1") =>
  DomainOwnershipProof("Ownership", { project: project(projectId), domain: HOSTNAME });

const CREATE = "POST /v1/workspaces/ws-1/domain-ownerships";
const tags = ["unit", "provider:prisma", "provider:prisma:domainownership"];

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => (Result.isFailure(result) ? String(result.failure) : undefined)),
  );

const absent = makeOwnershipCloud();
testFor(absent).test.provider(
  "fails with the record to publish and creates nothing when the record is absent",
  (stack) =>
    Effect.gen(function* () {
      absent.reset();
      yield* stack.destroy();

      const failure = yield* failureOf(stack.deploy(ownershipStack()));

      expect(failure).toContain("PrismaDomainOwnershipRequired");
      expect(failure).toContain(RECORD.name);
      expect(failure).toContain(RECORD.value);
      expect(absent.routes()).not.toContain(CREATE);
      expect(absent.deleted()).toBe(false);
      expect(absent.rows.size).toBe(0);

      yield* stack.destroy();
    }),
  { tags },
);

const created = makeOwnershipCloud();
testFor(created).test.provider(
  "creates the domain ownership once the record is seen and verifies it",
  (stack) =>
    Effect.gen(function* () {
      created.reset({ visibility: "seen" });
      yield* stack.destroy();

      const proved = yield* stack.deploy(ownershipStack());

      expect(proved.domainOwnershipId).toBe("do-created");
      expect(proved.status).toBe("verified");
      expect(created.routes()).toContain(CREATE);
      expect(created.routes()).toContain("POST /v1/domain-ownerships/do-created/verify");

      yield* stack.destroy();
      expect(created.rows.size).toBe(0);
    }),
  { tags },
);

const unknown = makeOwnershipCloud();
testFor(unknown).test.provider(
  "creates and verifies when the nameservers cannot be reached",
  (stack) =>
    Effect.gen(function* () {
      unknown.reset({ visibility: "unknown" });
      yield* stack.destroy();

      const proved = yield* stack.deploy(ownershipStack());

      expect(proved.status).toBe("verified");
      expect(unknown.routes()).toContain(CREATE);

      yield* stack.destroy();
    }),
  { tags },
);

const racedUnverified = makeOwnershipCloud();
testFor(racedUnverified).test.provider(
  "accepts an unverified domain ownership the create returns with 200",
  (stack) =>
    Effect.gen(function* () {
      racedUnverified.reset({
        visibility: "seen",
        unlisted: ownership("do-raced", "unverified"),
      });
      yield* stack.destroy();

      const proved = yield* stack.deploy(ownershipStack());

      expect(proved.domainOwnershipId).toBe("do-raced");
      expect(proved.status).toBe("verified");

      yield* stack.destroy();
    }),
  { tags },
);

const racedVerified = makeOwnershipCloud();
testFor(racedVerified).test.provider(
  "refuses a verified domain ownership the create returns with 200",
  (stack) =>
    Effect.gen(function* () {
      racedVerified.reset({ visibility: "seen", unlisted: ownership("do-raced", "verified") });
      yield* stack.destroy();

      const failure = yield* failureOf(stack.deploy(ownershipStack()));

      expect(failure).toContain("--adopt");
      expect(racedVerified.routes().some((route) => route.endsWith("/verify"))).toBe(false);
      expect(racedVerified.deleted()).toBe(false);

      racedVerified.reset();
      yield* stack.destroy();
    }),
  { tags },
);

const neverVerified = makeOwnershipCloud();
testFor(neverVerified).test.provider(
  "fails after the bounded verify loop and deletes nothing",
  (stack) =>
    Effect.gen(function* () {
      neverVerified.reset({ visibility: "seen", verifiesAs: "unverified" });
      yield* stack.destroy();

      const failure = yield* failureOf(stack.deploy(ownershipStack()));

      expect(failure).toContain("PrismaDomainOwnershipRequired");
      expect(neverVerified.routes().filter((route) => route.endsWith("/verify"))).toHaveLength(7);
      expect(neverVerified.deleted()).toBe(false);
      expect(neverVerified.rows.get("do-created")?.status).toBe("unverified");

      neverVerified.reset();
      yield* stack.destroy();
    }),
  { tags, timeout: 90_000 },
);

const unverified = makeOwnershipCloud();
testFor(unverified).test.provider(
  "takes over an unverified domain ownership without --adopt and deletes nothing on failure",
  (stack) =>
    Effect.gen(function* () {
      unverified.reset({}, ownership("do-1", "unverified"));
      yield* stack.destroy();

      const failure = yield* failureOf(stack.deploy(ownershipStack()));

      expect(failure).toContain("PrismaDomainOwnershipRequired");
      expect(failure).not.toContain("Cannot adopt resource");
      expect(unverified.routes()).not.toContain(CREATE);
      expect(unverified.deleted()).toBe(false);

      unverified.reset();
      yield* stack.destroy();
    }),
  { tags },
);

const foreign = makeOwnershipCloud();
testFor(foreign).test.provider(
  "refuses a verified domain ownership it did not record without --adopt",
  (stack) =>
    Effect.gen(function* () {
      foreign.reset({}, ownership("do-1", "verified"));
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

const replaced = makeOwnershipCloud();
testFor(replaced).test.provider(
  "refuses a verified row found by domain when the stored id is gone, without --adopt",
  (stack) =>
    Effect.gen(function* () {
      replaced.reset({ visibility: "seen" });
      yield* stack.destroy();
      const first = yield* stack.deploy(ownershipStack());
      expect(first.domainOwnershipId).toBe("do-created");

      // The row is replaced out of band; a changed project makes the deploy
      // reconcile from the stored id.
      replaced.reset({ visibility: "seen" }, ownership("do-2", "verified"));
      const failure = yield* failureOf(stack.deploy(ownershipStack("proj-2")));

      expect(failure).toContain("--adopt");
      expect(replaced.routes()).toContain("GET /v1/domain-ownerships/do-created");
      expect(replaced.routes().some((route) => route.startsWith("POST"))).toBe(false);
      expect(replaced.deleted()).toBe(false);

      replaced.reset();
      yield* stack.destroy();
    }),
  { tags },
);

const adopted = makeOwnershipCloud();
testFor(adopted, true).test.provider(
  "with --adopt, takes over a verified row and finds it by domain when the stored id is gone",
  (stack) =>
    Effect.gen(function* () {
      adopted.reset({}, ownership("do-1", "verified"));
      yield* stack.destroy();

      const first = yield* stack.deploy(ownershipStack());
      expect(first.domainOwnershipId).toBe("do-1");
      expect(adopted.routes().some((route) => route.startsWith("POST"))).toBe(false);

      adopted.reset({}, ownership("do-2", "verified"));
      const second = yield* stack.deploy(ownershipStack("proj-2"));

      expect(second.domainOwnershipId).toBe("do-2");
      expect(adopted.routes()).toContain("GET /v1/domain-ownerships/do-1");
      expect(adopted.routes().some((route) => route.startsWith("POST"))).toBe(false);
      expect(adopted.deleted()).toBe(false);

      yield* stack.destroy();
      expect(adopted.routes()).toContain("DELETE /v1/domain-ownerships/do-2");
    }),
  { tags },
);

const expiring = makeOwnershipCloud();
testFor(expiring, true).test.provider(
  "does not count an expiring domain ownership as proved, and deletes nothing on failure",
  (stack) =>
    Effect.gen(function* () {
      expiring.reset({}, ownership("do-1", "expiring"));
      yield* stack.destroy();

      const failure = yield* failureOf(stack.deploy(ownershipStack()));

      expect(failure).toContain("PrismaDomainOwnershipRequired");
      expect(expiring.deleted()).toBe(false);
      expect(expiring.rows.get("do-1")?.status).toBe("expiring");

      expiring.reset();
      yield* stack.destroy();
    }),
  { tags },
);
