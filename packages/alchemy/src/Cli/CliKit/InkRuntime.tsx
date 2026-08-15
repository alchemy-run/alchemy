/** @jsxImportSource react */
import { EventEmitter } from "node:events";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import { Box, render, Static } from "ink";
import { type ReactNode, useSyncExternalStore } from "react";
import { Alert, Spinner, Status } from "./components/Feedback.tsx";
import { CliEnvironment, useGlyphs } from "./components/Environment.tsx";
import { useTerminalInput } from "./components/Interactive.tsx";
import { interceptConsole } from "./components/Live.tsx";
import { Heading } from "./components/Layout.tsx";
import { Text } from "./components/Typography.tsx";
import { NonInteractiveTerminal, TerminalCancelled } from "./errors.ts";
import {
  confirmScreen,
  cycleSelectScreen,
  awaitExternalScreen,
  menuScreen,
  multiSelectScreen,
  passwordScreen,
  selectScreen,
  textScreen,
} from "./screens.tsx";
import { theme } from "./theme.ts";
import { applicationPresentation, type CliKitService } from "./CliKit.ts";
import type {
  ProgressHandle,
  ProgressOptions,
  RenderOptions,
  Screen,
  MenuOptions,
  CliKitCapabilities,
  CliKitOptions,
  InteractionError,
  LiveViewHandle,
  LiveViewOptions,
  View,
} from "./types.ts";

const SectionDepth = Context.Reference<number>("Cli/CliKit/SectionDepth", {
  defaultValue: () => 0,
});

const ENTER_ALTERNATE_SCREEN = "\u001B[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\u001B[?1049l";

interface Item {
  readonly key: number;
  readonly depth: number;
  readonly view: View;
  readonly placement?: LiveViewOptions["placement"];
}

const normalizeView = (view: View): View => {
  if (
    typeof view === "string" ||
    typeof view === "number" ||
    typeof view === "bigint"
  ) {
    return <Text>{String(view)}</Text>;
  }
  // Contract: an array of primitives renders as ONE Text line with the
  // elements concatenated (no separator) — matching how React renders
  // adjacent text children. Callers wanting separators must join themselves.
  if (
    Array.isArray(view) &&
    view.every(
      (item) =>
        item === null ||
        item === undefined ||
        typeof item === "boolean" ||
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "bigint",
    )
  ) {
    return (
      <Text>
        {view
          .filter(
            (item) =>
              item !== null && item !== undefined && typeof item !== "boolean",
          )
          .map(String)
          .join("")}
      </Text>
    );
  }
  return view;
};

interface StoreState {
  readonly staticItems: Item[];
  readonly transcript: ReadonlyArray<Item>;
  readonly live: ReadonlyArray<Item>;
  readonly active?: Item;
}

class TerminalStore {
  private state: StoreState = { staticItems: [], transcript: [], live: [] };
  private readonly listeners = new Set<() => void>();
  private nextKey = 0;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly snapshot = () => this.state;

  private commit(state: StoreState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  alloc() {
    return this.nextKey++;
  }

  append(depth: number, view: View) {
    this.commit({
      ...this.state,
      transcript: [
        ...this.state.transcript,
        { key: this.alloc(), depth, view },
      ],
    });
  }

  appendStatic(depth: number, view: View) {
    this.appendStaticBatch([{ depth, view }]);
  }

  appendStaticBatch(items: ReadonlyArray<{ depth: number; view: View }>) {
    if (items.length === 0) return;
    this.commit({
      ...this.state,
      staticItems: [
        ...this.state.staticItems,
        ...items.map(({ depth, view }) => ({
          key: this.alloc(),
          depth,
          view,
        })),
      ],
    });
  }

  setLive(
    key: number,
    depth: number,
    view: View,
    placement: LiveViewOptions["placement"] = "afterTranscript",
  ) {
    const item = { key, depth, view, placement };
    this.commit({
      ...this.state,
      live: this.state.live.some((entry) => entry.key === key)
        ? this.state.live.map((entry) => (entry.key === key ? item : entry))
        : [...this.state.live, item],
    });
  }

  removeLive(key: number) {
    this.commit({
      ...this.state,
      live: this.state.live.filter((entry) => entry.key !== key),
    });
  }

  completeLive(
    key: number,
    destination: "staticItems" | "transcript",
    view?: View,
  ) {
    const item = this.state.live.find((entry) => entry.key === key);
    if (item === undefined) return;
    this.commit({
      ...this.state,
      [destination]: [
        ...this.state[destination],
        {
          ...item,
          key: this.alloc(),
          view: view ?? item.view,
          placement: undefined,
        },
      ],
      live: this.state.live.filter((entry) => entry.key !== key),
    });
  }

  activate(depth: number, view: View) {
    this.commit({
      ...this.state,
      active: { key: this.alloc(), depth, view },
    });
  }

  deactivate() {
    if (this.state.active !== undefined)
      this.commit({ ...this.state, active: undefined });
  }

  clear() {
    this.commit({ ...this.state, transcript: [], live: [] });
  }

  clearStatic() {
    if (this.state.staticItems.length > 0) {
      this.commit({ ...this.state, staticItems: [] });
    }
  }

  clearTranscript() {
    if (this.state.transcript.length > 0) {
      this.commit({ ...this.state, transcript: [] });
    }
  }

  get idle() {
    return this.state.active === undefined && this.state.live.length === 0;
  }
}

/**
 * Always-on Ctrl+C handler wrapped around every screen by `run`. Screens no
 * longer need their own Ctrl+C wiring (a screen that forgot it used to make
 * the CLI unkillable, since Ink runs with `exitOnCtrlC: false` in raw mode);
 * they only handle Escape, whose semantics differ per screen.
 */
const ScreenCancelGuard = ({
  onCancel,
  children,
}: {
  readonly onCancel: () => void;
  readonly children?: ReactNode;
}) => {
  useTerminalInput(
    (input, key) => {
      if (key.ctrl && input === "c") onCancel();
    },
    { active: true },
  );
  return <>{children}</>;
};

const ItemView = ({ item }: { readonly item: Item }) => {
  const glyphs = useGlyphs();
  return (
    <Box paddingLeft={item.depth * 2} gap={1}>
      {item.depth === 0 ? null : (
        <Text color={theme.color.muted}>{glyphs.bar}</Text>
      )}
      <Box flexDirection="column" flexGrow={1}>
        {item.view}
      </Box>
    </Box>
  );
};

const TerminalRoot = ({ store }: { readonly store: TerminalStore }) => {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const beforeTranscript = state.live.filter(
    (item) => item.placement === "beforeTranscript",
  );
  const afterTranscript = state.live.filter(
    (item) => item.placement !== "beforeTranscript",
  );
  return (
    <Box flexDirection="column">
      <Static items={state.staticItems}>
        {(item) => <ItemView key={item.key} item={item} />}
      </Static>
      {beforeTranscript.map((item) => (
        <ItemView key={item.key} item={item} />
      ))}
      {state.transcript.map((item) => (
        <ItemView key={item.key} item={item} />
      ))}
      {afterTranscript.map((item) => (
        <ItemView key={item.key} item={item} />
      ))}
      {state.active === undefined ? null : (
        <Box marginTop={state.transcript.length > 0 ? 1 : 0}>
          <ItemView key={state.active.key} item={state.active} />
        </Box>
      )}
    </Box>
  );
};

const mountCapture = (
  view: ReactNode,
  options: RenderOptions,
  capabilities: CliKitCapabilities,
  onRender?: () => void,
) => {
  let frame = "";
  const stdout = Object.assign(new EventEmitter(), {
    columns: options.columns ?? capabilities.columns,
    rows: capabilities.rows,
    isTTY: options.colors ?? capabilities.colors,
    write(chunk: string) {
      frame = chunk;
      return true;
    },
  });
  const instance = render(
    <CliEnvironment capabilities={capabilities}>{view}</CliEnvironment>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
      onRender,
    },
  );
  return {
    snapshot: () => frame.replace(/[\s\n]+$/, ""),
    unmount: instance.unmount,
  };
};

const captureView = (
  view: ReactNode,
  options: RenderOptions,
  capabilities: CliKitCapabilities,
): string => {
  const capture = mountCapture(view, options, capabilities);
  const snapshot = capture.snapshot();
  capture.unmount();
  return snapshot;
};

const captureViewAsync = (
  view: ReactNode,
  options: RenderOptions,
  capabilities: CliKitCapabilities,
): Promise<string> =>
  new Promise((resolve) => {
    let capture: ReturnType<typeof mountCapture> | undefined;
    let settled = false;
    const finish = () => {
      if (settled) return;
      if (capture === undefined) {
        queueMicrotask(finish);
        return;
      }
      settled = true;
      const snapshot = capture.snapshot();
      capture.unmount();
      resolve(snapshot);
    };
    capture = mountCapture(view, options, capabilities, finish);
  });

export interface CliKitRuntime {
  readonly service: CliKitService;
  readonly dispose: () => Promise<void>;
}

export const makeRuntime = (
  options: CliKitOptions,
  capabilities: CliKitCapabilities,
): CliKitRuntime => {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const store = new TerminalStore();
  const interactionGate = Semaphore.makeUnsafe(1);
  const appGate = Semaphore.makeUnsafe(1);
  let instance: ReturnType<typeof render> | undefined;
  let restoreConsole: (() => void) | undefined;
  let appActive = false;
  let renderRevision = 0;
  const renderWaiters = new Set<{
    readonly after: number;
    readonly resolve: () => void;
  }>();
  let consoleFlushScheduled = false;
  let pendingConsole: Array<{ depth: number; view: View }> = [];

  const flushConsole = (): boolean => {
    consoleFlushScheduled = false;
    if (pendingConsole.length === 0) return false;
    const entries = pendingConsole;
    pendingConsole = [];
    store.appendStaticBatch(entries);
    return true;
  };

  const rendered = () => {
    renderRevision += 1;
    for (const waiter of renderWaiters) {
      if (renderRevision > waiter.after) {
        renderWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  };

  const waitForRenderAfter = (after: number) =>
    renderRevision > after || instance === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          renderWaiters.add({ after, resolve });
        });

  const enqueueConsole = (view: View) => {
    pendingConsole.push({ depth: 0, view });
    if (!consoleFlushScheduled) {
      consoleFlushScheduled = true;
      queueMicrotask(flushConsole);
    }
  };

  const ensureMounted = () => {
    if (instance !== undefined) return;
    instance = render(
      <CliEnvironment capabilities={capabilities}>
        <TerminalRoot store={store} />
      </CliEnvironment>,
      {
        stdin,
        stdout,
        stderr,
        exitOnCtrlC: false,
        patchConsole: false,
        onRender: rendered,
      },
    );
    if (options.captureConsole !== false) {
      restoreConsole = interceptConsole((entry) =>
        enqueueConsole(
          entry.method === "warn" || entry.method === "error" ? (
            <Status variant={entry.method === "warn" ? "warning" : "error"}>
              {entry.text}
            </Status>
          ) : (
            <Text tone={entry.method === "debug" ? "muted" : "default"}>
              {entry.text}
            </Text>
          ),
        ),
      );
    }
  };

  const unmount = async (): Promise<void> => {
    if (instance === undefined) return Promise.resolve();
    const beforeFlush = renderRevision;
    if (flushConsole()) await waitForRenderAfter(beforeFlush);
    const mounted = instance;
    instance = undefined;
    mounted.unmount();
    for (const waiter of renderWaiters) waiter.resolve();
    renderWaiters.clear();
    // Static output has been handed off to the terminal. Do not replay it
    // when a later live session mounts a fresh Ink root.
    store.clearStatic();
    restoreConsole?.();
    restoreConsole = undefined;
  };

  const releaseIfIdle = () =>
    Effect.suspend(() =>
      appActive || !store.idle ? Effect.void : Effect.promise(unmount),
    );

  const formatView = (view: View, renderOptions: RenderOptions = {}) =>
    captureView(normalizeView(view), renderOptions, capabilities);

  const renderView = (view: View, renderOptions: RenderOptions = {}) =>
    Effect.promise(() =>
      captureViewAsync(normalizeView(view), renderOptions, capabilities),
    );

  const print = (view: View) =>
    Effect.gen(function* () {
      const depth = yield* SectionDepth;
      view = normalizeView(view);
      if (instance !== undefined) flushConsole();
      if (appActive) {
        store.append(depth, view);
      } else if (instance !== undefined) {
        store.appendStatic(depth, view);
      } else {
        const output = yield* renderView(view);
        if (output !== "") stdout.write(`${output}\n`);
      }
    });

  const messageOptions = (
    message: string | { message: string; detail?: string },
  ) => (typeof message === "string" ? { message } : message);

  const log =
    (variant: "info" | "success" | "warning" | "error") =>
    (message: string | { message: string; detail?: string }) => {
      const options = messageOptions(message);
      return print(
        <Status variant={variant} detail={options.detail}>
          {options.message}
        </Status>,
      );
    };

  const run = <Value,>(screen: Screen<Value>) =>
    !capabilities.input
      ? Effect.fail(
          new NonInteractiveTerminal({
            operation: screen.name,
            message: `Cannot run ${screen.name} without an interactive terminal. Provide the equivalent command flags instead.`,
          }),
        )
      : interactionGate.withPermits(1)(
          Effect.gen(function* () {
            const depth = yield* SectionDepth;
            let completedView: View | undefined;
            return yield* Effect.callback<Value, TerminalCancelled>(
              (resume, signal) => {
                let settled = false;
                const finish = (
                  result: Effect.Effect<Value, TerminalCancelled>,
                  resultView?: View,
                ) => {
                  if (settled) return;
                  settled = true;
                  store.deactivate();
                  if (resultView !== undefined) {
                    if (appActive) store.append(depth, resultView);
                    else completedView = resultView;
                  }
                  resume(result);
                };
                const cancel = () =>
                  finish(
                    Effect.fail(new TerminalCancelled()),
                    <Text tone="muted">Cancelled.</Text>,
                  );
                store.activate(
                  depth,
                  <ScreenCancelGuard onCancel={cancel}>
                    {screen.render({
                      submit: (value, summary) =>
                        finish(Effect.succeed(value), summary),
                      cancel,
                    })}
                  </ScreenCancelGuard>,
                );
                // Seed the store before mounting so Ink's first render cannot
                // race the external-store subscription and miss the screen.
                ensureMounted();
                signal.addEventListener(
                  "abort",
                  () => {
                    if (!settled) {
                      settled = true;
                      store.deactivate();
                    }
                  },
                  { once: true },
                );
              },
            ).pipe(
              Effect.ensuring(
                Effect.suspend(() => {
                  if (appActive) {
                    return Effect.void;
                  }
                  return releaseIfIdle().pipe(
                    Effect.andThen(
                      completedView === undefined
                        ? Effect.void
                        : print(completedView),
                    ),
                  );
                }),
              ),
            );
          }),
        );

  const menu = <Value,>(
    options: MenuOptions<Value>,
  ): Effect.Effect<Value, InteractionError> =>
    Effect.suspend<Value, InteractionError, never>(() => {
      if (appActive) store.clear();
      return run(menuScreen(options));
    });

  const app = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | NonInteractiveTerminal, R> =>
    !capabilities.input
      ? Effect.fail(
          new NonInteractiveTerminal({
            operation: "application",
            message:
              "Cannot run a CLI application without terminal input. Provide the equivalent command flags instead.",
          }),
        )
      : appGate.withPermits(1)(
          Effect.gen(function* () {
            const presentation = yield* applicationPresentation;
            return yield* Effect.acquireUseRelease(
              Effect.sync(() => {
                if (presentation === "alternate") {
                  stdout.write(ENTER_ALTERNATE_SCREEN);
                }
                appActive = true;
                store.clear();
                ensureMounted();
              }),
              () => effect,
              () =>
                Effect.promise(async () => {
                  appActive = false;
                  store.clear();
                  await unmount();
                  if (presentation === "alternate") {
                    stdout.write(LEAVE_ALTERNATE_SCREEN);
                  }
                }),
            );
          }),
        );

  // A wizard owns the renderer when invoked standalone and reuses the
  // current application renderer when nested. Prompt serialization remains
  // centralized in `run`, so nested profile/OAuth flows suspend cleanly.
  const wizard = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | NonInteractiveTerminal, R> =>
    Effect.suspend(() =>
      appActive
        ? effect.pipe(
            Effect.ensuring(Effect.sync(() => store.clearTranscript())),
          )
        : app(effect),
    );

  const progress = (initial: ProgressOptions): Effect.Effect<ProgressHandle> =>
    Effect.gen(function* () {
      const depth = yield* SectionDepth;
      const key = store.alloc();
      let current = initial;
      let closed = false;
      const dynamic =
        capabilities.input && (appActive || stdout.isTTY === true);
      if (dynamic) {
        store.setLive(
          key,
          depth,
          <Spinner label={current.label} detail={current.detail} />,
        );
        ensureMounted();
      } else {
        yield* print(
          <Status variant="info" detail={initial.detail}>
            {initial.label}
          </Status>,
        );
      }
      const settle = (variant: "success" | "error", message?: string) =>
        Effect.suspend(() => {
          if (closed) return Effect.void;
          closed = true;
          const finalView = (
            <Status variant={variant}>{message ?? current.label}</Status>
          );
          if (!dynamic) return print(finalView);
          flushConsole();
          const beforeComplete = renderRevision;
          store.completeLive(
            key,
            appActive ? "transcript" : "staticItems",
            finalView,
          );
          return Effect.promise(() => waitForRenderAfter(beforeComplete)).pipe(
            Effect.andThen(releaseIfIdle()),
          );
        });
      return {
        update: (next) =>
          Effect.sync(() => {
            if (closed) return;
            current = next;
            if (dynamic)
              store.setLive(
                key,
                depth,
                <Spinner label={next.label} detail={next.detail} />,
              );
          }),
        succeed: (message) => settle("success", message),
        fail: (message) => settle("error", message),
        close: Effect.suspend(() => {
          if (closed || !dynamic) {
            closed = true;
            return releaseIfIdle();
          }
          closed = true;
          flushConsole();
          const beforeClose = renderRevision;
          store.removeLive(key);
          return Effect.promise(() => waitForRenderAfter(beforeClose)).pipe(
            Effect.andThen(releaseIfIdle()),
          );
        }),
      } satisfies ProgressHandle;
    });

  const live = (
    initial: View,
    options: LiveViewOptions = {},
  ): Effect.Effect<LiveViewHandle> =>
    Effect.gen(function* () {
      if (!capabilities.input) {
        let closed = false;
        yield* print(initial);
        return {
          update: (view) => (closed ? Effect.void : print(view)),
          close: Effect.sync(() => {
            closed = true;
          }),
        };
      }
      const depth = yield* SectionDepth;
      const key = store.alloc();
      let closed = false;
      store.setLive(key, depth, normalizeView(initial), options.placement);
      ensureMounted();
      return {
        update: (view) =>
          Effect.sync(() => {
            if (!closed)
              store.setLive(key, depth, normalizeView(view), options.placement);
          }),
        close: Effect.suspend(() => {
          if (closed) return Effect.void;
          closed = true;
          flushConsole();
          const beforeClose = renderRevision;
          if (options.persistOnClose)
            store.completeLive(key, appActive ? "transcript" : "staticItems");
          else store.removeLive(key);
          return Effect.promise(() => waitForRenderAfter(beforeClose)).pipe(
            Effect.andThen(releaseIfIdle()),
          );
        }),
      };
    });

  const service: CliKitService = {
    terminal: capabilities,
    output: {
      print,
      format: formatView,
      render: renderView,
      info: log("info"),
      success: log("success"),
      warning: log("warning"),
      error: log("error"),
      alert: (alertOptions) =>
        print(
          <Alert
            variant={alertOptions.variant}
            title={alertOptions.title}
            detail={alertOptions.detail}
          >
            {alertOptions.message}
          </Alert>,
        ),
      section: (title, body) =>
        Effect.gen(function* () {
          const depth = yield* SectionDepth;
          yield* print(<Heading>{title}</Heading>);
          return yield* body.pipe(
            Effect.provideService(SectionDepth, depth + 1),
          );
        }),
    },
    prompt: {
      text: (inputOptions) => run(textScreen(inputOptions)),
      password: (inputOptions) => run(passwordScreen(inputOptions)),
      confirm: (confirmOptions) => run(confirmScreen(confirmOptions)),
      select: (selectOptions) => run(selectScreen(selectOptions)),
      multiSelect: (selectOptions) => run(multiSelectScreen(selectOptions)),
      cycle: (selectOptions) => run(cycleSelectScreen(selectOptions)),
      awaitExternal: (externalOptions) =>
        run(awaitExternalScreen(externalOptions)),
      menu,
      custom: run,
    },
    wizard,
    application: app,
    live: { progress, open: live },
    task: (taskOptions, effect) =>
      Effect.gen(function* () {
        const handle = yield* progress(taskOptions);
        return yield* effect.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? handle.succeed() : handle.fail(),
          ),
        );
      }),
  };

  return {
    service,
    dispose: async () => {
      await unmount();
    },
  };
};
