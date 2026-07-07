import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpServer, type HttpEffect } from "../../Http.ts";
import * as Output from "../../Output.ts";
import { serveRpc } from "../../Rpc.ts";
import * as Server from "../../Server/index.ts";

export const MicrovmImageTypeId = "AWS.Lambda.MicrovmImage" as const;

/**
 * Runtime context for the in-VM process: an HTTP server (the MicroVM endpoint)
 * that exposes the impl's `fetch` handler plus any RPC shape methods. Mirrors
 * the Cloudflare `ContainerPlatform` process context.
 */
export const makeMicrovmRuntimeContext = (
  id: string,
): Server.ProcessContext => {
  const runners: Effect.Effect<void, never, any>[] = [];
  const env: Record<string, any> = {};

  const serve = <Req = never>(
    handler: HttpEffect<Req>,
    options?: { shape?: Record<string, unknown> },
  ) =>
    Effect.sync(() => {
      const finalHandler = options?.shape
        ? serveRpc(options.shape, handler)
        : handler;
      runners.push(
        Effect.gen(function* () {
          const httpServer = yield* Effect.serviceOption(HttpServer).pipe(
            Effect.map(Option.getOrUndefined),
          );
          if (httpServer) {
            yield* httpServer.serve(finalHandler);
            yield* Effect.never;
          }
        }).pipe(Effect.orDie),
      );
    });

  return {
    Type: MicrovmImageTypeId,
    LogicalId: id,
    id,
    env,
    set: (bindingId: string, output: Output.Output) =>
      Effect.sync(() => {
        const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
        env[key] = output.pipe(
          Output.map((value) =>
            Redacted.isRedacted(value)
              ? Redacted.make(
                  JSON.stringify({
                    _tag: "Redacted",
                    value: Redacted.value(value),
                  }),
                )
              : JSON.stringify(value),
          ),
        );
        return key;
      }),
    get: <T>(key: string) =>
      Config.string(key).pipe(
        Effect.flatMap((value) =>
          Effect.try({
            try: () => {
              const parsed = JSON.parse(value) as T;
              if (
                typeof parsed === "object" &&
                parsed !== null &&
                (parsed as { _tag?: unknown })._tag === "Redacted" &&
                "value" in parsed
              ) {
                return Redacted.make((parsed as { value: unknown }).value) as T;
              }
              return parsed;
            },
            catch: (error) => error as Error,
          }),
        ),
        Effect.catch((cause) =>
          Effect.die(
            new Error(`Failed to get environment variable: ${key}`, { cause }),
          ),
        ),
      ),
    run: ((effect: Effect.Effect<void, never, any>) =>
      Effect.sync(() => {
        runners.push(effect);
      })) as unknown as Server.ProcessContext["run"],
    serve,
    exports: Effect.sync(() => ({
      default: Effect.all(
        runners.map((eff) =>
          Effect.forever(
            eff.pipe(
              Effect.tapError((err) => Effect.logError(err)),
              Effect.ignore,
            ),
          ),
        ),
        { concurrency: "unbounded" },
      ),
    })),
  } as Server.ProcessContext;
};
