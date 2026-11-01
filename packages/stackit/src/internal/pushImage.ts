import { Docker } from "@alchemy.run/docker/Docker";
import { publishedRepoDigest } from "@alchemy.run/docker/Registry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { FUNCTION_PLATFORM } from "../Functions/internal.ts";

/** The image was pushed, but neither the push nor the engine reported its digest. */
export class FunctionImageDigestMissing extends Data.TaggedError(
  "Stackit.Functions.FunctionImageDigestMissing",
)<{
  readonly resourceName: string;
  readonly image: string;
  readonly message: string;
}> {}

/** The digest-pinned reference of an image pushed from this machine. */
export const pushedDigestReference = Effect.fn(function* (args: {
  id: string;
  imageUri: string;
  registry: {
    repository: string;
    username?: string | undefined;
    password?: string | Redacted.Redacted<string> | undefined;
  };
}) {
  const docker = yield* Docker;
  const { imageUri, registry } = args;
  // Pushing an image the build just pushed uploads nothing. It's here for its
  // output: the only place the engine reports the digest it published. Without
  // credentials, the push uses the machine's own registry login.
  const pushed = yield* docker.image.push(
    imageUri,
    registry.username !== undefined && registry.password !== undefined
      ? {
          // Docker keys credentials by host.
          server: registry.repository.split("/")[0]!,
          username: registry.username,
          password: registry.password,
        }
      : undefined,
    FUNCTION_PLATFORM,
  );
  const inspected = yield* docker.image.inspect(imageUri);
  const reference = publishedRepoDigest(imageUri, pushed, inspected.RepoDigests);
  if (reference === undefined) {
    return yield* new FunctionImageDigestMissing({
      resourceName: args.id,
      image: imageUri,
      message: `${args.id}: pushed ${imageUri}, but the container engine reported no digest for it`,
    });
  }
  return reference;
});
