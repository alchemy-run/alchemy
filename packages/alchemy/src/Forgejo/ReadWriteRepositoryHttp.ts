import * as Layer from "effect/Layer";
import { ReadWriteRepository } from "./ReadWriteRepository.ts";
import {
  makeForgejoHttpBinding,
  makeForgejoReadRepositoryClient,
  makeForgejoWriteRepositoryClient,
} from "./RuntimeHttp.ts";

/**
 * Repository reads and writes over HTTP using one restricted token.
 * Works with any Alchemy runtime host.
 *
 * @layer
 * @provides Forgejo.ReadWriteRepository
 */
export const ReadWriteRepositoryHttp = Layer.effect(
  ReadWriteRepository,
  makeForgejoHttpBinding({
    scope: "write:repository",
    capability: ReadWriteRepository.key,
    makeClient: (auth) => ({
      ...makeForgejoReadRepositoryClient(auth),
      ...makeForgejoWriteRepositoryClient(auth),
    }),
  }),
);
