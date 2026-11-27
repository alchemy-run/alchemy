/**
 * A dev ingress router for tests.
 *
 * The default export is an `alchemy/Local/Ingress` {@link Router} Layer that
 * really routes: one HTTP server on a free loopback port that forwards each
 * request to the listener attached for its `Host`. Point a resource's
 * `dev.ingress` at this module and its routed URL is exercised end to end,
 * inside the dev sidecar or in-process, without installing a router.
 *
 * ```ts
 * const worker = yield* Cloudflare.Worker("Api", {
 *   main,
 *   dev: { ingress: { module: "@alchemy.run/test/IngressForwarder" } },
 * });
 * const answer = yield* getRouted(worker.url); // worker.url is on the forwarder
 * ```
 *
 * Origins are `http://<stage>.<name>.<stack>.localhost:<port>`, with `name`
 * from the `Ingress` (default: the resource's logical id). Reach one with
 * {@link getRouted}, which dials loopback with the origin's `Host`, so no
 * test depends on resolving `*.localhost`.
 */
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import { IngressError, Router } from "alchemy/Local/Ingress";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Lowercase, host-safe label: `dev_alice` becomes `dev-alice`. */
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-");

interface Route {
  readonly host: string;
  readonly listener: URL;
  /** The latest attach for a target owns its route; an earlier scope closing leaves it alone. */
  readonly owner: symbol;
}

/**
 * A forwarder as a {@link Router} Layer. Each build starts its own server,
 * which stops when the Layer's scope closes. A fixture module default-exports
 * one to count or wrap builds; this module's default export is one.
 */
export const make = (): Layer.Layer<Router> =>
  Layer.effect(
    Router,
    Effect.gen(function* () {
      const routes = new Map<string, Route>();

      const server = NodeHttp.createServer((request, response) => {
        const host = (request.headers.host ?? "").replace(/:\d+$/, "");
        const route = [...routes.values()].find((candidate) => candidate.host === host);
        if (route === undefined) {
          response.writeHead(502, { "content-type": "text/plain" }).end(`no route for ${host}`);
          return;
        }
        const upstream = NodeHttp.request(
          {
            hostname: route.listener.hostname.replace(/^\[|\]$/g, ""),
            port: route.listener.port,
            method: request.method,
            path: request.url,
            headers: request.headers,
          },
          (answer) => {
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(response);
          },
        );
        upstream.on("error", (error) => {
          response.writeHead(502, { "content-type": "text/plain" }).end(String(error));
        });
        request.pipe(upstream);
      });

      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          server.listen(0, "127.0.0.1", () => resume(Effect.void));
        }),
        () =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
            server.closeAllConnections();
          }),
      );
      // Never what keeps a process alive: a router built for the dev sidecar
      // lives until the process exits.
      server.unref();
      const { port } = server.address() as AddressInfo;

      return {
        attach: (ingress, target, listener) => {
          if (listener.protocol !== "http:") {
            return Effect.fail(
              new IngressError({
                message: `The forwarder only routes http listeners, not ${listener.protocol}`,
              }),
            );
          }
          const host = `${slug(target.stage)}.${slug(ingress.name ?? target.id)}.${slug(target.stack)}.localhost`;
          // One forwarder serves every stack in the process (test files share
          // one), so a route is the resource's whole identity, not its fqn.
          const key = JSON.stringify([target.stack, target.stage, target.fqn]);
          return Effect.acquireRelease(
            Effect.sync(() => {
              const owner = Symbol(key);
              routes.set(key, { host, listener, owner });
              return owner;
            }),
            (owner) =>
              Effect.sync(() => {
                if (routes.get(key)?.owner === owner) routes.delete(key);
              }),
          ).pipe(Effect.as(`http://${host}:${port}`));
        },
      };
    }),
  );

export default make();

/** What a client sees from {@link getRouted}. */
export interface Answer {
  readonly status: number;
  readonly body: string;
}

/**
 * GET `path` from an origin the forwarder named: dial the forwarder on
 * loopback and send the origin's host as `Host`.
 */
export const getRouted = (origin: string, path = "/") =>
  Effect.callback<Answer, Error>((resume) => {
    const url = new URL(origin);
    const request = NodeHttp.request(
      { hostname: "127.0.0.1", port: url.port, path, headers: { host: url.host } },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resume(
            Effect.succeed({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          ),
        );
      },
    );
    request.on("error", (error) => resume(Effect.fail(error)));
    request.end();
  });

/**
 * An upstream HTTP server on a free loopback port that answers every request
 * with `<name> <path> <host>`, so a test sees which listener answered and
 * what `Host` reached it. Returns its listener URL.
 */
export const makeListener = (name: string) =>
  Effect.gen(function* () {
    const server = NodeHttp.createServer((request, response) => {
      response
        .writeHead(200, { "content-type": "text/plain" })
        .end(`${name} ${request.url} ${request.headers.host}`);
    });
    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        server.listen(0, "127.0.0.1", () => resume(Effect.void));
      }),
      () =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
          server.closeAllConnections();
        }),
    );
    return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });
