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

const program = (props: { version: string }) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const environment = yield* Azure.Automation.RuntimeEnvironment("Env", {
      ...where,
      language: "PowerShell",
      version: "7.4",
    });
    const pkg = yield* Azure.Automation.RuntimeEnvironmentPackage("Package", {
      ...where,
      runtimeEnvironment: environment.runtimeEnvironmentName,
      name: "PSWriteColor",
      contentLink: { uri: gallery(props.version) },
    });
    return { where, environment, pkg };
  });

const getPackage = (
  resourceGroupName: string,
  automationAccountName: string,
  runtimeEnvironmentName: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetPackage({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      runtimeEnvironmentName,
      packageName: "PSWriteColor",
    });
  });

// Free: a ~25 KB gallery module imports in 1-3 minutes.
test.provider(
  "import, re-import, and delete a runtime environment package",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, environment, pkg } = yield* stack.deploy(
          program({ version: "1.0.1" }),
        );
        const get = getPackage(
          where.resourceGroup,
          where.automationAccount,
          environment.runtimeEnvironmentName,
        );
        expect(pkg.provisioningState).toEqual("Succeeded");
        expect((yield* get).properties?.version).toEqual("1.0.1");

        // In-place: a new version re-imports the package.
        const updated = yield* stack.deploy(program({ version: "1.0.3" }));
        expect(updated.pkg.packageId).toEqual(pkg.packageId);
        expect((yield* get).properties?.version).toEqual("1.0.3");

        yield* stack.destroy();
        expect(yield* waitGone(get)).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 900_000 },
);
