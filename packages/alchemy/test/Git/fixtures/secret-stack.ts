/**
 * The tutorial's starter assembly, verbatim: `ServerLive` behind
 * `AuthenticatedSecret` with a user-declared `Alchemy.Random`, so the
 * stack can read the secret back. Its own module: a Worker's generated
 * entry imports its `main` module's default export.
 */
import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Output from "@/Output.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  AuthenticatedSecret,
  BlobStoreR2,
  GIT_WORKER_OPTIONS,
  HasherInline,
  PolicyOwners,
  ReposDurableObject,
  RegistryDurableObject,
  Server,
  ServerLive,
} from "@/Git/index.ts";

/** The secret, declared by the user so the stack can output it. */
export const GitSecret = Alchemy.Random("GitSecret");

const GitObjects = Cloudflare.R2.Bucket("GitObjects", { forceDestroy: true });

const GitLive = ServerLive.pipe(
  Layer.provide(ReposDurableObject),
  Layer.provide(RegistryDurableObject),
  Layer.provide(HasherInline),
  Layer.provide(BlobStoreR2(GitObjects)),
  Layer.provide(PolicyOwners),
  Layer.provide(AuthenticatedSecret({ principal: "acme", secret: GitSecret })),
);

export default class SecretGitHost extends Cloudflare.Worker<SecretGitHost>()(
  "GitSecretWorker",
  { main: import.meta.url, ...GIT_WORKER_OPTIONS },
  Effect.gen(function* () {
    const git = yield* Server;
    return { fetch: git.fetch };
  }).pipe(Effect.provide(GitLive)),
) {}

/** The starter stack: the host's URL and the secret, revealed. */
export const makeSecretStack = (name: string) =>
  Alchemy.Stack(
    name,
    { providers: Cloudflare.providers(), state: Alchemy.localState() },
    Effect.gen(function* () {
      const host = yield* SecretGitHost;
      const secret = yield* GitSecret;
      return {
        url: host.url.as<string>(),
        secret: Output.map(secret.text, Redacted.value),
      };
    }),
  );
