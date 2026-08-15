/** @jsxImportSource react */
/**
 * GUI-style dashboard behind bare `alchemy profile`. One Ink app stays
 * mounted for the whole session and screens replace each other in place:
 *
 *   overview — chip tabs (default profile first), selected profile's
 *              provider details, keybind bar, inline rename/new/delete
 *   edit     — replaces the overview: per-provider cycle rows
 *              (keep / reconfigure / remove, add for unconnected)
 *
 * Pure store actions (create/rename/delete/set-default) round-trip through
 * the hub via a request bridge WITHOUT unmounting — results come back as
 * in-app notices. Only flows that must prompt in the transcript (provider
 * configuration, credential refresh) resolve the session.
 */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { type JSX, useEffect, useState } from "react";
import {
  Alert,
  Box,
  CycleList,
  InlineConfirm,
  KeyBar,
  LiveStore,
  Spinner,
  Stack,
  Status,
  Tabs,
  Text,
  TextField,
  useCycleNavigation,
  useGlyphs,
  useKeyGlyphs,
  useLiveStore,
  useTerminalInput,
} from "../CliKit/components.ts";
import { CliKit, theme } from "../CliKit/index.ts";
import {
  type EditState,
  editStateStyle,
  ProfileDetailsBody,
  type ProfileProviderDisplay,
} from "./Profile.tsx";

// --- data contracts ---------------------------------------------------------

export interface DashboardEntry {
  readonly name: string;
  readonly isActive: boolean;
  readonly isDefault: boolean;
}

export interface ProfileDetailsPayload {
  readonly providers: ReadonlyArray<ProfileProviderDisplay>;
  /** Registry providers not yet connected to this profile. */
  readonly available: ReadonlyArray<string>;
}

export type PureAction =
  | { kind: "create"; name: string }
  | { kind: "rename"; name: string; newName: string }
  | { kind: "delete"; name: string }
  | { kind: "set-default"; name: string };

export type FlowAction =
  | {
      kind: "edit-apply";
      name: string;
      add: string[];
      reconfigure: string[];
      remove: string[];
    }
  | { kind: "refresh"; name: string };

export type ExternalAction = FlowAction | { kind: "exit" };

export interface ExecuteResult {
  readonly ok: boolean;
  readonly message: string;
  readonly entries: ReadonlyArray<DashboardEntry>;
  /** Profile to focus after the action (e.g. the new name of a rename). */
  readonly selected?: string;
}

// --- store ------------------------------------------------------------------

export type Details =
  | { state: "loading" }
  | ({ state: "ready" } & ProfileDetailsPayload)
  | { state: "failed"; message: string };

interface Notice {
  readonly ok: boolean;
  readonly message: string;
}

interface Flow {
  readonly kind: FlowAction["kind"];
  readonly name: string;
  /** Inline flows render within the overview (refresh spinner). */
  readonly inline: boolean;
}

interface DashState {
  readonly entries: ReadonlyArray<DashboardEntry>;
  readonly details: ReadonlyMap<string, Details>;
  readonly notice: Notice | undefined;
  readonly busy: boolean;
  /** One-shot tab focus request (e.g. follow a rename to its new name). */
  readonly focus: string | undefined;
  /** Active in-app flow; `inline` flows render within the overview. */
  readonly flow: Flow | undefined;
}

/**
 * Immutable-snapshot store on top of `LiveStore`, so every mutation notifies
 * the mounted dashboard. The resolver bridge and the notice auto-dismiss
 * timer live outside the snapshot — they carry no visual state.
 */
class DashStore extends LiveStore<DashState> {
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private resolver: ((action: PureAction | ExternalAction) => void) | null =
    null;

  constructor(entries: ReadonlyArray<DashboardEntry>) {
    super({
      entries,
      details: new Map(),
      notice: undefined,
      busy: false,
      focus: undefined,
      flow: undefined,
    });
  }

  detailsFor(name: string): Details {
    return this.snapshot().details.get(name) ?? { state: "loading" };
  }
  detailNames(): ReadonlySet<string> {
    return new Set(this.snapshot().details.keys());
  }
  setDetails(name: string, details: Details) {
    this.update((state) => ({
      ...state,
      details: new Map(state.details).set(name, details),
    }));
  }
  setFlow(flow: Flow | undefined) {
    this.update((state) => ({ ...state, flow }));
  }
  clearFocus() {
    this.update((state) => ({ ...state, focus: undefined }));
  }
  dispose() {
    clearTimeout(this.noticeTimer);
    this.resolver = null;
  }
  applyResult(result: ExecuteResult) {
    // toast: notices dismiss themselves after a beat
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.update((state) => ({ ...state, notice: undefined }));
    }, 4000);
    this.update((state) => ({
      ...state,
      entries: result.entries,
      notice: { ok: result.ok, message: result.message },
      focus: result.ok ? result.selected : undefined,
      busy: false,
    }));
  }
  bindResolver(resolve: (action: PureAction | ExternalAction) => void) {
    this.resolver = resolve;
  }
  readonly dispatch = (action: PureAction | ExternalAction) => {
    if (this.snapshot().busy || this.resolver === null) return;
    const resolve = this.resolver;
    this.resolver = null;
    clearTimeout(this.noticeTimer);
    this.update((state) => ({ ...state, busy: true, notice: undefined }));
    resolve(action);
  };
}

// --- building blocks --------------------------------------------------------

const DetailsPane = ({ details }: { details: Details }): JSX.Element => {
  if (details.state === "loading") {
    return <Spinner label="resolving credentials…" />;
  }
  if (details.state === "failed") {
    return <Status variant="error">{details.message}</Status>;
  }
  if (details.providers.length === 0) {
    return (
      <Text tone="muted">No accounts connected — press e to add one.</Text>
    );
  }
  // Same body as `profile show`, so the dashboard's detail pane and the
  // non-interactive command render identically.
  return (
    <ProfileDetailsBody
      providers={details.providers}
      reauthHint="press r to re-login"
    />
  );
};

// --- edit screen ------------------------------------------------------------

interface EditRow {
  readonly provider: string;
  readonly method: string | undefined; // undefined = not connected
  readonly states: ReadonlyArray<EditState>;
}

const EditScreen = ({
  profile,
  rows,
  onApply,
  onBack,
}: {
  profile: string;
  rows: ReadonlyArray<EditRow>;
  onApply: (choices: ReadonlyArray<EditState>) => void;
  onBack: () => void;
}): JSX.Element => {
  const { cursor, indices, move, cycle } = useCycleNavigation(
    rows.map((row) => row.states.length),
  );
  const keys = useKeyGlyphs();
  const glyphs = useGlyphs();
  const [unchanged, setUnchanged] = useState(false);
  useTerminalInput((input, key) => {
    const plain = !key.ctrl && !key.meta;
    if (key.escape) return onBack();
    if (key.up || (plain && input === "k")) move(-1);
    else if (key.down || (plain && input === "j")) move(1);
    else if ((plain && input === " ") || key.right) {
      cycle(1);
      setUnchanged(false);
    } else if (key.left) {
      cycle(-1);
      setUnchanged(false);
    } else if (key.enter) {
      if (indices.every((index) => index === 0)) setUnchanged(true);
      else onApply(rows.map((row, i) => row.states[indices[i]]!));
    }
  });
  if (rows.length === 0) {
    return (
      <Stack gap={1}>
        <Text>
          <Text bold color={theme.color.accent}>
            edit accounts
          </Text>
          <Text tone="muted"> · {profile}</Text>
        </Text>
        <Status>No providers are available for this profile.</Status>
        <KeyBar keys={[[keys.escape, "back"]]} />
      </Stack>
    );
  }
  const choices = rows.map((row) => ({
    label: row.provider,
    description: row.method ?? "not connected",
    states: row.states.map((state) => ({
      value: state,
      label: editStateStyle[state].label,
      icon: glyphs[editStateStyle[state].icon],
      variant: editStateStyle[state].variant,
    })),
  }));
  return (
    <Stack gap={1}>
      <Text>
        <Text bold color={theme.color.accent}>
          edit accounts
        </Text>
        <Text tone="muted"> · {profile}</Text>
      </Text>
      <CycleList choices={choices} cursor={cursor} indices={indices} />
      {unchanged ? (
        <Alert variant="warning" title="No changes to apply">
          Press Space to change an account, or Esc to go back.
        </Alert>
      ) : null}
      <KeyBar
        keys={[
          [keys.upDown, "navigate"],
          [keys.space, "change"],
          [keys.enter, "apply"],
          [keys.escape, "back"],
        ]}
      />
    </Stack>
  );
};

// --- main component ---------------------------------------------------------

type Mode = "normal" | "rename" | "create" | "delete";

const Dashboard = ({
  store,
  initialSelected,
}: {
  store: DashStore;
  initialSelected: number;
}): JSX.Element => {
  const state = useLiveStore(store);
  const keyGlyphs = useKeyGlyphs();
  const [selected, setSelected] = useState(initialSelected);
  const [mode, setMode] = useState<Mode>("normal");
  const [screen, setScreen] = useState<"overview" | "edit">("overview");
  const { entries, focus: requestedFocus, flow, busy, notice } = state;
  useEffect(() => {
    if (requestedFocus === undefined) return;
    const focusIndex = entries.findIndex(
      (entry) => entry.name === requestedFocus,
    );
    store.clearFocus();
    if (focusIndex >= 0) setSelected(focusIndex);
  }, [entries, requestedFocus, store]);
  const index = Math.min(Math.max(selected, 0), entries.length - 1);
  const entry = entries[index];
  const details =
    entry === undefined ? undefined : store.detailsFor(entry.name);

  useTerminalInput((input, key) => {
    // flow prompts, the edit screen, and the inline TextField/InlineConfirm
    // modes own the keyboard
    if (flow !== undefined || screen === "edit" || busy) return;
    if (mode !== "normal") return;
    if (input === "q" || key.escape || (key.ctrl && input === "c")) {
      store.dispatch({ kind: "exit" });
    } else if (key.ctrl || key.meta) {
      return;
    } else if (input === "n") {
      setMode("create");
    } else if (entry === undefined) {
      return;
    } else if (key.left || input === "h" || (key.shift && key.tab)) {
      setSelected((s) => (s + entries.length - 1) % entries.length);
    } else if (key.right || input === "l" || key.tab) {
      setSelected((s) => (s + 1) % entries.length);
    } else if (input === "R") {
      setMode("rename");
    } else if (input === "d" && !entry.isDefault) {
      setMode("delete");
    } else if ((input === "e" || key.enter) && details?.state === "ready") {
      setScreen("edit");
    } else if (input === "r") {
      store.dispatch({ kind: "refresh", name: entry.name });
    } else if (input === "s" && !entry.isDefault) {
      store.dispatch({ kind: "set-default", name: entry.name });
    }
  });

  if (flow !== undefined && !flow.inline) {
    return (
      <Text>
        <Text bold color={theme.color.accent}>
          {flow.kind === "refresh" ? "refresh" : "edit accounts"}
        </Text>
        <Text tone="muted"> · {flow.name}</Text>
      </Text>
    );
  }

  if (
    screen === "edit" &&
    entry !== undefined &&
    details !== undefined &&
    details.state === "ready"
  ) {
    const rows: EditRow[] = [
      ...details.providers.map((provider) => ({
        provider: provider.name,
        method: provider.method,
        states: ["keep", "reconfigure", "remove"] as const,
      })),
      ...details.available.map((name) => ({
        provider: name,
        method: undefined,
        states: ["skip", "add"] as const,
      })),
    ];
    return (
      <EditScreen
        profile={entry.name}
        rows={rows}
        onBack={() => setScreen("overview")}
        onApply={(choices) => {
          const pick = (state: EditState) =>
            rows.flatMap((row, i) =>
              choices[i] === state ? [row.provider] : [],
            );
          const action: ExternalAction = {
            kind: "edit-apply",
            name: entry.name,
            add: pick("add"),
            reconfigure: pick("reconfigure"),
            remove: pick("remove"),
          };
          setScreen("overview");
          if (
            action.add.length +
              action.reconfigure.length +
              action.remove.length ===
            0
          ) {
            return;
          }
          store.dispatch(action);
        }}
      />
    );
  }

  const annotation =
    entry === undefined
      ? ""
      : [
          entry.isActive ? "active" : undefined,
          entry.isDefault ? "default" : undefined,
        ]
          .filter((tag) => tag !== undefined)
          .join(" · ");

  const keybinds: ReadonlyArray<readonly [string, string]> =
    entry === undefined
      ? [
          ["n", "new"],
          ["q", "quit"],
        ]
      : [
          [keyGlyphs.leftRight, "switch"],
          ...(details?.state === "ready"
            ? ([[keyGlyphs.enter, "edit"]] as const)
            : []),
          ["r", "refresh"],
          ["n", "new"],
          ["R", "rename"],
          ...(entry.isDefault
            ? []
            : ([
                ["s", "set default"],
                ["d", "delete"],
              ] as const)),
          ["q", "quit"],
        ];

  return (
    <Stack gap={1}>
      <Tabs
        tabs={entries.map((e) => ({
          id: e.name,
          label: e.name,
          marked: e.isActive,
        }))}
        active={entry?.name ?? ""}
      />
      <Stack>
        {entry === undefined ? (
          <Text tone="muted">No profiles yet — press n to create one.</Text>
        ) : (
          <>
            <Text>
              <Text bold color={theme.color.accent}>
                {entry.name}
              </Text>
              {annotation === "" ? null : (
                <Text tone="muted"> · {annotation}</Text>
              )}
            </Text>
            <Box marginTop={1}>
              <DetailsPane details={details ?? { state: "loading" }} />
            </Box>
          </>
        )}
      </Stack>
      {/* Reserved row: notice, busy/refresh spinner, or blank — the key bar
          below never jumps when a toast dismisses or a spinner appears. */}
      <Box minHeight={1}>
        {flow?.inline ? (
          <Spinner label={`refreshing ${flow.name}…`} />
        ) : busy ? (
          <Spinner label="working…" />
        ) : notice !== undefined ? (
          <Status variant={notice.ok ? "success" : "error"}>
            {notice.message}
          </Status>
        ) : null}
      </Box>
      <Stack>
        {mode === "normal" && !busy && flow === undefined ? (
          <KeyBar keys={keybinds} />
        ) : mode === "delete" && entry !== undefined ? (
          <InlineConfirm
            message={`Delete '${entry.name}' and all its stored credentials?`}
            onSubmit={(confirmed) => {
              setMode("normal");
              if (confirmed)
                store.dispatch({ kind: "delete", name: entry.name });
            }}
            onCancel={() => setMode("normal")}
          />
        ) : (
          <Stack>
            <Text>
              <Text bold color={theme.color.accent}>
                {mode === "rename" && entry !== undefined
                  ? `rename '${entry.name}' to`
                  : "new profile name"}
              </Text>{" "}
              <Text tone="muted">({keyGlyphs.escape} to cancel)</Text>
            </Text>
            <Box paddingLeft={2}>
              <TextField
                key={`${mode}-${entry?.name ?? ""}`}
                placeholder={
                  mode === "rename" && entry !== undefined
                    ? `${entry.name}-new`
                    : "my-profile"
                }
                onSubmit={(value) => {
                  const name = value.trim();
                  if (name.length === 0) return;
                  setMode("normal");
                  store.dispatch(
                    mode === "rename" && entry !== undefined
                      ? { kind: "rename", name: entry.name, newName: name }
                      : { kind: "create", name },
                  );
                }}
                onCancel={() => setMode("normal")}
              />
            </Box>
          </Stack>
        )}
      </Stack>
    </Stack>
  );
};

// --- session driver ---------------------------------------------------------

export interface DashboardSessionOptions<R> {
  readonly entries: ReadonlyArray<DashboardEntry>;
  readonly selected: string | undefined;
  readonly loadDetails: (
    name: string,
  ) => Effect.Effect<ProfileDetailsPayload, never, R>;
  /** Executes a pure store action and returns the refreshed state. */
  readonly execute: (
    action: PureAction,
  ) => Effect.Effect<ExecuteResult, never, R>;
  /**
   * Runs an edit/refresh flow. Its prompts render inside the dashboard via
   * the embedded session; resolves with a toast message.
   */
  readonly runFlow: (action: FlowAction) => Effect.Effect<string, never, R>;
  /** Re-reads entries after a flow (active/default may have changed). */
  readonly reloadEntries: Effect.Effect<
    ReadonlyArray<DashboardEntry>,
    never,
    R
  >;
}

/**
 * Runs the dashboard inside CliKit's application renderer. Pure actions and
 * edit/refresh flows share the same frame, and the application clears it on
 * exit.
 */
export const runProfileDashboardSession = <R,>(
  options: DashboardSessionOptions<R>,
): Effect.Effect<void, never, R> =>
  Effect.flatMap(CliKit, (cli) =>
    cli.application(
      Effect.gen(function* () {
        const store = new DashStore(options.entries);

        const loadInto = (name: string) =>
          options.loadDetails(name).pipe(
            Effect.flatMap((payload) =>
              Effect.sync(() =>
                store.setDetails(name, { state: "ready", ...payload }),
              ),
            ),
            Effect.catchDefect((defect) =>
              Effect.sync(() =>
                store.setDetails(name, {
                  state: "failed",
                  message: String(defect),
                }),
              ),
            ),
          );

        const loader = yield* Effect.forEach(
          options.entries,
          (entry) => loadInto(entry.name),
          { concurrency: 2, discard: true },
        ).pipe(Effect.forkChild);

        const initialSelected = Math.max(
          0,
          options.entries.findIndex((entry) => entry.name === options.selected),
        );

        const live = yield* cli.live.open(
          <Dashboard store={store} initialSelected={initialSelected} />,
          { placement: "beforeTranscript" },
        );

        yield* Effect.gen(function* () {
          while (true) {
            const action = yield* Effect.callback<PureAction | ExternalAction>(
              (resume) => {
                store.bindResolver((action) => resume(Effect.succeed(action)));
              },
            );
            switch (action.kind) {
              case "exit":
                return;
              case "refresh":
              case "edit-apply": {
                store.setFlow({
                  kind: action.kind,
                  name: action.name,
                  // refresh keeps the overview on screen with a spinner; only
                  // account editing takes over the whole view
                  inline: action.kind === "refresh",
                });
                const message = yield* cli.wizard(options.runFlow(action));
                const entries = yield* options.reloadEntries;
                store.setDetails(action.name, { state: "loading" });
                yield* loadInto(action.name).pipe(Effect.forkChild);
                store.setFlow(undefined);
                store.applyResult({
                  ok: true,
                  message,
                  entries,
                  selected: action.name,
                });
                break;
              }
              default: {
                const result = yield* options.execute(action);
                // a renamed/created profile needs its details (re)resolved
                const names = store.detailNames();
                store.applyResult(result);
                yield* Effect.forEach(
                  result.entries.filter((e) => !names.has(e.name)),
                  (e) => loadInto(e.name),
                  { concurrency: 2, discard: true },
                ).pipe(Effect.forkChild);
              }
            }
          }
        }).pipe(
          Effect.ensuring(Effect.sync(() => store.dispose())),
          Effect.ensuring(live.close),
          Effect.ensuring(Fiber.interrupt(loader)),
        );
      }),
    ),
  ).pipe(Effect.orDie);
