import * as forgejo from "@distilled.cloud/stackit/git_forgejo";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { secretsDiffer } from "../internal/equal.ts";
import type { Providers } from "../Providers.ts";
import {
  getRepositoryOrUndefined,
  REPOSITORY_NAME_MAX_LENGTH,
  sameInstanceUrl,
  withForgejo,
} from "./internal.ts";

export interface RepositoryProps {
  /** URL of the instance, a `Stackit.Git.Instance`'s `url`. Changing it replaces the repository. */
  instanceUrl: string;
  /**
   * A Forgejo access token to manage the repository with, which you create in the instance's user
   * settings. Forgejo 17 checks its `user` scope to find the signed-in user, `repository` to create
   * and change repositories, and `organization` to create one in an organization.
   *
   * Alchemy records the props of every resource in its state store, and a `Redacted` value is
   * written there unencrypted, under a `__redacted__` marker. Give this or `username` and `password`.
   */
  token?: string | Redacted.Redacted<string>;
  /** A Forgejo user to manage the repository as, such as a `Stackit.Git.User`'s `username`. */
  username?: string;
  /**
   * That user's password. It gives everything the user can do, so prefer a token where one will do.
   * A user with two-factor sign-in can't use it.
   */
  password?: string | Redacted.Redacted<string>;
  /**
   * The user or organization that owns the repository, which the login must be able to create
   * repositories for. Changing it replaces the repository: the new one starts empty, and the plan
   * fails if the old one holds anything (see `forceDestroy`). Omit to keep the deployed owner.
   *
   * @default the signed-in user
   */
  owner?: string;
  /**
   * Name of the repository. Updates in place with a rename, which keeps its contents. Omit to keep
   * the deployed name.
   *
   * If omitted on the first deploy, a unique name is generated from the stack, stage and logical ID.
   */
  name?: string;
  /** Description of the repository. Omit to leave the live value alone. */
  description?: string;
  /**
   * Whether only the owner and collaborators can see the repository. Omit to leave the live value
   * alone; a new repository is private.
   *
   * @default true
   */
  private?: boolean;
  /** Default branch. Forgejo only moves it to a branch that exists. Omit to leave the live value alone. */
  defaultBranch?: string;
  /**
   * Create the repository with a first commit holding a README. Only used when the repository is
   * created. A repository with a commit counts as holding something (see `forceDestroy`).
   *
   * @default false
   */
  autoInit?: boolean;
  /** Whether the repository is a template. Omit to leave the live value alone. */
  template?: boolean;
  /** Website shown on the repository. Omit to leave the live value alone. */
  website?: string;
  /** Whether the repository has issues. Omit to leave the live value alone. */
  hasIssues?: boolean;
  /** Whether the repository has a wiki. Omit to leave the live value alone. */
  hasWiki?: boolean;
  /** Whether the repository has pull requests. Omit to leave the live value alone. */
  hasPullRequests?: boolean;
  /** Whether the repository can run pipelines. Omit to leave the live value alone. */
  hasActions?: boolean;
  /** Whether the repository is archived and read-only. Omit to leave the live value alone. */
  archived?: boolean;
  /**
   * Allow deleting the repository although it holds commits, or Alchemy adopted it rather than
   * created it. Without this, those stop the delete with `Stackit.Git.RepositoryDeleteRefused`, and
   * a change that replaces the repository fails at plan. Deploy it on its own first: an old
   * repository keeps the props it was deployed with.
   *
   * @default false
   */
  forceDestroy?: boolean;
}

export interface RepositoryAttributes {
  /** Forgejo's id of the repository. Stable across updates and renames. */
  repositoryId: number;
  /** Name of the repository. */
  repositoryName: string;
  /** The user or organization that owns the repository. */
  owner: string;
  /** `<owner>/<name>`. */
  fullName: string;
  /** URL of the instance. */
  instanceUrl: string;
  /** URL to clone over HTTPS. */
  cloneUrl: string;
  /** URL to clone over SSH. */
  sshUrl: string;
  /** URL of the repository's page. */
  htmlUrl: string;
  /** Default branch. */
  defaultBranch: string;
  /** Whether only the owner and collaborators can see the repository. */
  private: boolean;
  /** Description of the repository. */
  description: string;
  /** Whether the repository is archived. */
  archived: boolean;
  /** Whether Alchemy created the repository, rather than adopting one that was there. */
  createdByAlchemy: boolean;
}

export type Repository = Resource<
  "Stackit.Git.Repository",
  RepositoryProps,
  RepositoryAttributes,
  never,
  Providers
>;

/**
 * A repository on a STACKIT Git instance, managed through the instance's Forgejo REST API.
 *
 * **The machine running `alchemy deploy` has to be inside the instance's `acl`**, since a deploy
 * talks to the instance. Forgejo doesn't take a STACKIT token, so you give a Forgejo access token, or
 * a username and password, such as those of a `Stackit.Git.User` on an instance with local login.
 *
 * Attributes never hold the login. The props do, and Alchemy records props in its state store
 * unencrypted, under a `__redacted__` marker, as it does for every provider's `Redacted` props.
 *
 * A repository holds your work, so Alchemy is careful with it:
 *
 * - A new name renames it in place, keeping its contents.
 * - A delete stops with `Stackit.Git.RepositoryDeleteRefused` if the repository has commits, or
 *   if Alchemy adopted it rather than created it, until `forceDestroy` is deployed. A plan that
 *   would replace such a repository fails with it before anything changes. Commits are Forgejo's
 *   `empty` flag, read just before: issues on a repository with no commits aren't counted.
 * - A repository with another id under the recorded name is someone else's, and is left alone.
 * - Forgejo has no labels on repositories, so one found under an explicit name with no state is
 *   reported as unowned and only taken over with `--adopt`.
 *
 * Replacing a `Stackit.Git.Instance` replaces its repositories. They start empty on the new instance,
 * so a repository holding anything needs its own `forceDestroy` deployed first, as the old instance
 * does. Repositories go with their instance,
 * and listing them takes a login no `alchemy unsafe nuke` has, so there is no `list`.
 *
 * ### Creating a Repository
 * **Example:** A private repository, managed with a technical user
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {
 *   acl: ["203.0.113.7/32"],
 *   featureToggle: { enableLocalLogin: true },
 * });
 * const password = yield* Config.redacted("FORGE_CI_PASSWORD");
 * const user = yield* Stackit.Git.User("Ci", {
 *   instanceId: forge.instanceId,
 *   username: "ci-bot",
 *   email: "ci-bot@example.com",
 *   name: "CI bot",
 *   password,
 * });
 * const repository = yield* Stackit.Git.Repository("App", {
 *   instanceUrl: forge.url,
 *   username: user.username,
 *   password,
 * });
 * // git clone repository.cloneUrl
 * ```
 *
 * **Example:** A named repository in an organization, managed with an access token
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {});
 * const token = yield* Config.redacted("FORGE_TOKEN");
 * const repository = yield* Stackit.Git.Repository("App", {
 *   instanceUrl: forge.url,
 *   token,
 *   owner: "platform",
 *   name: "payments",
 *   description: "Payments service",
 *   autoInit: true,
 * });
 * ```
 *
 * ### Configuring the Repository
 * **Example:** Features and a public page
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {});
 * const token = yield* Config.redacted("FORGE_TOKEN");
 * const repository = yield* Stackit.Git.Repository("Docs", {
 *   instanceUrl: forge.url,
 *   token,
 *   name: "docs",
 *   private: false,
 *   website: "https://docs.example.com",
 *   hasWiki: false,
 *   hasIssues: true,
 *   hasActions: true,
 * });
 * ```
 *
 * ### Reading It at Runtime
 * **Example:** Read the repository from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * // A Worker has no stable egress address.
 * export const Forge = Stackit.Git.Instance("Forge", { acl: ["0.0.0.0/0"] });
 * export const App = Effect.gen(function* () {
 *   const forge = yield* Forge;
 *   const token = yield* Config.redacted("FORGE_READ_TOKEN");
 *   return yield* Stackit.Git.Repository("App", { instanceUrl: forge.url, token });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getRepository = yield* Stackit.Git.GetRepository(yield* App);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const repository = yield* getRepository({});
 *         return yield* HttpServerResponse.json({ empty: repository.empty });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.GetRepositoryHttp)),
 * ) {}
 * ```
 *
 * ### Deleting a Repository
 * **Example:** Allow deleting a repository with commits, or one Alchemy adopted
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {});
 * const token = yield* Config.redacted("FORGE_TOKEN");
 * // Deploy this first, then remove the resource or destroy the stack.
 * const repository = yield* Stackit.Git.Repository("App", {
 *   instanceUrl: forge.url,
 *   token,
 *   forceDestroy: true,
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** A new owner means a new, empty repository
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {});
 * const token = yield* Config.redacted("FORGE_TOKEN");
 * // If the old one has commits, this plan fails and nothing changes. Move the history first,
 * // deploy forceDestroy: true on its own, and then make this change.
 * const repository = yield* Stackit.Git.Repository("App", {
 *   instanceUrl: forge.url,
 *   token,
 *   owner: "platform",
 *   name: "app",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Git
 * @category Git
 */
export const Repository = Resource<Repository>("Stackit.Git.Repository");

/** A delete of a repository holding work this resource didn't write, with nothing opting in. */
export class RepositoryDeleteRefused extends Data.TaggedError(
  "Stackit.Git.RepositoryDeleteRefused",
)<{
  readonly fullName: string;
  readonly reason: "adopted" | "not-empty";
  readonly message: string;
}> {}

/** Another repository holds the name this resource wants. */
export class RepositoryNameTaken extends Data.TaggedError("Stackit.Git.RepositoryNameTaken")<{
  readonly fullName: string;
  readonly message: string;
}> {}

const generatedName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: REPOSITORY_NAME_MAX_LENGTH });

/** Why a delete with no opt-in would stop, if it would. */
const deleteRefusal = (
  output: RepositoryAttributes,
  current: forgejo.Repository,
  remedy: string,
): RepositoryDeleteRefused | undefined => {
  const { fullName } = output;
  if (!output.createdByAlchemy) {
    return new RepositoryDeleteRefused({
      fullName,
      reason: "adopted",
      message: `Alchemy adopted the repository ${fullName} rather than created it, so it won't delete it. ${remedy}`,
    });
  }
  if (!current.empty) {
    return new RepositoryDeleteRefused({
      fullName,
      reason: "not-empty",
      message: `The repository ${fullName} has commits, and deleting it would delete them. ${remedy}`,
    });
  }
  return undefined;
};

/**
 * A replacement ends in the old repository's delete, which sees the props it was deployed with. So
 * nothing can opt in after this point: refuse at plan, where nothing has happened yet.
 */
const refuseReplacement = (olds: RepositoryProps | undefined, output: RepositoryAttributes) =>
  Effect.gen(function* () {
    if (olds?.forceDestroy === true) return;
    // No login recorded: the delete reports that, and a plan has no way to look.
    if (olds?.token === undefined && olds?.password === undefined) return;
    yield* withForgejo(
      output.instanceUrl,
      olds,
      Effect.gen(function* () {
        const current = yield* getRepositoryOrUndefined(output.owner, output.repositoryName);
        if (current === undefined || current.id !== output.repositoryId) return;
        const refusal = deleteRefusal(
          output,
          current,
          "This change replaces the repository, so nothing was changed. Deploy forceDestroy: true on its own first, then make this change.",
        );
        if (refusal !== undefined) return yield* refusal;
      }),
    );
  });

const currentLogin = () => forgejo.getCurrentUser({}).pipe(Effect.map((user) => user.login));

const toAttrs = (
  instanceUrl: string,
  owner: string,
  repository: forgejo.Repository,
  createdByAlchemy: boolean,
): RepositoryAttributes => ({
  repositoryId: repository.id,
  repositoryName: repository.name,
  owner,
  fullName: repository.full_name,
  instanceUrl,
  cloneUrl: repository.clone_url,
  sshUrl: repository.ssh_url,
  htmlUrl: repository.html_url,
  defaultBranch: repository.default_branch,
  private: repository.private,
  description: repository.description,
  archived: repository.archived,
  createdByAlchemy,
});

/** What a PATCH has to send, diffed against the observed repository. */
const repositoryDelta = (repository: forgejo.Repository, news: RepositoryProps, name: string) => {
  const drifted = <A>(desired: A | undefined, observed: A | undefined) =>
    desired !== undefined && desired !== observed;
  return {
    ...(repository.name !== name ? { name } : {}),
    ...(drifted(news.description, repository.description) ? { description: news.description } : {}),
    ...(drifted(news.private, repository.private) ? { private: news.private } : {}),
    ...(drifted(news.defaultBranch, repository.default_branch)
      ? { default_branch: news.defaultBranch }
      : {}),
    ...(drifted(news.template, repository.template) ? { template: news.template } : {}),
    ...(drifted(news.website, repository.website) ? { website: news.website } : {}),
    ...(drifted(news.hasIssues, repository.has_issues) ? { has_issues: news.hasIssues } : {}),
    ...(drifted(news.hasWiki, repository.has_wiki) ? { has_wiki: news.hasWiki } : {}),
    ...(drifted(news.hasPullRequests, repository.has_pull_requests)
      ? { has_pull_requests: news.hasPullRequests }
      : {}),
    ...(drifted(news.hasActions, repository.has_actions) ? { has_actions: news.hasActions } : {}),
    ...(drifted(news.archived, repository.archived) ? { archived: news.archived } : {}),
  };
};

export const RepositoryProvider = () =>
  Provider.succeed(Repository, {
    stables: ["repositoryId", "owner", "instanceUrl", "createdByAlchemy"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved value can resolve to the place the repository already is, and an explicit
      // name can't exist twice there. A generated name carries the generation, so it never collides.
      if (hasUnresolvedTrigger<RepositoryProps>(news, ["instanceUrl", "owner"])) {
        yield* refuseReplacement(olds, output);
        return {
          action: "replace",
          deleteFirst: rawProp<RepositoryProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<RepositoryProps>(news);
      if (
        !sameInstanceUrl(resolved.instanceUrl, output.instanceUrl) ||
        (resolved.owner !== undefined && resolved.owner !== output.owner)
      ) {
        yield* refuseReplacement(olds, output);
        return { action: "replace", deleteFirst: false } as const;
      }
      // A `Redacted` serializes to a fixed marker, so the engine's default comparison can't see a
      // new login, and a later delete would sign in with the old one.
      const token = rawProp<RepositoryProps>(news, "token");
      const password = rawProp<RepositoryProps>(news, "password");
      if (
        isResolved(token) &&
        isResolved(password) &&
        olds !== undefined &&
        secretsDiffer({ token, password }, { token: olds.token, password: olds.password })
      ) {
        return { action: "update" } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const instanceUrl = output?.instanceUrl ?? olds?.instanceUrl;
      // Nothing says where to look, or how to sign in. A row with state keeps what it recorded.
      if (instanceUrl === undefined) return output;
      if (olds?.token === undefined && olds?.password === undefined) return output;
      return yield* withForgejo(
        instanceUrl,
        olds,
        Effect.gen(function* () {
          const owner = output?.owner ?? olds?.owner ?? (yield* currentLogin());
          const name = output?.repositoryName ?? olds?.name ?? (yield* generatedName(id));
          const repository = yield* getRepositoryOrUndefined(owner, name);
          if (repository === undefined) return undefined;
          if (output?.repositoryId === repository.id) {
            return toAttrs(instanceUrl, owner, repository, output.createdByAlchemy);
          }
          // A generated name carries this generation: a create that crashed before state.
          if (output === undefined && olds?.name === undefined) {
            return toAttrs(instanceUrl, owner, repository, true);
          }
          if (
            previous?.repositoryId === repository.id &&
            previous.owner === owner &&
            sameInstanceUrl(previous.instanceUrl, instanceUrl)
          ) {
            return toAttrs(instanceUrl, owner, repository, previous.createdByAlchemy);
          }
          return Unowned(toAttrs(instanceUrl, owner, repository, false));
        }),
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { instanceUrl } = news;
      return yield* withForgejo(
        instanceUrl,
        news,
        Effect.gen(function* () {
          // `output` only says where the repository is while it is on this instance.
          const deployed =
            output !== undefined && sameInstanceUrl(output.instanceUrl, instanceUrl)
              ? output
              : undefined;
          const owner = news.owner ?? deployed?.owner ?? (yield* currentLogin());
          const generated = news.name === undefined && output === undefined;
          const name = news.name ?? output?.repositoryName ?? (yield* generatedName(id));
          const fullName = `${owner}/${name}`;
          const recorded = deployed?.owner === owner ? deployed : undefined;

          // 1. Observe — `output` is a cache: it only names our repository while the id matches.
          const isOurs = (repository: forgejo.Repository) =>
            repository.id === recorded?.repositoryId;
          const atRecordedName =
            recorded !== undefined
              ? yield* getRepositoryOrUndefined(owner, recorded.repositoryName)
              : undefined;
          let current =
            atRecordedName !== undefined && isOurs(atRecordedName) ? atRecordedName : undefined;
          let createdByAlchemy = recorded?.createdByAlchemy ?? generated;

          /** Whatever holds the wanted name: a rename a crash left, ours by generation, or foreign. */
          const claimAtName = Effect.gen(function* () {
            const found = yield* getRepositoryOrUndefined(owner, name);
            if (found === undefined) return undefined;
            if (isOurs(found) || generated) return found;
            return yield* new RepositoryNameTaken({
              fullName,
              message: `The repository ${fullName} already exists on ${instanceUrl} and isn't the one this stack deployed. Choose another name, or adopt it with --adopt.`,
            });
          });
          current ??= yield* claimAtName;

          // 2. Ensure — a 409 may be our own create racing, so look again before failing.
          if (current === undefined) {
            const options = {
              name,
              private: news.private ?? true,
              ...(news.autoInit !== undefined ? { auto_init: news.autoInit } : {}),
              ...(news.description !== undefined ? { description: news.description } : {}),
              ...(news.defaultBranch !== undefined ? { default_branch: news.defaultBranch } : {}),
              ...(news.template !== undefined ? { template: news.template } : {}),
            };
            // Forgejo creates under a user and under an organization on different routes.
            const login = yield* currentLogin();
            const create: Effect.Effect<
              forgejo.Repository,
              forgejo.CreateCurrentUserRepositoryError | forgejo.CreateOrgRepositoryError,
              forgejo.ForgejoOpContext
            > =
              login === owner
                ? forgejo.createCurrentUserRepository(options)
                : forgejo.createOrgRepository({ org: owner, ...options });
            current = yield* create.pipe(
              Effect.catchTag("Conflict", (error) =>
                claimAtName.pipe(
                  Effect.flatMap((found) =>
                    found === undefined ? Effect.fail(error) : Effect.succeed(found),
                  ),
                ),
              ),
            );
            createdByAlchemy = true;
          }

          // 3. Sync — against the observed repository; a new name is a rename.
          const delta = repositoryDelta(current, news, name);
          if (Object.keys(delta).length > 0) {
            current = yield* forgejo.updateRepository({
              owner,
              repo: current.name,
              ...delta,
            });
          }

          // 4. Return
          return toAttrs(instanceUrl, owner, current, createdByAlchemy);
        }),
      );
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const { instanceUrl, owner, repositoryName, repositoryId } = output;
      yield* withForgejo(
        instanceUrl,
        olds,
        Effect.gen(function* () {
          const current = yield* getRepositoryOrUndefined(owner, repositoryName);
          // Gone, or someone else's repository under the same name.
          if (current === undefined || current.id !== repositoryId) return;
          if (olds?.forceDestroy !== true && force !== true) {
            const refusal = deleteRefusal(
              output,
              current,
              "Deploy it with forceDestroy: true to allow this. A repository already being replaced keeps the props it was deployed with, so only deleting it by hand finishes that replacement.",
            );
            if (refusal !== undefined) return yield* refusal;
          }
          yield* forgejo
            .deleteRepository({ owner, repo: repositoryName })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      );
    }),
  });
