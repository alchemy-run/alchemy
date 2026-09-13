import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { PublishToken } from "./PublishToken.ts";
import { connected, primary } from "./Repos.ts";

/**
 * Identity and health: who the operator is, which repositories are
 * connected, and whether GitHub answers.
 */
export const StatusApi = Effect.gen(function* () {
  const publishToken = yield* Effect.serviceOption(PublishToken);
  const listPullRequests = yield* GitHub.ListPullRequests(primary);

  // the CONNECTED repositories — static code (Repos.ts)
  const repos = yield* Effect.forEach(connected, (entry) =>
    GitHub.resolveRepository(entry.repository).pipe(
      Effect.map((identity) => `${identity.owner}/${identity.repository}`),
    ),
  );

  /* ── the operator's identity (cached) ───────────────────────────── */

  type Operator = {
    login: string;
    name: string | null;
    avatarUrl: string;
    url: string;
  } | null;
  let operatorCache: { at: number; value: Operator } | undefined;
  const readOperator: Effect.Effect<Operator> = Effect.gen(function* () {
    if (Option.isNone(publishToken)) return null;
    const now = Date.now();
    if (operatorCache !== undefined && now - operatorCache.at < 600_000) {
      return operatorCache.value;
    }
    const token = yield* publishToken.value;
    const value: Operator = yield* Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("https://api.github.com/user", {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${Redacted.value(token)}`,
          "user-agent": "root",
        },
      });
      const user = (yield* response.json) as {
        login: string;
        name: string | null;
        avatar_url: string;
        html_url: string;
      };
      return {
        login: user.login,
        name: user.name,
        avatarUrl: user.avatar_url,
        url: user.html_url,
      };
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.catch(() => Effect.succeed(null)),
    );
    operatorCache = { at: now, value };
    return value;
  });

  const whoami = HttpRouter.add(
    "GET",
    "/api/whoami",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(yield* readOperator);
    }),
  );

  const listRepos = HttpRouter.add(
    "GET",
    "/api/repos",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(repos);
    }),
  );

  const status = HttpRouter.add(
    "GET",
    "/api/status",
    Effect.gen(function* () {
      const snapshot = yield* listPullRequests({ state: "open" }).pipe(
        Effect.map((list) => ({
          phase: "running",
          openPullRequests: list.map((pull) => ({
            number: pull.number,
            title: pull.title,
          })),
        })),
        Effect.catch((error) =>
          Effect.succeed({ phase: "degraded", error: String(error) } as const),
        ),
      );
      return yield* HttpServerResponse.json(snapshot);
    }),
  );

  return Layer.mergeAll(whoami, listRepos, status);
});
