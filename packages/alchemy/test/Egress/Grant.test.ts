import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Grant from "@/Egress/Grant.ts";

const key = new Uint8Array(32).fill(7);
const otherKey = new Uint8Array(32).fill(8);

const routes: Record<string, ReadonlyArray<Grant.RouteSpec>> = {
  model: [{ host: "api.anthropic.com" }],
  repo: [
    { host: "github.com", paths: ["/a/b/**", "/a/b.git/**"] },
    { host: "api.github.com", paths: ["/repos/a/b/**", "/graphql"] },
  ],
};
const routesOf = (caveat: Grant.EgressCaveat) => Effect.succeed(routes[caveat.egress] ?? []);

const NOW = 1_000_000;
const minted = Grant.mint(key, "grant-1", [
  { expires: NOW + 60_000 },
  { anyOf: [{ egress: "model" }, { egress: "repo", scope: { repository: "a/b" } }] },
]);

describe("Egress.Grant", { tags: ["unit", "local"] }, () => {
  it.effect("a minted grant verifies with its key, and round-trips on the wire", () =>
    Effect.gen(function* () {
      const grant = yield* minted;
      expect(yield* Grant.verify(key, grant)).toBe(true);
      expect(yield* Grant.verify(otherKey, grant)).toBe(false);
      const decoded = yield* Grant.decode(`Macaroon ${Grant.encode(grant)}`);
      expect(decoded).toEqual(grant);
      expect(yield* Grant.verify(key, decoded)).toBe(true);
    }),
  );

  it.effect("a tampered grant does not verify", () =>
    Effect.gen(function* () {
      const grant = yield* minted;
      // Widen the scope.
      const widened: Grant.Grant = {
        ...grant,
        caveats: [grant.caveats[0]!, { anyOf: [{ egress: "model" }, { egress: "repo" }] }],
      };
      expect(yield* Grant.verify(key, widened)).toBe(false);
      // Extend the expiry.
      const extended: Grant.Grant = {
        ...grant,
        caveats: [{ expires: NOW + 3_600_000 }, grant.caveats[1]!],
      };
      expect(yield* Grant.verify(key, extended)).toBe(false);
      // Drop a caveat.
      expect(yield* Grant.verify(key, { ...grant, caveats: [grant.caveats[1]!] })).toBe(false);
      // Flip a signature bit.
      const flipped = `${grant.signature.slice(0, -1)}${grant.signature.endsWith("0") ? "1" : "0"}`;
      expect(yield* Grant.verify(key, { ...grant, signature: flipped })).toBe(false);
      expect(yield* Grant.verify(key, { ...grant, signature: "not hex" })).toBe(false);
    }),
  );

  it.effect("garbage is a decode error", () =>
    Effect.gen(function* () {
      for (const input of [undefined, "", "Macaroon", "Macaroon !!!", "Macaroon eyJ9"]) {
        const result = yield* Effect.result(Grant.decode(input));
        expect(result._tag).toBe("Failure");
      }
      const notAGrant = btoa(JSON.stringify({ id: 1, caveats: [], signature: "" }));
      expect((yield* Effect.result(Grant.decode(notAGrant)))._tag).toBe("Failure");
    }),
  );

  it.effect("covering picks the granted egress whose routes match the target", () =>
    Effect.gen(function* () {
      const grant = yield* minted;
      const at = (host: string, path: string, now = NOW) =>
        Grant.covering(grant, { host, path }, now, routesOf);
      expect(yield* at("api.anthropic.com", "/v1/messages")).toEqual({ egress: "model" });
      expect(yield* at("api.github.com", "/repos/a/b/issues")).toEqual({
        egress: "repo",
        scope: { repository: "a/b" },
      });
      expect(yield* at("github.com", "/a/b.git/info/refs")).toMatchObject({ egress: "repo" });
      expect(yield* at("api.github.com", "/repos/c/d")).toBeUndefined();
      expect(yield* at("example.com", "/")).toBeUndefined();
    }),
  );

  it.effect("an expired grant covers nothing", () =>
    Effect.gen(function* () {
      const grant = yield* minted;
      expect(Grant.isExpired(grant, NOW)).toBe(false);
      expect(Grant.isExpired(grant, NOW + 60_000)).toBe(true);
      expect(Grant.expiry(grant)).toBe(NOW + 60_000);
      const covered = yield* Grant.covering(
        grant,
        { host: "api.anthropic.com", path: "/" },
        NOW + 60_000,
        routesOf,
      );
      expect(covered).toBeUndefined();
    }),
  );

  it.effect("attenuation narrows a grant and still verifies; it can't widen it", () =>
    Effect.gen(function* () {
      const grant = yield* minted;
      // A shorter expiry.
      const shorter = yield* Grant.attenuate(grant, { expires: NOW + 1_000 });
      expect(yield* Grant.verify(key, shorter)).toBe(true);
      expect(Grant.expiry(shorter)).toBe(NOW + 1_000);
      expect(Grant.isExpired(shorter, NOW + 1_000)).toBe(true);
      // A later expiry doesn't extend it: the earliest wins.
      const later = yield* Grant.attenuate(grant, { expires: NOW + 3_600_000 });
      expect(Grant.expiry(later)).toBe(NOW + 60_000);

      // Only the model egress.
      const modelOnly = yield* Grant.attenuate(grant, { egress: "model" });
      expect(yield* Grant.verify(key, modelOnly)).toBe(true);
      const cover = (g: Grant.Grant, host: string, path: string) =>
        Grant.covering(g, { host, path }, NOW, routesOf);
      expect(yield* cover(modelOnly, "api.anthropic.com", "/v1/messages")).toEqual({
        egress: "model",
      });
      expect(yield* cover(modelOnly, "api.github.com", "/repos/a/b")).toBeUndefined();

      // An egress the grant doesn't name adds nothing.
      const other = yield* Grant.attenuate(grant, { egress: "other" });
      expect(yield* cover(other, "api.anthropic.com", "/")).toBeUndefined();

      // Removing the attenuation breaks the signature.
      expect(yield* Grant.verify(key, { ...modelOnly, caveats: grant.caveats })).toBe(false);
    }),
  );

  it.effect("signing doesn't depend on key order", () =>
    Effect.gen(function* () {
      const a = yield* Grant.mint(key, "id", [{ egress: "repo", scope: { a: 1, b: 2 } }]);
      const b = yield* Grant.mint(key, "id", [{ scope: { b: 2, a: 1 }, egress: "repo" }]);
      expect(a.signature).toBe(b.signature);
    }),
  );
});
