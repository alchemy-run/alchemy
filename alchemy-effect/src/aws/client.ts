import { LogLevel } from "effect";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import type { AWSClientConfig } from "itty-aws";
import { Credentials } from "./credentials.ts";
import { Region } from "./region.ts";

export type TagInstance<T> = T extends new (_: never) => infer R ? R : never;

export const createAWSServiceClientLayer =
  <Tag extends Context.Tag<any, any>, Client>(
    tag: Tag,
    clss: new (config: AWSClientConfig) => Client,
  ) =>
  () =>
    Layer.effect(
      tag,
      Effect.gen(function* () {
        const region = yield* Region;
        const credentials = yield* Credentials;
        //
        const client = new clss({
          region,
          credentials: {
            accessKeyId: Redacted.value(credentials.accessKeyId),
            secretAccessKey: Redacted.value(credentials.secretAccessKey),
            sessionToken: credentials.sessionToken
              ? Redacted.value(credentials.sessionToken)
              : undefined,
          },
        });
        return new Proxy(client as any, {
          get:
            (target: any, prop) =>
            (...args: any[]) =>
              target[prop](...args).pipe(
                // TODO(sam): make it easier to set log lever for a client
                Logger.withMinimumLogLevel(
                  process.env.DEBUG ? LogLevel.Debug : LogLevel.Info,
                ),
              ),
        });
      }),
    ) as Layer.Layer<TagInstance<Tag>, never, Region | Credentials>;
