import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  ListDashboards,
  type ListDashboardsRequest,
} from "./ListDashboards.ts";

export const ListDashboardsHttp = Layer.effect(
  ListDashboards,
  Effect.gen(function* () {
    const listDashboards = yield* cloudwatch.listDashboards;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.ListDashboards())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:ListDashboards"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.CloudWatch.ListDashboards`)(function* (
        request: ListDashboardsRequest = {},
      ) {
        return yield* listDashboards(request);
      });
    });
  }),
);
