/**
 * How GitHub bindings and event constructors accept a repository — the
 * {@link Repository} RESOURCE, in either of its two forms. There is no
 * plain `{ owner, repository }` ref type: the resource is the one way to
 * name a repository, and everything (bindings, event sources, delivery)
 * resolves identity from it.
 */
import * as Effect from "effect/Effect";
import { deferredResourceMeta, isResourceOfType } from "../Resource.ts";
import type { Repository, RepositoryProps } from "./Repository.ts";

/**
 * What a binding or scoped event constructor accepts:
 *
 * - a provisioned (yielded) {@link Repository} resource — resource-first
 *   inside a Stack program;
 * - the **un-yielded constructor Effect** itself
 *   (`export const repo = GitHub.Repository("repo", {...})`) — the
 *   deferred form, usable at module scope before any Stack exists. Its
 *   declared identity (`owner`/`name` props) is readable statically, so
 *   consumers resolve it WITHOUT a Stack; yielding the same exported
 *   const under a Stack resolves the one memoized instance.
 */
export type RepositoryLike = Repository | Effect.Effect<Repository, any, any>;

export const isRepositoryResource = (repo: unknown): repo is Repository =>
  isResourceOfType(repo, "GitHub.Repository");

const identityOfProps = (
  props: unknown,
): { owner: string; repository: string } | undefined => {
  const { owner, name } = (props ?? {}) as Partial<RepositoryProps>;
  return typeof owner === "string" && typeof name === "string"
    ? { owner, repository: name }
    : undefined;
};

/**
 * The repository's declared identity, read SYNCHRONOUSLY where possible
 * — `undefined` only when the value is a non-resource Effect or its
 * identity props are unresolved `Input`s (then only yielding under a
 * Stack can resolve it).
 */
export const repositoryIdentity = (
  repo: RepositoryLike,
): { owner: string; repository: string } | undefined => {
  if (isRepositoryResource(repo)) return identityOfProps(repo.Props);
  const meta = deferredResourceMeta(repo);
  return meta?.Type === "GitHub.Repository"
    ? identityOfProps(meta.Props)
    : undefined;
};

/**
 * THE one resolver every binding impl and consuming Layer uses to turn
 * a {@link RepositoryLike} into the plain `{ owner, repository }` it
 * calls the API and filters deliveries with:
 *
 * - yielded {@link Repository} → identity props (`Props.owner` /
 *   `Props.name`; defect if not plain strings);
 * - deferred constructor Effect → its static
 *   {@link deferredResourceMeta} when the identity props are plain
 *   strings (works OUTSIDE any Stack — a laptop factory process);
 *   otherwise `yield*`s it (legal only under a Stack, where resources
 *   are memoized by FQN — the bindings precedent).
 */
export const resolveRepository = (
  repo: RepositoryLike,
): Effect.Effect<{ owner: string; repository: string }> =>
  Effect.suspend(() => {
    const identity = repositoryIdentity(repo);
    if (identity !== undefined) return Effect.succeed(identity);
    if (!Effect.isEffect(repo)) {
      return Effect.die(
        new Error(
          `GitHub needs the repository's identity as plain strings, but ${String(
            repo,
          )} was declared with unresolved owner/name inputs`,
        ),
      );
    }
    // SAFETY: the deferred form without static identity is only legal
    // where a Stack is ambient (host init phase — the bindings
    // precedent); elsewhere this dies at runtime, by design.
    return Effect.map(repo as Effect.Effect<Repository>, (resolved) => {
      const identity = repositoryIdentity(resolved);
      if (identity === undefined) {
        throw new Error(
          `GitHub needs the repository's identity as plain strings, but ${resolved.FQN} was declared with unresolved owner/name inputs`,
        );
      }
      return identity;
    });
  });
