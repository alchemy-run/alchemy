import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  account,
  logLevel,
  sharedAccountTest,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const gallery = (version: string) =>
  `https://www.powershellgallery.com/api/v2/package/PSWriteColor/${version}`;

const program = (props: { version: string; env: string }) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const module = yield* Azure.Automation.Module("Module", {
      ...where,
      name: "PSWriteColor",
      contentLink: { uri: gallery(props.version) },
      tags: { env: props.env },
    });
    return { where, module };
  });

const getModule = (resourceGroupName: string, automationAccountName: string) =>
  Effect.gen(function* () {
    return yield* automation.GetModule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      moduleName: "PSWriteColor",
    });
  });

// Free: a ~25 KB gallery module imports in 1-3 minutes.
test.provider(
  "import, re-import, and delete a module",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, module } = yield* stack.deploy(
          program({ version: "1.0.1", env: "a" }),
        );
        const get = getModule(where.resourceGroup, where.automationAccount);
        expect(module.provisioningState).toEqual("Succeeded");
        expect(module.version).toEqual("1.0.1");
        expect((yield* get).tags?.env).toEqual("a");

        // In-place: new version re-imports; tags update.
        const updated = yield* stack.deploy(
          program({ version: "1.0.3", env: "b" }),
        );
        expect(updated.module.moduleId).toEqual(module.moduleId);
        expect(updated.module.version).toEqual("1.0.3");
        const observed = yield* get;
        expect(observed.properties?.version).toEqual("1.0.3");
        expect(observed.tags?.env).toEqual("b");

        yield* stack.destroy();
        expect(yield* waitGone(get)).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 900_000 },
);
