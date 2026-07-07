import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";
import { UntagResource, type UntagResourceRequest } from "./UntagResource.ts";

export const UntagResourceHttp = Layer.effect(
  UntagResource,
  Effect.gen(function* () {
    const untagResource = yield* sns.untagResource;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.UntagResource(${topic}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:UntagResource"],
                Resource: [topic.topicArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.SNS.UntagResource(${topic.LogicalId})`)(function* (
        request: UntagResourceRequest,
      ) {
        return yield* untagResource({
          ...request,
          ResourceArn: yield* TopicArn,
        });
      });
    });
  }),
);
