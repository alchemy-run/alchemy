import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { KeyWrap, newKey } from "./KeyWrap.ts";

/**
 * Keys stored as they are, with no root key over them. Whoever can read the
 * {@link KeyStore} can open what it sealed.
 *
 * @layer
 * @provides Domain.KeyWrap
 */
export const NoKeyWrap: Layer.Layer<KeyWrap> = Layer.succeed(KeyWrap, {
  make: () => Effect.map(newKey, (key) => ({ key, wrapped: key })),
  unwrap: (_, wrapped) => Effect.succeed(wrapped),
});
