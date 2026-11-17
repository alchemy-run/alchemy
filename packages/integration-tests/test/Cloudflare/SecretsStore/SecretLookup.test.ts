import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectDeployFails } from "../../lookup.ts";
import { testName } from "../../names.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:secretsstore", "live"];

const SECRET_VALUE = "sk-looked-up-secret-value";
// Secret names are unique per store, and the store is shared by the account.
const secretName = testName("LOOKUP_TARGET", "_");

// Reads the secret through each looked-up binding.
const callerScript = `export default {
  async fetch(request, env) {
    return new Response([await env.BY_NAME.get(), await env.BY_ID.get()].join(" | "));
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "SecretLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const store = yield* Cloudflare.SecretsStore.Store("lookup-store");
    const secret = yield* Cloudflare.SecretsStore.Secret("lookup-target", {
      store,
      name: secretName,
      value: Redacted.make(SECRET_VALUE),
    });
    return {
      storeId: store.storeId.as<string>(),
      storeName: store.storeName.as<string>(),
      secretId: secret.secretId.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up secret binds by name and by id, inside a looked-up store",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { storeId, storeName, secretId } = yield* target;

      const program = Effect.gen(function* () {
        const store = Cloudflare.SecretsStore.Store.lookup({ name: storeName });
        const caller = yield* Cloudflare.Worker("secret-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: {
            BY_NAME: Cloudflare.SecretsStore.Secret.lookup({
              storeId: store.storeId,
              name: secretName,
            }),
            BY_ID: Cloudflare.SecretsStore.Secret.lookup({ storeId, secretId }),
          },
        });
        return { url: caller.url.as<string>(), storeId: store.storeId };
      });
      const out = yield* stack.deploy(program);
      expect(out.storeId).toBe(storeId);

      yield* expectUrlContains(out.url, `${SECRET_VALUE} | ${SECRET_VALUE}`, {
        label: "secret lookup caller",
      });

      // A lookup re-resolves to the same secret, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["secret-lookup-caller"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the secret alone.
      yield* stack.destroy();
      const survivor = yield* secretsStore.getStoreSecret({ accountId, storeId, secretId });
      expect(survivor.name).toBe(secretName);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing secret fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { storeId } = yield* target;
      const name = testName("MISSING_SECRET", "_");
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("secret-lookup-missing", {
            script: callerScript,
            env: { BY_NAME: Cloudflare.SecretsStore.Secret.lookup({ storeId, name }) },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a secret this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("LOOKUP_MANAGED", "_");
      const managed = () =>
        Effect.gen(function* () {
          const store = yield* Cloudflare.SecretsStore.Store("lookup-managed-store");
          return yield* Cloudflare.SecretsStore.Secret("lookup-managed", {
            store,
            name,
            value: Redacted.make("managed"),
          });
        });
      const { storeId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("secret-lookup-managed-caller", {
              script: callerScript,
              env: { BY_NAME: Cloudflare.SecretsStore.Secret.lookup({ storeId, name }) },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
