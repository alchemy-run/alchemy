import {
  isAccessChallenge,
  parseCloudflaredToken,
} from "@/Cloudflare/Access.ts";
import {
  stateStoreAccessPolicies,
  stateStoreApplicationProps,
  validateTokenName,
  versionCheckApplicationProps,
} from "@/Cloudflare/StateStore/Protect.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

describe("state store protection", () => {
  describe("stateStoreAccessPolicies", () => {
    it("allows only Cloudflare account members when there are no tokens", () => {
      expect(
        stateStoreAccessPolicies({ accountId: "acct", serviceTokenIds: [] }),
      ).toEqual([
        {
          name: "Cloudflare account members",
          decision: "allow",
          include: [{ cloudflareAccountMember: { accountId: "acct" } }],
        },
      ]);
    });

    it("adds one service-auth policy listing every token", () => {
      const policies = stateStoreAccessPolicies({
        accountId: "acct",
        serviceTokenIds: ["t1", "t2"],
      });
      expect(policies).toHaveLength(2);
      expect(policies[1]).toEqual({
        name: "Alchemy state store tokens",
        decision: "non_identity",
        include: [
          { serviceToken: { tokenId: "t1" } },
          { serviceToken: { tokenId: "t2" } },
        ],
      });
    });
  });

  it("protects the worker's production and preview traffic", () => {
    const props = stateStoreApplicationProps({
      workerId: "worker-id",
      identityProviderId: "idp-id",
      policies: [],
    });
    expect(props.destinations).toEqual([
      { type: "worker", workerId: "worker-id" },
      { type: "preview_worker", workerId: "worker-id" },
    ]);
    expect(props.allowedIdps).toEqual(["idp-id"]);
    expect(props.autoRedirectToIdentity).toBe(true);
  });

  it("keeps /version public for older clients", () => {
    const props = versionCheckApplicationProps(
      "alchemy-state-store.example.workers.dev",
    );
    expect(props.domain).toBe(
      "alchemy-state-store.example.workers.dev/version",
    );
    expect(props.policies).toEqual([
      {
        name: "Public version check",
        decision: "bypass",
        include: ["everyone"],
      },
    ]);
  });

  describe("validateTokenName", () => {
    it.effect("accepts lowercase names with inner dashes", () =>
      Effect.gen(function* () {
        expect(yield* validateTokenName("github-actions")).toBe(
          "github-actions",
        );
        expect(yield* validateTokenName("ci2")).toBe("ci2");
      }),
    );

    it.effect("rejects names that cannot be logical IDs", () =>
      Effect.gen(function* () {
        for (const name of [
          "",
          "GitHub",
          "-ci",
          "ci-",
          "a b",
          "x".repeat(41),
        ]) {
          const exit = yield* Effect.exit(validateTokenName(name));
          expect(Exit.isFailure(exit)).toBe(true);
        }
      }),
    );
  });
});

describe("Cloudflare Access client", () => {
  it("recognizes the Access login redirect", () => {
    expect(
      isAccessChallenge({
        status: 302,
        location:
          "https://team.cloudflareaccess.com/cdn-cgi/access/login/app?kid=1",
      }),
    ).toBe(true);
    expect(isAccessChallenge({ status: 200, location: null })).toBe(false);
    expect(isAccessChallenge({ status: 404, location: null })).toBe(false);
    expect(
      isAccessChallenge({ status: 302, location: "https://example.com/" }),
    ).toBe(false);
  });

  it("extracts the token printed by cloudflared", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOlsiYSJdfQ.c2lnbmF0dXJl";
    expect(parseCloudflaredToken(`${jwt}\n`)).toBe(jwt);
    expect(
      parseCloudflaredToken(
        `A browser window should have opened...\nSuccessfully fetched your token:\n\n${jwt}\n\n`,
      ),
    ).toBe(jwt);
    expect(
      parseCloudflaredToken("Unable to find token for provided application."),
    ).toBe(undefined);
  });
});
