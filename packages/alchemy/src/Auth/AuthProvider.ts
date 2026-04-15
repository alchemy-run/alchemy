import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

export interface AuthProvider<Config, Credentials> {
  readonly name: string;

  configure(
    profileName: string,
    isReconfigure: boolean,
  ): Effect.Effect<Config | "remove" | undefined>;

  login(profileName: string, config: Config): Effect.Effect<void>;

  logout(profileName: string, config: Config): Effect.Effect<void>;

  prettyPrint(profileName: string, config: Config): Effect.Effect<void>;

  credentialsLayer(
    profileName: string,
    config: Config,
  ): Layer.Layer<Credentials>;
}
