import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as snippets from "@distilled.cloud/cloudflare/snippets";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:snippets", "live"];

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const code = `export default {
  async fetch(request) {
    return fetch(request);
  },
};`;

const callerScript = `export default {
  async fetch(request, env) {
    return new Response("snippet:" + env.SNIPPET);
  },
};`;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found in account`));
  }
  return zone.id;
});

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "SnippetLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;
    const snippet = yield* Cloudflare.Snippets.Snippet("lookup-target", { zoneId, code });
    return { zoneId, name: snippet.name.as<string>() };
  }).pipe(Effect.orDie),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up snippet resolves by zone and name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { zoneId, name } = yield* target;

      const program = Effect.gen(function* () {
        const snippet = Cloudflare.Snippets.Snippet.lookup({ zoneId, name });
        const caller = yield* Cloudflare.Worker("snippet-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { SNIPPET: snippet.name },
        });
        return { url: caller.url.as<string>(), createdOn: snippet.createdOn };
      });
      const out = yield* stack.deploy(program);
      expect(out.createdOn).toBeTruthy();

      yield* expectUrlContains(out.url, `snippet:${name}`, { label: "snippet lookup caller" });

      // A lookup re-resolves to the same snippet, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["snippet-lookup-caller"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the snippet alone.
      yield* stack.destroy();
      const survivor = yield* snippets.getSnippet({ zoneId, snippetName: name });
      expect(survivor.snippetName).toBe(name);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing snippet fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneId = yield* resolveZoneId;
      const name = `missing_${stack.stage.replace(/[^a-zA-Z0-9]/g, "_")}`;
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("snippet-lookup-missing", {
            script: callerScript,
            env: { SNIPPET: Cloudflare.Snippets.Snippet.lookup({ zoneId, name }).name },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a snippet this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneId = yield* resolveZoneId;
      const managed = () => Cloudflare.Snippets.Snippet("lookup-managed", { zoneId, code });
      const { name } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("snippet-lookup-managed-caller", {
              script: callerScript,
              env: { SNIPPET: Cloudflare.Snippets.Snippet.lookup({ zoneId, name }).name },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
