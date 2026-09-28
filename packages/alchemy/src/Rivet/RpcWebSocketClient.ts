import * as Shared from "../Workers/RpcWebSocketClient.ts";

export type { LayerOptions } from "../Workers/RpcWebSocketClient.ts";

/**
 * Browser-safe, scoped Effect RPC client using the shared WebSocket protocol.
 * Rivet's engine remains private. Browsers connect through an authenticated,
 * WebSocket-capable application ingress, never through a Lambda Function URL.
 * Direct native gateway connections require Rivet's bare subprotocols.
 *
 * ### Scoped Application Connection
 * **Example:** Connect through an authorized WebSocket ingress
 * ```typescript
 * const RoomLive = RpcWebSocketClient.layer(RoomClient, RoomRpcs,
 *   "wss://app.example.com/rooms/lobby", {
 *     socket: { protocols: ["rivet", "rivet_encoding.bare"] },
 *   },
 * ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
 * ```
 * The Layer owns the connection. Releasing it closes the socket and interrupts
 * unfinished calls; reconnects do not replay requests.
 *
 * @layer
 * @provides service
 * @product Rivet
 */
export const layer = Shared.layer;
