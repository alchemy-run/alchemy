import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class AuthError extends Schema.TaggedErrorClass<AuthError>()(
  "AuthError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface AuthProvider<Config extends { method: string }, Credentials> {
  readonly name: string;

  configure(profileName: string): Effect.Effect<Config, AuthError>;

  login(
    profileName: string,
    config: Config,
  ): Effect.Effect<void, AuthError, never>;

  logout(
    profileName: string,
    config: Config,
  ): Effect.Effect<void, AuthError, never>;

  prettyPrint(profileName: string, config: Config): Effect.Effect<void>;

  read(
    profileName: string,
    config: Config,
  ): Effect.Effect<Credentials, AuthError, never>;
}
