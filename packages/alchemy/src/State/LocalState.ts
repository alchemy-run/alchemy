import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { decodeFqn, encodeFqn, encodeFqnLegacy } from "../FQN.ts";
import { recordStateStoreInit } from "../Telemetry/Metrics.ts";
import { STATE_STORE_VERSION } from "./HttpStateApi.ts";
import {
  State,
  StateStoreError,
  withValidatedNames,
  type StateService,
} from "./State.ts";
import { encodeState, reviveState } from "./StateEncoding.ts";

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
 * The bookkeeping file that stores a stack's resolved output. Lives
 * alongside the resource files in the stage directory, so it must be
 * filtered out of `list` results and shielded from legacy-fqn fallback.
 */
const OUTPUT_FILE = "__stack_output__.json";

export const makeLocalState = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotAlchemy = path.join(process.cwd(), ".alchemy");
    const stateDir = path.join(dotAlchemy, "state");

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

    // The pre-escaping filename for the same fqn. `undefined` when it is
    // identical to the current encoding (nothing to fall back to) or when
    // it would collide with the bookkeeping file (an fqn like
    // `__stack_output__` legacy-encodes to the output file's own name —
    // reading or deleting it as a resource would corrupt the stack output).
    const legacyResource = (request: {
      stack: string;
      stage: string;
      fqn: string;
    }) => {
      const name = `${encodeFqnLegacy(request.fqn)}.json`;
      if (name === OUTPUT_FILE || name === `${encodeFqn(request.fqn)}.json`) {
        return undefined;
      }
      return path.join(stateDir, request.stack, request.stage, name);
    };

    const outputFile = ({ stack, stage }: { stack: string; stage: string }) =>
      path.join(stateDir, stack, stage, OUTPUT_FILE);

    // Write state files atomically: write to a unique sibling temp file, then
    // rename it over the target. Rename within a directory is atomic on POSIX
    // filesystems, so a concurrent `get` (e.g. a parallel test reading shared
    // `.alchemy/state`) never observes a truncated, mid-write file — which
    // would otherwise surface as `JSON.parse("")` → "Unexpected end of JSON
    // input". The temp suffix is unique per process+call so concurrent writers
    // of the same file don't clobber each other's temp.
    const writeAtomic = (file: string, contents: string) =>
      Effect.suspend(() => {
        const tmp = `${file}.${process.pid}.${Math.random()
          .toString(36)
          .slice(2)}.tmp`;
        return fs.writeFileString(tmp, contents).pipe(
          Effect.flatMap(() => fs.rename(tmp, file)),
          Effect.tapError(() => fs.remove(tmp).pipe(Effect.ignore)),
        );
      });

    // Parse a state file, tolerating an empty read. A zero-length file can
    // linger from a write that was interrupted before this atomic-write change
    // (or any non-atomic external writer); treat it as "absent" rather than
    // throwing a JSON parse error that would abort the whole operation.
    const parseState = (contents: string) =>
      contents.trim().length === 0
        ? undefined
        : JSON.parse(contents, reviveState);

    const readState = (file: string) =>
      fs.readFile(file).pipe(
        Effect.map((contents) => parseState(contents.toString())),
        recover,
      );

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
        readState(resource(request)).pipe(
          Effect.flatMap((found) => {
            if (found !== undefined) return Effect.succeed(found);
            // Fall back to the filename written by the legacy (pre-escaping)
            // encoding so state persisted by older versions stays readable.
            const legacy = legacyResource(request);
            return legacy === undefined
              ? Effect.succeed(undefined)
              : readState(legacy);
          }),
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
        ensure(stageDir(request)).pipe(
          Effect.flatMap(() =>
            writeAtomic(
              resource(request),
              JSON.stringify(encodeState(request.value), null, 2),
            ),
          ),
          // Migrate on write: a file left under the legacy encoding for the
          // same fqn would otherwise resurface as a duplicate in `list`.
          Effect.flatMap(() => {
            const legacy = legacyResource(request);
            return legacy === undefined ? Effect.void : fs.remove(legacy);
          }),
          recover,
          Effect.map(() => request.value),
        ),
      delete: (request) =>
        fs.remove(resource(request)).pipe(
          recover,
          Effect.flatMap(() => {
            const legacy = legacyResource(request);
            return legacy === undefined
              ? Effect.void
              : fs.remove(legacy).pipe(recover);
          }),
        ),
      deleteStack: ({ stack, stage }) =>
        Effect.suspend(() => {
          const dir =
            stage === undefined
              ? path.join(stateDir, stack)
              : stageDir({ stack, stage });
          return fs.remove(dir, { recursive: true }).pipe(
            recover,
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
          );
        }),
      list: (request) =>
        fs.readDirectory(stageDir(request)).pipe(
          recover,
          Effect.map((files) =>
            (files ?? [])
              // Only decode committed state files. Exclude:
              //  - the `__stack_output__.json` bookkeeping file — `decodeFqn`
              //    turns `__` into `/`, which would slip the literal name past
              //    a bare-name filter and make the engine look up a
              //    non-existent resource;
              //  - in-flight `*.tmp` files written by `writeAtomic` (and any
              //    other non-`.json` entry), which are not resources.
              .filter((file) => file.endsWith(".json") && file !== OUTPUT_FILE)
              .map((file) => decodeFqn(file.replace(/\.json$/, ""))),
          ),
        ),
      getOutput: (request) =>
        fs.readFile(outputFile(request)).pipe(
          Effect.map((file) => parseState(file.toString())),
          recover,
        ),
      setOutput: (request) =>
        ensure(stageDir(request)).pipe(
          Effect.flatMap(() =>
            writeAtomic(
              outputFile(request),
              JSON.stringify(encodeState(request.value as any), null, 2),
            ),
          ),
          recover,
          Effect.map(() => request.value),
        ),
    };
    return withValidatedNames(state);
  });
