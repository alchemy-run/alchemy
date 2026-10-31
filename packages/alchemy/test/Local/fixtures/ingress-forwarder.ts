import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as Effect from "effect/Effect";
import {
  IngressError,
  type IngressAdapter,
  type IngressFactory,
  type IngressOptions,
  type IngressTarget,
} from "@/Local/Ingress.ts";

/** The `IngressConfig.type` the forwarder's factory is registered under. */
export const FORWARDER_TYPE = "forwarder";

/** Lowercase, host-safe label: `dev_alice` becomes `dev-alice`. */
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-");

interface Route {
  readonly host: string;
  readonly listener: URL;
  /** The latest attach owns the route; an earlier scope closing leaves it alone. */
  readonly owner: symbol;
}

export interface Forwarder {
  /** Register under `IngressConfig.type` `"forwarder"` (see {@link FORWARDER_TYPE}). */
  readonly factory: IngressFactory;
  /** The forwarder's own port: every origin it names answers here. */
  readonly port: number;
  /** The live routes, by fqn. */
  readonly routes: () => ReadonlyMap<string, { readonly host: string; readonly listener: string }>;
  /** The options each `make` call received. */
  readonly made: () => ReadonlyArray<IngressOptions | undefined>;
}

/**
 * A router for tests: one HTTP server on a free loopback port that forwards a
 * request to the listener attached for its `Host`. Origins are
 * `http://<stage>.<label>.<domain>.localhost:<port>`, with `domain` from the
 * adapter's options (default: the stack name). It refuses non-`http:` listeners.
 *
 * Clients reach it with {@link get}, which dials the loopback address with the
 * origin's `Host`, so no test depends on resolving `*.localhost`.
 */
export const makeForwarder = Effect.gen(function* () {
  const routes = new Map<string, Route>();
  const made: Array<IngressOptions | undefined> = [];

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
  const { port } = server.address() as AddressInfo;

  const hostOf = (domain: string, target: IngressTarget) =>
    `${slug(target.stage)}.${slug(target.label)}.${slug(domain)}.localhost`;

  const factory: IngressFactory = {
    make: (options) =>
      Effect.sync((): IngressAdapter => {
        made.push(options);
        const domain = typeof options?.domain === "string" ? options.domain : undefined;
        const origin = (target: IngressTarget) =>
          `http://${hostOf(domain ?? target.stack, target)}:${port}`;
        return {
          origin: (target) => Effect.succeed(origin(target)),
          attach: (target, listener) =>
            listener.protocol !== "http:"
              ? Effect.fail(
                  new IngressError({
                    type: FORWARDER_TYPE,
                    message: `The forwarder only routes http listeners, not ${listener.protocol}`,
                  }),
                )
              : Effect.acquireRelease(
                  Effect.sync(() => {
                    const owner = Symbol(target.fqn);
                    routes.set(target.fqn, {
                      host: hostOf(domain ?? target.stack, target),
                      listener,
                      owner,
                    });
                    return { owner, origin: origin(target) };
                  }),
                  ({ owner }) =>
                    Effect.sync(() => {
                      if (routes.get(target.fqn)?.owner === owner) routes.delete(target.fqn);
                    }),
                ).pipe(Effect.map(({ origin }) => origin)),
        };
      }),
  };

  return {
    factory,
    port,
    routes: () =>
      new Map(
        [...routes].map(([fqn, route]) => [
          fqn,
          { host: route.host, listener: route.listener.href },
        ]),
      ),
    made: () => made,
  } satisfies Forwarder;
});

/** What a client sees from {@link get}. */
export interface Answer {
  readonly status: number;
  readonly body: string;
}

/**
 * GET `path` from an origin the forwarder named: dial the forwarder on
 * loopback and send the origin's host as `Host`.
 */
export const get = (origin: string, path = "/") =>
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
