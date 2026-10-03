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

const WHEELS = {
  "1.16.0":
    "https://files.pythonhosted.org/packages/d9/5a/e7c31adbe875f2abbb91bd84cf2dc52d792b5a01506781dbcf25c91daf11/six-1.16.0-py2.py3-none-any.whl",
  "1.17.0":
    "https://files.pythonhosted.org/packages/b7/ce/149a00dd41f10bc29e5921b496af8b574d8413afcd5e30dfa0ed46c2cc5e/six-1.17.0-py2.py3-none-any.whl",
} as const;

const program = (props: { version: keyof typeof WHEELS }) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const pkg = yield* Azure.Automation.Python3Package("Package", {
      ...where,
      name: "six",
      contentLink: { uri: WHEELS[props.version] },
    });
    return { where, pkg };
  });

const getPackage = (resourceGroupName: string, automationAccountName: string) =>
  Effect.gen(function* () {
    return yield* automation.GetPython3Package({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      packageName: "six",
    });
  });

// Free: a ~11 KB wheel imports in 1-3 minutes.
test.provider(
  "import, re-import, and delete a python 3 package",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, pkg } = yield* stack.deploy(
          program({ version: "1.16.0" }),
        );
        const get = getPackage(where.resourceGroup, where.automationAccount);
        expect(pkg.provisioningState).toEqual("Succeeded");
        expect((yield* get).properties?.version).toEqual("1.16.0");

        // In-place: a new wheel re-imports the package.
        const updated = yield* stack.deploy(program({ version: "1.17.0" }));
        expect(updated.pkg.packageId).toEqual(pkg.packageId);
        expect((yield* get).properties?.version).toEqual("1.17.0");

        yield* stack.destroy();
        expect(yield* waitGone(get)).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 900_000 },
);
