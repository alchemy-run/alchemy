import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import {
  DeregisterInstance,
  type DeregisterInstanceRequest,
} from "./DeregisterInstance.ts";
import type { Service } from "./Service.ts";

export const DeregisterInstanceHttp = Layer.effect(
  DeregisterInstance,
  Effect.gen(function* () {
    const deregisterInstance = yield* SD.deregisterInstance;

    return Effect.fn(function* <S extends Service>(service: S) {
      const ServiceId = yield* service.serviceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudMap.DeregisterInstance(${service}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["servicediscovery:DeregisterInstance"],
                  Resource: [service.serviceArn],
                },
                {
                  // Cloud Map deletes the Route 53 records/health check it
                  // created for the instance; these actions have no
                  // resource-level scoping for this use.
                  Effect: "Allow",
                  Action: [
                    "route53:GetHealthCheck",
                    "route53:DeleteHealthCheck",
                    "route53:UpdateHealthCheck",
                    "route53:ChangeResourceRecordSets",
                  ],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CloudMap.DeregisterInstance(${service.LogicalId})`)(
        function* (request: DeregisterInstanceRequest) {
          const serviceId = yield* ServiceId;
          return yield* deregisterInstance({
            ...request,
            ServiceId: serviceId,
          });
        },
      );
    });
  }),
);
