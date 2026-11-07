import { Endpoint } from "@distilled.cloud/aws";
import * as mgmt from "@distilled.cloud/aws/apigatewaymanagementapi";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { ApiGatewayV2Stage } from "./Stage.ts";

export interface PostToConnectionRequest extends mgmt.PostToConnectionRequest {}
export interface GetConnectionRequest extends mgmt.GetConnectionRequest {}
export interface DeleteConnectionRequest extends mgmt.DeleteConnectionRequest {}

/**
 * The runtime client returned by binding {@link ManageConnections} to a
 * WebSocket API stage.
 */
export interface ManageConnectionsClient {
  /**
   * Send data to a connected WebSocket client. Fails with a typed
   * `GoneException` when the connection has already disconnected (410).
   */
  readonly postToConnection: (
    request: PostToConnectionRequest,
  ) => Effect.Effect<mgmt.PostToConnectionResponse, mgmt.PostToConnectionError>;
  /**
   * Get metadata (connect time, last active time, source identity) about a
   * connection.
   */
  readonly getConnection: (
    request: GetConnectionRequest,
  ) => Effect.Effect<mgmt.GetConnectionResponse, mgmt.GetConnectionError>;
  /**
   * Forcibly disconnect a WebSocket client.
   */
  readonly deleteConnection: (
    request: DeleteConnectionRequest,
  ) => Effect.Effect<mgmt.DeleteConnectionResponse, mgmt.DeleteConnectionError>;
}

/**
 * Runtime binding for the WebSocket `@connections` management API
 * (`execute-api:ManageConnections`).
 *
 * Bind this to a WebSocket API {@link Stage} inside a function runtime to
 * push messages to connected clients — the flagship server-push primitive
 * for WebSocket APIs. The binding grants `execute-api:ManageConnections`
 * scoped to the stage's `@connections` ARN and targets the stage's
 * callback endpoint (`https://{apiId}.execute-api.{region}.amazonaws.com/{stage}`).
 *
 * Provide `ApiGatewayV2.ManageConnectionsHttp` on the hosting function's
 * Effect (`Effect.provide(ApiGatewayV2.ManageConnectionsHttp)`) to satisfy
 * the binding.
 * ### Pushing to clients
 * **Example:** Echo a message back to the sender
 * ```typescript
 * const connections = yield* ApiGatewayV2.ManageConnections(stage);
 *
 * yield* ApiGatewayV2.onWebSocketRoute(api, { routeKey: "$default" }, (event) =>
 *   connections
 *     .postToConnection({
 *       ConnectionId: event.requestContext.connectionId,
 *       Data: `echo:${event.body ?? ""}`,
 *     })
 *     .pipe(
 *       Effect.asVoid,
 *       // The peer may have disconnected between send and receive.
 *       Effect.catchTag("GoneException", () => Effect.void),
 *       Effect.orDie,
 *     ),
 * );
 * ```
 *
 * ### Managing connections
 * **Example:** Disconnect a client
 * ```typescript
 * yield* connections.deleteConnection({ ConnectionId: staleConnectionId });
 * ```
 *
 * @binding
 */
export interface ManageConnections extends Binding.Service<
  ManageConnections,
  "AWS.ApiGatewayV2.ManageConnections",
  <S extends ApiGatewayV2Stage>(stage: S) => Effect.Effect<ManageConnectionsClient>
> {}
export const ManageConnections = Binding.Service<ManageConnections>(
  "AWS.ApiGatewayV2.ManageConnections",
);

/**
 * HTTP implementation of the {@link ManageConnections} binding. Signs
 * `@connections` requests with the Lambda's IAM role against the stage's
 * callback endpoint.
 *
 * Provide it on the hosting Lambda function's Effect so the binding is
 * available at runtime:
 *
 * @example
 * ```typescript
 * export default MyFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const connections = yield* ApiGatewayV2.ManageConnections(stage);
 *     // ... register WebSocket routes that push via `connections`
 *     return {};
 *   }).pipe(Effect.provide(ApiGatewayV2.ManageConnectionsHttp)),
 * );
 * ```
 */
export const ManageConnectionsHttp = Layer.effect(
  ManageConnections,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const postToConnection = yield* AWSBindings.withCredentials(mgmt.postToConnection);
    const getConnection = yield* AWSBindings.withCredentials(mgmt.getConnection);
    const deleteConnection = yield* AWSBindings.withCredentials(mgmt.deleteConnection);

    return Effect.fn(function* <S extends ApiGatewayV2Stage>(stage: S) {
      const CallbackUrl = yield* stage.callbackUrl;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.ApiGatewayV2.ManageConnections(${stage})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["execute-api:ManageConnections"],
              Resource: [stage.connectionsArn],
            },
          ],
        });
      }

      // The management API is served from the stage's own callback
      // endpoint rather than the service default, so each call overrides
      // the distilled endpoint resolver with the bound URL.
      const withEndpoint = <A, E>(
        effect: Effect.Effect<A, E>,
        endpoint: string,
      ): Effect.Effect<A, E> =>
        Effect.provideService(effect, Endpoint.Endpoint, Effect.succeed(endpoint));

      return {
        postToConnection: Effect.fn(`AWS.ApiGatewayV2.PostToConnection(${stage.LogicalId})`)(
          function* (request: PostToConnectionRequest) {
            const endpoint = yield* CallbackUrl;
            return yield* withEndpoint(postToConnection(request), endpoint);
          },
        ),
        getConnection: Effect.fn(`AWS.ApiGatewayV2.GetConnection(${stage.LogicalId})`)(function* (
          request: GetConnectionRequest,
        ) {
          const endpoint = yield* CallbackUrl;
          return yield* withEndpoint(getConnection(request), endpoint);
        }),
        deleteConnection: Effect.fn(`AWS.ApiGatewayV2.DeleteConnection(${stage.LogicalId})`)(
          function* (request: DeleteConnectionRequest) {
            const endpoint = yield* CallbackUrl;
            return yield* withEndpoint(deleteConnection(request), endpoint);
          },
        ),
      };
    });
  }),
);
