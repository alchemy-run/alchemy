/**
 * The Git host with its pack hasher on dynamically loaded Workers (DESIGN
 * §22.12): the same building-block assembly as `stack.ts`, with
 * `HasherWorkerLoader` in place of the in-process hasher.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ADMIN_TOKEN_CONFIG_KEY,
  AuthTokens,
  BlobStoreR2,
  GIT_WORKER_OPTIONS,
  ReposDurableObject,
  RegistryDurableObject,
  Server,
  ServerLive,
} from "@/Git/index.ts";
import { HasherWorkerLoader } from "@/Git/WorkerLoader/index.ts";

export const TEST_ADMIN_TOKEN: string =
  process.env[ADMIN_TOKEN_CONFIG_KEY] ?? "gs_test-admin-key-git-service-suite";
process.env[ADMIN_TOKEN_CONFIG_KEY] ??= TEST_ADMIN_TOKEN;

const GitObjects = Cloudflare.R2.Bucket("GitLoaderObjects", {
  forceDestroy: true,
});

const GitLive = ServerLive.pipe(
  Layer.provide(ReposDurableObject),
  Layer.provide(RegistryDurableObject),
  Layer.provide(HasherWorkerLoader()),
  Layer.provide(BlobStoreR2(GitObjects)),
  Layer.provide(AuthTokens),
);

export default class LoaderGitHost extends Cloudflare.Worker<LoaderGitHost>()(
  "GitLoaderWorker",
  {
    main: import.meta.url,
    ...GIT_WORKER_OPTIONS,
    observability: { enabled: true },
  },
  Effect.gen(function* () {
    const git = yield* Server;
    return { fetch: git.fetch };
  }).pipe(Effect.provide(GitLive)),
) {}

export const makeLoaderTestStack = (name: string) =>
  Alchemy.Stack(
    name,
    { providers: Cloudflare.providers(), state: Cloudflare.state() },
    Effect.gen(function* () {
      const host = yield* LoaderGitHost;
      return { url: host.url.as<string>() };
    }),
  );
