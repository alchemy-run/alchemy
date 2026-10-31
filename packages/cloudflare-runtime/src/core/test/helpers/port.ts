import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Port from "../../internal/Port.ts";

/**
 * Holds `port` until the scope closes. The holder only occupies the port: it
 * drops every connection it accepts. Other local tools probe fresh listeners
 * with keep-alive requests (T3 Code and VS Code port detection do), and a held
 * connection would keep `server.close` from ever completing.
 */
export const occupy = (port: number, host?: string) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer((socket) => socket.destroy());
      server.once("error", (err) => resume(Effect.die(err)));
      server.listen({ port, host, exclusive: true }, () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Effect.map((server) => server.address() as NodeNet.AddressInfo));

export const find = (port: number) =>
  Port.make({ cache: false }).pipe(Effect.flatMap((ports) => ports.find(port)));

export const check = (port: number) =>
  Port.make({ cache: false }).pipe(Effect.flatMap((ports) => ports.check(port)));
