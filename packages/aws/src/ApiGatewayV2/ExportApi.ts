import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Api } from "./Api.ts";
import { RegisterApiGatewayV2Binding } from "./BindingHttp.ts";

/**
 * Request options for {@link ExportApi}. `ApiId` is resolved from the
 * bound {@link Api}; `Specification` defaults to `OAS30` (the only
 * supported value — exports are OpenAPI 3.0, HTTP APIs only).
 */
export interface ExportApiRequest extends Partial<Omit<agw2.ExportApiRequest, "ApiId">> {}

/**
 * Runtime binding for exporting an HTTP API's OpenAPI 3.0 definition
 * (`apigateway:GET` on `/apis/{apiId}/exports/{specification}`).
 *
 * Bind an {@link Api} inside a function runtime to serve or snapshot the
 * live API definition — e.g. publishing your own `/openapi.json` route or
 * diffing deployed routes against the source of truth. The response
 * `body` is a byte `Stream` of the JSON (or YAML) document. Provide
 * `ApiGatewayV2.ExportApiHttp` on the Function effect to implement the
 * binding.
 *
 * ### Exporting API definitions
 * **Example:** Serve the live OpenAPI document
 * ```typescript
 * // init
 * const exportApi = yield* ApiGatewayV2.ExportApi(api);
 *
 * // runtime
 * const exported = yield* exportApi({ OutputType: "JSON" });
 * const document = yield* Stream.mkString(Stream.decodeText(exported.body!));
 * ```
 *
 * @binding
 */
export interface ExportApi extends Binding.Service<
  ExportApi,
  "AWS.ApiGatewayV2.ExportApi",
  <A extends Api>(
    api: A,
  ) => Effect.Effect<
    (request?: ExportApiRequest) => Effect.Effect<agw2.ExportApiResponse, agw2.ExportApiError>
  >
> {}
export const ExportApi = Binding.Service<ExportApi>("AWS.ApiGatewayV2.ExportApi");

/**
 * HTTP implementation of the {@link ExportApi} binding. Grants
 * `apigateway:GET` on the API's `/exports/*` path and calls the API with
 * the host Function's credentials.
 */
export const ExportApiHttp = Layer.effect(
  ExportApi,
  Effect.gen(function* () {
    const registerApiGatewayV2Binding = yield* RegisterApiGatewayV2Binding;
    const exportApi = yield* AWSBindings.withCredentials(agw2.exportApi);
    return Effect.fn(function* <A extends Api>(api: A) {
      const ApiId = yield* api.apiId;
      yield* registerApiGatewayV2Binding({
        cap: "AWS.ApiGatewayV2.ExportApi",
        target: api,
        verb: "GET",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/apis/${api.apiId}/exports/*`,
        ],
      });
      return Effect.fn(`AWS.ApiGatewayV2.ExportApi(${api.LogicalId})`)(function* (
        request?: ExportApiRequest,
      ) {
        return yield* exportApi({
          ...request,
          ApiId: yield* ApiId,
          Specification: request?.Specification ?? "OAS30",
        });
      });
    });
  }),
);
