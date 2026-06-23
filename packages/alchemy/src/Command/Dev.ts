import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Hash from "effect/Hash";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { isResolved } from "../Diff.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import * as RpcProvider from "../Local/RpcProvider.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  Command,
  CommandError,
  UnexpectedExit,
  type CommandProps,
} from "./Command.ts";

export interface DevProps extends CommandProps {}

export interface Dev extends Resource<
  "Command.Dev",
  DevProps,
  {
    /**
     * URL extracted from the first matching stdout/stderr line. Best-effort:
     * `undefined` if no URL appears within 5 seconds.
     */
    url: string | undefined;
  }
> {}

export const Dev = Resource<Dev>("Command.Dev");

export const DevProviderLive = () =>
  Provider.succeed(Dev, {
    list: () => Effect.succeed([]),
    reconcile: () => Effect.succeed({ url: undefined }),
    delete: () => Effect.void,
  });

// Matches the first plain http(s) URL. Stops at whitespace and at a small
// set of punctuation typically used to wrap URLs in log output.
const URL_REGEX = /https?:\/\/[^\s)\],"'`]+/;

// ECMA-262 ANSI/VT100 escape sequences — `Vite`, `Next`, etc. surround the
// URL with color codes that would otherwise be eaten by the URL regex.
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

const extractUrl = (text: string) =>
  text.replaceAll(ANSI_REGEX, "").match(URL_REGEX)?.[0];

export const DevProviderLocal = () =>
  RpcProvider.effect(
    Dev,
    import.meta.resolve(
      // See LocalWorkerProvider — must match the on-disk extension of the
      // sidecar entry file.
      import.meta.url.endsWith(".ts") ? "./Local.ts" : "./Local.js",
      import.meta.url,
    ),
    Effect.gen(function* () {
      const { spawn } = yield* Command("Command.Dev");
      const map = yield* FiberMap.make();
      const hashes = new Map<string, number>();
      const scope = yield* Effect.scope;

      const mirror = (
        child: ChildProcessSpawner.ChildProcessHandle,
        sink: "stdout" | "stderr",
      ) =>
        child[sink].pipe(
          Stream.tap((chunk) => Effect.sync(() => process[sink].write(chunk))),
          Stream.runDrain,
          Effect.forkScoped,
        );

      const awaitUrl = (child: ChildProcessSpawner.ChildProcessHandle) =>
        child.stdout.pipe(
          Stream.decodeText,
          Stream.run(Sink.find((text) => !!extractUrl(text))),
          Effect.map(Option.map(extractUrl)),
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.succeedNone,
          }),
          Effect.map(Option.getOrUndefined),
        );

      const awaitError = (child: ChildProcessSpawner.ChildProcessHandle) =>
        child.stderr.pipe(
          Stream.decodeText,
          Stream.runFold(
            () => "",
            (acc, text) => acc + text,
          ),
          Effect.zip(child.exitCode),
          Effect.flatMap(([stderr, exitCode]) =>
            Effect.fail(
              new UnexpectedExit({
                exitCode,
                stderr,
              }),
            ),
          ),
        );

      const spawnAndExtractResult = Effect.fn(function* (
        props: DevProps,
        deferred: Deferred.Deferred<string | undefined, CommandError>,
      ) {
        const child = yield* spawn(props);
        yield* mirror(child, "stdout");
        yield* mirror(child, "stderr");
        yield* Effect.raceAllFirst([awaitUrl(child), awaitError(child)]).pipe(
          Effect.mapError(
            (error) =>
              new CommandError({
                command: props.command,
                reason: error._tag === "UnexpectedExit" ? error : error.reason,
              }),
          ),
          Deferred.into(deferred),
        );
        return yield* child.exitCode;
      }, Scope.provide(scope));

      return {
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ instanceId, news }) {
          if (!isResolved(news)) return undefined;
          const hash = Hash.structure(news);
          if (
            hashes.get(instanceId) === hash &&
            (yield* FiberMap.has(map, instanceId))
          ) {
            return { action: "noop" };
          }
          return { action: "update" };
        }),
        reconcile: Effect.fn(function* ({ instanceId, news }) {
          const hash = Hash.structure(news);
          hashes.set(instanceId, hash);
          const deferred = yield* Deferred.make<
            string | undefined,
            CommandError
          >();
          yield* FiberMap.run(
            map,
            instanceId,
            spawnAndExtractResult(news, deferred),
            { propagateInterruption: true },
          );
          return { url: yield* Deferred.await(deferred) };
        }),
        delete: Effect.fn(function* ({ instanceId }) {
          yield* FiberMap.remove(map, instanceId);
          hashes.delete(instanceId);
        }),
      };
    }),
  );

export const DevProvider = () =>
  ProviderLayer.select({
    live: DevProviderLive,
    local: DevProviderLocal,
  });
