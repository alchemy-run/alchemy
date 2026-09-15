import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { existsSync } from "node:fs";
import { decodeFqn, encodeFqn } from "../FQN.ts";
import { recordStateStoreInit } from "../Telemetry/Metrics.ts";
import { writeFileAtomic } from "../Util/AtomicFile.ts";
import { STATE_STORE_VERSION } from "./HttpStateApi.ts";
import { resolveLocalSecretCodec, type SecretCodec } from "./SecretCodec.ts";
import {
  State,
  stateDecodeError,
  StateStoreError,
  type StateService,
} from "./State.ts";
import {
  containsRedacted,
  encodeState,
  hasSecretMarker,
  makeStateReviver,
} from "./StateEncoding.ts";

/**
 * The process's working directory, captured ONCE at module load.
 *
 * The local state tree is anchored here instead of calling `process.cwd()`
 * at store-build time: every state store built in this process — a deploy's
 * and its later destroy's alike — must resolve the SAME `.alchemy/state`
 * tree. A per-build `process.cwd()` read lets any transient working
 * directory change (third-party code sharing the process) point one
 * session's store at a different (empty) tree. A destroy built during such
 * a window lists no state, plans "no changes", and silently leaks every
 * cloud resource of the stack.
 */
const initialCwd = process.cwd();

export const localState = () =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path
      >();

      const make = makeLocalState().pipe(
        recordStateStoreInit,
        Effect.provideContext(context),
      );

      return yield* Effect.cached(make);
    }),
  );

/**
 * Construct the local file-based state store (`.alchemy/state/`).
 *
 * `Redacted` values are encrypted at rest with an auto-generated
 * machine key at `~/.alchemy/state.key` (created on first use). Set
 * `ALCHEMY_PASSWORD` to use a shared password-derived key instead —
 * e.g. to share one state tree across machines.
 */
export const makeLocalState = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    // Local state is encrypted by default: ALCHEMY_PASSWORD when set,
    // otherwise the auto-generated `~/.alchemy/state.key`. Resolved
    // lazily so store construction stays infallible and no key file is
    // created until a secret is actually read or written. Memoized on
    // SUCCESS only — `Effect.cached` would persist a failure (e.g. a
    // transiently unreadable `~/.alchemy`) for the process lifetime.
    const [codecMemo, invalidateCodec] = yield* Effect.cachedInvalidateWithTTL(
      resolveLocalSecretCodec.pipe(
        Effect.mapError(
          (e) =>
            new StateStoreError({
              message: `Failed to initialize the state secret key: ${e.message}`,
              cause: e,
            }),
        ),
        Effect.provideContext(context),
      ),
      Duration.infinity,
    );
    const getCodec = codecMemo.pipe(Effect.tapError(() => invalidateCodec));
    const noCodec = Effect.succeed<SecretCodec | undefined>(undefined);
    const dotAlchemy = path.join(initialCwd, ".alchemy");
    const stateDir = path.join(dotAlchemy, "state");

    const fail = (err: PlatformError) =>
      Effect.fail(
        new StateStoreError({
          message: err.message,
          cause: err,
        }),
      );

    const recover = <T>(
      effect: Effect.Effect<T, PlatformError | StateStoreError, never>,
    ) =>
      effect.pipe(
        Effect.catchTag("PlatformError", (e) =>
          e.reason._tag === "NotFound" ? Effect.void : fail(e),
        ),
      );

    // Directory-level NotFound recovery with a trust-but-verify twist.
    //
    // `list` and `deleteStack` treat a missing stage/stack directory as
    // "no state" — the legitimate shape for a never-deployed (or fully
    // destroyed) stack. But a FALSE NotFound here is catastrophic: a
    // destroy that cannot see its state plans "no changes" and silently
    // leaks every cloud resource of the stack. So before recovering, the
    // async result is cross-checked with a synchronous `existsSync` — a
    // deliberately independent code path (`node:fs`, not the FileSystem
    // service) so a misbehaving async fs answer cannot vouch for itself.
    // If the directory actually exists, fail loudly instead of degrading
    // to an empty listing. A directory cannot legitimately reappear
    // between the two checks: nothing recreates a stage dir concurrently
    // with the session that is listing or deleting it.
    const recoverMissingDir = <T>(
      dir: string,
      effect: Effect.Effect<T, PlatformError, never>,
    ) =>
      effect.pipe(
        Effect.catchTag("PlatformError", (e) => {
          if (e.reason._tag !== "NotFound") return fail(e);
          return Effect.flatMap(
            Effect.sync(() => existsSync(dir)),
            (exists) =>
              exists
                ? Effect.fail(
                    new StateStoreError({
                      message:
                        `state store reported NotFound for '${dir}', but the directory exists — ` +
                        `refusing to treat the stack's state as empty (a destroy acting on this ` +
                        `answer would leak every resource of the stack)`,
                      cause: e,
                    }),
                  )
                : Effect.void,
          );
        }),
      );

    const stageDir = ({ stack, stage }: { stack: string; stage: string }) =>
      path.join(stateDir, stack, stage);

    const resource = ({
      stack,
      stage,
      fqn,
    }: {
      stack: string;
      stage: string;
      fqn: string;
    }) => path.join(stateDir, stack, stage, `${encodeFqn(fqn)}.json`);

    const outputFile = ({ stack, stage }: { stack: string; stage: string }) =>
      path.join(stateDir, stack, stage, `__stack_output__.json`);

    // Write state files atomically so a concurrent `get` (e.g. a parallel
    // test reading shared `.alchemy/state`) never observes a truncated,
    // mid-write file — which would otherwise surface as `JSON.parse("")` →
    // "Unexpected end of JSON input".
    const writeAtomic = (file: string, contents: string) =>
      writeFileAtomic(fs, file, contents);

    // Parse a state file, tolerating an empty read. A zero-length file can
    // linger from a write that was interrupted before this atomic-write change
    // (or any non-atomic external writer); treat it as "absent" rather than
    // throwing a JSON parse error that would abort the whole operation.
    // Decode failures (malformed JSON, wrong state key for `__secret__`
    // envelopes) surface as StateStoreError, not defects. The codec is
    // resolved only when the file carries a `__secret__` marker, so
    // secret-free and legacy state never needs the key file at all —
    // and a codec failure only surfaces when the state genuinely holds
    // an encrypted envelope (the marker gate can false-positive on a
    // plain string containing the marker text).
    const parseState = (contents: string, what: string) => {
      const parse = (codec: SecretCodec | undefined) =>
        Effect.try({
          try: () =>
            contents.trim().length === 0
              ? undefined
              : JSON.parse(contents, makeStateReviver(codec)),
          catch: stateDecodeError(what),
        });
      if (!hasSecretMarker(contents)) return parse(undefined);
      return getCodec.pipe(
        Effect.flatMap(parse),
        Effect.catchTag("StateStoreError", (codecError) =>
          parse(undefined).pipe(Effect.mapError(() => codecError)),
        ),
      );
    };

    const created = new Set<string>();

    const ensure = (dir: string) =>
      created.has(dir)
        ? Effect.succeed(void 0)
        : fs
            .makeDirectory(dir, { recursive: true })
            .pipe(Effect.tap(() => Effect.sync(() => created.add(dir))));

    const state: StateService = {
      id: "local",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () =>
        fs.readDirectory(stateDir).pipe(
          recover,
          Effect.map((files) => files ?? []),
        ),
      listStages: (stack: string) =>
        fs.readDirectory(path.join(stateDir, stack)).pipe(
          recover,
          Effect.map((files) => files ?? []),
        ),
      get: (request) =>
        fs.readFile(resource(request)).pipe(
          Effect.flatMap((file) => parseState(file.toString(), request.fqn)),
          recover,
        ),
      getReplacedResources: Effect.fn(function* (request) {
        return (yield* Effect.all(
          (yield* state.list(request)).map((fqn) =>
            state.get({
              stack: request.stack,
              stage: request.stage,
              fqn,
            }),
          ),
        )).filter((r) => r?.status === "replaced");
      }),
      set: (request) =>
        Effect.all([
          // Secret-free values never need (or create) the key file.
          containsRedacted(request.value) ? getCodec : noCodec,
          ensure(stageDir(request)),
        ]).pipe(
          Effect.flatMap(([codec]) =>
            writeAtomic(
              resource(request),
              JSON.stringify(encodeState(request.value, codec), null, 2),
            ),
          ),
          recover,
          Effect.map(() => request.value),
        ),
      delete: (request) => fs.remove(resource(request)).pipe(recover),
      deleteStack: ({ stack, stage }) =>
        Effect.suspend(() => {
          const dir =
            stage === undefined
              ? path.join(stateDir, stack)
              : stageDir({ stack, stage });
          return fs.remove(dir, { recursive: true }).pipe(
            (eff) => recoverMissingDir(dir, eff),
            // Drop cached `ensure`d directories under the removed tree, or a
            // later `set` for the same (stack, stage) skips makeDirectory and
            // its write fails with NotFound — silently swallowed by `recover`.
            Effect.tap(() =>
              Effect.sync(() => {
                for (const cached of created) {
                  if (cached === dir || cached.startsWith(dir + path.sep)) {
                    created.delete(cached);
                  }
                }
              }),
            ),
            // Deleting the last stage leaves an empty `{stack}/` husk that
            // `listStacks` would keep reporting forever (and durable
            // per-test scratch stacks would accumulate one per test). Prune
            // it when no stages remain. The read-then-remove is not racy:
            // nothing recreates a stage dir concurrently with the session
            // that is deleting it (same invariant as recoverMissingDir).
            Effect.tap(() => {
              if (stage === undefined) return Effect.void;
              const stackDir = path.join(stateDir, stack);
              return fs.readDirectory(stackDir).pipe(
                Effect.flatMap((entries) =>
                  entries.length === 0
                    ? fs
                        .remove(stackDir, { recursive: true })
                        .pipe(
                          Effect.tap(() =>
                            Effect.sync(() => created.delete(stackDir)),
                          ),
                        )
                    : Effect.void,
                ),
                Effect.ignore,
              );
            }),
          );
        }),
      list: (request) =>
        fs.readDirectory(stageDir(request)).pipe(
          (eff) => recoverMissingDir(stageDir(request), eff),
          Effect.map((files) =>
            (files ?? [])
              // Only decode committed state files. Exclude:
              //  - the `__stack_output__.json` bookkeeping file — `decodeFqn`
              //    turns `__` into `/`, which would slip the literal name past
              //    a bare-name filter and make the engine look up a
              //    non-existent resource;
              //  - in-flight `*.tmp` files written by `writeAtomic` (and any
              //    other non-`.json` entry), which are not resources.
              .filter(
                (file) =>
                  file.endsWith(".json") && file !== "__stack_output__.json",
              )
              .map((file) => decodeFqn(file.replace(/\.json$/, ""))),
          ),
        ),
      getOutput: (request) =>
        fs.readFile(outputFile(request)).pipe(
          Effect.flatMap((file) =>
            parseState(file.toString(), "__stack_output__"),
          ),
          recover,
        ),
      setOutput: (request) =>
        Effect.all([
          containsRedacted(request.value) ? getCodec : noCodec,
          ensure(stageDir(request)),
        ]).pipe(
          Effect.flatMap(([codec]) =>
            writeAtomic(
              outputFile(request),
              JSON.stringify(encodeState(request.value as any, codec), null, 2),
            ),
          ),
          recover,
          Effect.map(() => request.value),
        ),
    };
    return state;
  });
