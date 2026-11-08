import { existsSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { dotAlchemyDirectory } from "../AlchemyContext.ts";
import { decodeFqn, encodeFqn } from "../FQN.ts";
import { recordStateStoreInit } from "../Telemetry/Metrics.ts";
import { writeFileAtomic } from "../Util/AtomicFile.ts";
import { initialCwd } from "../Util/Node.ts";
import { STATE_STORE_VERSION } from "./HttpStateApi.ts";
import { State, StateStoreError, type StateService } from "./State.ts";
import { type SealingScope, stateCodec } from "./StateEncryption.ts";
import {
  checkStoreFormat,
  currentStoreFormat,
  parseStoreFormat,
  STORE_FORMAT_FILE,
} from "./StoreFormat.ts";

export const localState = () =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

      const make = makeLocalState().pipe(recordStateStoreInit, Effect.provideContext(context));

      return yield* Effect.cached(make);
    }),
  );

export const makeLocalState = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotAlchemy = yield* dotAlchemyDirectory;
    // Keep the store anchored across deploy/destroy even if another task changes cwd.
    const stateDir = path.resolve(initialCwd, dotAlchemy, "state");
    // Secrets are encrypted when a StateEncryption is provided to the store.
    const codec = yield* stateCodec;

    const fail = (err: PlatformError) =>
      Effect.fail(
        new StateStoreError({
          message: err.message,
          cause: err,
        }),
      );

    const recover = <T>(effect: Effect.Effect<T, PlatformError, never>) =>
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
    const recoverMissingDir = <T>(dir: string, effect: Effect.Effect<T, PlatformError, never>) =>
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

    const resource = ({ stack, stage, fqn }: { stack: string; stage: string; fqn: string }) =>
      path.join(stateDir, stack, stage, `${encodeFqn(fqn)}.json`);

    const outputFile = ({ stack, stage }: { stack: string; stage: string }) =>
      path.join(stateDir, stack, stage, `__stack_output__.json`);

    // Write state files atomically so a concurrent `get` (e.g. a parallel
    // test reading shared `.alchemy/state`) never observes a truncated,
    // mid-write file — which would otherwise surface as `JSON.parse("")` →
    // "Unexpected end of JSON input".
    const writeAtomic = (file: string, contents: string) => writeFileAtomic(fs, file, contents);

    // Parse a state file, tolerating an empty read. A zero-length file can
    // linger from a write that was interrupted before this atomic-write change
    // (or any non-atomic external writer); treat it as "absent" rather than
    // throwing a JSON parse error that would abort the whole operation.
    const parseState = <T>(scope: SealingScope, file: string, contents: string) =>
      contents.trim().length === 0
        ? Effect.undefined
        : codec.decode<T>(scope, contents, `state file '${file}'`);

    const created = new Set<string>();

    const ensure = (dir: string) =>
      created.has(dir)
        ? Effect.void
        : fs
            .makeDirectory(dir, { recursive: true })
            .pipe(Effect.tap(() => Effect.sync(() => created.add(dir))));

    // The store's format record: checked before reading, written before the
    // first write, so a directory this version never wrote to stays as it is.
    const formatFile = path.join(stateDir, STORE_FORMAT_FILE);
    const checkFormat = yield* Effect.cached(
      fs.readFileString(formatFile).pipe(
        recover,
        Effect.flatMap((text) =>
          checkStoreFormat(
            "Local state store",
            text === undefined ? undefined : parseStoreFormat(text)?.format,
          ),
        ),
      ),
    );
    const stampFormat = yield* Effect.cached(
      checkFormat.pipe(
        Effect.andThen(
          ensure(stateDir).pipe(
            Effect.andThen(writeAtomic(formatFile, JSON.stringify(currentStoreFormat(), null, 2))),
            recover,
          ),
        ),
      ),
    );

    /**
     * Read a state file. One the codec calls stale (a secret in plaintext
     * while encrypting, or sealed while turning encryption off) is written
     * again.
     */
    const readState = Effect.fn(function* <T>(scope: SealingScope, file: string, rewrite = true) {
      yield* checkFormat;
      const contents = yield* fs.readFileString(file).pipe(recover);
      if (contents === undefined) return undefined;
      const value = yield* parseState<T>(scope, file, contents);
      if (rewrite && value !== undefined && codec.stale(contents)) {
        const text = yield* codec.encode(scope, value, 2);
        yield* writeAtomic(file, text).pipe(recover);
      }
      return value;
    });

    const state: StateService = {
      id: "local",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () =>
        fs.readDirectory(stateDir).pipe(
          recover,
          Effect.map((files) => (files ?? []).filter((file) => file !== STORE_FORMAT_FILE)),
        ),
      listStages: (stack: string) =>
        fs.readDirectory(path.join(stateDir, stack)).pipe(
          recover,
          Effect.map((files) => files ?? []),
        ),
      get: (request) => readState(request, resource(request)),
      getReplacedResources: Effect.fn(function* (request) {
        return (yield* Effect.forEach(yield* state.list(request), (fqn) =>
          state.get({
            stack: request.stack,
            stage: request.stage,
            fqn,
          }),
        )).filter((r) => r?.status === "replaced");
      }),
      set: (request) =>
        stampFormat.pipe(
          Effect.andThen(codec.encode(request, request.value, 2)),
          Effect.flatMap((text) =>
            ensure(stageDir(request)).pipe(
              Effect.flatMap(() => writeAtomic(resource(request), text)),
              recover,
            ),
          ),
          Effect.map(() => request.value),
        ),
      delete: (request) => fs.remove(resource(request)).pipe(recover),
      deleteStack: ({ stack, stage }) =>
        Effect.suspend(() => {
          const dir = stage === undefined ? path.join(stateDir, stack) : stageDir({ stack, stage });
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
                        .pipe(Effect.tap(() => Effect.sync(() => created.delete(stackDir))))
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
              .filter((file) => file.endsWith(".json") && file !== "__stack_output__.json")
              .map((file) => decodeFqn(file.replace(/\.json$/, ""))),
          ),
        ),
      // Other stacks read an output without the stage's lock, and its own
      // deploy writes it again anyway, so it isn't rewritten here.
      getOutput: (request) => readState(request, outputFile(request), false),
      setOutput: (request) =>
        stampFormat.pipe(
          Effect.andThen(codec.encode(request, request.value, 2)),
          Effect.flatMap((text) =>
            ensure(stageDir(request)).pipe(
              Effect.flatMap(() => writeAtomic(outputFile(request), text)),
              recover,
            ),
          ),
          Effect.map(() => request.value),
        ),
    };
    return state;
  });
