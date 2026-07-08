import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  DescribeAccountSettings,
  type DescribeAccountSettingsRequest,
} from "./DescribeAccountSettings.ts";

export const DescribeAccountSettingsHttp = Layer.effect(
  DescribeAccountSettings,
  Effect.gen(function* () {
    const describeAccountSettings = yield* Kinesis.describeAccountSettings;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.DescribeAccountSettings())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["kinesis:DescribeAccountSettings"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Kinesis.DescribeAccountSettings`)(function* (
        request?: DescribeAccountSettingsRequest,
      ) {
        return yield* describeAccountSettings(request ?? {});
      });
    });
  }),
);
