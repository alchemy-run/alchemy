import * as SSM from "@distilled.cloud/aws/ssm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import { GetParameter, type GetParameterRequest } from "./GetParameter.ts";
import type { Parameter } from "./Parameter.ts";

export const GetParameterHttp = Layer.effect(
  GetParameter,
  Effect.gen(function* () {
    const getParameter = yield* SSM.getParameter;

    return Effect.fn(function* <P extends Parameter>(parameter: P) {
      const Name = yield* parameter.parameterName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SSM.GetParameter(${parameter}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["ssm:GetParameter"],
                Resource: [parameter.parameterArn],
              },
              {
                // kms:Decrypt so `WithDecryption: true` works on SecureString
                // parameters. For String/StringList parameters `keyArn` is
                // undefined and we fall back to the parameter's own ARN, which
                // matches no KMS key — the statement then grants nothing.
                Effect: "Allow",
                Action: ["kms:Decrypt"],
                Resource: [
                  Output.all(parameter.parameterArn, parameter.keyArn).pipe(
                    Output.map(
                      ([parameterArn, keyArn]) => keyArn ?? parameterArn,
                    ),
                  ),
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.SSM.GetParameter(${parameter.LogicalId})`)(
        function* (request: GetParameterRequest = {}) {
          return yield* getParameter({
            ...request,
            Name: yield* Name,
          });
        },
      );
    });
  }),
);
