import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { AddPermission, type AddPermissionRequest } from "./AddPermission.ts";
import type { Topic } from "./Topic.ts";

export const AddPermissionHttp = Layer.effect(
  AddPermission,
  Effect.gen(function* () {
    const addPermission = yield* sns.addPermission;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.AddPermission(${topic}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:AddPermission"],
                Resource: [topic.topicArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.SNS.AddPermission(${topic.LogicalId})`)(function* (
        request: AddPermissionRequest,
      ) {
        return yield* addPermission({
          ...request,
          TopicArn: yield* TopicArn,
        });
      });
    });
  }),
);
