import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { GetServiceQuota } from "./GetServiceQuota.ts";

export const GetServiceQuotaHttp = Layer.effect(
  GetServiceQuota,
  Effect.gen(function* () {
    const getServiceQuota = yield* servicequotas.getServiceQuota;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ServiceQuotas.GetServiceQuota())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["servicequotas:GetServiceQuota"],
                  // servicequotas:GetServiceQuota has no resource-level IAM
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn("AWS.ServiceQuotas.GetServiceQuota")(function* (
        request: servicequotas.GetServiceQuotaRequest,
      ) {
        return yield* getServiceQuota(request);
      });
    });
  }),
);
