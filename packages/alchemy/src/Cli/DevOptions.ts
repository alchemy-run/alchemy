import * as Schema from "effect/Schema";

/** Wire format passed from the `alchemy dev` supervisor to its exec child. */
export const DevOptions = Schema.Struct({
  main: Schema.String,
  stage: Schema.String,
  envFile: Schema.OptionFromOptional(Schema.String),
  profile: Schema.optional(Schema.String),
  force: Schema.Boolean,
  /** Expose every local resource through a Cloudflare quick tunnel. */
  tunnel: Schema.Boolean,
  /** Domain local resources are served under (`<name>.<domain>`). */
  domain: Schema.String,
  /** Port of the shared dev ingress. */
  port: Schema.Number,
  /** Dev relay to connect to (`--relay <url>`), if any. */
  relay: Schema.optional(Schema.String),
  /** Namespace claimed on the relay (`--relay-namespace`). */
  relayNamespace: Schema.optional(Schema.String),
});

export type DevOptions = typeof DevOptions.Type;
