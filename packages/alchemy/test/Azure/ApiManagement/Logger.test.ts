import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * APIM stores Application Insights keys without validating them, so fixed
 * placeholder keys keep the test free of an Insights component.
 */
const KEY_ONE = "00000000-0000-4000-8000-000000000001";
const KEY_TWO = "00000000-0000-4000-8000-000000000002";

const getLogger = (
  resourceGroupName: string,
  serviceName: string,
  loggerId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetLogger({
      subscriptionId,
      resourceGroupName,
      serviceName,
      loggerId,
    }),
  );

const program = (logger?: {
  name: string;
  key: string;
  description: string;
  isBuffered: boolean;
}) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const created = logger
      ? yield* Azure.ApiManagement.Logger("Insights", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: logger.name,
          loggerType: "applicationInsights",
          credentials: { instrumentationKey: Redacted.make(logger.key) },
          description: logger.description,
          isBuffered: logger.isBuffered,
        })
      : undefined;
    return { group, service, logger: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete a logger",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({
          name: "alchemy-insights",
          key: KEY_ONE,
          description: "first",
          isBuffered: true,
        }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.logger?.loggerName).toEqual("alchemy-insights");
      expect(first.logger?.loggerId).toContain("/loggers/alchemy-insights");
      const observed = yield* getLogger(rg, svc, "alchemy-insights");
      expect(observed.properties?.loggerType).toEqual("applicationInsights");
      expect(observed.properties?.description).toEqual("first");
      expect(observed.properties?.isBuffered).toEqual(true);

      // In-place update: description, buffering, and a rotated key.
      yield* stack.deploy(
        program({
          name: "alchemy-insights",
          key: KEY_TWO,
          description: "second",
          isBuffered: false,
        }),
      );
      const updated = yield* getLogger(rg, svc, "alchemy-insights");
      expect(updated.properties?.description).toEqual("second");
      expect(updated.properties?.isBuffered).toEqual(false);

      // Replacement: a new identifier creates a new logger and deletes the old.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-insights-v2",
          key: KEY_TWO,
          description: "second",
          isBuffered: false,
        }),
      );
      expect(replaced.logger?.loggerName).toEqual("alchemy-insights-v2");
      expect(
        (yield* getLogger(rg, svc, "alchemy-insights-v2")).properties
          ?.description,
      ).toEqual("second");
      expect(yield* untilGone(getLogger(rg, svc, "alchemy-insights"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the logger.
      yield* stack.deploy(program());
      expect(
        yield* untilGone(getLogger(rg, svc, "alchemy-insights-v2")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
