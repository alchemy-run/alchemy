import { createServer } from "node:http";
import { gatewayLayer } from "@alchemy.run/effect-cluster/internal/Gateway";
import { describe, expect, it } from "@alchemy.run/test";
import { NodeHttpServer } from "@effect/platform-node";
import { Sharding } from "effect/cluster";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type * as LogLevel from "effect/LogLevel";
import * as References from "effect/References";

// The gateway serves every call a runner gets, so it must not log each one at Info.
describe("Effect Cluster gateway", () => {
  it.live("logs a call as one Debug line", () => {
    const logs: Array<{ level: LogLevel.LogLevel; message: string }> = [];
    const capture = Logger.make(({ logLevel, message }) => {
      const parts = Array.isArray(message) ? message : [message];
      logs.push({ level: logLevel, message: parts.map(String).join(" ") });
    });
    return Effect.gen(function* () {
      // No entity is hosted: the call is refused before it reaches Sharding.
      const gateway = gatewayLayer([], "token").pipe(
        Layer.provide(Layer.succeed(Sharding.Sharding, {} as Sharding.Sharding["Service"])),
        Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 })),
      );
      const context = yield* Layer.build(gateway);
      const server = Context.get(context, HttpServer.HttpServer);
      const { port } = server.address as { readonly port: number };
      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/rpc`, { method: "POST", body: "[]" }),
      );
      expect(response.status).toBe(401);
      // The server logs after it sends the response.
      yield* Effect.sleep("50 millis");
      expect(logs.filter((log) => log.level !== "Debug")).toEqual([]);
      expect(logs).toEqual([{ level: "Debug", message: "POST /rpc 401" }]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Logger.layer([capture])),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  });
});
