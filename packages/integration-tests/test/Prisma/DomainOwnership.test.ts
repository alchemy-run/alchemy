import { describe, expect, it } from "@alchemy.run/test";
import { Unowned } from "alchemy/AdoptPolicy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Provider from "alchemy/Provider";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { PrismaDomainOwnershipRequired } from "../../../prisma/src/internal/DomainOwnership.ts";
import {
  DomainOwnershipProof,
  DomainOwnershipProofProvider,
} from "../../../prisma/src/internal/DomainOwnershipProof.ts";
import {
  data,
  makeFakeManagementApi,
  noContent,
  page,
  routesOf,
  unhandled,
  WIRE_CREATED_AT,
} from "./fixtures/FakeManagementApi.ts";

const HOSTNAME = "app.custom.test";
const RECORD_NAME = `_prisma-verification.${HOSTNAME}`;
const RECORD_VALUE = `prisma-verification=${"a".repeat(64)}`;

type Status = "unverified" | "verified" | "expiring";

const ownership = (status: Status, id = "do-1") => ({
  id,
  type: "domainOwnership",
  workspaceId: "ws-1",
  domain: HOSTNAME,
  verification: { type: "TXT", name: RECORD_NAME, value: RECORD_VALUE, ttl: 300 },
  status,
  expiresAt: status === "expiring" ? "2026-12-01T00:00:00.000Z" : null,
  verificationRecordLastSeenAt: status === "unverified" ? null : "2026-11-06T00:00:00.000Z",
  verificationRecordPresent: status === "unverified" ? null : status === "verified",
  verificationRecordSyncError: null,
  createdAt: WIRE_CREATED_AT,
});

interface Platform {
  /** Rows the list route returns. */
  listed: ReturnType<typeof ownership>[];
  /** Status the create route returns. */
  created: Status;
  /** Statuses the verify route returns, one per call; the last repeats. */
  verified: Status[];
}

const fakePlatform = (platform: Platform) =>
  makeFakeManagementApi((request) => {
    const path = request.pathname;
    if (path === "/v1/workspaces/ws-1/domain-ownerships") {
      if (request.method === "GET") return page(platform.listed);
      if (request.method === "POST") {
        return data(ownership(platform.created), { status: 201 });
      }
    }
    if (path === "/v1/domain-ownerships/do-1/verify" && request.method === "POST") {
      const status =
        platform.verified.length > 1 ? platform.verified.shift()! : platform.verified[0]!;
      return data(ownership(status));
    }
    if (path === "/v1/domain-ownerships/do-1" && request.method === "DELETE") {
      return noContent();
    }
    return unhandled(request);
  });

const provider = DomainOwnershipProofProvider().pipe(
  Layer.provide(
    Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
  ),
);

const project = { projectId: "proj-1", workspaceId: "ws-1" } as never;

const reconcileInput = (output?: unknown) =>
  ({
    id: "Ownership",
    fqn: "Ownership",
    instanceId: "00000000000000000000000000000000",
    news: { project, domain: HOSTNAME },
    olds: undefined,
    output,
    session: undefined as never,
    bindings: [],
  }) as never;

const reconcile = (output?: unknown) =>
  Effect.gen(function* () {
    const live = yield* Provider.findProvider(DomainOwnershipProof);
    return yield* live.reconcile(reconcileInput(output));
  });

describe(
  "Prisma.DomainOwnership",
  { tags: ["unit", "provider:prisma", "provider:prisma:domain-ownership", "local"] },
  () => {
    it.effect("creates the domain ownership and verifies it until Prisma reports verified", () => {
      const api = fakePlatform({ listed: [], created: "unverified", verified: ["verified"] });
      return Effect.gen(function* () {
        const attrs = yield* reconcile();

        expect(attrs.status).toBe("verified");
        expect(attrs.expiresAt).toBeNull();
        expect(attrs.verifiedAt).toBe("2026-11-06T00:00:00.000Z");
        expect(attrs.recordName).toBe(RECORD_NAME);
        expect(routesOf(api.captured)).toEqual([
          "GET /v1/workspaces/ws-1/domain-ownerships",
          "POST /v1/workspaces/ws-1/domain-ownerships",
          "POST /v1/domain-ownerships/do-1/verify",
        ]);
      }).pipe(
        Effect.provide(provider),
        Effect.provide(api.layer),
        Effect.provide(PlatformServices),
      );
    });

    it.effect("returns a domain ownership Prisma already reports verified without a call", () => {
      const api = fakePlatform({
        listed: [ownership("verified")],
        created: "verified",
        verified: [],
      });
      return Effect.gen(function* () {
        const attrs = yield* reconcile();

        expect(attrs.domainOwnershipId).toBe("do-1");
        expect(attrs.status).toBe("verified");
        expect(routesOf(api.captured)).toEqual(["GET /v1/workspaces/ws-1/domain-ownerships"]);
      }).pipe(
        Effect.provide(provider),
        Effect.provide(api.layer),
        Effect.provide(PlatformServices),
      );
    });

    it.effect("does not count an expiring domain ownership as proved", () => {
      const api = fakePlatform({
        listed: [ownership("expiring")],
        created: "verified",
        verified: ["verified"],
      });
      return Effect.gen(function* () {
        const attrs = yield* reconcile();

        expect(attrs.status).toBe("verified");
        expect(routesOf(api.captured)).toEqual([
          "GET /v1/workspaces/ws-1/domain-ownerships",
          "POST /v1/domain-ownerships/do-1/verify",
        ]);
      }).pipe(
        Effect.provide(provider),
        Effect.provide(api.layer),
        Effect.provide(PlatformServices),
      );
    });

    it.effect(
      "fails with the record to publish, and removes the domain ownership it created",
      () => {
        const api = fakePlatform({ listed: [], created: "unverified", verified: ["unverified"] });
        return Effect.gen(function* () {
          const fiber = yield* reconcile().pipe(
            Effect.flip,
            Effect.forkChild({ startImmediately: true }),
          );
          for (let i = 0; i < 100 && fiber.pollUnsafe() === undefined; i++) {
            yield* TestClock.adjust("5 seconds");
            yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
          }
          const error = yield* Fiber.join(fiber);

          expect(error).toBeInstanceOf(PrismaDomainOwnershipRequired);
          if (error instanceof PrismaDomainOwnershipRequired) {
            expect(error.hostname).toBe(HOSTNAME);
            expect(error.recordName).toBe(RECORD_NAME);
            expect(error.recordValue).toBe(RECORD_VALUE);
          }
          const routes = routesOf(api.captured);
          expect(routes.filter((route) => route.endsWith("/verify"))).toHaveLength(7);
          expect(routes.at(-1)).toBe("DELETE /v1/domain-ownerships/do-1");
        }).pipe(
          Effect.provide(provider),
          Effect.provide(api.layer),
          Effect.provide(PlatformServices),
          Effect.provide(TestClock.layer()),
        );
      },
    );

    it.effect("keeps an existing unverified domain ownership it could not prove", () => {
      const api = fakePlatform({
        listed: [ownership("unverified")],
        created: "unverified",
        verified: ["unverified"],
      });
      return Effect.gen(function* () {
        const fiber = yield* reconcile().pipe(
          Effect.flip,
          Effect.forkChild({ startImmediately: true }),
        );
        for (let i = 0; i < 100 && fiber.pollUnsafe() === undefined; i++) {
          yield* TestClock.adjust("5 seconds");
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
        }
        const error = yield* Fiber.join(fiber);

        expect(error).toBeInstanceOf(PrismaDomainOwnershipRequired);
        expect(routesOf(api.captured)).not.toContain("DELETE /v1/domain-ownerships/do-1");
        expect(routesOf(api.captured)).not.toContain("POST /v1/workspaces/ws-1/domain-ownerships");
      }).pipe(
        Effect.provide(provider),
        Effect.provide(api.layer),
        Effect.provide(PlatformServices),
        Effect.provide(TestClock.layer()),
      );
    });

    it.effect("reads a domain ownership it did not record as Unowned, with its status", () => {
      const api = fakePlatform({
        listed: [ownership("expiring")],
        created: "verified",
        verified: [],
      });
      return Effect.gen(function* () {
        const live = yield* Provider.findProvider(DomainOwnershipProof);
        const attrs = yield* live.read!({
          id: "Ownership",
          fqn: "Ownership",
          instanceId: "00000000000000000000000000000000",
          olds: { project, domain: HOSTNAME },
          output: undefined,
        } as never);

        expect(attrs && Unowned.is(attrs)).toBe(true);
        expect(attrs?.status).toBe("expiring");
        expect(attrs?.expiresAt).toBe("2026-12-01T00:00:00.000Z");
        expect(attrs?.verifiedAt).toBeNull();
      }).pipe(
        Effect.provide(provider),
        Effect.provide(api.layer),
        Effect.provide(PlatformServices),
      );
    });
  },
);
