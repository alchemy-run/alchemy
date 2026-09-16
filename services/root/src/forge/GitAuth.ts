/**
 * The FORGE's front door — auth in user land, the way a git host
 * builds it (the engine holds no users, no credentials, no policy):
 * ONE HttpRouter middleware in front of every git route.
 *
 * v1 model, per the plan: one shared ORG CREDENTIAL names the org
 * caller (humans and agents alike — `git` sends it as the Basic
 * password, REST clients as a bearer token), and ANONYMOUS callers
 * may read public repositories and nothing more (`Git.isRead`). The
 * mirrors we seed are public, so clones need no credential.
 */
import { isRead, RegistryStore } from "alchemy/Git";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** The org's shared credential. Deployed hosts set `FORGE_SECRET`;
 *  dev falls back to a deterministic value so the loop works out of
 *  the box. Per-caller credentials are a later hardening phase. */
export const forgeSecret: Effect.Effect<Redacted.Redacted<string>> =
  Config.Redacted("FORGE_SECRET").pipe(
    Config.withDefault(Redacted.make("root-forge-dev-secret")),
    Effect.orDie,
  );

export interface ForgeUser {
  readonly id: string;
  readonly name: string;
}

/** Who is calling, as the middleware resolved it: the org, or `null`
 *  for an anonymous read of a public repository. */
export class ForgeCaller extends Context.Service<
  ForgeCaller,
  { readonly user: ForgeUser | null }
>()("root/forge/Caller") {}

export const ORG_USER: ForgeUser = { id: "org", name: "root" };

/** The credential a request carries: `git` sends HTTP Basic with the
 *  token in the password field; REST clients send `Bearer`/`token`.
 *  Shared with the forge's plain routes (Sync, the issues facade). */
export const credential = (
  headers: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const header = headers.authorization;
  if (header === undefined) return undefined;
  const space = header.indexOf(" ");
  if (space === -1) return undefined;
  const scheme = header.slice(0, space).toLowerCase();
  const rest = header.slice(space + 1).trim();
  if (scheme === "bearer" || scheme === "token") return rest || undefined;
  if (scheme === "basic") {
    const decoded = Buffer.from(rest, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon === -1 ? undefined : decoded.slice(colon + 1) || undefined;
  }
  return undefined;
};

/** A 401 that makes `git` prompt for credentials. */
const unauthorized = HttpServerResponse.jsonUnsafe(
  { _tag: "Unauthorized" },
  { status: 401, headers: { "www-authenticate": 'Basic realm="git"' } },
);

/** The middleware over every git route (mirrors the reference shape
 *  in packages/alchemy/test/Git/fixtures/test-auth.ts). */
export const ForgeAuthLive = HttpRouter.middleware<{ provides: ForgeCaller }>()(
  Effect.gen(function* () {
    const registry = yield* RegistryStore;
    const secret = Redacted.value(yield* forgeSecret);
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const presented = credential(request.headers);
        if (presented === secret) {
          return yield* Effect.provideService(httpEffect, ForgeCaller, {
            user: ORG_USER,
          });
        }
        if (presented !== undefined) return unauthorized;

        // Anonymous: a read of one public repository, or nothing. A
        // missing repository is the route's 404, so a 401 never
        // confirms a private one exists.
        if (!isRead(request)) return unauthorized;
        const params = yield* HttpRouter.params;
        const owner = params.owner?.toLowerCase();
        const name = params.repo?.toLowerCase().replace(/\.git$/, "");
        if (owner === undefined || name === undefined) return unauthorized;
        const entry = yield* registry
          .resolve(owner, name)
          .pipe(Effect.catchTag("StoreError", () => Effect.succeed(undefined)));
        if (entry !== undefined && !entry.public) return unauthorized;
        return yield* Effect.provideService(httpEffect, ForgeCaller, {
          user: null,
        });
      }).pipe(Effect.provide(RuntimeContext.phantom));
  }),
).layer;
