import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  RegisterInstance,
  type RegisterInstanceRequest,
} from "./RegisterInstance.ts";
import type { Service } from "./Service.ts";

export const RegisterInstanceHttp = Layer.effect(
  RegisterInstance,
  Effect.gen(function* () {
    const registerInstance = yield* SD.registerInstance;

    return Effect.fn(function* <S extends Service>(service: S) {
      const ServiceId = yield* service.serviceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudMap.RegisterInstance(${service}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["servicediscovery:RegisterInstance"],
                  Resource: [service.serviceArn],
                },
                {
                  // For DNS services Cloud Map creates Route 53 records and
                  // (optionally) health checks on the caller's behalf; these
                  // actions have no resource-level scoping for this use.
                  Effect: "Allow",
                  Action: [
                    "route53:GetHealthCheck",
                    "route53:CreateHealthCheck",
                    "route53:UpdateHealthCheck",
                    "route53:ChangeResourceRecordSets",
                    "ec2:DescribeInstances",
                  ],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CloudMap.RegisterInstance(${service.LogicalId})`)(
        function* (request: RegisterInstanceRequest) {
          const serviceId = yield* ServiceId;
          return yield* registerInstance({
            ...request,
            ServiceId: serviceId,
          });
        },
      );
    });
  }),
);
