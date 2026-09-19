import * as Layer from "effect/Layer";
import { WriteRepository } from "./WriteRepository.ts";
import {
  makeForgejoHttpBinding,
  makeForgejoWriteRepositoryClient,
} from "./RuntimeHttp.ts";

/**
 * Repository writes over HTTP with an automatically provisioned restricted token.
 * Works with any Alchemy runtime host.
 *
 * @layer
 * @provides Forgejo.WriteRepository
 */
export const WriteRepositoryHttp = Layer.effect(
  WriteRepository,
  makeForgejoHttpBinding({
    scope: "write:repository",
    capability: WriteRepository.key,
    makeClient: makeForgejoWriteRepositoryClient,
  }),
);
