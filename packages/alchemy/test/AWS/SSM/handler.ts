import * as Lambda from "@/AWS/Lambda";
import * as SSM from "@/AWS/SSM";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

export class SSMTestFunction extends Lambda.Function<Lambda.Function>()(
  "SSMTestFunction",
) {}

export default SSMTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const stringParameter = yield* SSM.Parameter("TestStringParameter", {
      value: "plain-config-value",
      tags: { Environment: "test" },
    });
    const secureParameter = yield* SSM.Parameter("TestSecureParameter", {
      type: "SecureString",
      value: Redacted.make("bound-secret-value"),
    });

    const getStringParameter = yield* SSM.GetParameter(stringParameter);
    const getSecureParameter = yield* SSM.GetParameter(secureParameter);
    const getParameters = yield* SSM.GetParameters(
      stringParameter,
      secureParameter,
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/get-string") {
          const result = yield* getStringParameter();
          return yield* HttpServerResponse.json({
            name: result.Parameter?.Name,
            type: result.Parameter?.Type,
            value: plain(result.Parameter?.Value),
          });
        }

        if (request.method === "GET" && pathname === "/get-secure") {
          const result = yield* getSecureParameter({ WithDecryption: true });
          return yield* HttpServerResponse.json({
            name: result.Parameter?.Name,
            type: result.Parameter?.Type,
            value: plain(result.Parameter?.Value),
          });
        }

        if (request.method === "GET" && pathname === "/get-many") {
          const result = yield* getParameters({ WithDecryption: true });
          return yield* HttpServerResponse.json({
            parameters: (result.Parameters ?? []).map((parameter) => ({
              name: parameter.Name,
              type: parameter.Type,
              value: plain(parameter.Value),
            })),
            invalidParameters: result.InvalidParameters ?? [],
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(SSM.GetParameterHttp, SSM.GetParametersHttp)),
  ),
);
