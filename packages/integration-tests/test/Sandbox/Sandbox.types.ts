import * as Anthropic from "@alchemy.run/anthropic";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Sandbox from "@alchemy.run/sandbox";
import * as Egress from "alchemy/Egress";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class Box extends Sandbox.Sandbox<Box, { size: "small" | "large" }>()("SandboxTypes") {}

const program = Effect.succeed({});

// Every declared size maps to an instance type.
export const hosted = Cloudflare.Containers.Sandbox(
  Box,
  { main: "./sandbox.ts", sizes: { small: "lite", large: "standard-4" } },
  program,
);

export const missing = Cloudflare.Containers.Sandbox(
  Box,
  // @ts-expect-error Property 'large' is missing
  { main: "./sandbox.ts", sizes: { small: "lite" } },
  program,
);

export const extra = Cloudflare.Containers.Sandbox(
  Box,
  {
    main: "./sandbox.ts",
    // @ts-expect-error 'huge' is not a declared size
    sizes: { small: "lite", large: "standard-4", huge: "standard-4" },
  },
  program,
);

export const unknownInstance = Cloudflare.Containers.Sandbox(
  Box,
  // @ts-expect-error not a Cloudflare Container instance type
  { main: "./sandbox.ts", sizes: { small: "lite", large: "enormous" } },
  program,
);

// The host is what `yield* Box` needs.
type _HostSatisfiesYield = Assert<
  Equal<typeof hosted, Layer.Layer<Sandbox.Sandbox.Host<Box>, never, Cloudflare.Providers>>
>;
type _YieldNeedsHost = Assert<Equal<Effect.Services<typeof Box>, Sandbox.Sandbox.Host<Box>>>;

export const usage = Effect.gen(function* () {
  const sandbox = yield* Box;
  // start() only takes declared sizes.
  yield* sandbox.start({ size: "large" });
  // @ts-expect-error 'medium' is not a declared size
  yield* sandbox.start({ size: "medium" });
  // @ts-expect-error a size is required
  yield* sandbox.start({});
  type _Size = Assert<Equal<Sandbox.SandboxSize<typeof Box>, "small" | "large">>;
});

//#region accepted egress kinds

class WorkGateway extends Egress.Gateway<WorkGateway>()("SandboxTypesWork", {
  model: Anthropic.Egress,
  repo: GitHub.Egress,
}) {}

class UserGateway extends Egress.Gateway<UserGateway>()("SandboxTypesUser", {
  repo: GitHub.Egress,
  custom: Egress.Http,
}) {}

class Accepting extends Sandbox.Sandbox<
  Accepting,
  { size: "small"; egress: GitHub.Egress | Anthropic.Egress }
>()("SandboxTypesAccepting", { egress: [GitHub.Egress, Anthropic.Egress] }) {}

// The kinds a declaration accepts.
type _Kinds = Assert<
  Equal<Sandbox.SandboxKinds<typeof Accepting>, GitHub.Egress | Anthropic.Egress>
>;

// Declaring kinds needs their values (the host installs their tools)…
// @ts-expect-error the accepted kinds are missing
class _MissingKinds extends Sandbox.Sandbox<
  _MissingKinds,
  { size: "small"; egress: GitHub.Egress }
>()("SandboxTypesMissingKinds") {}
// …of the declared kinds only.
class _WrongKinds extends Sandbox.Sandbox<_WrongKinds, { size: "small"; egress: GitHub.Egress }>()(
  "SandboxTypesWrongKinds",
  // @ts-expect-error Egress.Http is not an accepted kind
  { egress: [Egress.Http] },
) {}

export const granting = Effect.gen(function* () {
  const sandbox = yield* Accepting;
  const work = yield* WorkGateway;
  const user = yield* UserGateway;
  // Egresses from several gateways, of accepted kinds.
  yield* sandbox.start({
    size: "small",
    egress: [
      work.model,
      work.repo.narrow({ repository: "alchemy-run/alchemy", issue: 1 }),
      user.repo.narrow({ repository: "sam/dotfiles", graphql: false }),
    ],
    ttl: "5 minutes",
  });
  yield* sandbox.setEgress({ egress: [work.model] });
  yield* sandbox.setEgress({ ttl: "1 minute" });
  // @ts-expect-error Egress.Http is not a kind this sandbox accepts
  yield* sandbox.start({ size: "small", egress: [user.custom] });
  // @ts-expect-error not a GitHub scope
  work.repo.narrow({ repo: "alchemy-run/alchemy" });
  // @ts-expect-error not an egress of WorkGateway
  work.stripe;
});

export const acceptsNone = Effect.gen(function* () {
  const sandbox = yield* Box;
  const work = yield* WorkGateway;
  // @ts-expect-error a sandbox that declares no kinds accepts no egress
  yield* sandbox.start({ size: "small", egress: [work.model] });
});

//#endregion
