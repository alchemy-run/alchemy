import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:access", "live"];

// Access custom pages need an entitlement the standing test account lacks
// (`AccessCustomPagesNotEntitled`, pinned in CustomPage.test.ts). Set
// CLOUDFLARE_TEST_ACCESS_CUSTOM_PAGES=1 on an entitled account.
const entitled = !!process.env.CLOUDFLARE_TEST_ACCESS_CUSTOM_PAGES;

const callerScript = `export default {
  async fetch(request, env) {
    return new Response("page:" + env.PAGE);
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "AccessCustomPageLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const page = yield* Cloudflare.Access.CustomPage("lookup-target", {
      type: "forbidden",
      customHtml: "<html><body><h1>Denied</h1></body></html>",
    });
    return { customPageId: page.customPageId.as<string>(), name: page.name.as<string>() };
  }),
);

const target = beforeAll(
  entitled ? deploy(TargetStack) : Effect.succeed({ customPageId: "", name: "" }),
);
afterAll.skipIf(!entitled || !!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider.skipIf(!entitled)(
  "a looked-up custom page resolves by id and by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { customPageId, name } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Access.CustomPage.lookup({ name });
        const byId = Cloudflare.Access.CustomPage.lookup({ customPageId });
        const caller = yield* Cloudflare.Worker("custom-page-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { PAGE: byName.customPageId },
        });
        return { url: caller.url.as<string>(), type: byId.type };
      });
      const out = yield* stack.deploy(program);
      expect(out.type).toBe("forbidden");

      yield* expectUrlContains(out.url, `page:${customPageId}`, {
        label: "custom page lookup caller",
      });

      const plan = yield* stack.plan(program);
      expect(plan.resources["custom-page-lookup-caller"].action).toBe("noop");

      yield* stack.destroy();
      const page = yield* zeroTrust.getAccessCustomPage({ accountId, customPageId });
      expect(page.uid).toBe(customPageId);
    }),
  { tags, timeout: 240_000 },
);

test.provider.skipIf(!entitled)(
  "a lookup of a missing custom page fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("custom-page-lookup-missing", {
            script: callerScript,
            env: { PAGE: Cloudflare.Access.CustomPage.lookup({ name }).customPageId },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "a lookup of a custom page this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        Cloudflare.Access.CustomPage("lookup-managed", {
          type: "forbidden",
          customHtml: "<html><body><h1>Denied</h1></body></html>",
        });
      const { customPageId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("custom-page-lookup-managed-caller", {
              script: callerScript,
              env: { PAGE: Cloudflare.Access.CustomPage.lookup({ customPageId }).customPageId },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
