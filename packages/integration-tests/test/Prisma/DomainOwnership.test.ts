import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
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

// `.test` has no nameservers, so the authoritative lookup finds none and the
// verification record never counts as visible.
const HOSTNAME = "app.custom.test";
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

/** One workspace's domain ownerships, served over the Management API routes. */
const makeOwnershipCloud = () => {
  const rows = new Map<string, WireOwnership>();
  const fake: FakeManagementApi = makeFakeManagementApi((request) => {
    const path = request.pathname;
    if (path === "/v1/workspaces/ws-1/domain-ownerships/verification") {
      return data(RECORD);
    }
    if (path === "/v1/workspaces/ws-1/domain-ownerships") {
      if (request.method === "GET") return page(Array.from(rows.values()));
      if (request.method === "POST") {
        const existing = Array.from(rows.values())[0];
        if (existing) return data(existing);
        const created = ownership("do-created", "unverified");
        rows.set(created.id, created);
        return data(created, { status: 201 });
      }
    }
    const [, , , id, action] = path.split("/");
    if (path.startsWith("/v1/domain-ownerships/") && id !== undefined) {
      const row = rows.get(id);
      if (row === undefined) return notFound("Domain ownership not found.");
      if (action === "verify" && request.method === "POST") return data(row);
      if (action === undefined && request.method === "GET") return data(row);
      if (action === undefined && request.method === "DELETE") {
        rows.delete(id);
        return noContent();
      }
    }
    return unhandled(request);
  });
  const reset = (...initial: WireOwnership[]) => {
    rows.clear();
    for (const row of initial) rows.set(row.id, row);
    fake.captured.length = 0;
  };
  return { fake, rows, reset, routes: () => routesOf(fake.captured) };
};

class TestPrismaProviders extends Provider.ProviderCollection<TestPrismaProviders>()("Prisma") {}

const providers = (fake: FakeManagementApi) =>
  Layer.effect(TestPrismaProviders, Provider.collection([DomainOwnershipProof])).pipe(
    Layer.provideMerge(DomainOwnershipProofProvider()),
    Layer.provide(
      Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
    ),
    Layer.provideMerge(fake.layer),
  );

const project = (projectId: string): ProjectReference =>
  ({ projectId, workspaceId: "ws-1" }) as ProjectReference;

const ownershipStack = (projectId = "proj-1") =>
  DomainOwnershipProof("Ownership", { project: project(projectId), domain: HOSTNAME });

const tags = ["local", "provider:prisma", "provider:prisma:domainownership"];

const created = makeOwnershipCloud();
const createdTest = Test.make({ providers: providers(created.fake) });

createdTest.test.provider(
  "fails with the record to publish and creates nothing when the record is not visible",
  (stack) =>
    Effect.gen(function* () {
      created.reset();
      yield* stack.destroy();

      const result = yield* stack.deploy(ownershipStack()).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        const message = String(result.failure);
        expect(message).toContain("PrismaDomainOwnershipRequired");
        expect(message).toContain(RECORD.name);
        expect(message).toContain(RECORD.value);
      }
      expect(created.routes()).not.toContain("POST /v1/workspaces/ws-1/domain-ownerships");
      expect(created.routes().some((route) => route.startsWith("DELETE"))).toBe(false);
      expect(created.rows.size).toBe(0);

      yield* stack.destroy();
    }),
  { tags },
);

const unverified = makeOwnershipCloud();
const unverifiedTest = Test.make({ providers: providers(unverified.fake) });

unverifiedTest.test.provider(
  "takes over an unverified domain ownership without --adopt and deletes nothing on failure",
  (stack) =>
    Effect.gen(function* () {
      unverified.reset(ownership("do-1", "unverified"));
      yield* stack.destroy();

      const result = yield* stack.deploy(ownershipStack()).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("PrismaDomainOwnershipRequired");
        expect(String(result.failure)).not.toContain("Cannot adopt resource");
      }
      expect(unverified.routes()).not.toContain("POST /v1/workspaces/ws-1/domain-ownerships");
      expect(unverified.routes().some((route) => route.startsWith("DELETE"))).toBe(false);
      expect(unverified.rows.has("do-1")).toBe(true);

      unverified.reset();
      yield* stack.destroy();
    }),
  { tags },
);

const foreign = makeOwnershipCloud();
const foreignTest = Test.make({ providers: providers(foreign.fake) });

foreignTest.test.provider(
  "refuses a verified domain ownership it did not record without --adopt",
  (stack) =>
    Effect.gen(function* () {
      foreign.reset(ownership("do-1", "verified"));
      yield* stack.destroy();

      const result = yield* stack.deploy(ownershipStack()).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("Cannot adopt resource");
      }
      expect(foreign.routes().some((route) => route.startsWith("POST"))).toBe(false);
      expect(foreign.routes().some((route) => route.startsWith("DELETE"))).toBe(false);

      foreign.reset();
      yield* stack.destroy();
    }),
  { tags },
);

const adopted = makeOwnershipCloud();
const adoptedTest = Test.make({ providers: providers(adopted.fake), adopt: true });

adoptedTest.test.provider(
  "adopts a verified domain ownership, finds it by domain when the stored id is gone, and deletes it on destroy",
  (stack) =>
    Effect.gen(function* () {
      adopted.reset(ownership("do-1", "verified"));
      yield* stack.destroy();

      const first = yield* stack.deploy(ownershipStack());
      expect(first.domainOwnershipId).toBe("do-1");
      expect(first.status).toBe("verified");
      expect(adopted.routes().some((route) => route.startsWith("POST"))).toBe(false);

      // The row is replaced out of band; a changed project makes the deploy
      // reconcile from the stored id.
      adopted.reset(ownership("do-2", "verified"));
      const second = yield* stack.deploy(ownershipStack("proj-2"));

      expect(second.domainOwnershipId).toBe("do-2");
      expect(adopted.routes()).toContain("GET /v1/domain-ownerships/do-1");
      expect(adopted.routes()).toContain("GET /v1/workspaces/ws-1/domain-ownerships");
      expect(adopted.routes().some((route) => route.startsWith("POST"))).toBe(false);
      expect(adopted.routes().some((route) => route.startsWith("DELETE"))).toBe(false);

      yield* stack.destroy();
      expect(adopted.routes()).toContain("DELETE /v1/domain-ownerships/do-2");
      expect(adopted.rows.size).toBe(0);
    }),
  { tags },
);

const expiring = makeOwnershipCloud();
const expiringTest = Test.make({ providers: providers(expiring.fake), adopt: true });

expiringTest.test.provider(
  "does not count an expiring domain ownership as proved, and deletes nothing on failure",
  (stack) =>
    Effect.gen(function* () {
      expiring.reset(ownership("do-1", "expiring"));
      yield* stack.destroy();

      const result = yield* stack.deploy(ownershipStack()).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("PrismaDomainOwnershipRequired");
      }
      expect(expiring.routes().some((route) => route.startsWith("DELETE"))).toBe(false);
      expect(expiring.rows.get("do-1")?.status).toBe("expiring");

      expiring.reset();
      yield* stack.destroy();
    }),
  { tags },
);
