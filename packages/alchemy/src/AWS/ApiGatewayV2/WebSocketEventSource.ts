import type * as lambda from "aws-lambda";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Api } from "./Api.ts";

/**
 * The event shape a WebSocket route handler receives — the API Gateway v2
 * WebSocket proxy event (`requestContext.connectionId`, `routeKey`,
 * `eventType`, plus `body` for `MESSAGE` events).
 */
export type WebSocketEvent = lambda.APIGatewayProxyWebsocketEventV2;

/**
 * The result a WebSocket route handler may return. For `$connect` routes a
 * non-2xx `statusCode` rejects the connection; for other routes the result
 * is only surfaced to the client when the route has a route response
 * configured. Returning `void` means `{ statusCode: 200 }`.
 */
export type WebSocketResult =
  | { statusCode: number; body?: string }
  | undefined
  | void;

export interface WebSocketRouteProps {
  /**
   * The WebSocket route key this handler serves: `$connect`,
   * `$disconnect`, `$default`, or a custom action name matched by the
   * API's route selection expression.
   */
  routeKey: string;
}

export type WebSocketEventSourceService = <Req = never>(
  api: Api,
  props: WebSocketRouteProps,
  handler: (
    event: WebSocketEvent,
  ) => Effect.Effect<WebSocketResult, never, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source connecting a WebSocket {@link Api} route to the hosting
 * Lambda function.
 *
 * At deploy time the Lambda implementation (`Lambda.WebSocketEventSource`)
 * materializes the `Integration`, `Route`, and invoke `Permission` for the
 * route; at runtime it dispatches matching WebSocket proxy events to the
 * handler.
 */
export class WebSocketEventSource extends Context.Service<
  WebSocketEventSource,
  WebSocketEventSourceService
>()("AWS.ApiGatewayV2.WebSocketEventSource") {}

/**
 * Subscribe an Effect handler to a WebSocket route of an API Gateway v2
 * WEBSOCKET {@link Api}.
 *
 * Provide `Lambda.WebSocketEventSource` on the hosting function to
 * satisfy the requirement.
 *
 * @param api The WebSocket API.
 * @param props The route key to serve.
 * @param handler Invoked once per WebSocket event for the route.
 */
export function onWebSocketRoute<Req = never>(
  api: Api,
  props: WebSocketRouteProps,
  handler: (
    event: WebSocketEvent,
  ) => Effect.Effect<WebSocketResult, never, Req>,
): Effect.Effect<void, never, WebSocketEventSource> {
  return WebSocketEventSource.use((source) => source(api, props, handler));
}
