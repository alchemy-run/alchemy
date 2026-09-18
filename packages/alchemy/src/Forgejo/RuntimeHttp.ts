import { Credentials } from "@distilled.cloud/forgejo";
import * as RepositoryAPI from "@distilled.cloud/forgejo/repository";
import * as IssueAPI from "@distilled.cloud/forgejo/issue";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Config from "effect/Config";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import * as Namespace from "../Namespace.ts";
import * as Output from "../Output.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { ApiToken } from "./ApiToken.ts";
import type { Repository } from "./Repository.ts";
import type { ForgejoBindingOptions, ForgejoSecret } from "./RuntimeTypes.ts";

// Input dependencies resolve during deployment; the accessor reads host env at runtime.
export const forgejoSecretOutput = (
  value: ForgejoSecret,
): Output.Output<Redacted.Redacted<string>, never> =>
  Config.isConfig(value)
    ? Output.fromEffect(
        Effect.gen(function* () {
          return yield* value;
        }).pipe(Effect.orDie),
      )
    : Redacted.isRedacted(value)
      ? new Output.LiteralExpr(value)
      : value;

/** Hash full logical identities rather than sanitizing ambiguous path strings. */
export const forgejoBindingId = (
  host: string,
  repo: Repository,
  permission: string,
) =>
  Effect.gen(function* () {
    const bytes = yield* Effect.sync(() =>
      new TextEncoder().encode(
        JSON.stringify([host, repo.Type, repo.FQN, permission]),
      ),
    );
    const hash = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", bytes),
    );
    return yield* Effect.sync(() =>
      Array.from(new Uint8Array(hash), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
    );
  });

export const makeForgejoAuth = (
  host: string,
  scope: string,
  capability: string,
) => {
  return Effect.fn(function* (
    repo: Repository,
    options?: ForgejoBindingOptions,
  ) {
    const permission =
      options?.token === undefined
        ? scope
        : JSON.stringify([scope, "external", capability, options.credentialId]);
    const id = yield* forgejoBindingId(host, repo, permission);
    const Token = yield* ApiToken;
    // Replay the declaration at runtime so Output accessors have identical paths.
    const token =
      options?.token ??
      (yield* Namespace.set("ForgejoRuntime")(
        Token(`Token${id}`, {
          scopes: [scope],
          repositories: [{ owner: repo.owner, name: repo.name }],
          rotation: Output.interpolate`${repo.apiBaseUrl}:${repo.repoId}:${options?.rotation ?? ""}`,
        }),
      )).token;
    const value = yield* Output.named(
      forgejoSecretOutput(token),
      `Forgejo${id}Token`,
    );
    const owner = yield* Output.named(repo.owner, `Forgejo${id}Owner`);
    const name = yield* Output.named(repo.name, `Forgejo${id}Name`);
    const apiBaseUrl = yield* Output.named(repo.apiBaseUrl, `Forgejo${id}Url`);
    const http = yield* HttpClient.HttpClient.pipe(
      Effect.provide(FetchHttpClient.layer),
    );
    const run =
      <I extends { owner: string; repo: string }, A, E>(
        operation: (
          input: I,
        ) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
      ) =>
      (
        request: Omit<I, "owner" | "repo"> = {} as Omit<I, "owner" | "repo">,
      ): Effect.Effect<A, E, RuntimeContext> =>
        Effect.gen(function* () {
          const credentials = {
            token: yield* value,
            apiBaseUrl: yield* apiBaseUrl,
          };
          return yield* operation({
            ...request,
            owner: yield* owner,
            repo: yield* name,
          } as I).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(Credentials, Effect.succeed(credentials)),
                Layer.succeed(HttpClient.HttpClient, http),
              ),
            ),
          );
        });
    return { run };
  });
};

export type ForgejoRuntimeAuth = Effect.Success<
  ReturnType<ReturnType<typeof makeForgejoAuth>>
>;

export const makeForgejoHttpBinding = <Client>(options: {
  scope: string;
  capability: string;
  makeClient: (auth: ForgejoRuntimeAuth) => Client;
}) =>
  Effect.gen(function* () {
    const host = yield* Binding.Host;
    if (!host) {
      return yield* Effect.die("Forgejo HTTP bindings require a runtime host.");
    }
    const auth = makeForgejoAuth(
      `${host.Type}:${host.FQN}`,
      options.scope,
      options.capability,
    );
    return (repo: Repository, bindingOptions?: ForgejoBindingOptions) =>
      auth(repo, bindingOptions).pipe(Effect.map(options.makeClient));
  });

export const makeForgejoReadRepositoryClient = ({
  run,
}: ForgejoRuntimeAuth) => ({
  get: run(RepositoryAPI.getRepo),
  getTopics: run(RepositoryAPI.repoListTopics),
  getContent: run(RepositoryAPI.repoGetContents),
});
export const makeForgejoWriteRepositoryClient = ({
  run,
}: ForgejoRuntimeAuth) => ({
  setTopics: run(RepositoryAPI.repoUpdateTopics),
  createFile: run(RepositoryAPI.repoCreateFile),
  updateFile: run(RepositoryAPI.repoUpdateFile),
  deleteFile: run(RepositoryAPI.repoDeleteFile),
});
export const makeForgejoReadIssuesClient = ({ run }: ForgejoRuntimeAuth) => ({
  list: run(IssueAPI.listIssues),
  get: run(IssueAPI.getIssue),
  listComments: run(IssueAPI.issueGetComments),
});
export const makeForgejoWriteIssuesClient = ({ run }: ForgejoRuntimeAuth) => ({
  create: run(IssueAPI.createIssue),
  update: run(IssueAPI.editIssue),
  createComment: run(IssueAPI.issueCreateComment),
});
