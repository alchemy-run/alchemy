import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  RemovePermission,
  type RemovePermissionRequest,
} from "./RemovePermission.ts";
import type { Topic } from "./Topic.ts";

export const RemovePermissionHttp = Layer.effect(
  RemovePermission,
  Effect.gen(function* () {
    const removePermission = yield* sns.removePermission;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.RemovePermission(${topic}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:RemovePermission"],
                Resource: [topic.topicArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.SNS.RemovePermission(${topic.LogicalId})`)(
        function* (request: RemovePermissionRequest) {
          return yield* removePermission({
            ...request,
            TopicArn: yield* TopicArn,
          });
        },
      );
    });
  }),
);
