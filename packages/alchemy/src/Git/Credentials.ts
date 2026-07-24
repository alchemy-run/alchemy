import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import type { Remote } from "./Remote.ts";

export interface RemoteCredentials {
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
}

export interface CredentialsService {
  /**
   * Credentials for `remote`, or `None` when this helper does not
   * answer for its host (the workspace proceeds unauthenticated —
   * fine for public reads, loud on push).
   */
  readonly for: (
    remote: Remote,
  ) => Effect.Effect<Option.Option<RemoteCredentials>>;
}

/**
 * The credential-helper protocol — git's own architecture, as a
 * service: workspace Layers ask "who authenticates this remote?", and
 * PROVIDER modules answer for their hosts (`GitHub.GitCredentials`
 * answers github.com from the GitHub credential chain; a Cloudflare
 * Artifacts layer answers its own remotes with scoped repo tokens).
 * Composition decides which helpers are present, exactly like
 * `~/.gitconfig` credential helpers.
 */
export class Credentials extends Context.Service<
  Credentials,
  CredentialsService
>()("alchemy/Git/Credentials") {}
