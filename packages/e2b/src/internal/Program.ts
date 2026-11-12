/**
 * How a template runs its `main` program.
 *
 * `@alchemy.run/docker/BuildPlan` bundles `main` and adds the layer that
 * runs it with Bun from `/app`; E2B starts that command when it builds the
 * template and captures it running in the template's snapshot, so every
 * sandbox boots with it already serving on `PORT`. An Effect program (the
 * class form) is wrapped in the generated bootstrap entry; an async program
 * (`main` with no Effect impl) is bundled and run as-is.
 */
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** The port a template's program serves on unless `port` says otherwise. */
export const DEFAULT_PORT = 3000;

/**
 * The generated entry: raises the runtime flag BEFORE the user's module is
 * evaluated (hence the dynamic import), then boots the program. It imports
 * only `@alchemy.run/e2b/Bootstrap` and `main` — see `alchemy/Runtime/Bootstrap`.
 */
export const makeBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "@alchemy.run/e2b/Bootstrap";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

/**
 * A value as the env var the program reads, verbatim. Bound values arrive
 * already packed by the host (`packEnvValue`, so a `Redacted` keeps its
 * marker); packing again would double-encode them, and a user's `env` is read
 * raw (`Config`, `process.env`).
 */
const envValue = (value: unknown): string | undefined =>
  value === undefined || value === null
    ? undefined
    : Redacted.isRedacted(value)
      ? String(Redacted.value(value))
      : typeof value === "string"
        ? value
        : JSON.stringify(value);

/** The program's environment: Alchemy's runtime vars, bound env, then the user's `env`. */
export const programEnv = Effect.fn(function* (
  port: number,
  bound: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, unknown>> | undefined,
) {
  const stack = yield* Stack;
  const values = Object.fromEntries(
    Object.entries({ ...bound, ...env }).flatMap(([key, value]) => {
      const text = envValue(value);
      return text === undefined ? [] : [[key, text]];
    }),
  ) as Record<string, string>;
  return {
    ALCHEMY_STACK_NAME: stack.name,
    ALCHEMY_STAGE: stack.stage,
    ALCHEMY_PHASE: "runtime",
    HOST: "0.0.0.0",
    PORT: String(port),
    ...values,
  };
});

/** The template's snapshot is taken once the program answers HTTP. */
export const programReadyCmd = (port: number) =>
  `bun -e "fetch('http://127.0.0.1:${port}/').then(()=>process.exit(0),()=>process.exit(1))"`;
