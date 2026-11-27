import * as Cloudflare from "@alchemy.run/cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/** What a selectable container reports about itself. */
export interface Identity {
  /** The Container that answered. */
  container: string;
  /** The JavaScript runtime its image runs. */
  runtime: "bun" | "node";
  /** A plain declared `env` entry. */
  greeting: string | undefined;
  /** A `Redacted` declared `env` entry, read back as a plain string. */
  secret: string | undefined;
  /** The env a capability bound onto the container. */
  boundEnv: string | undefined;
  /** An `env` entry the Durable Object passed to `start()`. */
  caller: string | undefined;
  /** Whether the account id the bootstrap needs reached the process. */
  hasAccountId: boolean;
}

type Shape = {
  whoami: () => Effect.Effect<Identity, never, RuntimeContext>;
  echo: (text: string) => Effect.Effect<string>;
};

/** An Effect-native container on the bun runtime. */
export class BunBox extends Cloudflare.Container<BunBox, Shape>()("BunBox") {}

/** An Effect-native container on the node runtime. */
export class NodeBox extends Cloudflare.Container<NodeBox, Shape>()("NodeBox") {}

/** The names the Worker routes by. */
export type BoxName = "bun" | "node";
