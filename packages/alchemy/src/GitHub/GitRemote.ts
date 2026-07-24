import type * as Git from "../Git/Remote.ts";
import type { Repository, RepositoryProps } from "./Repository.ts";
import { type RepositoryLike, repositoryIdentity } from "./RepositoryLike.ts";

/**
 * GitHub → Git: derive a provider-neutral {@link Git.Remote} from the
 * {@link Repository} resource — the dependency points DOWN (GitHub
 * knows Git; `Git.Workspaces` never knows GitHub). Usable at module
 * scope with the deferred constructor form
 * (`export const repo = GitHub.Repository(…)`). Dies when the
 * repository's identity props are unresolved `Input`s, same doctrine
 * as every GitHub binding.
 */
export const remote = (repo: RepositoryLike): Git.Remote => {
  const identity = repositoryIdentity(repo);
  if (identity === undefined) {
    throw new Error(
      "GitHub.remote needs the repository's identity as plain strings, " +
        "but it was declared with unresolved owner/name inputs",
    );
  }
  const props = (
    repo as { readonly Props?: Partial<RepositoryProps> } as Repository
  ).Props as Partial<RepositoryProps> | undefined;
  return {
    url: `https://github.com/${identity.owner}/${identity.repository}.git`,
    ...(typeof props?.defaultBranch === "string"
      ? { defaultBranch: props.defaultBranch }
      : {}),
  };
};
