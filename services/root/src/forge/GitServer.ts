/**
 * The ORG's GIT SERVER — `alchemy/Git` embedded in the ApiWorker.
 *
 * The company hosts its own code: smart HTTP for `git clone`/`push`
 * at `/:owner/:repo/…`, the typed REST plane at `/api/v1` (repos,
 * refs, trees/blobs, pulls), and the GitHub REST v3 facade at
 * `/api/v3` so Octokit and `gh api` work against US. Each line of
 * the stack is one replaceable decision (see alchemy.run/git):
 * objects in R2, refs/pulls in per-repo Durable Objects, the
 * owner/name registry in its own DO, hashing in-isolate, and OUR
 * middleware (GitAuth.ts) deciding who may call what.
 *
 * This is the first goal's substrate: agentic workflows isolated
 * from public GitHub — the repos here are seeded mirrors of
 * alchemy/distilled/floci (Seed.ts), and later a deployed instance
 * becomes the source of truth with GitHub as a mirror.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import {
  ApiHandlersLive,
  BlobStoreR2,
  GitApi,
  GroupsLive,
  Handlers,
  HasherInline,
  InternalApiLive,
  RegistryDurableObject,
  ReposDurableObject,
} from "alchemy/Git";
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ForgeAuthLive, ForgeCaller } from "./GitAuth.ts";

/** The forge's bytes: packs, clone bundles, oversize objects. */
export const GitObjects = Cloudflare.R2.Bucket("GitObjects");

/** The blob store over that bucket — some read paths resolve it per
 *  request (the DO-less clone fast path), so the host provides it
 *  around the git http effect too. */
export const GitBlobStore = BlobStoreR2(GitObjects);

/** The GitHub facade group with OUR `/user` probe: the engine has no
 *  user to answer with, so the middleware's caller answers (`gh` and
 *  Octokit probe this before anything else). */
const GitHubGroup = HttpApiBuilder.group(GitApi, "github", (h) =>
  Effect.map(Handlers, (git) =>
    h.handleAll({
      ...git.github,
      user: () =>
        Effect.gen(function* () {
          const caller = yield* Effect.serviceOption(ForgeCaller);
          const user = Option.isSome(caller) ? caller.value.user : null;
          return user === null
            ? HttpServerResponse.jsonUnsafe(
                { message: "Requires authentication" },
                { status: 401 },
              )
            : HttpServerResponse.jsonUnsafe({
                login: user.name,
                id: 1,
                type: "User",
              });
        }),
    }),
  ),
);

/** The git routes, ready to merge into the ApiWorker's router. */
export const GitRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(GitApi).pipe(
    Layer.provide(Layer.mergeAll(GroupsLive, GitHubGroup)),
    Layer.provide(ForgeAuthLive),
  ),
  // the push pipeline's internal hash route (self service-binding)
  InternalApiLive,
).pipe(
  Layer.provide(ApiHandlersLive),
  Layer.provide(ReposDurableObject),
  Layer.provide(RegistryDurableObject),
  // in-process hashing: the reference layer — fan-out is a scaling
  // seam we can swap later without touching anything else
  Layer.provide(HasherInline),
  Layer.provide(GitBlobStore),
  Layer.provide(Http.Platform),
);
