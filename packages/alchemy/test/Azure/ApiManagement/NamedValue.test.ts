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

const where = (
  resourceGroupName: string,
  serviceName: string,
  namedValueId: string,
) =>
  Effect.map(subscriptionId, (subscriptionId) => ({
    subscriptionId,
    resourceGroupName,
    serviceName,
    namedValueId,
  }));

const getNamedValue = (rg: string, svc: string, id: string) =>
  Effect.flatMap(where(rg, svc, id), apim.GetNamedValue);

const getValue = (rg: string, svc: string, id: string) =>
  Effect.flatMap(where(rg, svc, id), apim.ListNamedValueValue);

const program = (values?: {
  plainName: string;
  plain: string;
  secret: string;
  labels: string[];
}) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    if (values === undefined) return { group, service };
    const plain = yield* Azure.ApiManagement.NamedValue("Region", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: values.plainName,
      displayName: values.plainName,
      value: values.plain,
      tags: values.labels,
    });
    const secret = yield* Azure.ApiManagement.NamedValue("BackendKey", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "backend-key",
      displayName: "backend-key",
      value: Redacted.make(values.secret),
      secret: true,
    });
    return { group, service, plain, secret };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete plain and secret named values",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({
          plainName: "region",
          plain: "eu-west",
          secret: "s3cret-one",
          labels: ["config"],
        }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.plain?.namedValueName).toEqual("region");
      expect(first.secret?.secret).toEqual(true);
      const plain = yield* getNamedValue(rg, svc, "region");
      expect(plain.properties?.value).toEqual("eu-west");
      expect(plain.properties?.tags).toEqual(["config"]);
      const secret = yield* getNamedValue(rg, svc, "backend-key");
      expect(secret.properties?.secret).toEqual(true);
      expect(secret.properties?.value).toBeUndefined();
      expect((yield* getValue(rg, svc, "backend-key")).value).toEqual(
        "s3cret-one",
      );

      // In-place update: both values and the labels.
      yield* stack.deploy(
        program({
          plainName: "region",
          plain: "us-east",
          secret: "s3cret-two",
          labels: ["config", "geo"],
        }),
      );
      const plainUpdated = yield* getNamedValue(rg, svc, "region");
      expect(plainUpdated.properties?.value).toEqual("us-east");
      expect([...(plainUpdated.properties?.tags ?? [])].sort()).toEqual([
        "config",
        "geo",
      ]);
      expect((yield* getValue(rg, svc, "backend-key")).value).toEqual(
        "s3cret-two",
      );

      // Replacement: a new identifier creates a new named value.
      yield* stack.deploy(
        program({
          plainName: "region-v2",
          plain: "us-east",
          secret: "s3cret-two",
          labels: ["config"],
        }),
      );
      expect(
        (yield* getNamedValue(rg, svc, "region-v2")).properties?.value,
      ).toEqual("us-east");
      expect(yield* untilGone(getNamedValue(rg, svc, "region"))).toEqual(
        "gone",
      );

      // Removing the named values deletes them while the service stays.
      yield* stack.deploy(program());
      expect(yield* untilGone(getNamedValue(rg, svc, "region-v2"))).toEqual(
        "gone",
      );
      expect(yield* untilGone(getNamedValue(rg, svc, "backend-key"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
