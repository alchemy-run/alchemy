import * as Layer from "effect/Layer";
import { ReadRepository } from "./ReadRepository.ts";
import {
  makeForgejoHttpBinding,
  makeForgejoReadRepositoryClient,
} from "./RuntimeHttp.ts";

/**
 * Repository reads over HTTP with an automatically provisioned restricted token.
 * Works with any Alchemy runtime host.
 *
 * @layer
 * @provides Forgejo.ReadRepository
 */
export const ReadRepositoryHttp = Layer.effect(
  ReadRepository,
  makeForgejoHttpBinding({
    scope: "read:repository",
    capability: ReadRepository.key,
    makeClient: makeForgejoReadRepositoryClient,
  }),
);
