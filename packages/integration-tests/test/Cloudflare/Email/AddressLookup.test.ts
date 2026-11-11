import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import { expectDeployFails } from "../../lookup.ts";
import { testName } from "../../names.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import { emailRoutingScoped } from "./scope.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:email", "live"];

// The standing destination address the EmailAddress suite keeps: Cloudflare
// refuses to delete an address for ~15 minutes after creating it, and every
// create sends a verification email, so tests reuse one retained address.
const standingEmail = "alchemy-list-test@alchemy-test-2.us";

// Echoes the address the Worker was given, proving the lookup's attribute
// reached a consumer.
const callerScript = `export default {
  async fetch(request, env) {
    return new Response("forward to " + env.TO);
  },
};`;

// The target stack registers (or re-adopts) the standing address, retained
// so destroying the stack never tries to delete it.
const TargetStack = Alchemy.Stack(
  "EmailAddressLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const address = yield* Cloudflare.Email.Address("lookup-target", {
      email: standingEmail,
    }).pipe(RemovalPolicy.retain());
    return { addressId: address.addressId.as<string>() };
  }),
);

// Without the Email Routing scope every test skips, so nothing deploys.
const target = beforeAll(
  emailRoutingScoped ? deploy(TargetStack) : Effect.succeed({ addressId: "" }),
);
afterAll.skipIf(!emailRoutingScoped || !!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider.skipIf(!emailRoutingScoped)(
  "a looked-up address reaches a consumer, by email and by id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { addressId } = yield* target;

      const program = Effect.gen(function* () {
        const byEmail = Cloudflare.Email.Address.lookup({ email: standingEmail });
        const byId = Cloudflare.Email.Address.lookup({ addressId });
        const caller = yield* Cloudflare.Worker("address-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { TO: byEmail.email },
        });
        return {
          url: caller.url.as<string>(),
          addressId: byEmail.addressId,
          emailById: byId.email,
        };
      });
      const out = yield* stack.deploy(program);
      expect(out.addressId).toBe(addressId);
      expect(out.emailById).toBe(standingEmail);

      yield* expectUrlContains(out.url, `forward to ${standingEmail}`, {
        label: "address lookup caller",
      });

      // A lookup re-resolves to the same address, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["address-lookup-caller"].action).toBe("noop");

      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider.skipIf(!emailRoutingScoped)(
  "a lookup of a missing address fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const email = `${testName("missing")}@alchemy-test-2.us`;
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("address-lookup-missing", {
            script: callerScript,
            env: { TO: Cloudflare.Email.Address.lookup({ email }).email },
          }),
        ),
        ["LookupNotFoundError", email],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider.skipIf(!emailRoutingScoped)(
  "a lookup of an address this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        Cloudflare.Email.Address("lookup-managed", { email: standingEmail }).pipe(
          RemovalPolicy.retain(),
        );
      yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("address-lookup-managed-caller", {
              script: callerScript,
              env: { TO: Cloudflare.Email.Address.lookup({ email: standingEmail }).email },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
