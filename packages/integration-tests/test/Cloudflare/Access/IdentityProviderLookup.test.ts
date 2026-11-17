import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { testName } from "../../names.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:access", "live"];

// Self-hosted Access applications need a domain on an active zone in the
// account; the shared standing zone is the only one tests can use.
const zoneName = "alchemy-test-2.us";

const oidcConfig = {
  clientId: "alchemy-test-client",
  clientSecret: "alchemy-test-secret",
  authUrl: "https://idp.alchemy-test.example/authorize",
  tokenUrl: "https://idp.alchemy-test.example/token",
  certsUrl: "https://idp.alchemy-test.example/keys",
  scopes: ["openid", "email", "profile"],
};

const callerScript = `export default {
  async fetch(request, env) {
    return new Response("idp:" + env.IDP_ID);
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "AccessIdentityProviderLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const idp = yield* Cloudflare.Access.IdentityProvider("lookup-target", {
      name: testName("alchemy-zt-idp-lookup"),
      type: "oidc",
      config: oidcConfig,
    });
    return {
      identityProviderId: idp.identityProviderId.as<string>(),
      name: idp.name.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up identity provider gates a new application, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { identityProviderId, name } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Access.IdentityProvider.lookup({ name, type: "oidc" });
        const byId = Cloudflare.Access.IdentityProvider.lookup({ identityProviderId });
        const app = yield* Cloudflare.Access.Application("idp-lookup-app", {
          type: "self_hosted",
          domain: `${testName("alchemy-idp-lookup")}.${zoneName}`,
          sessionDuration: "24h",
          allowedIdps: [byName.identityProviderId],
        });
        const caller = yield* Cloudflare.Worker("idp-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { IDP_ID: byId.identityProviderId },
        });
        return { applicationId: app.applicationId, url: caller.url.as<string>(), type: byId.type };
      });
      const out = yield* stack.deploy(program);
      expect(out.type).toBe("oidc");

      const app = yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: out.applicationId,
      });
      expect((app as { allowedIdps?: ReadonlyArray<string> }).allowedIdps).toEqual([
        identityProviderId,
      ]);

      yield* expectUrlContains(out.url, `idp:${identityProviderId}`, {
        label: "identity provider lookup caller",
      });

      // A lookup re-resolves to the same identity provider, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["idp-lookup-app"].action).toBe("noop");
      expect(plan.resources["idp-lookup-caller"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the identity provider.
      yield* stack.destroy();
      const survivor = yield* zeroTrust.getIdentityProviderForAccount({
        accountId,
        identityProviderId,
      });
      expect(survivor.name).toBe(name);
    }),
  { tags: [...tags, "provider:cloudflare:worker"], timeout: 240_000 },
);

test.provider(
  "a lookup of a missing identity provider fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-idp-by-name": Cloudflare.Access.IdentityProvider.lookup({ name }),
        "missing-idp-by-id": Cloudflare.Access.IdentityProvider.lookup({
          identityProviderId: "00000000-0000-4000-8000-000000000000",
        }),
      };
      for (const [id, idp] of Object.entries(lookups)) {
        yield* expectDeployFails(
          stack.deploy(
            Cloudflare.Worker(id, {
              script: callerScript,
              env: { IDP_ID: idp.identityProviderId },
            }),
          ),
          ["LookupNotFoundError"],
        );
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of an identity provider this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        Cloudflare.Access.IdentityProvider("lookup-managed", {
          name: testName("alchemy-zt-idp-lookup-managed"),
          type: "oidc",
          config: oidcConfig,
        });
      const { identityProviderId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("idp-lookup-managed-caller", {
              script: callerScript,
              env: {
                IDP_ID: Cloudflare.Access.IdentityProvider.lookup({ identityProviderId })
                  .identityProviderId,
              },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
