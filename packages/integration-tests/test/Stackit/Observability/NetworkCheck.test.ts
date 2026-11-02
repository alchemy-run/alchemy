import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observeInstance, slow } from "./observability.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("observability", "networkcheck"),
  timeout: 2_700_000,
} as const;

const FIRST = "example.com:443";
const SECOND = "example.org:443";

/** The instance, plus the check when props are given. */
const app = (props?: Omit<Stackit.Observability.NetworkCheckProps, "instanceId">) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.Observability.Instance("NetworkCheckInstance", {});
    if (props === undefined) return { instance, check: undefined };
    return {
      instance,
      check: yield* Stackit.Observability.NetworkCheck("CheckUnderTest", {
        instanceId: instance.instanceId,
        ...props,
      }),
    };
  });

/** Out of band: there is no get, so the check is found in the list. */
const observeCheck = (projectId: string, instanceId: string, checkId: string) =>
  observability
    .listNetworkChecks({ projectId, instanceId })
    .pipe(
      Effect.map(
        ({ networkChecks }) =>
          networkChecks.find((check) => check.id === checkId) ?? ("gone" as const),
      ),
    );

test.provider.skipIf(slow)(
  "create, replace and delete a network check",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(app({ address: FIRST }));
      const instanceId = created.instance.instanceId;
      const check = created.check!;

      expect(check.checkId).toEqual(expect.any(String));
      expect(check.instanceId).toEqual(instanceId);
      expect(check.address).toEqual(FIRST);

      // Out of band.
      const fetched = yield* observeCheck(projectId, instanceId, check.checkId);
      expect(fetched === "gone" ? "gone" : fetched.address).toEqual(FIRST);

      // `list` enumerates it, because Alchemy owns the instance.
      const provider = yield* Provider.findProvider(Stackit.Observability.NetworkCheck);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.checkId === check.checkId)?.address).toEqual(FIRST);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app({ address: FIRST }));
      expect(plan.resources.CheckUnderTest).toMatchObject({ action: "noop" });

      // A new target is a new check, and the old one goes.
      const replaced = yield* stack.deploy(app({ address: SECOND }));
      expect(replaced.check!.checkId).not.toEqual(check.checkId);
      expect(replaced.check!.address).toEqual(SECOND);
      yield* expectGone(observeCheck(projectId, instanceId, check.checkId));

      const last = replaced.check!.checkId;

      // Removing it from the stack deletes it and leaves the instance.
      yield* stack.deploy(app());
      yield* expectGone(observeCheck(projectId, instanceId, last));
      const instance = yield* observeInstance(projectId, instanceId);
      expect(instance === "gone" ? "gone" : "present").toEqual("present");

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, instanceId));
    }).pipe(logLevel),
  options,
);
