import { serveWebRequest } from "@/Cloudflare/Workers/HttpServer";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  Rpc,
  RpcGroup,
  RpcSerialization,
  RpcServer,
} from "effect/unstable/rpc";

class PingResult extends Schema.Class<PingResult>("PingResult")({
  ok: Schema.Boolean,
  message: Schema.String,
}) {}

const ping = Rpc.make("ping", {
  payload: {
    name: Schema.String,
  },
  success: PingResult,
});

const Rpcs = RpcGroup.make(ping);

const RpcHandlers = Rpcs.toLayer({
  ping: ({ name }) =>
    Effect.succeed(
      new PingResult({
        ok: true,
        message: `hello ${name}`,
      }),
    ),
});

describe("Cloudflare.Workers.HttpServer", () => {
  it.effect("serves Effect RPC HTTP apps through the Worker adapter", () =>
    Effect.gen(function* () {
      const rpcApp = yield* RpcServer.toHttpEffect(Rpcs).pipe(
        Effect.provide(
          Layer.mergeAll(RpcHandlers, RpcSerialization.layerJsonRpc()),
        ),
      );

      const response = yield* serveWebRequest(
        new Request("https://worker.example/rpc", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "ping",
            params: {
              name: "workerd",
            },
            headers: [],
          }),
        }) as any,
        rpcApp,
      ).pipe(Effect.timeout("2 seconds"));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(JSON.parse(yield* Effect.promise(() => response.text()))).toEqual({
        jsonrpc: "2.0",
        id: 0,
        result: {
          ok: true,
          message: "hello workerd",
        },
      });
    }),
  );
});
