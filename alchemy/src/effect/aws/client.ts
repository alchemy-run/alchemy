import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { AWSClientConfig } from "itty-aws";
import * as Credentials from "./credentials.ts";
import * as Region from "./region.ts";

export const createAWSServiceClientLayer = <
  Tag extends Context.Tag<any, any>,
  Client extends new (
    config: AWSClientConfig,
  ) => any,
>(
  tag: Tag,
  clss: Client,
) =>
  Layer.effect(
    tag,
    Effect.gen(function* () {
      const region = yield* Region.Region;
      const credentials = yield* Credentials.Credentials;
      return new clss({
        region,
        credentials: {
          accessKeyId: Redacted.value(credentials.accessKeyId),
          secretAccessKey: Redacted.value(credentials.secretAccessKey),
          sessionToken: credentials.sessionToken
            ? Redacted.value(credentials.sessionToken)
            : undefined,
        },
      });
    }),
  );
