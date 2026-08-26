import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as chromemanagement from "@distilled.cloud/gcp/chromemanagement_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  customerName,
  hasGcpCreds,
  logLevel,
  probeName,
  probeParent,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const probeBody: chromemanagement.GoogleChromeManagementVersionsV1ConnectorConfig =
  {
    displayName: "Alchemy Probe",
    type: "REPORTING",
    details: {
      pubSubConfig: {
        topicFullPath:
          "projects/alchemy-gcp-testing-83661/topics/alchemy-probe",
        reportingSettings: {
          enabledDefaultEvents: ["ALL_DEFAULT_EVENTS"],
        },
      },
    },
  };

test.provider.skipIf(!hasGcpCreds)(
  "getCustomersConnectorConfigs on a missing connector config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        chromemanagement.getCustomersConnectorConfigs({
          name: probeName,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CHROMEMANAGEMENT)(
  "createCustomersConnectorConfigs without Chrome Management access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        chromemanagement.createCustomersConnectorConfigs({
          parent: probeParent,
          connectorConfigId: "alchemy-probe",
          body: probeBody,
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a connector config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = customerName;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("ChromeEvents", {});
          const config = yield* GCP.Chromemanagement.CustomersConnectorConfig(
            "Reporting",
            {
              parent,
              type: "REPORTING",
              displayName: "Alchemy reporting",
              details: {
                pubSubConfig: {
                  topicFullPath: topic.name,
                  reportingSettings: {
                    enabledDefaultEvents: ["ALL_DEFAULT_EVENTS"],
                  },
                },
              },
            },
          );
          return { config, topicName: topic.name };
        }),
      );

      expect(created.config.name).toContain("/connectorConfigs/");
      expect(created.config.parent).toEqual(parent);
      expect(created.config.connectorConfigId.length).toBeGreaterThan(0);
      expect(created.config.displayName).toEqual("Alchemy reporting");
      expect(created.config.type).toEqual("REPORTING");
      expect(created.config.details?.pubSubConfig?.topicFullPath).toEqual(
        created.topicName,
      );

      const fetched = yield* chromemanagement.getCustomersConnectorConfigs({
        name: created.config.name,
      });
      expect(fetched.name).toEqual(created.config.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.type).toEqual("REPORTING");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("ChromeEvents", {});
          const config = yield* GCP.Chromemanagement.CustomersConnectorConfig(
            "Reporting",
            {
              parent: created.config.parent,
              connectorConfigId: created.config.connectorConfigId,
              type: "REPORTING",
              displayName: "Alchemy reporting (prod)",
              details: {
                pubSubConfig: {
                  topicFullPath: topic.name,
                  reportingSettings: {
                    enabledDefaultEvents: ["BROWSER_CRASH_EVENT"],
                    enabledOptInEvents: ["ALL_OPT_IN_EVENTS"],
                  },
                },
              },
            },
          );
          return { config, topicName: topic.name };
        }),
      );

      expect(updated.config.name).toEqual(created.config.name);
      expect(updated.config.displayName).toEqual("Alchemy reporting (prod)");
      expect(
        updated.config.details?.pubSubConfig?.reportingSettings
          ?.enabledDefaultEvents,
      ).toContain("BROWSER_CRASH_EVENT");

      const fetchedUpdate =
        yield* chromemanagement.getCustomersConnectorConfigs({
          name: updated.config.name,
        });
      expect(fetchedUpdate.displayName).toContain("Alchemy reporting (prod)");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.config.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
