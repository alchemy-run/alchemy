/**
 * A coding-agent harness in a container, kept working across container
 * restarts by the Durable Object that owns it:
 *
 * - Every session's events are mirrored into the Durable Object's storage as
 *   they happen, so history (`list`, `events`) is served from there whether
 *   the container is running, asleep, or gone.
 * - After every turn the workspace (a git repository: its working tree,
 *   uncommitted and untracked changes included, and its local branches) and
 *   the harnesses' own session files are checkpointed into the Durable
 *   Object — incremental git bundles and a tarball in its SQLite. This is the
 *   durable copy: any container, on any image, can be restored from it.
 * - Snapshots are a cache on top: the container is snapshotted when it shuts
 *   down, and a `prepare`d workspace is snapshotted once per image (by one
 *   designated instance of the Durable Object class) so new sessions don't
 *   rebuild it. A snapshot only restores onto the image it was taken from.
 *
 * A container that dies without warning (crash, host failure) loses only
 * the turn in progress: it restarts from a snapshot and the latest
 * checkpoint.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  type Harness as AIHarness,
  type Session,
  SessionError,
  type SessionEvent,
  type SessionEventInput,
  SessionInfo,
  StartSession,
} from "../../AI/Session.ts";
import { connectHarness } from "../../AI/SessionRpcs.ts";
import { SessionStore } from "../../AI/SessionStore.ts";
import { EGRESS_CA, EGRESS_CA_BUNDLE } from "../../Runtime/Bootstrap/EgressCa.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { toHttpClient } from "../Fetcher.ts";
import { callInstance, registerInternal } from "../Workers/DurableObjectInternal.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { DurableSessionStore } from "../Workers/DurableSessionStore.ts";
import type { Container } from "./Container.ts";
import type { ContainerApplication } from "./ContainerApplication.ts";
import type {
  ContainerClient,
  ContainerExecOptions,
  ContainerStartOptions,
} from "./ContainerClient.ts";
import { type Egress, makeEgress } from "./Egress.ts";

/** The host the container calls when it is told to shut down. */
export const HARNESS_CONTROL_HOST = "alchemy.internal";

/** Env that makes the container report its `SIGTERM` (see Runtime/Bootstrap/ShutdownSnapshot.ts). */
export const SNAPSHOT_ON_SHUTDOWN = "ALCHEMY_SNAPSHOT_ON_SHUTDOWN";

export interface HarnessOptions {
  /** The container port the harness serves `AI.HarnessRpcs` on. @default 3000 */
  readonly port?: number;
  /**
   * The git repository sessions work in. After every turn its working tree
   * (uncommitted and untracked changes included; ignored files such as
   * `node_modules` not) and local branches are checkpointed into this
   * Durable Object, and restored into whichever container runs next.
   */
  readonly workspace?: string;
  /**
   * Directories saved whole with every checkpoint: the harnesses' own
   * session files, so conversations resume.
   * @default ["~/.claude/projects", "~/.codex/sessions", "~/.local/share/opencode"]
   */
  readonly state?: ReadonlyArray<string>;
  /**
   * Builds the workspace once per image: `commands` run (with `sh -c`, in
   * order) in a fresh container, which is then snapshotted. Every session's
   * container starts from that snapshot — a build cache; each session's own
   * work comes from its checkpoints.
   */
  readonly prepare?: HarnessPrepare;
}

/** How `Harness` builds the workspace a session starts from. */
export interface HarnessPrepare {
  /** Shell commands, e.g. `git clone …` and `pnpm install`. */
  readonly commands: ReadonlyArray<string>;
  /** Egress for the build (e.g. `GitHub.Egress` to clone a private repository). */
  readonly egress?: ReadonlyArray<Egress>;
  /** Let the build reach hosts outside its egress (e.g. a package registry). @default false */
  readonly enableInternet?: boolean;
  /** The instance type to build on. */
  readonly instance?: ContainerStartOptions["instance"];
}

/**
 * The instances of the Durable Object class that build and keep prepared
 * snapshots: one per image and command set (`<prefix>:<hash>`), so changing
 * either reaches a fresh instance running the current code.
 */
export const PREPARE_INSTANCE = "~alchemy-harness-prepare";

/** Identifies a prepared snapshot: the image it's built on and the commands. */
const preparedHash = (prepare: HarnessPrepare, image: string) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${image}\n${JSON.stringify(prepare.commands)}`),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
  });

const DEFAULT_STATE = ["~/.claude/projects", "~/.codex/sessions", "~/.local/share/opencode"];

/** Checkpoints chained before the next one is written whole. */
const MAX_BUNDLE_CHAIN = 20;

/** SQLite values are capped at 2 MB; blobs are stored in parts. */
const BLOB_PART = 1_000_000;

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "alchemy",
  GIT_AUTHOR_EMAIL: "alchemy@localhost",
  GIT_COMMITTER_NAME: "alchemy",
  GIT_COMMITTER_EMAIL: "alchemy@localhost",
  // Fixed dates: an unchanged workspace checkpoints to the same commit.
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_DATE: "@0 +0000",
};

/**
 * Commit the working tree (through a scratch index, leaving the agent's
 * index alone) as `refs/alchemy/checkpoint`, then print every local branch
 * and the checkpoint as `<sha> <ref>` lines. Exits 3 when $WS is not a git
 * work tree.
 */
const CHECKPOINT_SCRIPT = `set -e
cd "$WS" 2>/dev/null || exit 3
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3
idx=$(mktemp)
trap 'rm -f "$idx"' EXIT
export GIT_INDEX_FILE="$idx"
head=$(git rev-parse -q --verify HEAD || true)
if [ -n "$head" ]; then git read-tree "$head"; fi
git add -A
tree=$(git write-tree)
branch=$(git symbolic-ref -q --short HEAD || true)
commit=$(printf 'alchemy checkpoint\n\nbranch: %s\n' "$branch" | git commit-tree "$tree" \${head:+-p "$head"})
git update-ref refs/alchemy/checkpoint "$commit"
git for-each-ref --format='%(objectname) %(refname)' refs/heads refs/alchemy/checkpoint`;

/**
 * Bundle the objects behind the checkpoint and local branches that the
 * restore base doesn't have: not the remote-tracking history (the prepared
 * workspace has it, or it's fetched again), nor what $EXCLUDE (the previous
 * checkpoint's refs) already covered. Exits 4 when there's nothing new.
 */
const BUNDLE_SCRIPT = `set -e
cd "$WS"
ex=""
for sha in $EXCLUDE; do
  if git cat-file -e "$sha^{commit}" 2>/dev/null; then ex="$ex ^$sha"; fi
done
out=$(mktemp)
trap 'rm -f "$out" "$out.err"' EXIT
if ! git bundle create "$out" refs/alchemy/checkpoint --branches $ex --not --remotes 2>"$out.err"; then
  if grep -q "empty bundle" "$out.err"; then exit 4; fi
  cat "$out.err" >&2
  exit 1
fi
cat "$out"`;

/**
 * Restore a checkpoint: fetch its bundles (fetching any prerequisite the
 * base lacks from origin), set the local branches ($REFS), point HEAD where
 * it was, and make the working tree the checkpoint's — the index matches
 * HEAD again, so uncommitted changes show as uncommitted.
 */
const RESTORE_SCRIPT = `set -e
cd "$WS"
for b in $BUNDLES; do
  missing=$(git bundle verify "$b" 2>&1 >/dev/null | grep -oE '[0-9a-f]{40}' || true)
  if [ -n "$missing" ]; then git fetch -q --depth=1 origin $missing || true; fi
  git fetch -q "$b" '+refs/*:refs/alchemy/restore/*'
done
printf '%s\n' "$REFS" | while read -r sha ref; do
  if [ -n "$ref" ]; then git update-ref "$ref" "$sha"; fi
done
ckpt=$(git rev-parse refs/alchemy/checkpoint)
branch=$(git log -1 --format=%b "$ckpt" | sed -n 's/^branch: //p')
if [ -n "$branch" ]; then
  git symbolic-ref HEAD "refs/heads/$branch"
elif parent=$(git rev-parse -q --verify "$ckpt^"); then
  git update-ref --no-deref HEAD "$parent"
fi
git read-tree --reset -u "$ckpt"
git reset -q
git for-each-ref --format='delete %(refname)' refs/alchemy/restore | git update-ref --stdin
rm -f $BUNDLES`;

/** The bundle commands run by the harness trust (system roots plus the egress CA). */
const EXEC_CA_BUNDLE = `${EGRESS_CA_BUNDLE}.exec`;

/**
 * Commands run with `exec` don't inherit the container program's
 * environment: trust the egress interception CA here too (see
 * Runtime/Bootstrap/EgressCa.ts). The platform writes the CA shortly after
 * the container starts with egress, so wait for it when egress is set
 * ($ALCHEMY_EXPECT_EGRESS_CA).
 */
const TRUST_EGRESS_CA = `if [ -n "$ALCHEMY_EXPECT_EGRESS_CA" ]; then
  i=0
  while [ ! -s ${EGRESS_CA} ] && [ $i -lt 60 ]; do sleep 0.5; i=$((i + 1)); done
fi
if [ -s ${EGRESS_CA} ]; then
  for roots in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do
    if [ -f "$roots" ]; then cat "$roots" > ${EXEC_CA_BUNDLE}; break; fi
  done
  cat ${EGRESS_CA} >> ${EXEC_CA_BUNDLE}
  export SSL_CERT_FILE=${EXEC_CA_BUNDLE} GIT_SSL_CAINFO=${EXEC_CA_BUNDLE} NODE_EXTRA_CA_CERTS=${EXEC_CA_BUNDLE} REQUESTS_CA_BUNDLE=${EXEC_CA_BUNDLE} CURL_CA_BUNDLE=${EXEC_CA_BUNDLE}
fi
`;

/** A tarball (to stdout) of the state directories that exist. */
const stateTarScript = (paths: ReadonlyArray<string>) => `set -e
list=""
for p in ${paths.map((p) => p.replace(/^~/, "$HOME")).join(" ")}; do
  if [ -e "$p" ]; then list="$list \${p#/}"; fi
done
if [ -z "$list" ]; then exit 0; fi
cd /
tar -czf - $list`;

interface CheckpointMeta {
  /** Bumped by every checkpoint. */
  readonly seq: number;
  /** The first checkpoint of the bundle chain (bundles from here to `seq`). */
  readonly from: number;
  /** `<sha> <ref>` lines: the local branches and the checkpoint commit. */
  readonly refs: ReadonlyArray<string>;
  readonly hasState: boolean;
}

interface SnapshotMeta {
  readonly id: string;
  readonly at: number;
  /** The image it was taken on: snapshots restore only onto it. */
  readonly image?: string;
  /** The checkpoint it already contains. */
  readonly checkpoint?: number;
}

/**
 * The harness of a container owned by this Durable Object. `start` runs it
 * (restoring the container's last snapshot); `list` and `events` read this
 * Durable Object's storage and never need the container.
 */
export interface Harness {
  /**
   * Start the container if it isn't running — restoring its latest snapshot
   * — with these options (its `egress` decides what it can reach), and
   * return its harness. Sessions opened or resumed through it are recorded
   * in this Durable Object.
   */
  readonly start: (
    options?: ContainerStartOptions,
  ) => Effect.Effect<AIHarness, SessionError, RuntimeContext>;
  /** Sessions recorded in this Durable Object, newest first. */
  readonly list: () => Effect.Effect<ReadonlyArray<SessionInfo>, never, RuntimeContext>;
  /** A session's recorded events from `after` onward: replay, then live while it runs. */
  readonly events: (
    sessionId: string,
    options?: { readonly after?: number },
  ) => Stream.Stream<SessionEvent, never, RuntimeContext>;
  /** Snapshot the container's filesystem now. */
  readonly snapshot: () => Effect.Effect<void, SessionError, RuntimeContext>;
  /** Snapshot the container, then stop it. */
  readonly stop: () => Effect.Effect<void, SessionError, RuntimeContext>;
}

const decodeInfo = Schema.decodeUnknownSync(SessionInfo);
const decodeStart = Schema.decodeUnknownSync(StartSession);

/** A snapshot taken this recently already covers a shutdown request. */
const RECENT_SNAPSHOT_MS = 5_000;

/**
 * A coding-agent harness in a container, kept working across restarts: its
 * sessions' history lives in this Durable Object, and the container's
 * filesystem is snapshotted when it shuts down and restored when it starts
 * again. Declare it at the top of the Durable Object that owns the
 * container; its program serves the harness (e.g. `{ fetch: claude.fetch }`).
 *
 * Snapshots need the container's `schedulingPolicy: "durable_object"`;
 * without it, history is still kept but the filesystem starts fresh.
 *
 * ### Running sessions that survive restarts
 * **Example:** A Durable Object with many sessions
 * ```typescript
 * export class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agent",
 *   Effect.gen(function* () {
 *     const model = yield* Anthropic.Egress(Sandbox, {
 *       apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
 *     });
 *     const harness = yield* Cloudflare.Containers.Harness(Sandbox);
 *
 *     return Effect.gen(function* () {
 *       const live = harness.start({ egress: [model] });
 *       return {
 *         open: () =>
 *           live.pipe(
 *             Effect.flatMap((claude) => claude.start({})),
 *             Effect.map((session) => session.id),
 *           ),
 *         prompt: (session: string, prompt: string) =>
 *           live.pipe(
 *             Effect.flatMap((claude) => claude.get(session)),
 *             Effect.flatMap((s) => s.prompt(prompt)),
 *           ),
 *         list: () => harness.list(),
 *         events: (session: string, after?: number) => harness.events(session, { after }),
 *         stop: () => harness.stop(),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @binding
 * @product Containers
 * @category Containers
 */
export const Harness = (
  container: Container.Decl.Any,
  options: HarnessOptions = {},
): Effect.Effect<Harness, never, DurableObjectState> =>
  Effect.gen(function* () {
    // Deploy: the container reports its SIGTERM to this object.
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const application = (yield* (
        container as unknown as { Application: Effect.Effect<ContainerApplication> }
      ).Application) as ContainerApplication;
      yield* application.bind`Harness`({ env: { [SNAPSHOT_ON_SHUTDOWN]: "1" } });
    }
    const sandbox =
      (yield* container as unknown as Effect.Effect<ContainerClient>) as ContainerClient;
    const state = yield* DurableObjectState;
    const port = options.port ?? 3000;

    //#region storage

    const sql = state.storage.sql;
    let ready = false;
    const ensureTables = Effect.suspend(() => {
      if (ready) return Effect.void;
      ready = true;
      return Effect.all([
        sql.exec(
          "CREATE TABLE IF NOT EXISTS alchemy_harness_sessions (id TEXT PRIMARY KEY, start TEXT NOT NULL, info TEXT, container_cursor INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
        ),
        sql.exec(
          "CREATE TABLE IF NOT EXISTS alchemy_harness_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        ),
        sql.exec(
          "CREATE TABLE IF NOT EXISTS alchemy_harness_blobs (name TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (name, part))",
        ),
      ]).pipe(Effect.asVoid);
    });
    const run = <A>(effect: Effect.Effect<A, never, RuntimeContext>) =>
      Effect.andThen(ensureTables, effect);

    const getMeta = (key: string) =>
      run(
        Effect.flatMap(
          sql.exec<{ value: string }>("SELECT value FROM alchemy_harness_meta WHERE key = ?", key),
          (cursor) => cursor.toArray(),
        ),
      ).pipe(Effect.map((rows) => rows[0]?.value));
    const setMeta = (key: string, value: string) =>
      run(
        sql
          .exec(
            "INSERT INTO alchemy_harness_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            key,
            value,
          )
          .pipe(Effect.asVoid),
      );

    const getJson = <A>(key: string) =>
      Effect.map(getMeta(key), (value) =>
        value === undefined ? undefined : (JSON.parse(value) as A),
      );
    const setJson = (key: string, value: unknown) => setMeta(key, JSON.stringify(value));

    const putBlob = (name: string, data: Uint8Array) =>
      run(
        Effect.gen(function* () {
          yield* sql.exec("DELETE FROM alchemy_harness_blobs WHERE name = ?", name);
          for (let part = 0; part * BLOB_PART < data.length || part === 0; part++) {
            yield* sql.exec(
              "INSERT INTO alchemy_harness_blobs (name, part, data) VALUES (?, ?, ?)",
              name,
              part,
              data.slice(part * BLOB_PART, (part + 1) * BLOB_PART).buffer,
            );
          }
        }),
      );
    const getBlob = (name: string) =>
      run(
        Effect.flatMap(
          sql.exec<{ data: ArrayBuffer }>(
            "SELECT data FROM alchemy_harness_blobs WHERE name = ? ORDER BY part",
            name,
          ),
          (cursor) => cursor.toArray(),
        ),
      ).pipe(
        Effect.map((rows) => {
          if (rows.length === 0) return undefined;
          const parts = rows.map((row) => new Uint8Array(row.data));
          const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
          let offset = 0;
          for (const part of parts) {
            out.set(part, offset);
            offset += part.length;
          }
          return out;
        }),
      );
    const deleteBlobs = (prefix: string) =>
      run(
        sql
          .exec("DELETE FROM alchemy_harness_blobs WHERE name LIKE ?", `${prefix}%`)
          .pipe(Effect.asVoid),
      );

    type SessionRow = {
      id: string;
      start: string;
      info: string | null;
      container_cursor: number;
      generation: number;
    };
    const getSession = (id: string) =>
      run(
        Effect.flatMap(
          sql.exec<SessionRow>("SELECT * FROM alchemy_harness_sessions WHERE id = ?", id),
          (cursor) => cursor.toArray(),
        ),
      ).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));
    const recordSession = (id: string, start: StartSession) =>
      run(
        sql
          .exec(
            "INSERT INTO alchemy_harness_sessions (id, start, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
            id,
            JSON.stringify(start),
            Date.now(),
          )
          .pipe(Effect.asVoid),
      );
    const updateSession = (
      id: string,
      fields: {
        readonly info?: SessionInfo;
        readonly cursor?: number;
        readonly generation?: number;
      },
    ) =>
      run(
        Effect.all([
          fields.info === undefined
            ? Effect.void
            : sql.exec(
                "UPDATE alchemy_harness_sessions SET info = ? WHERE id = ?",
                JSON.stringify(fields.info),
                id,
              ),
          fields.cursor === undefined
            ? Effect.void
            : sql.exec(
                "UPDATE alchemy_harness_sessions SET container_cursor = ?, generation = ? WHERE id = ?",
                fields.cursor,
                fields.generation ?? 0,
                id,
              ),
        ]).pipe(Effect.asVoid),
      );

    // The event log: this Durable Object's SQLite, stamped with its own
    // cursors (a restarted container counts from 1 again).
    const store = yield* SessionStore.pipe(Effect.provide(DurableSessionStore));

    //#endregion

    //#region running commands in the container

    /** Whether the running container has egress (so its CA will appear). */
    let expectEgressCa = false;

    const sh = (
      script: string,
      execOptions: {
        readonly env?: Record<string, string>;
        readonly stdin?: Uint8Array;
      } = {},
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const stdin = execOptions.stdin;
          const child = yield* sandbox.exec(["sh", "-c", `${TRUST_EGRESS_CA}${script}`], {
            env: {
              ...GIT_IDENTITY,
              ...(expectEgressCa ? { ALCHEMY_EXPECT_EGRESS_CA: "1" } : {}),
              ...execOptions.env,
            },
            stdout: "pipe",
            stderr: "pipe",
            ...(stdin ? { stdin: new Blob([stdin as Uint8Array<ArrayBuffer>]).stream() } : {}),
          } as ContainerExecOptions);
          const output = yield* child.output();
          return {
            exitCode: output.exitCode,
            stdout: new Uint8Array(output.stdout),
            stderr: new TextDecoder().decode(output.stderr),
          };
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SessionError({ message: `running in the container failed: ${cause.message}` }),
        ),
      );

    const check = (what: string, result: { readonly exitCode: number; readonly stderr: string }) =>
      result.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new SessionError({
              message: `${what} failed (${result.exitCode}): ${result.stderr.slice(-2000)}`,
            }),
          );

    //#endregion

    //#region checkpoints

    const stateDirs = options.state ?? DEFAULT_STATE;
    let checkpointSeq: number | undefined;

    /** Save the workspace and state directories into this object. */
    const checkpoint = Effect.gen(function* () {
      const previous = yield* getJson<CheckpointMeta>("checkpoint");
      const seq = (previous?.seq ?? 0) + 1;
      let from = previous?.from ?? seq;
      let refs = previous?.refs ?? [];

      if (options.workspace) {
        const computed = yield* sh(CHECKPOINT_SCRIPT, { env: { WS: options.workspace } });
        if (computed.exitCode !== 3) {
          yield* check("checkpointing the workspace", computed);
          const next = new TextDecoder().decode(computed.stdout).split("\n").filter(Boolean).sort();
          if (next.join("\n") !== refs.join("\n")) {
            // A long chain is replaced by one bundle of everything local.
            const whole = previous === undefined || seq - from >= MAX_BUNDLE_CHAIN;
            const bundled = yield* sh(BUNDLE_SCRIPT, {
              env: {
                WS: options.workspace,
                EXCLUDE: whole ? "" : refs.map((line) => line.split(" ")[0]).join(" "),
              },
            });
            if (bundled.exitCode !== 4) {
              yield* check("bundling the workspace", bundled);
              if (whole) {
                yield* deleteBlobs("bundle:");
                from = seq;
              }
              yield* putBlob(`bundle:${seq}`, bundled.stdout);
            }
            refs = next;
          }
        }
      }

      const tar = yield* sh(stateTarScript(stateDirs));
      yield* check("saving the harness state", tar);
      const hasState = tar.stdout.length > 0;
      if (hasState) yield* putBlob("state", tar.stdout);

      yield* setJson("checkpoint", { seq, from, refs, hasState } satisfies CheckpointMeta);
      checkpointSeq = seq;
    });

    /** Apply the latest checkpoint to a container that holds an older one (or none). */
    const restoreCheckpoint = (contains: number) =>
      Effect.gen(function* () {
        const latest = yield* getJson<CheckpointMeta>("checkpoint");
        if (latest === undefined || latest.seq <= contains) return;
        if (options.workspace && latest.refs.length > 0) {
          const bundles: string[] = [];
          for (let seq = latest.from; seq <= latest.seq; seq++) {
            const data = yield* getBlob(`bundle:${seq}`);
            if (data === undefined) continue;
            const path = `/tmp/alchemy-checkpoint-${seq}.bundle`;
            yield* check(
              "copying a checkpoint into the container",
              yield* sh(`cat > ${path}`, { stdin: data }),
            );
            bundles.push(path);
          }
          yield* check(
            "restoring the workspace",
            yield* sh(RESTORE_SCRIPT, {
              env: {
                WS: options.workspace,
                BUNDLES: bundles.join(" "),
                REFS: latest.refs.join("\n"),
              },
            }),
          );
        }
        if (latest.hasState) {
          const data = yield* getBlob("state");
          if (data !== undefined) {
            yield* check(
              "restoring the harness state",
              yield* sh("mkdir -p / && tar -xzf - -C /", { stdin: data }),
            );
          }
        }
        checkpointSeq = latest.seq;
      });

    /** Checkpoint after a turn, in the background; requests during one coalesce. */
    let checkpointing = false;
    let checkpointAgain = false;
    const requestCheckpoint = (scope: Scope.Scope) =>
      Effect.suspend(() => {
        if (checkpointing) {
          checkpointAgain = true;
          return Effect.void;
        }
        checkpointing = true;
        const loop: Effect.Effect<void, never, RuntimeContext> = Effect.suspend(() => {
          checkpointAgain = false;
          return checkpoint.pipe(
            Effect.catchCause((cause) => Effect.logWarning("checkpoint failed", cause)),
            Effect.andThen(Effect.suspend(() => (checkpointAgain ? loop : Effect.void))),
          );
        });
        return loop.pipe(
          Effect.ensuring(Effect.sync(() => (checkpointing = false))),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      });

    //#endregion

    //#region snapshots

    /** The image the running container was started from. */
    let currentImage: string | undefined;
    let lastSnapshotAt = 0;
    const snapshot = Effect.gen(function* () {
      const taken = yield* sandbox.snapshotContainer({ name: `harness-${Date.now()}` }).pipe(
        Effect.mapError(
          (cause) =>
            new SessionError({
              message: `snapshotting the container failed (snapshots need schedulingPolicy "durable_object"): ${cause.message}`,
            }),
        ),
      );
      lastSnapshotAt = Date.now();
      yield* setJson("snapshot", {
        id: taken.id,
        at: lastSnapshotAt,
        image: currentImage,
        checkpoint: checkpointSeq,
      } satisfies SnapshotMeta);
    });

    /** Checkpoint (bounded), then snapshot: the container is going away. */
    const saveBeforeStop = Effect.gen(function* () {
      const saved = yield* Effect.exit(checkpoint.pipe(Effect.timeout("2 minutes")));
      if (Exit.isFailure(saved))
        yield* Effect.logWarning("checkpoint before stopping failed", saved.cause);
      const taken = yield* Effect.exit(snapshot);
      if (Exit.isFailure(taken))
        yield* Effect.logWarning("snapshot before stopping failed", taken.cause);
      return Exit.isSuccess(taken);
    });

    /** The container calls this when it is told to shut down. */
    const control = makeEgress({
      key: "alchemy:harness-control",
      hosts: [HARNESS_CONTROL_HOST],
      handle: (request) =>
        Effect.gen(function* () {
          if (new URL(request.url).pathname !== "/shutdown") {
            return new Response("not found\n", { status: 404 });
          }
          if (Date.now() - lastSnapshotAt < RECENT_SNAPSHOT_MS) return new Response("ok\n");
          return (yield* saveBeforeStop)
            ? new Response("ok\n")
            : new Response("snapshot failed\n", { status: 500 });
        }),
    });

    //#endregion

    //#region the prepared workspace (a build cache, kept by one instance)

    type PreparedStatus =
      | { readonly status: "ready"; readonly id: string }
      | { readonly status: "building" }
      | { readonly status: "failed"; readonly message: string };

    /** Builds in this instance, by key: running, or failed (reported once). */
    const builds = new Map<string, PreparedStatus>();

    /**
     * Run one prepare command detached in the container — writing its output
     * and exit code to files — and poll for the exit code with short calls,
     * so a long command never rides on one long-lived connection.
     */
    const runDetached = (command: string, index: number) =>
      Effect.gen(function* () {
        const log = `/tmp/alchemy-prepare-${index}.log`;
        const exit = `/tmp/alchemy-prepare-${index}.exit`;
        yield* check(
          `prepare: starting ${command}`,
          yield* sh(
            `rm -f ${exit}
if command -v setsid >/dev/null 2>&1; then detach=setsid; else detach=nohup; fi
$detach sh -c 'sh -c "$PREPARE_COMMAND" > ${log} 2>&1; echo $? > ${exit}' </dev/null >/dev/null 2>&1 &`,
            { env: { PREPARE_COMMAND: command } },
          ),
        );
        const code = yield* sh(`cat ${exit} 2>/dev/null`).pipe(
          Effect.map((result) => new TextDecoder().decode(result.stdout).trim()),
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (value) => value !== "",
          }),
          Effect.timeoutOrElse({
            duration: "60 minutes",
            orElse: () =>
              Effect.fail(new SessionError({ message: `prepare: ${command} ran over 60 minutes` })),
          }),
        );
        if (code !== "0") {
          const tail = new TextDecoder().decode((yield* sh(`tail -c 4000 ${log}`)).stdout);
          return yield* new SessionError({
            message: `prepare: ${command} failed (${code}): ${tail}`,
          });
        }
      });

    /** Build the prepared snapshot for `image`. Runs in a prepare instance. */
    const buildPrepared = (prepare: HarnessPrepare, image: string, key: string) =>
      Effect.gen(function* () {
        // A build interrupted earlier may have left its container running.
        yield* sandbox.destroy().pipe(Effect.ignore);
        expectEgressCa = (prepare.egress?.length ?? 0) > 0;
        yield* sandbox
          .start({
            image,
            egress: [...(prepare.egress ?? [])],
            enableInternet: prepare.enableInternet ?? false,
            ...(prepare.instance ? { instance: prepare.instance } : {}),
          } as ContainerStartOptions)
          .pipe(
            Effect.mapError(
              (cause) =>
                new SessionError({
                  message: `starting the prepare container failed: ${String(cause)}`,
                }),
            ),
          );
        for (const [index, command] of prepare.commands.entries()) {
          yield* runDetached(command, index);
        }
        const taken = yield* sandbox.snapshotContainer({ name: "harness-prepared" }).pipe(
          Effect.mapError(
            (cause) =>
              new SessionError({
                message: `snapshotting the prepared workspace failed: ${cause.message}`,
              }),
          ),
        );
        yield* setJson(key, { id: taken.id });
        return taken.id;
      }).pipe(
        // Succeeded or failed, the build container is done.
        Effect.ensuring(sandbox.destroy().pipe(Effect.ignore)),
      );

    /**
     * The prepared snapshot's status, starting its build in the background
     * if needed. Answers at once: callers poll, so no call lasts as long as
     * the build. Runs in a prepare instance.
     */
    const preparedStatus = (prepare: HarnessPrepare, image: string) =>
      Effect.gen(function* () {
        const key = `prepared:${yield* preparedHash(prepare, image)}`;
        const existing = yield* getJson<{ readonly id: string }>(key);
        if (existing) return { status: "ready", id: existing.id } satisfies PreparedStatus;
        const current = builds.get(key);
        if (current?.status === "failed") {
          // Report the failure once; the next request builds again.
          builds.delete(key);
          return current;
        }
        if (current === undefined) {
          builds.set(key, { status: "building" });
          const context = yield* Effect.context<RuntimeContext>();
          void Effect.runPromise(
            buildPrepared(prepare, image, key).pipe(
              Effect.match({
                onSuccess: () => builds.delete(key),
                onFailure: (error) => builds.set(key, { status: "failed", message: error.message }),
              }),
              Effect.provideContext(context),
            ),
          );
        }
        return { status: "building" } satisfies PreparedStatus;
      });

    if (options.prepare && globalThis.__ALCHEMY_RUNTIME__) {
      const prepare = options.prepare;
      registerInternal(state.raw, "harness.prepare", (payload) =>
        preparedStatus(prepare, (payload as { image: string }).image),
      );
    }

    /** The prepared snapshot for `image`, from the instance that keeps it (polling its build). */
    const prepared = (prepare: HarnessPrepare, image: string) =>
      Effect.gen(function* () {
        const hash = yield* preparedHash(prepare, image);
        const ask = callInstance<PreparedStatus>(
          state.raw,
          `${PREPARE_INSTANCE}:${hash}`,
          "harness.prepare",
          { image },
        );
        const status = yield* ask.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (s) => s.status !== "building",
          }),
          Effect.timeoutOrElse({
            duration: "90 minutes",
            orElse: () => Effect.fail(new Error("the prepared workspace took over 90 minutes")),
          }),
        );
        if (status.status === "failed") return yield* Effect.fail(new Error(status.message));
        return { id: (status as { readonly id: string }).id };
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SessionError({ message: `preparing the workspace failed: ${cause.message}` }),
        ),
      );

    //#endregion

    //#region the running harness

    /** Each time the container starts, its sessions and cursors start over. */
    let generation = 0;
    /** The connection to this generation's harness, and what it mirrors. */
    let connection:
      | {
          readonly generation: number;
          readonly scope: Scope.Closeable;
          readonly harness: AIHarness;
          readonly mirrored: Set<string>;
        }
      | undefined;

    const startContainer = (startOptions: ContainerStartOptions | undefined) =>
      Effect.gen(function* () {
        const egress = [...(startOptions?.egress ?? []), control];
        expectEgressCa = true;
        if (yield* sandbox.running.pipe(Effect.orElseSucceed(() => false))) {
          // Running: only the egress may have changed.
          yield* sandbox.start({ ...startOptions, egress });
          if (generation === 0) {
            // A new activation of this object found the container running.
            generation = Number((yield* getMeta("generation")) ?? "1");
            checkpointSeq ??= (yield* getJson<SnapshotMeta>("snapshot"))?.checkpoint;
          }
          return;
        }
        generation = Number((yield* getMeta("generation")) ?? "0") + 1;
        yield* setMeta("generation", String(generation));
        const image = startOptions?.image ?? (yield* sandbox.images).main;
        currentImage = image;
        const { image: _image, ...rest } = startOptions ?? {};
        const startFrom = (snapshotId: string) =>
          Effect.exit(
            sandbox.start({
              ...rest,
              egress,
              containerSnapshot: { id: snapshotId },
            } as ContainerStartOptions),
          );

        // 1. This session's own snapshot — only onto the image it was taken on.
        const own = yield* getJson<SnapshotMeta>("snapshot");
        if (own && own.image !== undefined && own.image === image) {
          const restored = yield* startFrom(own.id);
          if (Exit.isSuccess(restored)) {
            yield* restoreCheckpoint(own.checkpoint ?? 0);
            return;
          }
          yield* Effect.logWarning("restoring the container's snapshot failed", restored.cause);
        }

        // 2. The prepared workspace for this image, then the checkpoints.
        if (options.prepare && image) {
          const base = yield* Effect.exit(prepared(options.prepare, image));
          if (Exit.isSuccess(base)) {
            const restored = yield* startFrom(base.value.id);
            if (Exit.isSuccess(restored)) {
              yield* restoreCheckpoint(0);
              return;
            }
            yield* Effect.logWarning("starting from the prepared workspace failed", restored.cause);
          } else {
            yield* Effect.logWarning("preparing the workspace failed", base.cause);
          }
        }

        // 3. A fresh container, then the checkpoints.
        // TODO(harness-recovery): a session whose container died during a
        // turn has lost that turn's unsaved work (checkpoints are taken
        // between turns). Detect it per session (recorded events past the
        // last checkpoint) and tell the agent, so it can redo the work.
        yield* sandbox.start({ ...startOptions, egress });
        yield* restoreCheckpoint(0);
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionError
            ? cause
            : new SessionError({ message: `starting the container failed: ${String(cause)}` }),
        ),
      );

    const connect = Effect.gen(function* () {
      if (connection && connection.generation === generation) return connection;
      if (connection) yield* Scope.close(connection.scope, Exit.void);
      const scope = yield* Scope.make();
      const tcp = yield* sandbox.getTcpPort(port);
      const harness = yield* connectHarness(toHttpClient(tcp as never)).pipe(Scope.provide(scope));
      connection = { generation, scope, harness, mirrored: new Set() };
      return connection;
    });

    /** Copy a session's events from the container into this object, in the background. */
    const mirror = (current: NonNullable<typeof connection>, session: Session) =>
      Effect.gen(function* () {
        if (current.mirrored.has(session.id)) return;
        current.mirrored.add(session.id);
        const row = yield* getSession(session.id);
        const after = Option.match(row, {
          onNone: () => 0,
          // A new container's cursors start over.
          onSome: (r) => (r.generation === current.generation ? r.container_cursor : 0),
        });
        yield* session.events({ after }).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              const { cursor, sessionId: _sessionId, at: _at, ...input } = event;
              yield* store.append(session.id, input as SessionEventInput);
              yield* updateSession(session.id, { cursor, generation: current.generation });
              if (event.type === "turn.completed") yield* requestCheckpoint(current.scope);
              if (
                event.type === "state" ||
                event.type === "turn.completed" ||
                event.type === "model.changed"
              ) {
                const info = yield* session.info().pipe(Effect.option);
                if (Option.isSome(info)) yield* updateSession(session.id, { info: info.value });
              }
            }),
          ),
          Effect.ignore,
          Effect.ensuring(Effect.sync(() => current.mirrored.delete(session.id))),
          Effect.forkIn(current.scope),
        );
      });

    /** The container's session, wrapped so its history is read from this object. */
    const durableSession = (session: Session): Session => ({
      ...session,
      events: (eventsOptions) => store.read(session.id, eventsOptions),
    });

    const durableHarness = (current: NonNullable<typeof connection>): AIHarness => ({
      name: current.harness.name,
      capabilities: current.harness.capabilities,
      start: (startOptions) =>
        Effect.gen(function* () {
          const id = startOptions?.id ?? crypto.randomUUID();
          const open = { ...startOptions, id };
          yield* recordSession(id, { ...open, prompt: undefined });
          const session = yield* current.harness.start(open);
          yield* mirror(current, session);
          return durableSession(session);
        }),
      get: (id) =>
        Effect.gen(function* () {
          const existing = yield* current.harness.get(id).pipe(Effect.option);
          if (Option.isSome(existing)) {
            yield* mirror(current, existing.value);
            return durableSession(existing.value);
          }
          // Not in this container (it restarted): reopen it from its record —
          // the harness resumes it from the files on disk.
          const row = yield* getSession(id);
          if (Option.isNone(row)) {
            return yield* new SessionError({ sessionId: id, message: `no session ${id}` });
          }
          const session = yield* current.harness.start({
            ...decodeStart(JSON.parse(row.value.start)),
            id,
          });
          yield* mirror(current, session);
          return durableSession(session);
        }),
      list: () => list(),
    });

    //#endregion

    const list = () =>
      run(
        Effect.flatMap(
          sql.exec<{ id: string; info: string | null }>(
            "SELECT id, info FROM alchemy_harness_sessions ORDER BY created_at DESC",
          ),
          (cursor) => cursor.toArray(),
        ),
      ).pipe(
        Effect.map((rows) =>
          rows.flatMap((row) => (row.info ? [decodeInfo(JSON.parse(row.info))] : [])),
        ),
      );

    return {
      start: (startOptions) =>
        startContainer(startOptions).pipe(
          Effect.andThen(connect),
          Effect.map(durableHarness),
          Effect.mapError((cause) =>
            cause instanceof SessionError
              ? cause
              : new SessionError({ message: `connecting to the harness failed: ${String(cause)}` }),
          ),
        ),
      list,
      events: (sessionId, eventsOptions) => store.read(sessionId, eventsOptions),
      snapshot: () => snapshot,
      stop: () =>
        Effect.gen(function* () {
          yield* saveBeforeStop;
          if (connection) {
            yield* Scope.close(connection.scope, Exit.void);
            connection = undefined;
          }
          yield* sandbox.destroy().pipe(Effect.ignore);
        }),
    } satisfies Harness;
  });
