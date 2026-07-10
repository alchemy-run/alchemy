import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import {
  DiscoverInstances,
  type DiscoverInstancesRequest,
} from "./DiscoverInstances.ts";
import type { Service } from "./Service.ts";

export const DiscoverInstancesHttp = Layer.effect(
  DiscoverInstances,
  Effect.gen(function* () {
    const discoverInstances = yield* SD.discoverInstances;

    return Effect.fn(function* <S extends Service>(service: S) {
      const NamespaceName = yield* service.namespaceName;
      const ServiceName = yield* service.serviceName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudMap.DiscoverInstances(${service}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["servicediscovery:DiscoverInstances"],
                  // DiscoverInstances does not support resource-level IAM
                  // permissions — "*" is the narrowest valid scope.
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CloudMap.DiscoverInstances(${service.LogicalId})`)(
        function* (request?: DiscoverInstancesRequest) {
          const namespaceName = yield* NamespaceName;
          const serviceName = yield* ServiceName;
          return yield* discoverInstances({
            ...request,
            NamespaceName: namespaceName,
            ServiceName: serviceName,
          });
        },
      );
    });
  }),
);
