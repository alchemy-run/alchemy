import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import { PORTLESS_HEADER } from "portless";

const connects = (host: string, port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });
    socket.once("error", () => resume(Effect.succeed(false)));
    return Effect.sync(() => socket.destroy());
  });

/** Whether something listens on the port, on either loopback address. */
export const isListening = (port: number) =>
  Effect.all([connects("127.0.0.1", port), connects("::1", port)], {
    concurrency: "unbounded",
  }).pipe(Effect.map(([ipv4, ipv6]) => ipv4 || ipv6));

/**
 * Whether a Portless proxy answers on the port: the way Portless tells its
 * proxy from other services is its response header. A TLS proxy answers plain
 * HTTP on its port too, so one probe covers both.
 */
export const isPortlessProxy = (port: number) =>
  Effect.callback<boolean>((resume) => {
    // A socket left open would hold the proxy up when it is told to stop.
    const request = NodeHttp.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "HEAD",
        timeout: 500,
        agent: false,
        headers: { connection: "close" },
      },
      (response) => {
        response.resume();
        resume(Effect.succeed(response.headers[PORTLESS_HEADER.toLowerCase()] === "1"));
      },
    );
    request.once("error", () => resume(Effect.succeed(false)));
    request.once("timeout", () => {
      request.destroy();
      resume(Effect.succeed(false));
    });
    request.end();
    return Effect.sync(() => request.destroy());
  });
