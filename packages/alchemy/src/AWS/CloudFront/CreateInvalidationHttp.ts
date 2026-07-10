import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  CreateInvalidation,
  type CreateInvalidationRequest,
} from "./CreateInvalidation.ts";
import type { Distribution } from "./Distribution.ts";

export const CreateInvalidationHttp = Layer.effect(
  CreateInvalidation,
  Effect.gen(function* () {
    const createInvalidation = yield* cloudfront.createInvalidation;

    return Effect.fn(function* (distribution: Distribution) {
      const DistributionId = yield* distribution.distributionId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudFront.CreateInvalidation(${distribution}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudfront:CreateInvalidation"],
                  Resource: [distribution.distributionArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.CloudFront.CreateInvalidation(${distribution.LogicalId})`,
      )(function* (request: CreateInvalidationRequest) {
        return yield* createInvalidation({
          ...request,
          DistributionId: yield* DistributionId,
        });
      });
    });
  }),
);
