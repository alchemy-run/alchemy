import * as Cloudflare from "alchemy/Cloudflare";

/**
 * The single Cloudflare Artifacts namespace that backs every post.
 *
 * Each post (and every fork/reply) owns one Git-compatible repository inside
 * this namespace. Forks branch off their parent's repo via `repo.fork(...)`,
 * so the whole product is one namespace full of related repositories.
 *
 * Namespaces on Cloudflare are implicit — the first repo created against this
 * name conjures it, so there is nothing to provision at deploy time.
 */
export const Repos = Cloudflare.Artifacts("Repos", {
  namespace: "forked-repos",
});
