import * as DO from "@distilled.cloud/digitalocean";
import { fromApiKey } from "@distilled.cloud/digitalocean/Credentials";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { CreateSandboxOptions, SandboxesClient, SandboxHandle } from "./CreateSandbox.ts";
import {
  autoPauseOf,
  defaultRegion,
  deleteMicrovm,
  urlOf,
  waitUntilRunning,
  type Microvm,
  sizeOf,
  type SandboxSize,
} from "./internal.ts";
import type { Template } from "./Template.ts";

/** A MicroVM API call failed. */
export class SandboxError extends Data.TaggedError("DigitalOcean.Sandboxes.SandboxError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SandboxBindingNotConfigured extends Data.TaggedError(
  "DigitalOcean.Sandboxes.BindingNotConfigured",
)<{}> {
  override get message() {
    return "CreateSandbox is not bound to this runtime: its token is missing from the environment.";
  }
}

const TOKEN_ENV = "DO_SANDBOX_TOKEN";
const BASE_ENV = "DO_SANDBOX_BASE";

const sourceOf = (base: string) =>
  base.startsWith("checkpoint:") ? { checkpoint_id: base.slice(11) } : { oci_ref: base };

const asSandboxError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError(
      (cause) => new SandboxError({ message: "A DigitalOcean MicroVM call failed.", cause }),
    ),
  );

const handleOf = (
  microvm: Microvm,
  withToken: <A, E>(e: Effect.Effect<A, E, any>) => Effect.Effect<A, SandboxError>,
): SandboxHandle => ({
  sandboxId: microvm.id,
  url: urlOf(microvm),
  exec: (command, options) =>
    withToken(
      DO.runMicrovmCommand({
        microvm_id: microvm.id,
        argv: typeof command === "string" ? ["/bin/sh", "-lc", command] : [...command],
        cwd: options?.cwd,
      }).pipe(Effect.map((r) => ({ exitCode: r.exit_code, stdout: r.stdout, stderr: r.stderr }))),
    ),
  pause: withToken(DO.postMicrovmPause({ microvm_id: microvm.id }).pipe(Effect.asVoid)),
  resume: withToken(DO.microvmsPostResume({ microvm_id: microvm.id }).pipe(Effect.asVoid)),
  delete: withToken(deleteMicrovm(microvm.id)),
});

/** Builds `CreateSandbox(base, { token })` for any host. */
export const makeSandboxesBinding = Effect.succeed(
  Effect.fn(function* (
    base: Template | string,
    options: { readonly token: Redacted.Redacted<string> },
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const runtime = yield* CurrentRuntimeContext;
      if (runtime !== undefined) {
        yield* runtime.set(TOKEN_ENV, Output.literal(options.token));
        yield* runtime.set(
          BASE_ENV,
          typeof base === "string"
            ? Output.literal(base)
            : base.checkpointId.pipe(Output.map((id) => `checkpoint:${id}`)),
        );
      }
    }

    // Read in the construction phase, where the host's runtime context is
    // present; request handlers close over the values.
    const runtime = globalThis.__ALCHEMY_RUNTIME__ ? yield* CurrentRuntimeContext : undefined;
    const boundToken =
      runtime === undefined
        ? undefined
        : yield* runtime.get<string | Redacted.Redacted<string>>(TOKEN_ENV);
    const boundBaseValue = runtime === undefined ? undefined : yield* runtime.get<string>(BASE_ENV);

    const resolve = Effect.gen(function* () {
      const token = boundToken;
      const boundBase = boundBaseValue;
      if (token === undefined || boundBase === undefined)
        return yield* new SandboxBindingNotConfigured();
      const credentials = fromApiKey({
        apiKey: typeof token === "string" ? Redacted.make(token) : token,
      });
      const withToken = <A, E>(effect: Effect.Effect<A, E, any>) =>
        asSandboxError(
          effect.pipe(Effect.provide(Layer.mergeAll(credentials, FetchHttpClient.layer))),
        ) as Effect.Effect<A, SandboxError>;
      return { base: boundBase, withToken };
    });

    return {
      create: (createOptions?: CreateSandboxOptions) =>
        Effect.gen(function* () {
          const { base: boundBase, withToken } = yield* resolve;
          const region = yield* withToken(defaultRegion(undefined));
          const microvm = yield* withToken(
            DO.createMicrovm({
              name: createOptions?.name ?? `sandbox-${Math.random().toString(36).slice(2, 10)}`,
              source: sourceOf(boundBase),
              region,
              size: sizeOf(createOptions?.size),
              environment: createOptions?.env,
              http_port: createOptions?.httpPort,
              auto_pause: autoPauseOf(createOptions?.autoPauseSeconds),
              auto_resume: createOptions?.autoPauseSeconds !== undefined ? true : undefined,
            }).pipe(
              Effect.map((r) => r.microvm),
              Effect.flatMap((created) => waitUntilRunning(created.id)),
            ),
          );
          return handleOf(microvm, withToken);
        }),
      get: (sandboxId: string) =>
        Effect.gen(function* () {
          const { withToken } = yield* resolve;
          const microvm = yield* withToken(
            DO.getMicrovm({ microvm_id: sandboxId }).pipe(Effect.map((r) => r.microvm)),
          );
          return handleOf(microvm, withToken);
        }),
    } satisfies SandboxesClient;
  }),
);
