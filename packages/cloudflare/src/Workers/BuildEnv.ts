import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isSelfUrl } from "./Worker.ts";
import { isContainerDecl } from "./WorkerAsyncBindings.ts";
import { isWorkerLoader } from "./WorkerLoader.ts";

/**
 * Resolve `props.env` to the literal values a build inlines (vite's
 * `import.meta.env`, a framework's `process.env`): strings pass through,
 * numbers and booleans are stringified, `Redacted<string>`s are unwrapped,
 * `Worker.URL` becomes this Worker's own URL, env-bound Effects are
 * evaluated, and bindings that happen to be Effects are skipped.
 */
export const resolveBuildEnv = (
  env: Record<string, unknown> | undefined,
  selfUrl: string | undefined,
): Effect.Effect<Record<string, string>> =>
  Effect.forEach(
    Object.entries(env ?? {}),
    Effect.fn(function* ([key, value]): Effect.fn.Return<[string, string | undefined]> {
      if (typeof value === "string") return [key, value];
      if (typeof value === "number" || typeof value === "boolean") return [key, String(value)];
      if (Redacted.isRedacted(value)) {
        const inner = Redacted.value(value);
        return [key, typeof inner === "string" ? inner : undefined];
      }
      // `Worker.URL` (bare tag or called). The bare tag is Effect-shaped,
      // so check before `Effect.isEffect`.
      if (isSelfUrl(value)) return [key, selfUrl];
      // A `WorkerLoader` and a `Cloudflare.Container` declaration are
      // Effect-shaped bindings, not env values: yielding a Container would
      // resolve the started-instance tag, which only exists inside a Durable
      // Object (#997).
      if (isWorkerLoader(value) || isContainerDecl(value)) return [key, undefined];
      if (Effect.isEffect(value)) {
        const resolved: unknown = yield* value as any as Effect.Effect<any>;
        return [
          key,
          typeof resolved === "string" ||
          typeof resolved === "number" ||
          typeof resolved === "boolean"
            ? String(resolved)
            : undefined,
        ];
      }
      return [key, undefined];
    }),
  ).pipe(
    Effect.map((entries) =>
      Object.fromEntries(
        entries.filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    ),
  );
