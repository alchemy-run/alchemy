import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { BindKey } from "../ClickHouseCloudBindings.ts";
import { RunQueryApiEndpointFailed } from "../Errors.ts";
import type { QueryApiEndpoint } from "./QueryApiEndpoint.ts";
import { RunQueryApiEndpoint, type RunQueryApiEndpointRequest } from "./RunQueryApiEndpoint.ts";

/** Parse a `JSONEachRow` body: one JSON object per line. */
const parseRows = (body: string) =>
  Effect.try({
    try: () =>
      body
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    catch: () => new RunQueryApiEndpointFailed({ status: 200, body }),
  });

/** {@link RunQueryApiEndpoint} over HTTPS; works on any host. */
export const RunQueryApiEndpointHttp = Layer.effect(
  RunQueryApiEndpoint,
  Effect.gen(function* () {
    const bindKey = yield* BindKey;
    return Effect.fn(function* (target: QueryApiEndpoint) {
      const { key, keyId, keySecret } = yield* bindKey(
        "RunQueryApiEndpoint",
        target,
        // From the props, not the endpoint's attributes: the endpoint waits
        // for this key (binding data), so the role can't wait for the endpoint.
        Output.interpolate`instance/${target.Props.serviceId}`,
        ["control-plane:service:view-query-api-endpoints"],
      );
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        yield* target.bind(
          `ClickHouseCloud.QueryApiEndpoints.RunQueryApiEndpoint(${host?.LogicalId ?? ""})`,
          { apiKeyIds: [key.id] },
        );
      }
      const url = yield* target.url;
      return (request?: RunQueryApiEndpointRequest) =>
        Effect.gen(function* () {
          const auth = `${yield* keyId}:${Redacted.value(yield* keySecret)}`;
          // The endpoint's own URL, as `getQueryApiEndpoint` hands it back.
          const response = yield* HttpClient.execute(
            HttpClientRequest.post(yield* url).pipe(
              HttpClientRequest.setUrlParam("format", "JSONEachRow"),
              HttpClientRequest.setHeader("Authorization", `Basic ${btoa(auth)}`),
              HttpClientRequest.bodyJsonUnsafe({ queryVariables: request?.queryVariables ?? {} }),
            ),
          );
          const body = yield* response.text;
          if (response.status >= 300) {
            return yield* new RunQueryApiEndpointFailed({ status: response.status, body });
          }
          return yield* parseRows(body);
        }).pipe(Effect.provide(FetchHttpClient.layer));
    });
  }),
);
