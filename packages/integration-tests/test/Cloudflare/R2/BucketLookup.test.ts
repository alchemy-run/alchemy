import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:r2", "live"];

// Writes and reads back an object through each looked-up bucket.
const callerScript = `export default {
  async fetch(request, env) {
    const out = [];
    for (const name of ["DEFAULT", "EU"]) {
      await env[name].put("greeting", "hello from " + name);
      out.push(await (await env[name].get("greeting")).text());
    }
    return new Response(out.join(" | "));
  },
};`;

// The targets belong to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "R2BucketLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("lookup-target", { forceDestroy: true });
    const eu = yield* Cloudflare.R2.Bucket("lookup-target-eu", {
      jurisdiction: "eu",
      forceDestroy: true,
    });
    return {
      name: bucket.bucketName.as<string>(),
      euName: eu.bucketName.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up bucket binds by name and jurisdiction, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { name, euName } = yield* target;

      const program = Effect.gen(function* () {
        const eu = Cloudflare.R2.Bucket.lookup({ name: euName, jurisdiction: "eu" });
        const caller = yield* Cloudflare.Worker("r2-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { DEFAULT: Cloudflare.R2.Bucket.lookup({ name }), EU: eu },
        });
        return { url: caller.url.as<string>(), euJurisdiction: eu.jurisdiction };
      });
      const out = yield* stack.deploy(program);
      expect(out.euJurisdiction).toBe("eu");

      yield* expectUrlContains(out.url, "hello from DEFAULT | hello from EU", {
        label: "r2 lookup caller",
      });

      // A lookup re-resolves to the same bucket, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["r2-lookup-caller"].action).toBe("noop");

      // Destroying the stack that looked them up leaves the buckets alone.
      yield* stack.destroy();
      const survivor = yield* r2.getBucket({ accountId, bucketName: name });
      expect(survivor.name).toBe(name);
      const euSurvivor = yield* r2.getBucket({
        accountId,
        bucketName: euName,
        jurisdiction: "eu",
      });
      expect(euSurvivor.name).toBe(euName);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing bucket fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("r2-lookup-missing", {
            script: callerScript,
            env: { DEFAULT: Cloudflare.R2.Bucket.lookup({ name }) },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a bucket this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.R2.Bucket("lookup-managed");
      const { bucketName } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("r2-lookup-managed", {
              script: callerScript,
              env: { DEFAULT: Cloudflare.R2.Bucket.lookup({ name: bucketName }) },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
