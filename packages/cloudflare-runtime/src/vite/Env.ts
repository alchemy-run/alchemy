import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
const hasMarker = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === "object" || typeof value === "function");
const isSelfUrl = (value: unknown) =>
  hasMarker(value) && value["~alchemy/Kind"] === "Cloudflare.Workers.URL";
const isWorkerLoader = (value: unknown) =>
  hasMarker(value) && value["~alchemy/Kind"] === "Cloudflare.DynamicWorker";
const isContainerDecl = (value: unknown) =>
  hasMarker(value) && "~alchemy/Container/ClassName" in value;
/**
 * Resolve `props.env` to the literal values vite's `import.meta.env`
 * defines are computed from: strings pass through, `Redacted<string>`s
 * are unwrapped, env-bound Effects are evaluated, and `WorkerLoader`s
 * (bindings that happen to be Effects) are skipped.
 */
export const resolveViteEnv = (
  env: Record<string, unknown>,
  selfUrl: string | undefined,
) =>
  Effect.gen(function* () {
    return Object.fromEntries(
      (yield* Effect.all(
        Object.entries(env).map(
          Effect.fn(function* ([key, value]) {
            return [
              key,
              typeof value === "string"
                ? value
                : Redacted.isRedacted(value) &&
                    typeof Redacted.value(value) === "string"
                  ? Redacted.value(value)
                  : // `Worker.URL` (bare tag or called) — resolved to this
                    // Worker's own URL. The bare tag is Effect-shaped, so
                    // check before `Effect.isEffect`.
                    isSelfUrl(value)
                    ? selfUrl
                    : // A `WorkerLoader` is a real Effect that also carries
                      // the `~alchemy/Kind` marker — it is a binding, not a
                      // runnable env value. Check it before `Effect.isEffect`
                      // so we don't execute it as an inlined env entry.
                      isWorkerLoader(value)
                      ? undefined
                      : // A `Cloudflare.Container` declaration is likewise
                        // Effect-shaped but is a binding (DO namespace +
                        // ContainerApplication) — yielding it would resolve
                        // the started-instance tag, which only exists inside
                        // a Durable Object (#997).
                        isContainerDecl(value)
                        ? undefined
                        : Effect.isEffect(value)
                          ? yield* value as any as Effect.Effect<any>
                          : undefined,
            ];
          }),
        ),
      )).filter(([_, value]) => value !== undefined),
    );
  });
