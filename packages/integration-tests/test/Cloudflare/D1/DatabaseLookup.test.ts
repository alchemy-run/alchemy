import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:d1", "live"];

// Writes a row through the database found by name and reads it back through
// the one found by id: the response proves both bind the same database.
const callerScript = `export default {
  async fetch(request, env) {
    await env.BY_NAME.exec("CREATE TABLE IF NOT EXISTS greetings (id INTEGER PRIMARY KEY, msg TEXT)");
    await env.BY_NAME.prepare("INSERT OR REPLACE INTO greetings (id, msg) VALUES (1, ?)")
      .bind("hello from a looked-up database")
      .run();
    const msg = await env.BY_ID.prepare("SELECT msg FROM greetings WHERE id = 1").first("msg");
    return new Response(msg ?? "not yet");
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "D1DatabaseLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.Database("lookup-target");
    return {
      name: database.databaseName.as<string>(),
      databaseId: database.databaseId.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up database binds by name and by id, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { name, databaseId } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.D1.Database.lookup({ name });
        const caller = yield* Cloudflare.Worker("d1-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { BY_NAME: byName, BY_ID: Cloudflare.D1.Database.lookup({ databaseId }) },
        });
        return { url: caller.url.as<string>(), databaseId: byName.databaseId };
      });
      const out = yield* stack.deploy(program);
      expect(out.databaseId).toBe(databaseId);

      yield* expectUrlContains(out.url, "hello from a looked-up database", {
        label: "d1 lookup caller",
      });

      // A lookup re-resolves to the same database, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["d1-lookup-caller"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the database alone.
      yield* stack.destroy();
      const survivor = yield* d1.getDatabase({ accountId, databaseId });
      expect(survivor.name).toBe(name);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing database fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("d1-lookup-missing", {
            script: callerScript,
            env: { BY_NAME: Cloudflare.D1.Database.lookup({ name }) },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a database this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.D1.Database("lookup-managed");
      const { databaseName } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("d1-lookup-managed", {
              script: callerScript,
              env: { BY_NAME: Cloudflare.D1.Database.lookup({ name: databaseName }) },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
