import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { HttpClientError } from "effect/unstable/http/HttpClientError";
import { AlchemyContext } from "../AlchemyContext.ts";
import { Stack } from "../Stack.ts";

export class RpcProviderClient extends Context.Service<
  RpcProviderClient,
  {
    readonly url: string;
    readonly register: (
      mainUrl: string,
    ) => Effect.Effect<
      string,
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
    register: Effect.fnUntraced(function* (mainUrl) {
      const alchemyContext = yield* AlchemyContext;
      const stack = yield* Stack;
      const response = yield* client.post(url, {
        body: yield* HttpBody.json({
          mainUrl,
          context: { alchemyContext, stack },
        }),
      });
      return yield* response.text;
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
