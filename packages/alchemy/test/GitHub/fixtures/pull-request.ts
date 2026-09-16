import * as GitHub from "@/GitHub";
import { GitHubCredentials } from "@/GitHub/Credentials";
import { Octokit } from "@/GitHub/Octokit";
import * as Output from "@/Output";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
if (!["alchemy-run-test", "alchemy-run-test-2"].includes(owner)) {
  throw new Error(`Unsafe GITHUB_TEST_OWNER: ${owner}`);
}

const repositories = ["alchemy-pr-1569-pull-request", "alchemy-pr-1569-query"];

export const providers = GitHub.providers({ baseUrl: "github.com" }).pipe(
  Layer.flatMap((context) =>
    Layer.succeedContext(
      Context.add(
        context,
        GitHubCredentials,
        Context.get(context, GitHubCredentials).pipe(
          Effect.map((credentials) => ({
            ...credentials,
            octokit: (override?: { baseUrl: string | undefined }) => {
              const client = credentials.octokit(override);
              client.hook.wrap("request", (request, options) => {
                if (options.url === "/user/repos") {
                  options.url = `/orgs/${owner}/repos`;
                }
                const endpoint = client.request.endpoint(options);
                const url = new URL(endpoint.url);
                const parts = url.pathname.split("/").filter(Boolean);
                const allowed =
                  url.hostname === "api.github.com" &&
                  ((parts[0] === "repos" &&
                    parts[1] === owner &&
                    repositories.includes(parts[2]!)) ||
                    (parts[0] === "orgs" &&
                      parts[1] === owner &&
                      parts[2] === "repos" &&
                      (endpoint.method === "GET" ||
                        repositories.includes(String(options.name)))) ||
                    (endpoint.method === "GET" &&
                      (url.pathname === "/user" ||
                        url.pathname === `/users/${owner}`)) ||
                    url.pathname === "/graphql");
                if (!allowed) {
                  throw new Error(
                    `Blocked GitHub request outside PR #1569 fixtures: ${endpoint.method} ${url}`,
                  );
                }
                return request(options);
              });
              return client;
            },
          })),
        ),
      ),
    ),
  ),
);

export const fixture = (name: string) =>
  GitHub.Repository("Repo", {
    owner,
    name,
    description: "Retained deterministic fixture for alchemy PR #1569",
    visibility: "public",
    autoInit: true,
  });

export const repoName = (repo: GitHub.Repository) =>
  Output.map(repo.fullName, (fullName) => fullName.split("/")[1]!);

export const request = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => error as Error & { status?: number },
  });

export const prepareBranches = Effect.fn(function* (repo: string) {
  const client = yield* Octokit;
  const scope = { owner, repo };
  const { data: repository } = yield* request(() =>
    client.rest.repos.get(scope),
  );
  const base = repository.default_branch;
  const { data: ref } = yield* request(() =>
    client.rest.git.getRef({ ...scope, ref: `heads/${base}` }),
  );
  for (const branch of ["alchemy-pr-1569-a", "alchemy-pr-1569-b"]) {
    const existing = yield* request(() =>
      client.rest.git.getRef({ ...scope, ref: `heads/${branch}` }),
    ).pipe(
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.succeed(undefined),
      ),
    );
    if (existing === undefined) {
      yield* request(() =>
        client.rest.git.createRef({
          ...scope,
          ref: `refs/heads/${branch}`,
          sha: ref.object.sha,
        }),
      );
      yield* request(() =>
        client.rest.repos.createOrUpdateFileContents({
          ...scope,
          branch,
          path: "alchemy-pr-1569.txt",
          message: "Add deterministic PR test fixture",
          content: "YWxjaGVteSBQUiBmaXh0dXJlCg==",
        }),
      );
    }
  }
  return base;
});

export const deleteBranches = Effect.fn(function* (repo: string) {
  const client = yield* Octokit;
  for (const branch of ["alchemy-pr-1569-a", "alchemy-pr-1569-b"]) {
    yield* request(() =>
      client.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` }),
    );
  }
});
