import type { ExecutionContext } from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ServiceMap from "effect/ServiceMap";

export class CloudflareContext extends ServiceMap.Service<
  CloudflareContext,
  {
    env: unknown;
    ctx: ExecutionContext;
  }
>()("Cloudflare.Context") {}

export const getCloudflareEnvKey = Effect.fnUntraced(function* <T>(
  key: string,
) {
  return yield* Effect.serviceOption(CloudflareContext).pipe(
    Effect.map((context) => context.pipe(Option.getOrUndefined)),
    Effect.mapError(
      () =>
        new CloudflareContextNotFound({
          message: "Cloudflare context not found",
        }),
    ),
    Effect.flatMap((context) => {
      const env = context?.env as Record<string, unknown>;
      if (!(key in env)) {
        return Effect.fail(
          new CloudflareContextKeyNotFound({
            message: `${key} is not set in cloudflare context (found ${Object.keys(env).join(", ")})`,
            key,
          }),
        );
      }
      return Effect.succeed(env[key] as T);
    }),
    Effect.orDie,
  );
});

export class CloudflareContextNotFound extends Data.TaggedError(
  "Cloudflare.Context.NotFound",
)<{
  message: string;
}> {}

export class CloudflareContextKeyNotFound extends Data.TaggedError(
  "Cloudflare.Context.KeyNotFound",
)<{
  message: string;
  key: string;
}> {}
