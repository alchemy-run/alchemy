/**
 * Shared scaffolding for the `Vercel.Website.*` props-transformers.
 * NOT exported from `Website/index.ts` (or `Vercel/index.ts`).
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Command from "../../Command/index.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import {
  isYieldableEffectLike,
  type YieldableEffectLike,
} from "../../Util/effect.ts";
import { asEffect } from "../../Util/types.ts";
import { Function } from "../Functions/Function.ts";

/**
 * Serialize a Website's `env` for the build subprocess. The same record
 * doubles as the Function's project-env input, so entries may be plain
 * strings, `Redacted` secrets, `effect/Config` values, `Output`
 * references, or binding sentinels:
 *
 * - strings and `Redacted` values pass through unchanged
 * - `Output` references resolve at reconcile; the resolved value is
 *   serialized the same way inline values are
 * - binding sentinels (`~alchemy/Kind`-marked, e.g. `Function.URL`) have
 *   no build-time env representation and are dropped (the Function
 *   provider substitutes them during project-env sync)
 * - `Config` (and any other runnable Effect) is resolved here, at stack
 *   construction
 * - remaining plain values (`null`, numbers, JSON objects) are stringified
 */
export const serializeBuildEnv = Effect.fn(function* (
  env: Record<string, unknown> | undefined,
) {
  const entries: [string, unknown][] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v === undefined) continue;
    if (typeof v === "string" || Redacted.isRedacted(v)) {
      entries.push([k, v]);
    } else if (Output.isOutput(v)) {
      entries.push([k, Output.map(v, serializeBuildEnvValue)]);
    } else if (v !== null && typeof v === "object" && "~alchemy/Kind" in v) {
      // Binding sentinel (`Function.URL` is Effect-shaped AND kind-marked,
      // so this check must precede the runnable-Effect branch) — deploy-time
      // only, nothing to expose to the build subprocess.
      continue;
    } else if (isYieldableEffectLike(v)) {
      const resolved = serializeBuildEnvValue(
        yield* asEffect(v as YieldableEffectLike<unknown, unknown, never>).pipe(
          Effect.orDie,
        ),
      );
      if (resolved === undefined) continue;
      entries.push([k, resolved]);
    } else {
      entries.push([k, JSON.stringify(v)]);
    }
  }
  return Object.fromEntries(entries) as Record<
    string,
    string | Redacted.Redacted<string>
  >;
});

const serializeBuildEnvValue = (
  value: unknown,
): string | Redacted.Redacted<string> | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.isRedacted(value)
        ? (value as Redacted.Redacted<string>)
        : JSON.stringify(value);

/**
 * The shared shape of a framework Website transformer: run the framework's
 * own build (whose Vercel preset/adapter emits `.vercel/output` natively)
 * via a `Command.Build` namespaced under the site's id, then deploy the
 * tree through `Vercel.Function`'s `source` channel.
 *
 * The `Command.Build` is memoized by content hash of the project inputs
 * (`.gitignore`-aware plus the nearest lockfile by default), and the
 * Function's own skip-on-hash makes an unchanged tree a no-op deploy.
 */
export const makeVercelOutputSite = (input: {
  id: string;
  props: any;
  /** Build command used when `props.command` is absent. */
  defaultCommand: string;
  /** Env forced onto the build subprocess (e.g. `NITRO_PRESET=vercel`). */
  buildEnv?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const props = input.props;
    // `Build` carries a constant logical id, so it is namespaced under the
    // site's id to keep two sites on one stack from colliding. The
    // Function itself resolves in the CALLER's namespace.
    const build = yield* Command.Build("Build", {
      command: props.command ?? input.defaultCommand,
      cwd: props.rootDir,
      outdir: ".vercel/output",
      memo: props.memo,
      env: {
        ...(yield* serializeBuildEnv(props.env)),
        ...input.buildEnv,
      },
    }).pipe(Namespace.push(input.id));
    const {
      rootDir: _rootDir,
      command: _command,
      memo: _memo,
      ...fnProps
    } = props;
    return yield* Function(input.id, {
      ...fnProps,
      source: {
        kind: "buildOutput",
        dir: build.outdir,
        hash: build.hash.output,
      },
    } as any);
  });

/** Resolve a Website's props argument (plain object or Effect) to props. */
export const resolveWebsiteProps = Effect.fn(function* (propsEff: unknown) {
  const props: any =
    (Effect.isEffect(propsEff)
      ? yield* propsEff as Effect.Effect<any>
      : propsEff) ?? {};
  return props;
});
