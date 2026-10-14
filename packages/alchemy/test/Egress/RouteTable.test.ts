import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import type { EgressRef, MintedGrant } from "@/Egress/Kind.ts";
import { routesFor, routesOverlap } from "@/Egress/Route.ts";
import { routesForScope } from "@/GitHub/Egress.ts";

const work = { id: "WorkGateway", url: "https://work.example/" };
const user = { id: "UserGateway", url: "https://user.example/" };

const model: EgressRef = { gateway: "WorkGateway", egress: "model" };
const workRepo: EgressRef = {
  gateway: "WorkGateway",
  egress: "repo",
  scope: { repository: "alchemy-run/alchemy", issue: 42 },
};
const userRepo = (graphql?: boolean): EgressRef => ({
  gateway: "UserGateway",
  egress: "repo",
  scope: { repository: "sam/dotfiles", ...(graphql === false ? { graphql } : {}) },
  subject: "u_123",
});

const minted = (
  gateway: MintedGrant["gateway"],
  grant: string,
  routes: MintedGrant["routes"],
): MintedGrant => ({ gateway, grant, expires: 0, routes });

describe("Egress.routesFor", { tags: ["unit", "local"] }, () => {
  it.effect("builds one table for several gateways (DESIGN §7)", () =>
    Effect.gen(function* () {
      const table = yield* routesFor([model, workRepo, userRepo(false)], {
        WorkGateway: minted(work, "g1", [
          [{ host: "api.anthropic.com" }],
          routesForScope({ repository: "alchemy-run/alchemy", issue: 42 }),
        ]),
        UserGateway: minted(user, "g2", [
          routesForScope({ repository: "sam/dotfiles", graphql: false }),
        ]),
      });
      expect(table).toEqual([
        { host: "api.anthropic.com", gateway: work, grant: "g1" },
        {
          host: "github.com",
          paths: ["/alchemy-run/alchemy/**", "/alchemy-run/alchemy.git/**"],
          gateway: work,
          grant: "g1",
        },
        {
          host: "api.github.com",
          paths: ["/repos/alchemy-run/alchemy/**", "/graphql"],
          gateway: work,
          grant: "g1",
        },
        {
          host: "uploads.github.com",
          paths: ["/repos/alchemy-run/alchemy/**"],
          gateway: work,
          grant: "g1",
        },
        {
          host: "github.com",
          paths: ["/sam/dotfiles/**", "/sam/dotfiles.git/**"],
          gateway: user,
          grant: "g2",
        },
        { host: "api.github.com", paths: ["/repos/sam/dotfiles/**"], gateway: user, grant: "g2" },
        {
          host: "uploads.github.com",
          paths: ["/repos/sam/dotfiles/**"],
          gateway: user,
          grant: "g2",
        },
      ]);
    }),
  );

  it.effect("two egresses that both claim GraphQL conflict", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        routesFor([workRepo, userRepo()], {
          WorkGateway: minted(work, "g1", [
            routesForScope({ repository: "alchemy-run/alchemy", issue: 42 }),
          ]),
          UserGateway: minted(user, "g2", [routesForScope({ repository: "sam/dotfiles" })]),
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("EgressRouteConflict");
        expect(result.failure.host).toBe("api.github.com");
        expect(result.failure.egresses).toEqual([workRepo, userRepo()]);
        expect(result.failure.message).toContain("/graphql");
      }
    }),
  );

  it.effect("a whole-host route conflicts with anything else on that host", () =>
    Effect.gen(function* () {
      const whole: EgressRef = { gateway: "UserGateway", egress: "repo" };
      const result = yield* Effect.result(
        routesFor([workRepo, whole], {
          WorkGateway: minted(work, "g1", [
            routesForScope({ repository: "alchemy-run/alchemy", graphql: false }),
          ]),
          UserGateway: minted(user, "g2", [routesForScope(undefined)]),
        }),
      );
      expect(result._tag === "Failure" && result.failure.host).toBe("github.com");
    }),
  );

  it.effect("the same egress granted twice is one set of routes", () =>
    Effect.gen(function* () {
      const table = yield* routesFor([model, model], {
        WorkGateway: minted(work, "g1", [
          [{ host: "api.anthropic.com" }],
          [{ host: "api.anthropic.com" }],
        ]),
      });
      expect(table).toHaveLength(1);
    }),
  );

  it("path overlap", () => {
    const at = (paths?: ReadonlyArray<string>) => ({ host: "h", paths });
    expect(routesOverlap(at(["/a/**"]), at(["/b/**"]))).toBe(false);
    expect(routesOverlap(at(["/a/**"]), at(["/a/b/**"]))).toBe(true);
    expect(routesOverlap(at(["/a/**"]), at(["/a"]))).toBe(true);
    expect(routesOverlap(at(["/ab/**"]), at(["/a/**"]))).toBe(false);
    expect(routesOverlap(at(["/graphql"]), at(["/graphql"]))).toBe(true);
    expect(routesOverlap(at(["/graphql"]), at(["/repos/**"]))).toBe(false);
    expect(routesOverlap(at(), at(["/x"]))).toBe(true);
    expect(routesOverlap(at(["/x"]), { host: "other", paths: ["/x"] })).toBe(false);
  });
});
