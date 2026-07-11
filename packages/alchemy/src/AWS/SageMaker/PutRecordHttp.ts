import * as featurestore from "@distilled.cloud/aws/sagemaker-featurestore-runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { FeatureGroup } from "./FeatureGroup.ts";
import { PutRecord, type PutRecordRequest } from "./PutRecord.ts";

export const PutRecordHttp = Layer.effect(
  PutRecord,
  Effect.gen(function* () {
    const putRecord = yield* featurestore.putRecord;

    return Effect.fn(function* <F extends FeatureGroup>(featureGroup: F) {
      const FeatureGroupName = yield* featureGroup.featureGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.SageMaker.PutRecord(${featureGroup}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sagemaker:PutRecord"],
                  Resource: [featureGroup.featureGroupArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.SageMaker.PutRecord(${featureGroup.LogicalId})`)(
        function* (request: PutRecordRequest) {
          const featureGroupName = yield* FeatureGroupName;
          return yield* putRecord({
            ...request,
            FeatureGroupName: featureGroupName,
          });
        },
      );
    });
  }),
);
