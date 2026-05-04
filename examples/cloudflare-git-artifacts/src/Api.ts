import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import RepoMetadata from "./RepoMetadata.ts";
import { Repos } from "./Repos.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.path,
    observability: { enabled: true },
  },
  Effect.gen(function* () {
    const repos = yield* Cloudflare.Artifacts.bind(Repos);
    const metadata = yield* RepoMetadata;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const parts = url.pathname.split("/").filter(Boolean);

        // POST /repos — create a repo + init metadata
        if (
          parts[0] === "repos" &&
          parts.length === 1 &&
          request.method === "POST"
        ) {
          const body = JSON.parse((yield* request.text) || "{}") as {
            name?: string;
            description?: string;
          };
          const name = body.name?.trim();
          if (!name) {
            return yield* HttpServerResponse.json(
              { error: "name is required" },
              { status: 400 },
            );
          }
          return yield* repos
            .create(name, {
              description: body.description,
              setDefaultBranch: "main",
            })
            .pipe(
              Effect.tap((created) =>
                metadata
                  .getByName(created.name)
                  .init(body.description ?? "")
                  .pipe(Effect.orDie),
              ),
              Effect.flatMap((created) =>
                HttpServerResponse.json({
                  name: created.name,
                  remote: created.remote,
                  token: created.token,
                  tokenExpiresAt: created.tokenExpiresAt,
                  defaultBranch: created.defaultBranch,
                }),
              ),
              Effect.catchTag("ArtifactsError", (err) =>
                HttpServerResponse.json(
                  { error: err.message },
                  { status: 409 },
                ),
              ),
            );
        }

        // GET /repos — list repos
        if (
          parts[0] === "repos" &&
          parts.length === 1 &&
          request.method === "GET"
        ) {
          return yield* repos.list({ limit: 50 }).pipe(
            Effect.flatMap((list) => HttpServerResponse.json(list)),
            Effect.catchTag("ArtifactsError", (err) =>
              HttpServerResponse.json(
                { error: err.message },
                { status: 500 },
              ),
            ),
          );
        }

        // GET /repos/:name — combined Artifacts info (from list) + DO metadata.
        // `repos.get(name).raw` is an opaque RPC stub (no enumerable fields), so
        // we look the repo up via `list()` to get a serialisable POJO.
        if (
          parts[0] === "repos" &&
          parts.length === 2 &&
          request.method === "GET"
        ) {
          const name = parts[1]!;
          return yield* repos.list({ limit: 100 }).pipe(
            Effect.flatMap((list) => {
              const found = list.repos.find((r) => r.name === name);
              if (!found) {
                return HttpServerResponse.json(
                  { name, error: "not found" },
                  { status: 404 },
                );
              }
              return metadata
                .getByName(name)
                .get()
                .pipe(
                  Effect.catch(() => Effect.succeed(null)),
                  Effect.flatMap((meta) =>
                    HttpServerResponse.json({ ...found, metadata: meta }),
                  ),
                );
            }),
            Effect.catchTag("ArtifactsError", (err) =>
              HttpServerResponse.json(
                { name, error: err.message },
                { status: 500 },
              ),
            ),
          );
        }

        // PATCH /repos/:name — update description / topics on the DO
        if (
          parts[0] === "repos" &&
          parts.length === 2 &&
          request.method === "PATCH"
        ) {
          const name = parts[1]!;
          const patch = JSON.parse((yield* request.text) || "{}") as {
            description?: string;
            topics?: string[];
          };
          const meta = yield* metadata
            .getByName(name)
            .update(patch)
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json(meta);
        }

        // DELETE /repos/:name — delete repo
        if (
          parts[0] === "repos" &&
          parts.length === 2 &&
          request.method === "DELETE"
        ) {
          const name = parts[1]!;
          return yield* repos.delete(name).pipe(
            Effect.map(() => HttpServerResponse.empty({ status: 204 })),
            Effect.catchTag("ArtifactsError", (err) =>
              HttpServerResponse.json(
                { name, error: err.message },
                { status: 404 },
              ),
            ),
          );
        }

        // POST /repos/:name/star — bump star count on the DO
        if (
          parts[0] === "repos" &&
          parts[2] === "star" &&
          request.method === "POST"
        ) {
          const meta = yield* metadata
            .getByName(parts[1]!)
            .star()
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json(meta);
        }

        // POST /repos/:name/clone-token — mint a short-lived token
        if (
          parts[0] === "repos" &&
          parts[2] === "clone-token" &&
          request.method === "POST"
        ) {
          const body = JSON.parse((yield* request.text) || "{}") as {
            scope?: "read" | "write";
            ttl?: number;
          };
          return yield* repos.get(parts[1]!).pipe(
            Effect.flatMap((repo) =>
              repo.createToken(body.scope ?? "read", body.ttl ?? 3600),
            ),
            Effect.flatMap((token) => HttpServerResponse.json(token)),
            Effect.catchTag("ArtifactsError", (err) =>
              HttpServerResponse.json(
                { error: err.message },
                { status: 404 },
              ),
            ),
          );
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.text("Internal Server Error", { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.ArtifactsBindingLive))),
) {}
