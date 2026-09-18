import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ReadRepository } from "./ReadRepository.ts";
import { WriteRepository } from "./WriteRepository.ts";
import { ReadWriteRepository } from "./ReadWriteRepository.ts";
import { ReadIssues } from "./ReadIssues.ts";
import { WriteIssues } from "./WriteIssues.ts";
import { ReadWriteIssues } from "./ReadWriteIssues.ts";
import type { Repository } from "./Repository.ts";
import type { ForgejoBindingOptions } from "./RuntimeTypes.ts";
import {
  makeForgejoAuth,
  makeForgejoReadRepositoryClient,
  makeForgejoWriteRepositoryClient,
  makeForgejoReadIssuesClient,
  makeForgejoWriteIssuesClient,
  type ForgejoRuntimeAuth,
} from "./RuntimeHttp.ts";

export const makeForgejoCapabilityLayers = <Host>(
  host: Effect.Effect<string, never, Host>,
) => {
  const implementation = <Client>(
    scope: string,
    makeClient: (auth: ForgejoRuntimeAuth) => Client,
    capability: string,
  ) =>
    Effect.gen(function* () {
      const identity = yield* host;
      const auth = makeForgejoAuth(identity, scope, capability);
      return (repo: Repository, options?: ForgejoBindingOptions) =>
        auth(repo, options).pipe(Effect.map(makeClient));
    });
  return {
    readRepository: Layer.effect(
      ReadRepository,
      implementation(
        "read:repository",
        makeForgejoReadRepositoryClient,
        ReadRepository.key,
      ),
    ),
    writeRepository: Layer.effect(
      WriteRepository,
      implementation(
        "write:repository",
        makeForgejoWriteRepositoryClient,
        WriteRepository.key,
      ),
    ),
    readWriteRepository: Layer.effect(
      ReadWriteRepository,
      implementation(
        "write:repository",
        (auth) => ({
          ...makeForgejoReadRepositoryClient(auth),
          ...makeForgejoWriteRepositoryClient(auth),
        }),
        ReadWriteRepository.key,
      ),
    ),
    readIssues: Layer.effect(
      ReadIssues,
      implementation("read:issue", makeForgejoReadIssuesClient, ReadIssues.key),
    ),
    writeIssues: Layer.effect(
      WriteIssues,
      implementation(
        "write:issue",
        makeForgejoWriteIssuesClient,
        WriteIssues.key,
      ),
    ),
    readWriteIssues: Layer.effect(
      ReadWriteIssues,
      implementation(
        "write:issue",
        (auth) => ({
          ...makeForgejoReadIssuesClient(auth),
          ...makeForgejoWriteIssuesClient(auth),
        }),
        ReadWriteIssues.key,
      ),
    ),
  };
};
