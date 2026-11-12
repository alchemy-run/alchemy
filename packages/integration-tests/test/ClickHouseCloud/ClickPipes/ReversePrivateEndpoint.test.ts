import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { messageOf } from "../fixtures/errors.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// A real endpoint needs a VPC endpoint service (or MSK cluster) in an AWS
// account. Set CLICKHOUSE_CLOUD_TEST_VPC_ENDPOINT_SERVICE to its service name.
const endpointService = process.env.CLICKHOUSE_CLOUD_TEST_VPC_ENDPOINT_SERVICE;

const declare = (vpcEndpointServiceName: string) =>
  Effect.gen(function* () {
    const serviceId = yield* testServiceId;
    return yield* ClickHouseCloud.ClickPipes.ReversePrivateEndpoint("Link", {
      serviceId,
      description: "alchemy test",
      type: "VPC_ENDPOINT_SERVICE",
      vpcEndpointServiceName,
    });
  });

test.provider.skipIf(needsService || endpointService !== undefined)(
  "an endpoint service that doesn't exist is refused",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const error = yield* stack
        .deploy(declare("com.amazonaws.vpce.us-east-1.vpce-svc-00000000000000000"))
        .pipe(Effect.flip);
      expect(error._tag).toEqual("BadRequest");
      expect(messageOf(error)).toContain(
        "VPC endpoint service com.amazonaws.vpce.us-east-1.vpce-svc-00000000000000000 was not found",
      );
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);

test.provider.skipIf(needsService || endpointService === undefined)(
  "create a reverse private endpoint, wait for it, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      if (endpointService === undefined) return;
      const rpe = yield* stack.deploy(declare(endpointService));
      // An endpoint service that needs acceptance stops at PendingAcceptance.
      expect(["Ready", "PendingAcceptance"]).toContain(rpe.status);
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 1_800_000 },
);
