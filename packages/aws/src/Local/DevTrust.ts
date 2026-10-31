import * as Effect from "effect/Effect";
import * as Floci from "./Floci.ts";

/**
 * `alchemy dev` trusts the local AWS emulator's CA, so local Workers and
 * `Command.Dev` processes accept its TLS certificate. The file is created
 * during the first apply, when `ensureFloci` downloads it.
 */
export const devTrust = Effect.succeed([Floci.FLOCI_CA_PATH]);
