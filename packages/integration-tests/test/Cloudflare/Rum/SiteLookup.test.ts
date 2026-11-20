import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as rum from "@distilled.cloud/cloudflare/rum";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails } from "../../lookup.ts";
import { testName } from "../../names.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:rum", "live"];

const zoneName = "alchemy-test-2.us";
// A host site, never a zone site: Rule.test.ts clears the zone's sites.
const HOST = `${testName("rum-lookup")}.${zoneName}`;

// Hands the site's beacon token to the page it would render.
const callerScript = `export default {
  async fetch(request, env) {
    return new Response("token:" + env.RUM_TOKEN);
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "RumSiteLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const site = yield* Cloudflare.Rum.Site("lookup-target", { host: HOST });
    return { siteTag: site.siteTag.as<string>(), siteToken: site.siteToken.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up site hands its beacon token to a Worker, by tag and by host",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { siteTag, siteToken } = yield* target;

      const program = Effect.gen(function* () {
        const byHost = Cloudflare.Rum.Site.lookup({ host: HOST });
        const byTag = Cloudflare.Rum.Site.lookup({ siteTag });
        const caller = yield* Cloudflare.Worker("rum-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { RUM_TOKEN: byHost.siteToken },
        });
        return { url: caller.url.as<string>(), host: byTag.host };
      });
      const out = yield* stack.deploy(program);
      expect(out.host).toBe(HOST);

      yield* expectUrlContains(out.url, `token:${siteToken}`, { label: "rum lookup caller" });

      // A lookup re-resolves to the same site, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["rum-lookup-caller"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the site alone.
      yield* stack.destroy();
      const survivor = yield* rum.getSiteInfo({ accountId, siteId: siteTag });
      expect(survivor.host).toBe(HOST);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing site fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const host = `${testName("rum-lookup-missing")}.${zoneName}`;
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("rum-lookup-missing", {
            script: callerScript,
            env: { RUM_TOKEN: Cloudflare.Rum.Site.lookup({ host }).siteToken },
          }),
        ),
        ["LookupNotFoundError", host],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a site this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        Cloudflare.Rum.Site("lookup-managed", {
          host: `${testName("rum-lookup-managed")}.${zoneName}`,
        });
      const { siteTag } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("rum-lookup-managed-caller", {
              script: callerScript,
              env: { RUM_TOKEN: Cloudflare.Rum.Site.lookup({ siteTag }).siteToken },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
