import * as Context from "effect/Context";

export class ProviderSecret extends Context.Service<ProviderSecret, string>()(
  "SecretManagerFixture.ProviderSecret",
) {}

export class StateSecret extends Context.Service<StateSecret, string>()(
  "SecretManagerFixture.StateSecret",
) {}
