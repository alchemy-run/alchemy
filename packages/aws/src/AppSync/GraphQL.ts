import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import * as SigV4 from "@distilled.cloud/aws/SigV4";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as AWSBindings from "../AWSBindings.ts";
import type { GraphqlApi } from "./GraphqlApi.ts";

/**
 * The GraphQL endpoint returned a non-2xx response or an unparseable body.
 * GraphQL *field* errors do NOT fail the effect — they are surfaced on
 * {@link GraphQLResult.errors} alongside any partial `data`.
 */
export class GraphQLApiError extends Data.TaggedError("GraphQLApiError")<{
  /** HTTP status of the failed request (0 when the request never left). */
  readonly status: number;
  /** The raw response body (or the underlying failure message). */
  readonly body: string;
}> {}

/** A single entry of the standard GraphQL `errors` array. */
export interface GraphQLErrorItem {
  message: string;
  path?: ReadonlyArray<string | number>;
  locations?: ReadonlyArray<{ line: number; column: number }>;
  errorType?: string;
  [key: string]: unknown;
}

/** The standard GraphQL response envelope. */
export interface GraphQLResult<T = unknown> {
  /** The (possibly partial) result data. */
  data?: T;
  /** GraphQL field/validation errors, if any. */
  errors?: ReadonlyArray<GraphQLErrorItem>;
  extensions?: Record<string, unknown>;
}

/** A GraphQL operation to execute against the API. */
export interface GraphQLRequest {
  /** The GraphQL document, e.g. `query($a: Int!) { add(a: $a, b: 1) }`. */
  query: string;
  /** Values for the document's variables. */
  variables?: Record<string, unknown>;
  /** Which operation to run when the document defines several. */
  operationName?: string;
}

export interface GraphQLClient {
  /**
   * Execute a GraphQL operation (query or mutation), SigV4-signed with the
   * host Function's credentials. Fails only on transport/HTTP errors —
   * GraphQL field errors are returned on `result.errors`.
   */
  execute<T = unknown>(
    request: GraphQLRequest,
  ): Effect.Effect<
    GraphQLResult<T>,
    GraphQLApiError | Credentials.CredentialsError | SigV4.SigningError
  >;
}

/**
 * Runtime binding for the `appsync:GraphQL` data-plane action — execute
 * GraphQL operations against a {@link GraphqlApi}'s endpoint from a Lambda
 * (or other AWS runtime), SigV4-signed with the host Function's IAM role.
 *
 * The API must accept `AWS_IAM` authentication (as its primary mode or an
 * additional provider). Provide `AppSync.GraphQLHttp` on the hosting
 * function's Effect to implement the binding.
 *
 * ### Executing GraphQL Operations
 * **Example:** Query an IAM-authenticated API
 * ```typescript
 * const api = yield* AppSync.GraphqlApi("Api", {
 *   authenticationType: "AWS_IAM",
 *   schema,
 * });
 * const graphql = yield* AppSync.GraphQL(api);
 *
 * const result = yield* graphql.execute<{ add: number }>({
 *   query: "query($a: Int!, $b: Int!) { add(a: $a, b: $b) }",
 *   variables: { a: 2, b: 3 },
 * });
 * // result.data?.add === 5; field errors appear on result.errors
 * ```
 *
 * @binding
 */
export interface GraphQL extends Binding.Service<
  GraphQL,
  "AWS.AppSync.GraphQL",
  (api: GraphqlApi) => Effect.Effect<GraphQLClient>
> {}
export const GraphQL = Binding.Service<GraphQL>("AWS.AppSync.GraphQL");

/**
 * HTTP implementation of the {@link GraphQL} binding. The AppSync data
 * plane has no SDK operation — each request is a SigV4-signed POST
 * (service `"appsync"`) to the API's `graphqlUrl`, made with the host
 * Function's own credentials. Grants `appsync:GraphQL` on every field of
 * the bound API (`{apiArn}/types/*&#47;fields/*`).
 */
export const GraphQLHttp = Layer.effect(
  GraphQL,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    // Resolve the ambient distilled context once at layer construction —
    // credentials themselves are re-read per request (SSO/STS rotate).
    const services = yield* AWSBindings.withCredentials(
      Effect.context<Credentials.Credentials | Region.Region | HttpClient.HttpClient>(),
    );

    return Effect.fn(function* (api: GraphqlApi) {
      // Outputs yield DEFERRED effects — resolving them here registers the
      // attribute on the host environment; re-yield per invocation below.
      const GraphqlUrl = yield* api.graphqlUrl;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.AppSync.GraphQL(${api})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["appsync:GraphQL"],
              Resource: [Output.interpolate`${api.apiArn}/types/*/fields/*`],
            },
          ],
        });
      }

      const execute = Effect.fn(`AWS.AppSync.GraphQL(${api.LogicalId})`)(function* (
        request: GraphQLRequest,
      ) {
        const url = new URL(yield* GraphqlUrl);
        const body = JSON.stringify({
          query: request.query,
          variables: request.variables,
          operationName: request.operationName,
        });

        // Sign for the API's own region, parsed from its endpoint.
        const { credentials, region, client } = yield* Effect.gen(function* () {
          const credentials = yield* yield* Credentials.Credentials;
          const region =
            /\.appsync-api\.([a-z0-9-]+)\.amazonaws\.com$/.exec(url.hostname)?.[1] ??
            (yield* yield* Region.Region);
          const client = yield* HttpClient.HttpClient;
          return { credentials, region, client };
        }).pipe(Effect.provideContext(services));

        const signed = yield* SigV4.sign({
          method: "POST",
          url: url.toString(),
          headers: { "content-type": "application/json" },
          body,
          accessKeyId: Redacted.value(credentials.accessKeyId),
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
          service: "appsync",
          region,
          allHeaders: true,
        });

        const toError = (status: number) => (cause: unknown) =>
          new GraphQLApiError({
            status,
            body: cause instanceof Error ? cause.message : String(cause),
          });

        const response = yield* client
          .execute(
            HttpClientRequest.post(signed.url).pipe(
              HttpClientRequest.bodyText(body),
              // The signed headers (content-type included) win over the body's.
              HttpClientRequest.setHeaders(signed.headers),
            ),
          )
          .pipe(Effect.mapError(toError(0)));
        const text = yield* response.text.pipe(Effect.mapError(toError(response.status)));
        if (response.status < 200 || response.status >= 300) {
          return yield* new GraphQLApiError({ status: response.status, body: text });
        }
        return yield* Effect.try({
          try: () => JSON.parse(text) as GraphQLResult,
          catch: toError(response.status),
        });
      });

      return { execute } as GraphQLClient;
    });
  }),
);
