import * as featurestore from "@distilled.cloud/aws/sagemaker-featurestore-runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { FeatureGroup } from "./FeatureGroup.ts";
import { GetRecord, type GetRecordRequest } from "./GetRecord.ts";

export const GetRecordHttp = Layer.effect(
  GetRecord,
  Effect.gen(function* () {
    const getRecord = yield* featurestore.getRecord;

    return Effect.fn(function* <F extends FeatureGroup>(featureGroup: F) {
      const FeatureGroupName = yield* featureGroup.featureGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.SageMaker.GetRecord(${featureGroup}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sagemaker:GetRecord"],
                  Resource: [featureGroup.featureGroupArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.SageMaker.GetRecord(${featureGroup.LogicalId})`)(
        function* (request: GetRecordRequest) {
          const featureGroupName = yield* FeatureGroupName;
          return yield* getRecord({
            ...request,
            FeatureGroupName: featureGroupName,
          });
        },
      );
    });
  }),
);
