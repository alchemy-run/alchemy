import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as cf from "@distilled.cloud/stackit/cloud_foundry";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitTags } from "../helpers.ts";
import { asManager, deployer, expectGone } from "./helpers.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("cloudfoundry", "serviceinstance"),
  timeout: 1_500_000,
} as const;

test.provider(
  "create, update and delete a user-provided instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (args: { apiKey: string; tags: string[]; name?: string }) =>
        Effect.gen(function* () {
          const target = yield* deployer("Service");
          const instance = yield* Stackit.CloudFoundry.ServiceInstance("Provided", {
            spaceId: target.space.spaceId,
            credentials: target.credentials,
            name: args.name,
            serviceCredentials: { apiKey: Redacted.make(args.apiKey) },
            tags: args.tags,
          });
          return { manager: target.manager, instance };
        });

      const created = yield* stack.deploy(program({ apiKey: "one", tags: ["payments"] }));
      const login = created.manager;
      expect(created.instance.type).toEqual("user-provided");
      expect(created.instance.tags).toEqual(["payments"]);
      const guid = created.instance.serviceInstanceId;

      // Out of band: the credentials reached the instance.
      const observed = yield* cf.getServiceInstanceCredentials({ guid }).pipe(asManager(login));
      expect(Redacted.value(observed.apiKey as Redacted.Redacted<string>)).toEqual("one");

      const unchanged = yield* stack.plan(program({ apiKey: "one", tags: ["payments"] }));
      expect(unchanged.resources.Provided).toMatchObject({ action: "noop" });

      const updated = yield* stack.deploy(
        program({ apiKey: "two", tags: ["payments", "eu"], name: "alchemy-test-cf-provided" }),
      );
      expect(updated.instance.serviceInstanceId).toEqual(guid);
      expect(updated.instance.name).toEqual("alchemy-test-cf-provided");
      expect([...updated.instance.tags].sort()).toEqual(["eu", "payments"]);
      const afterUpdate = yield* cf.getServiceInstanceCredentials({ guid }).pipe(asManager(login));
      expect(Redacted.value(afterUpdate.apiKey as Redacted.Redacted<string>)).toEqual("two");

      // Dropping the instance from the stack deletes it, with the manager still there.
      yield* stack.deploy(deployer("Service"));
      yield* expectGone(cf.getServiceInstance({ guid }).pipe(asManager(login)));

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

// Priced by the offering, and which offerings exist is the account's: name one to run this.
test.provider.skipIf(!process.env.STACKIT_TEST_CF_OFFERING || !process.env.STACKIT_TEST_CF_PLAN)(
  "create and delete a managed instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (offering: string) =>
        Effect.gen(function* () {
          const target = yield* deployer("Managed");
          const instance = yield* Stackit.CloudFoundry.ServiceInstance("Managed", {
            spaceId: target.space.spaceId,
            credentials: target.credentials,
            offering,
            plan: process.env.STACKIT_TEST_CF_PLAN!,
          });
          return { manager: target.manager, instance };
        });
      const deployed = yield* stack.deploy(program(process.env.STACKIT_TEST_CF_OFFERING!));
      expect(deployed.instance.type).toEqual("managed");
      expect(deployed.instance.lastOperationState).toEqual("succeeded");
      const guid = deployed.instance.serviceInstanceId;

      // A plan can only move within its offering, so another offering is another instance.
      const otherOffering = yield* stack.plan(program("alchemy-test-other-offering"));
      expect(otherOffering.resources.Managed).toMatchObject({ action: "replace" });

      yield* stack.deploy(deployer("Managed"));
      yield* expectGone(cf.getServiceInstance({ guid }).pipe(asManager(deployed.manager)));

      yield* stack.destroy();
    }).pipe(logLevel),
  { ...options, timeout: 2_400_000 },
);
