import * as Anthropic from "@alchemy.run/anthropic";
import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Egress from "alchemy/Egress";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

type Assert<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class WorkGateway extends Egress.Gateway<WorkGateway>()("WorkGateway", {
  model: Anthropic.Egress,
  repo: GitHub.Egress,
}) {}

class UserGateway extends Egress.Gateway<UserGateway>()("UserGateway", {
  repo: GitHub.Egress,
  custom: Egress.Http,
}) {}

const model = Anthropic.Egress({ apiKey: Config.Redacted("ANTHROPIC_API_KEY") });
const repo = GitHub.Egress({ token: GitHub.ProfileToken, repositories: [] });
const custom = Egress.Http({ credential: { host: "api.example.com", headers: {} } });

// serve: exactly the declared names, each of its declared kind.
WorkGateway.serve(
  Effect.gen(function* () {
    return { model: yield* model, repo: yield* repo };
  }),
);
UserGateway.serve(
  Effect.gen(function* () {
    return {
      // A credential per subject.
      repo: yield* GitHub.Egress({ token: ({ subject }) => Effect.succeed(`token-${subject}`) }),
      custom: yield* custom,
    };
  }),
);

WorkGateway.serve(
  // @ts-expect-error — `repo` is missing
  Effect.gen(function* () {
    return { model: yield* model };
  }),
);

WorkGateway.serve(
  // @ts-expect-error — `extra` isn't declared
  Effect.gen(function* () {
    return { model: yield* model, repo: yield* repo, extra: yield* custom };
  }),
);

WorkGateway.serve(
  // @ts-expect-error — `model` is an Anthropic egress, not a GitHub one
  Effect.gen(function* () {
    return { model: yield* repo, repo: yield* repo };
  }),
);

// The gateway's host: a Worker serving it.
const GatewayWorker = Cloudflare.Worker(
  "WorkGatewayWorker",
  { main: "./gateway.ts" },
  WorkGateway.serve(
    Effect.gen(function* () {
      return { model: yield* model, repo: yield* repo };
    }),
  ),
);
WorkGateway.host(GatewayWorker);
WorkGateway.host(GatewayWorker, { path: "/egress" });
// @ts-expect-error — a Worker that doesn't serve a gateway can't host one
WorkGateway.host(Cloudflare.Worker("Plain", { main: "./plain.ts" }, Effect.succeed({})));

// Or a Lambda Function (with a function URL) serving it.
const GatewayLambda = AWS.Lambda.Function(
  "WorkGatewayLambda",
  { main: "./gateway.ts", functionUrl: true },
  WorkGateway.serve(
    Effect.gen(function* () {
      return { model: yield* model, repo: yield* repo };
    }),
  ),
);
WorkGateway.host(GatewayLambda);

// yield* Gateway: each declared egress, grantable; narrow takes the kind's scope.
Effect.gen(function* () {
  const work = yield* WorkGateway;
  const user = yield* UserGateway;

  work.repo.narrow({ repository: "alchemy-run/alchemy", issue: 42 });
  user.repo.narrow({ repository: "sam/dotfiles", graphql: false }).for("u_123");
  user.custom.narrow({ paths: ["/v1/**"] });
  const refs = [work.model.ref, work.repo.ref, user.custom.ref];
  type _Refs = Assert<Equals<(typeof refs)[number], Egress.EgressRef>>;

  // @ts-expect-error — the gateway has no `stripe`
  work.stripe;
  // @ts-expect-error — 'repo' is not a field of GitHub.Scope
  work.repo.narrow({ repo: "alchemy-run/alchemy" });
  // @ts-expect-error — an Anthropic egress can't be narrowed
  work.model.narrow({ repository: "alchemy-run/alchemy" });
  // @ts-expect-error — an HTTP scope is { paths }
  user.custom.narrow({ host: "api.example.com" });

  return yield* Egress.grant([work.model, work.repo.narrow({ repository: "a/b" })]);
});

// Yielding a gateway leaves its host for the stack to provide.
type _NeedsHost = Assert<
  Equals<
    Extract<Effect.Services<typeof WorkGateway>, Egress.GatewayHost<any>>,
    Egress.GatewayHost<WorkGateway>
  >
>;
