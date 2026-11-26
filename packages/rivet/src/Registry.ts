/**
 * Software for an agentOS VM (`Rivet.SandboxTemplate`'s `software`): the
 * packages agentOS's registry publishes, and packages from a URL.
 *
 * A registry package installs the build listed for the agentOS release the
 * Rivet Services node runs, pinned to its digest when the VM's config is
 * accepted. The names follow agentOS's release manifest
 * (`releases.rivet.dev/agent-os/<release>/software/manifest.json`).
 *
 * ```typescript
 * import * as Registry from "@alchemy.run/rivet/Registry";
 *
 * const base = yield* Rivet.SandboxTemplate("Agent", {
 *   software: [Registry.Git, Registry.Ripgrep, Registry.Jq],
 * });
 * ```
 *
 * @module
 */

/** A package an agentOS VM installs: from agentOS's registry, or from a URL. */
export type Software =
  | {
      /** The registry package's name, such as `git`. */
      readonly registry: string;
      /**
       * The agentOS release whose manifest lists it, such as `0.4.3` or
       * `latest`.
       * @default the release the Rivet Services node runs
       */
      readonly version?: string;
    }
  | {
      /** Where the `.aospkg` package is. */
      readonly url: string;
      /** Its SHA-256 digest, `sha256:…`, checked before it installs. */
      readonly digest?: string;
    };

/** A package from a URL, checked against `digest` when given. */
export const Url = (options: { readonly url: string; readonly digest?: string }): Software =>
  options.digest === undefined
    ? { url: options.url }
    : { url: options.url, digest: options.digest };

/** POSIX access control lists: `getfacl`, `setfacl`. */
export const Acl: Software = { registry: "acl" };

/** Extended attributes: `getfattr`, `setfattr`. */
export const Attr: Software = { registry: "attr" };

/** The Browserbase CLI, for remote browsers. */
export const Browserbase: Software = { registry: "browserbase" };

/** `sh`, `cat`, `ls`, `cp`, `mv`, `rm`, `sort` and 80+ POSIX commands. Installed by default. */
export const Coreutils: Software = { registry: "coreutils" };

/** `curl`, an HTTP(S) client. */
export const Curl: Software = { registry: "curl" };

/** GNU `diff`. Installed by default. */
export const Diffutils: Software = { registry: "diffutils" };

/** The DuckDB analytics database CLI. */
export const DuckDB: Software = { registry: "duckdb" };

/** `envsubst`, environment variable substitution. */
export const Envsubst: Software = { registry: "envsubst" };

/** `fd`, a file finder. */
export const Fd: Software = { registry: "fd" };

/** `file`, file type detection. */
export const File: Software = { registry: "file" };

/** GNU `find` and `xargs`. Installed by default. */
export const Findutils: Software = { registry: "findutils" };

/** GNU `awk`. Installed by default. */
export const Gawk: Software = { registry: "gawk" };

/** `git`, version control. */
export const Git: Software = { registry: "git" };

/** GNU `grep`, `egrep`, `fgrep`. Installed by default. */
export const Grep: Software = { registry: "grep" };

/** `gzip`, `gunzip`, `zcat`. Installed by default. */
export const Gzip: Software = { registry: "gzip" };

/** `jq`, a JSON processor. */
export const Jq: Software = { registry: "jq" };

/** `rg`, recursive search. */
export const Ripgrep: Software = { registry: "ripgrep" };

/** GNU `sed`. Installed by default. */
export const Sed: Software = { registry: "sed" };

/** A POSIX shell. */
export const Sh: Software = { registry: "sh" };

/** The SQLite CLI, `sqlite3`. */
export const Sqlite3: Software = { registry: "sqlite3" };

/** The OpenSSH client, with enforced `known_hosts` checks. */
export const Ssh: Software = { registry: "ssh" };

/** GNU `tar`. Installed by default. */
export const Tar: Software = { registry: "tar" };

/** `tree`, a directory tree display. */
export const Tree: Software = { registry: "tree" };

/** `unzip`, extracts zip archives. */
export const Unzip: Software = { registry: "unzip" };

/** `vim`, with its runtime. */
export const Vim: Software = { registry: "vim" };

/** GNU `wget`, a file downloader. */
export const Wget: Software = { registry: "wget" };

/** `xfs_io`, low-level filesystem I/O. */
export const Xfsprogs: Software = { registry: "xfsprogs" };

/** `yq`, a YAML and JSON processor. */
export const Yq: Software = { registry: "yq" };

/** `zip`, creates zip archives. */
export const Zip: Software = { registry: "zip" };
