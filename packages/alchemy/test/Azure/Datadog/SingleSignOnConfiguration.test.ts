import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datadog from "@distilled.cloud/azure/datadog";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  logLevel,
  monitorStack,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfiguration = (resourceGroupName: string, monitorName: string) =>
  Effect.gen(function* () {
    return yield* datadog.GetSingleSignOnConfiguration({
      subscriptionId: yield* subscription,
      resourceGroupName,
      monitorName,
      configurationName: "default",
    });
  });

/** Entra ID enterprise app created from the Datadog SAML gallery app. */
const enterpriseAppId = process.env.AZURE_TEST_DATADOG_ENTERPRISE_APP_ID;

const program = (singleSignOnState: "Enable" | "Disable") =>
  Effect.gen(function* () {
    const { group, monitor } = yield* monitorStack;
    const sso = yield* Azure.Datadog.SingleSignOnConfiguration("Sso", {
      resourceGroup: group.resourceGroupName,
      monitor: monitor.monitorName,
      singleSignOnState,
      enterpriseAppId,
    });
    return { group, monitor, sso };
  });

// Needs a Datadog monitor (Marketplace SaaS purchase, ~3-10 minutes; the
// free trial cannot create one, see the Monitor probe) and an Entra ID
// enterprise app from the Datadog gallery. Run only with AZURE_TEST_PAID=1
// and AZURE_TEST_DATADOG_ENTERPRISE_APP_ID.
test.provider.skipIf(!runPaidOnly || !enterpriseAppId)(
  "enable and disable datadog single sign-on",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, monitor, sso } = yield* stack.deploy(program("Enable"));
      expect(sso.singleSignOnState).toEqual("Enable");
      const observed = yield* getConfiguration(
        group.resourceGroupName,
        monitor.monitorName,
      );
      expect(observed.properties?.enterpriseAppId).toEqual(enterpriseAppId);

      // In place: disable.
      yield* stack.deploy(program("Disable"));
      expect(
        (yield* getConfiguration(group.resourceGroupName, monitor.monitorName))
          .properties?.singleSignOnState,
      ).toEqual("Disable");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getConfiguration(group.resourceGroupName, monitor.monitorName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
