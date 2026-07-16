/**
 * Compile-only regression test: the Worker class form (and the named
 * three-arg form) accept an `Effect` of props, not just a plain props
 * object. Stage/Stack-dependent props (e.g. deriving a stage-specific
 * domain) are the motivating case — see the props-only overload, which
 * always supported this.
 */
import * as Cloudflare from "@/Cloudflare";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const domain = (domain: string) =>
  Stage.pipe(
    Effect.map((stage) =>
      stage === "prod"
        ? domain
        : stage.startsWith("staging-")
          ? `${stage}.${domain}`
          : undefined,
    ),
  );

const impl = Effect.gen(function* () {
  return {
    fetch: Effect.succeed(HttpServerResponse.text("ok")),
  };
});

// Class form with an Effect of props that yields Stage.
export default class StageDomainWorker extends Cloudflare.Worker<StageDomainWorker>()(
  "StageDomainWorker",
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      domain: yield* domain("facilitator.example.com"),
      dev: {
        host: "127.0.0.1",
        port: 1337,
        strictPort: true,
      },
    };
  }),
  impl,
) {}

// Same via Stack (also part of PlatformServices).
export class StackDomainWorker extends Cloudflare.Worker<StackDomainWorker>()(
  "StackDomainWorker",
  Effect.gen(function* () {
    const stack = yield* Stack;
    return {
      main: import.meta.url,
      domain: stack.stage === "prod" ? "api.example.com" : undefined,
    };
  }),
  impl,
) {}

// Named three-arg form (no class).
export const NamedWorker = Cloudflare.Worker(
  "NamedWorker",
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      domain: yield* domain("named.example.com"),
    };
  }),
  impl,
);

type RequirementsOf<T> =
  T extends Effect.Effect<unknown, unknown, infer Req> ? Req : never;
type Assert<T extends true> = T;

// Stage/Stack are provided by the Stack at plan/deploy and by the runtime
// bridges inside the deployed Worker, so they must not leak out of the
// declaration's requirements.
type _ClassFormDischargesStage = Assert<
  Stage extends RequirementsOf<typeof StageDomainWorker> ? false : true
>;
type _ClassFormDischargesStack = Assert<
  Stack extends RequirementsOf<typeof StackDomainWorker> ? false : true
>;
type _NamedFormDischargesStage = Assert<
  Stage extends RequirementsOf<typeof NamedWorker> ? false : true
>;
