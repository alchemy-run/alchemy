import * as GitHub from "alchemy/GitHub";
import { Self } from "alchemy/Self";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

/**
 * The credential a push authenticates with (`coding/PushBranch.ts`) — a
 * runtime read of a GitHub token. A SEAM by design: production mints it
 * from the host's FQN-memoized `PersonalAccessToken` resource
 * ({@link PublishTokenLive}); tests provide a literal from the
 * environment without any stack machinery.
 */
export class PublishToken extends Context.Service<
  PublishToken,
  Effect.Effect<Redacted.Redacted<string>>
>()("alchemy-org/PublishToken") {}

/**
 * ONE token resource per host, FQN-memoized — the SAME
 * `${LogicalId}GitHubToken` every `GitHub.*Http` binding on this
 * Worker shares (the BindingHttp convention). Yielding `value` at
 * layer init binds it into the deployed environment; the returned
 * Effect reads it back at runtime.
 */
export const PublishTokenLive = Layer.effect(
  PublishToken,
  Effect.gen(function* () {
    const self = yield* Self;
    const token = yield* GitHub.PersonalAccessToken(
      `${self.LogicalId}GitHubToken`,
    );
    return yield* token.value;
  }),
);
