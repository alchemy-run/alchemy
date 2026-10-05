import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  account,
  logLevel,
  subscription,
  tags,
  waitGone,
  sharedAccountTest,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name?: string; runAs: boolean }) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const credential = yield* Azure.Automation.Credential("RunAs", {
      ...where,
      userName: "svc-runbooks",
      password: Redacted.make("not-a-real-password-1!"),
    });
    const group = yield* Azure.Automation.HybridRunbookWorkerGroup("Workers", {
      ...where,
      name: props.name,
      credential: props.runAs ? credential.credentialName : undefined,
    });
    return { where, credential, group };
  });

const getGroup = (
  resourceGroupName: string,
  automationAccountName: string,
  hybridRunbookWorkerGroupName: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetHybridRunbookWorkerGroup({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      hybridRunbookWorkerGroupName,
    });
  });

// Free: an empty worker group needs no machines; seconds to provision.
test.provider(
  "create, update, replace, and delete a hybrid worker group",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, group } = yield* stack.deploy(program({ runAs: false }));
        const get = (name: string) =>
          getGroup(where.resourceGroup, where.automationAccount, name);
        const observed = yield* get(group.hybridRunbookWorkerGroupName);
        expect(
          observed.properties?.credential?.name ?? undefined,
        ).toBeUndefined();

        // In-place: attach a Run As credential.
        const updated = yield* stack.deploy(program({ runAs: true }));
        expect(updated.group.hybridRunbookWorkerGroupId).toEqual(
          group.hybridRunbookWorkerGroupId,
        );
        expect(
          (yield* get(group.hybridRunbookWorkerGroupName)).properties
            ?.credential?.name,
        ).toEqual(updated.credential.credentialName);

        // Replacement: the name is immutable.
        const replaced = yield* stack.deploy(
          program({ name: "alchemy-test-workers-renamed", runAs: true }),
        );
        expect(replaced.group.hybridRunbookWorkerGroupName).toEqual(
          "alchemy-test-workers-renamed",
        );
        expect(
          yield* waitGone(get(group.hybridRunbookWorkerGroupName)),
        ).toEqual("gone");

        yield* stack.destroy();
        expect(
          yield* waitGone(get(replaced.group.hybridRunbookWorkerGroupName)),
        ).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
