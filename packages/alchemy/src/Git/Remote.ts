/**
 * The provider-neutral name of a git remote. `Git` is the LOWER layer:
 * provider modules (GitHub, Cloudflare Artifacts, GitLab…) depend on
 * it and DERIVE remotes from their own resource types —
 * `GitHub.remote(repo)` — never the reverse. Anything that can be
 * `git clone`d is representable here.
 */
export interface Remote {
  /** Credential-free clone URL (`https://github.com/owner/repo.git`). */
  readonly url: string;
  /**
   * The default branch, when the deriving provider knows it.
   * @default "main"
   */
  readonly defaultBranch?: string;
}

/** The default branch a {@link Remote} tracks when it declares none. */
export const defaultBranch = (remote: Remote): string =>
  remote.defaultBranch ?? "main";
