import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { Dashboard } from "./Dashboard.ts";
import { GetDashboard, type GetDashboardRequest } from "./GetDashboard.ts";

export const GetDashboardHttp = Layer.effect(
  GetDashboard,
  Effect.gen(function* () {
    const getDashboard = yield* cloudwatch.getDashboard;

    return Effect.fn(function* (dashboard: Dashboard) {
      const DashboardName = yield* dashboard.dashboardName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.GetDashboard(${dashboard}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:GetDashboard"],
                  Resource: [dashboard.dashboardArn],
                },
              ],
            },
          );
        }
      }

      return Effect.fn(`AWS.CloudWatch.GetDashboard(${dashboard.LogicalId})`)(
        function* (request: GetDashboardRequest = {}) {
          return yield* getDashboard({
            ...request,
            DashboardName: yield* DashboardName,
          });
        },
      );
    });
  }),
);
