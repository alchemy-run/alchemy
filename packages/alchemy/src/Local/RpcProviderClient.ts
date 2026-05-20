import { newWebSocketRpcSession } from "capnweb";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { HttpClientError } from "effect/unstable/http/HttpClientError";
import { AlchemyContext } from "../AlchemyContext.ts";
import type { ProviderService } from "../Provider.ts";
import { Stack } from "../Stack.ts";
import { deserializeRpcHandlers } from "./RpcSerialization.ts";
import type { RpcApi, RpcProvider } from "./RpcServer.ts";

export class RpcProviderClient extends Context.Service<
  RpcProviderClient,
  {
    readonly url: string;
    readonly get: (
      mainUrl: string,
      providerName: string,
    ) => Effect.Effect<
      ProviderService,
      HttpClientError | HttpBody.HttpBodyError,
      AlchemyContext | Stack
    >;
  }
>()("RpcProviderClient") {}

export const SPAWNER_URL_ENV_KEY = "ALCHEMY_RPC_SPAWNER_URL" as const;

const make = Effect.fnUntraced(function* (url: string) {
  const client = yield* HttpClient.HttpClient;

  return RpcProviderClient.of({
    url,
    get: Effect.fnUntraced(function* (mainUrl, providerName) {
      const alchemyContext = yield* AlchemyContext;
      const stack = yield* Stack;
      const response = yield* client.post(url, {
        body: yield* HttpBody.json({
          mainUrl,
          context: { alchemyContext, stack },
        }),
      });
      const websocketUrl = yield* response.text;
      const session = newWebSocketRpcSession<RpcApi>(websocketUrl);
      const provider = yield* Effect.promise(
        () => session.getProvider(providerName) as Promise<RpcProvider>,
      );
      return deserializeRpcHandlers(provider, ["tail"]);
    }),
  });
});

export const layer = (url: string) =>
  Layer.effect(RpcProviderClient, make(url));

export const fromEnv = () =>
  Layer.effect(
    RpcProviderClient,
    Effect.suspend(() => {
      const url = process.env[SPAWNER_URL_ENV_KEY];
      if (!url) {
        return Effect.die(
          new Error(`${SPAWNER_URL_ENV_KEY} environment variable is not set`),
        );
      }
      return make(url);
    }),
  );
