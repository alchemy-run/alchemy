/** @jsxImportSource react */
import { PassThrough } from "node:stream";
import {
  NonInteractiveTerminal,
  Application,
  Screen,
  TerminalCancelled,
  CliKit,
  hyperlink,
  linePrefix,
  stripAnsi,
  layer as cliKitLayer,
} from "@/Cli/CliKit/index.ts";
import {
  AnsweredPrompt,
  Alert,
  BooleanChoice,
  DescriptionList,
  Heading,
  LiveStore,
  PromptFrame,
  ProgressGroup,
  SectionHeading,
  Status,
  Toast,
  Tabs,
  TaskRow,
  Text,
  TextField,
  useLiveStore,
} from "@/Cli/CliKit/components.ts";
import { makeRuntime } from "@/Cli/CliKit/SigilRuntime.tsx";
import { isInProgress } from "@/Cli/views/statusStyle.ts";
import { makeResourceLogger, makeResourceOutput } from "@/Cli/Output.ts";
import { stackOutputsView } from "@/Cli/views/StackOutputs.tsx";
import { Plan } from "@/Cli/views/Plan.tsx";
import { ProfileDetailsBody } from "@/Cli/views/Profile.tsx";
import {
  buildStageNodes,
  stateExplorerScreen,
  StateExplorerStore,
  type StateExplorerSource,
} from "@/Cli/views/StateExplorer.tsx";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import { expect, it } from "alchemy-test";
import { planWith, updateNode } from "./PlanTestNodes.ts";

class CaptureStream extends PassThrough {
  readonly columns = 80;
  readonly rows = 24;
  output = "";

  constructor(readonly isTTY = false) {
    super();
    this.on("data", (chunk) => {
      this.output += chunk.toString();
    });
  }

  waitFor(text: string): Promise<void> {
    if (this.output.includes(text)) return Promise.resolve();
    return new Promise((resolve) => {
      const onData = () => {
        if (!this.output.includes(text)) return;
        this.off("data", onData);
        resolve();
      };
      this.on("data", onData);
    });
  }
}

class InputStream extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  private resolveReady: (() => void) | undefined;
  readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  setRawMode(mode: boolean) {
    this.isRaw = mode;
    if (mode) this.resolveReady?.();
    return this;
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }
}

const makeStatic = () => {
  const stdout = new CaptureStream();
  const runtime = makeRuntime(
    {
      input: false,
      // SAFETY: CaptureStream implements the writable stream surface consumed by Sigil.
      stdout: stdout as unknown as NodeJS.WriteStream,
      captureConsole: false,
    },
    {
      input: false,
      columns: stdout.columns,
      rows: stdout.rows,
      colors: false,
      unicode: true,
      alternateScreen: false,
    },
  );
  return { ...runtime, stdout };
};

it.effect("reports terminal-native progress on TTY output", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();
    yield* service.nativeProgress.set("indeterminate");
    yield* service.nativeProgress.set("normal", 50);
    yield* service.nativeProgress.set("inactive");

    expect(stdout.output).toContain("\u001B]9;4;3\u001B\\");
    expect(stdout.output).toContain("\u001B]9;4;1;50\u001B\\");
    expect(stdout.output).toContain("\u001B]9;4;0\u001B\\");
  }),
);

const makeExplorerSource = () => {
  const calls = { stacks: 0, stages: 0, resources: 0, files: 0 };
  const source: StateExplorerSource = {
    backend: "local",
    listStacks: Effect.sync(() => {
      calls.stacks++;
      return ["app"];
    }),
    listStages: () =>
      Effect.sync(() => {
        calls.stages++;
        return ["prod"];
      }),
    listResources: () =>
      Effect.sync(() => {
        calls.resources++;
        return ["Api/Worker"];
      }),
    readFile: () =>
      Effect.sync(() => {
        calls.files++;
        return { status: "created", url: "https://workers.dev" };
      }),
    deleteNodes: () => Effect.void,
  };
  return { calls, source };
};

const explorerSource = makeExplorerSource().source;
const flushEffects = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

it("builds Finder-style namespace columns from FQN names", () => {
  const nodes = buildStageNodes("app", "prod", ["Api/Worker"]);
  expect(nodes.map((node) => node.name)).toEqual(["Api", "output"]);
  const api = nodes[0];
  expect(api?.kind).toBe("namespace");
  if (api?.kind === "namespace") {
    expect(api.children.map((node) => node.name)).toEqual(["Worker"]);
  }
});

it("loads state columns and file contents only when selected", async () => {
  const { calls, source } = makeExplorerSource();
  const store = new StateExplorerStore(source);
  store.loadRoot();
  await flushEffects();
  expect(calls).toEqual({ stacks: 1, stages: 0, resources: 0, files: 0 });

  const root = store.snapshot().root;
  expect(root.status).toBe("ready");
  if (root.status !== "ready") return;
  const stack = root.value[0]!;
  store.loadChildren(stack);
  await flushEffects();
  expect(calls).toEqual({ stacks: 1, stages: 1, resources: 0, files: 0 });

  const stages = store.snapshot().children.get(stack.id);
  if (stages?.status !== "ready") return;
  const stage = stages.value[0]!;
  store.loadChildren(stage);
  await flushEffects();
  expect(calls).toEqual({ stacks: 1, stages: 1, resources: 1, files: 0 });

  const state = store.snapshot().children.get(stage.id);
  if (state?.status !== "ready") return;
  const namespace = state.value.find((node) => node.kind === "namespace");
  if (namespace?.kind !== "namespace") return;
  store.loadFile(namespace.children[0]!);
  await flushEffects();
  expect(calls).toEqual({ stacks: 1, stages: 1, resources: 1, files: 1 });
});

it("ignores state explorer responses from before a refresh", async () => {
  let resolveStale: ((stacks: ReadonlyArray<string>) => void) | undefined;
  let request = 0;
  const source: StateExplorerSource = {
    ...explorerSource,
    listStacks: Effect.suspend(() => {
      request++;
      if (request === 1) {
        return Effect.promise(
          () =>
            new Promise((resolve) => {
              resolveStale = resolve;
            }),
        );
      }
      return Effect.succeed(["fresh"]);
    }),
  };
  const store = new StateExplorerStore(source);
  store.loadRoot();
  store.refresh();
  await flushEffects();

  resolveStale?.(["stale"]);
  await flushEffects();

  const root = store.snapshot().root;
  expect(root.status).toBe("ready");
  if (root.status === "ready") {
    expect(root.value.map((node) => node.name)).toEqual(["fresh"]);
  }
});

it("formats stack outputs as labeled values instead of a raw object dump", () => {
  const { service } = makeStatic();
  const apiUrl =
    "https://cloudflareworkerexample-api-clxp5k3fbtqacxdev7mx7uuxmw.testing-2b2.workers.dev";
  const output = service.output.format(
    stackOutputsView({
      apiUrl,
      metadata: { region: "us-east-1", replicas: 2 },
    }),
    { columns: 10_000 },
  );

  expect(output).toContain("Outputs");
  expect(output).toContain("apiUrl");
  expect(output).toContain(apiUrl);
  expect(output).toContain("metadata");
  expect(output).toContain("region");
});

it("renders detailed plans as nested YAML", () => {
  const { service } = makeStatic();
  const output = service.output.format(
    <Plan
      plan={planWith([
        updateNode({ config: { retries: 2 } }, { config: { retries: 3 } }),
      ])}
      detailed
    />,
    { columns: 80 },
  );

  expect(output).toContain("before:");
  expect(output).toContain("config:");
  expect(output).toContain("retries: 2");
  expect(output).toContain("after:");
  expect(output).toContain("retries: 3");
  expect(output).toContain("(Test.Resource)");
});

it("replaces provider details with refresh progress in place", () => {
  const { service } = makeStatic();
  const output = service.output.format(
    <ProfileDetailsBody
      providers={[
        {
          name: "Cloudflare",
          method: "oauth",
          status: "ready",
          lines: ["accessToken: cfoa****", "expires: in 59m"],
        },
        {
          name: "GitHub",
          method: "gh-cli",
          status: "ready",
          lines: ["token: gho_cZ****"],
        },
      ]}
      refreshingProvider="Cloudflare"
    />,
    { columns: 80 },
  );

  expect(output).toContain("Cloudflare");
  expect(output).toContain("refreshing OAuth credentials…");
  expect(output).not.toContain("accessToken: cfoa****");
  expect(output).not.toContain("expires: in 59m");
  expect(output).toContain("GitHub");
  expect(output).toContain("token: gho_cZ****");
});

it("renders input frames inline by default and keeps a stacked variant", () => {
  const { service } = makeStatic();
  const inline = service.output.format(
    <PromptFrame
      message="Profile name"
      description="Used to select stored credentials."
      layout="inline"
    >
      <Text>production</Text>
    </PromptFrame>,
  );
  const stacked = service.output.format(
    <PromptFrame message="Profile name" layout="stacked">
      <Text>production</Text>
    </PromptFrame>,
  );

  expect(inline).toContain("Profile name: production");
  expect(inline).toContain("Used to select stored credentials.");
  expect(stacked).toContain("Profile name\n");
  expect(stacked).toContain("production");
});

it("renders compact informational toasts with a rail", () => {
  const { service } = makeStatic();
  const output = service.output.format(
    <Toast variant="info">Credentials refreshed.</Toast>,
  );

  expect(output).toBe("│ • Credentials refreshed.");
});

/**
 * Scoped variant of `makeStatic` for tests that mount a persistent renderer.
 * Disposal runs as a finalizer, so a failing test never leaks a Sigil
 * instance.
 */
const makeLive = (
  overrides: {
    readonly stdin?: InputStream;
    readonly captureConsole?: boolean;
    readonly input?: boolean;
    readonly unicode?: boolean;
    readonly colors?: boolean;
    readonly onInterrupt?: () => void;
  } = {},
) => {
  const input = overrides.input ?? true;
  return Effect.acquireRelease(
    Effect.sync(() => {
      const stdout = new CaptureStream(input);
      const stderr = new CaptureStream(input);
      // Interactive runtimes need a raw-mode-capable stdin: with a real
      // process.stdin pipe Sigil's useInput throws during commit, which now
      // surfaces as a renderer error instead of being silently swallowed.
      const stdin = overrides.stdin ?? (input ? new InputStream() : undefined);
      const runtime = makeRuntime(
        {
          input,
          // SAFETY: InputStream implements the raw readable stream surface consumed by Sigil.
          stdin: stdin as unknown as NodeJS.ReadStream | undefined,
          // SAFETY: CaptureStream implements the writable stream surface consumed by Sigil.
          stdout: stdout as unknown as NodeJS.WriteStream,
          // SAFETY: CaptureStream implements the writable stream surface consumed by Sigil.
          stderr: stderr as unknown as NodeJS.WriteStream,
          captureConsole: overrides.captureConsole ?? false,
          onInterrupt: overrides.onInterrupt,
        },
        {
          input,
          columns: stdout.columns,
          rows: stdout.rows,
          colors: overrides.colors ?? false,
          unicode: overrides.unicode ?? true,
          alternateScreen: input,
        },
      );
      return { ...runtime, stdout, stderr };
    }),
    ({ dispose }) => Effect.promise(dispose),
  );
};

it.effect(
  "turns Ctrl-C into an interrupt while an idle live view owns stdin",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdin = new InputStream();
        let interrupts = 0;
        const { service } = yield* makeLive({
          stdin,
          onInterrupt: () => {
            interrupts += 1;
          },
        });
        yield* service.live.open(<Status>Development server running</Status>);
        yield* Effect.promise(() => stdin.ready);

        yield* Effect.sync(() => stdin.write("\x03"));
        yield* settleInput;

        expect(interrupts).toBe(1);
      }),
    ),
);

it.effect("keeps stack output URLs reachable", () =>
  Effect.gen(function* () {
    const { service } = yield* makeLive({ colors: true });
    const url = "https://example.com/deploy";
    const output = service.output.format(stackOutputsView({ url }), {
      colors: true,
    });
    expect(stripAnsi(output)).toContain(url);
  }),
);

it.effect(
  "keeps the state explorer active while searching and quits cleanly",
  () =>
    Effect.gen(function* () {
      const stdin = new InputStream();
      const { service, stdout } = yield* makeLive({ stdin });
      const fiber = yield* service
        .application(service.prompt.custom(stateExplorerScreen(explorerSource)))
        .pipe(Application.alternate)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => stdin.ready);
      yield* Effect.promise(() => stdout.waitFor("Loading"));

      yield* Effect.sync(() => stdin.write("/"));
      yield* settleInput;
      yield* Effect.sync(() => stdin.write("workers.dev"));
      yield* settleInput;
      yield* Effect.sync(() => stdin.write("\r"));
      yield* settleInput;
      expect(fiber.pollUnsafe()).toBeUndefined();

      yield* Effect.sync(() => stdin.write("q"));
      yield* Fiber.join(fiber);
    }),
);

it.effect("renders the built-in layout components without writing", () =>
  Effect.gen(function* () {
    const { service, stdout } = makeStatic();
    const rendered = yield* service.output.render(
      <>
        <SectionHeading annotation="active">Profile</SectionHeading>
        <DescriptionList
          items={[
            { label: "Name", value: "production" },
            { label: "Status", value: "ready" },
          ]}
        />
      </>,
    );

    expect(rendered).toContain("Profile");
    expect(rendered).toContain("production");
    expect(rendered).toContain("ready");
    expect(stdout.output).toBe("");
  }),
);

it.effect("renders confirmations as a compact segmented choice", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();

    expect((yield* service.output.render(<BooleanChoice value />)).trim()).toBe(
      "Yes   No",
    );
    expect(
      (yield* service.output.render(<BooleanChoice value={false} />)).trim(),
    ).toBe("Yes   No");
  }),
);

it.effect("preserves zero in primitive-array views", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();
    const rendered = yield* service.output.render(["count: ", 0, false, null]);

    expect(rendered).toBe("count: 0");
  }),
);

it("does not animate work before it starts", () => {
  expect(isInProgress("pending")).toBe(false);
  expect(isInProgress("creating")).toBe(true);
  expect(isInProgress("updating")).toBe(true);
  expect(isInProgress("deleting")).toBe(true);
  expect(isInProgress("running")).toBe(true);
});

it.effect("prints headings and data views through one service", () =>
  Effect.gen(function* () {
    const { service, stdout } = makeStatic();
    yield* service.output.print(<Heading>Deployments</Heading>);
    yield* service.output.print(
      <DescriptionList
        items={[
          { label: "api", value: "ready" },
          { label: "worker", value: "updating" },
        ]}
      />,
    );

    expect(stdout.output).toContain("Deployments");
    expect(stdout.output).toContain("worker");
    expect(stdout.output).toContain("updating");
  }),
);

it.effect("fails input operations when no terminal input is available", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();
    const failure = yield* service.prompt
      .select({
        message: "Choose",
        options: [{ label: "One", value: 1 }],
      })
      .pipe(Effect.flip);

    expect(failure).toBeInstanceOf(NonInteractiveTerminal);
    if (failure instanceof NonInteractiveTerminal) {
      expect(failure.operation).toBe("selection");
    }

    const cycleFailure = yield* service.prompt
      .cycle({ message: "Change", options: [] })
      .pipe(Effect.flip);
    const externalFailure = yield* service.prompt
      .awaitExternal({
        message: "Authorize",
        waitingLabel: "Waiting",
        inputLabel: "Enter code",
      })
      .pipe(Effect.flip);
    expect(cycleFailure).toBeInstanceOf(NonInteractiveTerminal);
    if (cycleFailure instanceof NonInteractiveTerminal) {
      expect(cycleFailure.operation).toBe("cycle selection");
    }
    expect(externalFailure).toBeInstanceOf(NonInteractiveTerminal);
    if (externalFailure instanceof NonInteractiveTerminal) {
      expect(externalFailure.operation).toBe("external authorization");
    }
  }),
);

it.effect("progress handles are updateable and settle only once", () =>
  Effect.gen(function* () {
    const { service, stdout } = makeStatic();
    const progress = yield* service.live.progress({ label: "Deploying" });
    yield* progress.update({ label: "Uploading", detail: "2/3" });
    yield* progress.succeed("Deployed");
    yield* progress.fail("must not print");

    expect(stdout.output).toContain("Deploying");
    expect(stdout.output).toContain("Deployed");
    expect(stdout.output).not.toContain("must not print");
  }),
);

/** Live views are immutable; dynamic content flows through caller stores. */
const LiveLabel = ({ store }: { readonly store: LiveStore<string> }) => (
  <Text>{useLiveStore(store)}</Text>
);

it.effect("tears down store-driven live views idempotently", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    const store = new LiveStore("Scanning");
    const live = yield* service.live.open(<LiveLabel store={store} />);
    yield* Effect.sync(() => store.set("Deleting"));
    yield* live.close;
    yield* live.close;

    expect(stdout.output).toContain("\u001B[?25h");
  }),
);

it.effect("does not let one closing view tear down a newer live view", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    const first = yield* service.live.open(<Text>first</Text>);
    const closing = yield* first.close.pipe(Effect.forkChild);
    const store = new LiveStore("second");
    const second = yield* service.live.open(<LiveLabel store={store} />, {
      persistOnClose: true,
    });
    yield* Fiber.join(closing);
    yield* Effect.sync(() => store.set("second updated"));
    yield* second.close;

    expect(stdout.output).toContain("second updated");
  }),
);

interface OrderingCase {
  readonly name: string;
  readonly captureConsole: boolean;
  readonly emit: (service: CliKit["Service"]) => Effect.Effect<void>;
  readonly verify: (output: string) => void;
}

const orderingCases: ReadonlyArray<OrderingCase> = [
  {
    name: "commits persistent live views to the static transcript",
    captureConsole: false,
    emit: () => Effect.void,
    verify: (output) => {
      expect(output).toContain("Deployed");
      expect(output.slice(output.lastIndexOf("Deployed"))).not.toContain(
        "\u001B[2K",
      );
      expect(output).toContain("\u001B[?25h");
    },
  },
  {
    name: "keeps styled captured logs static and ordered before completed live views",
    captureConsole: true,
    emit: () =>
      Effect.sync(() => console.log("\u001B[32mruntime ready\u001B[0m")),
    verify: (output) => {
      expect(output.match(/runtime ready/g)?.length).toBe(1);
      expect(output).toContain("\u001B[32m");
      expect(output.indexOf("runtime ready")).toBeLessThan(
        output.lastIndexOf("Deployed"),
      );
    },
  },
  {
    name: "orders semantic output through the active renderer",
    captureConsole: false,
    emit: (service) => service.output.info("runtime ready"),
    verify: (output) => {
      expect(output.indexOf("runtime ready")).toBeLessThan(
        output.lastIndexOf("Deployed"),
      );
    },
  },
];

it.effect.each(orderingCases)("$name", ({ captureConsole, emit, verify }) =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive({
      captureConsole,
      colors: captureConsole,
    });

    const store = new LiveStore("Deploying");
    const live = yield* service.live.open(<LiveLabel store={store} />, {
      persistOnClose: true,
    });
    yield* emit(service);
    yield* Effect.sync(() => store.set("Deployed"));
    yield* live.close;

    verify(stdout.output);
  }),
);

it.effect("commits stdio above active Sigil views", () =>
  Effect.gen(function* () {
    const { service, stdout, stderr } = yield* makeLive({
      captureConsole: true,
    });
    const store = new LiveStore("Resolving credentials");
    const live = yield* service.live.open(<LiveLabel store={store} />, {
      persistOnClose: true,
    });

    yield* Effect.sync(() => {
      stdout.write("floci stdout\n");
      stderr.write("node warning\n");
      store.set("Credentials resolved");
    });
    yield* live.close;

    expect(stdout.output).toContain("floci stdout");
    expect(stdout.output).toContain("node warning");
    expect(stderr.output).not.toContain("node warning");
    expect(stdout.output).toContain("Credentials resolved");
    expect(stdout.output.lastIndexOf("node warning")).toBeLessThan(
      stdout.output.lastIndexOf("Credentials resolved"),
    );
  }),
);

it.effect("progress settles into success and failure status output", () =>
  Effect.gen(function* () {
    const { service, stdout } = makeStatic();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const first = yield* service.live.progress({
          label: "Resolve credentials",
        });
        yield* first.succeed();
        const second = yield* service.live.progress({
          label: "Apply resource",
        });
        yield* second.fail();
      }),
    );

    expect(stdout.output).toContain("Resolve credentials");
    expect(stdout.output).toContain("Apply resource");
    expect(stdout.output).toContain("✓");
    expect(stdout.output).toContain("×");
  }),
);

it.effect("task collapses success and failure into status output", () =>
  Effect.gen(function* () {
    const { service, stdout } = makeStatic();
    yield* service.task(
      { label: "Resolve credentials" },
      Effect.succeed("credentials"),
    );
    yield* service
      .task({ label: "Apply resource" }, Effect.fail("nope"))
      .pipe(Effect.ignore);

    expect(stdout.output).toContain("Resolve credentials");
    expect(stdout.output).toContain("Apply resource");
    expect(stdout.output).toContain("✓");
    expect(stdout.output).toContain("×");
  }),
);

it.effect("status output composes as a normal view", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();
    const rendered = yield* service.output.render(
      <Status variant="warning" detail="retrying">
        API unavailable
      </Status>,
    );
    expect(rendered).toContain("API unavailable");
    expect(rendered).toContain("retrying");
  }),
);

it.effect("uses ASCII fallbacks when Unicode is unavailable", () =>
  Effect.gen(function* () {
    const { service } = yield* makeLive({ input: false, unicode: false });
    const rendered = yield* service.output.render(
      <>
        <Heading>Deploy</Heading>
        <Status variant="success">Complete</Status>
      </>,
    );
    expect(rendered).toContain("@ Deploy");
    expect(rendered).toContain("+ Complete");
    expect(rendered).not.toContain("✓");
  }),
);

it("strips terminal colors and hyperlinks", () => {
  expect(
    stripAnsi(`\u001B[31mred\u001B[0m ${hyperlink("docs", "https://x")}`),
  ).toBe("red docs");
});

it("uses one resource-prefixed pipeline for chunked stdout and stderr", () => {
  const lines: string[] = [];
  const output = makeResourceOutput("www", {
    log: (...args) => lines.push(args.join(" ")),
  });

  output.stdout.push("first\nsec");
  output.stdout.push("ond\r");
  output.stderr.push("failed");
  output.stdout.flush();
  output.stderr.flush();

  const prefix = stripAnsi(linePrefix("www"));
  expect(lines.map(stripAnsi)).toEqual([
    `${prefix} first`,
    `${prefix} second`,
    `${prefix} failed`,
  ]);
});

it.effect(
  "routes effectful resource output through the configured logger",
  () => {
    const entries: Array<{ level: string; message: unknown }> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      entries.push({ level: logLevel, message });
    });
    const output = makeResourceLogger("www");

    return Effect.gen(function* () {
      yield* output("stdout", "[MDX] generated files");
      yield* output("stderr", "vite diagnostic");
      expect(entries).toEqual([
        { level: "Info", message: ["[www] [MDX] generated files"] },
        { level: "Info", message: ["[www] vite diagnostic"] },
      ]);
    }).pipe(Effect.provide(Logger.layer([logger])));
  },
);

it.effect("does not decorate resource stderr as a semantic failure", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive({ captureConsole: true });
    const live = yield* service.live.open(<Text>Building</Text>);

    const output = makeResourceOutput("www", globalThis.console);
    output.stderr.push("[FILE_NAME_CONFLICT] warning\n");
    output.stderr.flush();
    yield* live.close;

    const rendered = stripAnsi(stdout.output);
    expect(rendered).toContain(
      `${stripAnsi(linePrefix("www"))} [FILE_NAME_CONFLICT] warning`,
    );
    expect(rendered).not.toContain("×");
  }),
);

it.effect("runs interactive components inside the owned session", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    const result = yield* service.prompt.custom(
      Screen.make("test screen", ({ submit }) => {
        queueMicrotask(() => submit("completed", <Status>Done</Status>));
        return <Status>Working</Status>;
      }),
    );
    expect(result).toBe("completed");
    expect(stdout.output).toContain("Done");
  }),
);

it.effect("restores the terminal after an alternate-screen interaction", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    yield* service
      .application(
        service.prompt.custom(
          Screen.make("full screen", ({ submit }) => {
            queueMicrotask(() => submit(undefined));
            return <Status>Browsing</Status>;
          }),
        ),
      )
      .pipe(Application.alternate);

    expect(stdout.output).toContain("\u001B[?1049h");
    expect(stdout.output).toContain("\u001B[?1049l");
    expect(stdout.output.indexOf("\u001B[?1049h")).toBeLessThan(
      stdout.output.indexOf("\u001B[?1049l"),
    );
  }),
);

it.effect("treats the terminal DEL byte as text-field backspace", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .custom(
        Screen.make("backspace", ({ submit }) => (
          <TextField initialValue="abc" onChange={submit} onSubmit={submit} />
        )),
      )
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("\x7f"));
    const result = yield* Fiber.join(fiber);

    expect(result).toBe("ab");
  }),
);

/** Let a written stdin chunk flow through Sigil's input pipeline. */
const settleInput = Effect.yieldNow.pipe(Effect.repeat({ times: 2 }));

it.effect("strips control characters from pasted text-field input", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .custom(
        Screen.make("paste", ({ submit }) => <TextField onSubmit={submit} />),
      )
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    // A paste arrives as one chunk; embedded newlines/tabs must not survive.
    yield* Effect.sync(() => stdin.write("to\tken\r\n123"));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("\r"));
    const result = yield* Fiber.join(fiber);

    expect(result).toBe("token123");
  }),
);

it.effect("shows the whole typed value while width remains available", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service, stdout } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .text({ message: "New profile name" })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    // Regression: the field's box used to shrink to its content, so the
    // measured "available" width collapsed to the minimum and the value
    // scrolled after ~4 characters despite a mostly-empty row.
    yield* Effect.sync(() => stdin.write("my-longer-profile-name"));
    yield* Effect.promise(() => stdout.waitFor("my-longer-profile-name"));
    expect(stdout.output).toContain("my-longer-profile-name");
    yield* Effect.sync(() => stdin.write("\r"));
    const result = yield* Fiber.join(fiber);

    expect(result).toBe("my-longer-profile-name");
  }),
);

it.effect("shows a text prompt default before it is accepted", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service, stdout } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .text({
        message: "Emulator endpoint",
        defaultValue: "http://localhost:4566",
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.promise(() => stdout.waitFor("http://localhost:4566"));
    expect(stripAnsi(stdout.output)).toContain(
      "Emulator endpoint: http://localhost:4566",
    );
    yield* Effect.sync(() => stdin.write("\r"));

    expect(yield* Fiber.join(fiber)).toBe("http://localhost:4566");
  }),
);

it.effect("deletes a whole emoji grapheme on backspace", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .custom(
        Screen.make("grapheme", ({ submit }) => (
          <TextField initialValue="a👍" onChange={submit} onSubmit={submit} />
        )),
      )
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("\x7f"));
    const result = yield* Fiber.join(fiber);

    expect(result).toBe("a");
  }),
);

it.effect("erases the multi-select filter with the terminal DEL byte", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .multiSelect({
        message: "pick",
        options: [
          { value: "alpha", label: "alpha" },
          { value: "beta", label: "beta" },
        ],
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    // Filter to nothing, erase the filter with DEL, then toggle + confirm.
    yield* Effect.sync(() => stdin.write("z"));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("\x7f"));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write(" "));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("\r"));
    const result = yield* Fiber.join(fiber);

    expect(result).toEqual(["alpha"]);
  }),
);

it.effect("filters searchable selects without stealing Enter", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .select({
        message: "pick",
        searchable: true,
        options: [
          { value: "alpha", label: "alpha" },
          { value: "beta", label: "beta" },
        ],
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("bet"));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("\r"));
    const result = yield* Fiber.join(fiber);

    expect(result).toBe("beta");
  }),
);

it.effect("keeps required cycle edits open until something changes", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .cycle({
        message: "Manage accounts",
        requireChange: true,
        options: [
          {
            label: "Cloudflare",
            states: [
              { value: "keep", label: "keep" },
              { value: "remove", label: "remove" },
            ],
          },
        ],
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("\r"));
    yield* settleInput;
    expect(fiber.pollUnsafe()).toBe(undefined);

    yield* Effect.sync(() => stdin.write(" "));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("\r"));
    const result = yield* Fiber.join(fiber);
    expect(result).toEqual(["remove"]);
  }),
);

it.effect("reopens browser authorization from the waiting screen", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });
    let opened = 0;

    const fiber = yield* service.prompt
      .awaitExternal({
        message: "Authorize",
        waitingLabel: "Waiting",
        url: "https://example.com/authorize",
        inputLabel: "Enter code",
        onOpen: async () => {
          opened += 1;
        },
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("o"));
    yield* settleInput;
    expect(opened).toBe(1);

    yield* Effect.sync(() => stdin.write("\r"));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("code"));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("\r"));
    const result = yield* Fiber.join(fiber);
    expect(result).toBe("code");
  }),
);

it.effect("keeps browser-only authorization cancellable", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service, stdout } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .awaitExternal({
        message: "AWS authorization",
        waitingLabel: "Waiting",
        url: "https://example.com/authorize",
        allowManualInput: false,
      })
      .pipe(Effect.flip, Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.promise(() => stdout.waitFor("AWS authorization"));
    expect(stripAnsi(stdout.output)).not.toContain("enter code manually");

    // Enter is intentionally inert for a browser-only flow.
    yield* Effect.sync(() => stdin.write("\r"));
    yield* settleInput;
    expect(fiber.pollUnsafe()).toBeUndefined();

    yield* Effect.sync(() => stdin.write("\x1b"));
    const failure = yield* Fiber.join(fiber);
    expect(failure).toBeInstanceOf(TerminalCancelled);
  }),
);

it.effect("shows a device authorization code", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service, stdout } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .awaitExternal({
        message: "AWS authorization",
        waitingLabel: "Waiting for device authorization…",
        url: "https://device.sso.example.com/",
        code: "ABCD-EFGH",
        allowManualInput: false,
      })
      .pipe(Effect.flip, Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.promise(() => stdout.waitFor("ABCD-EFGH"));

    const output = stripAnsi(stdout.output);
    expect(output).toContain("Code ABCD-EFGH");
    expect(output).toContain("copy code");

    yield* Effect.sync(() => stdin.write("\x1b"));
    const failure = yield* Fiber.join(fiber);
    expect(failure).toBeInstanceOf(TerminalCancelled);
  }),
);

it.effect("toggles every visible multi-select choice on ctrl+a", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .multiSelect({
        message: "pick",
        options: [
          { value: "alpha", label: "alpha" },
          { value: "beta", label: "beta" },
          { value: "gamma", label: "gamma", disabled: true },
        ],
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("\x01"));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("\r"));
    const result = yield* Fiber.join(fiber);

    expect(result).toEqual(["alpha", "beta"]);
  }),
);

it.effect("returns an explicit undefined menu back target on Escape", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .menu<string | undefined>({
        message: "pick",
        back: undefined,
        options: [{ value: "alpha", label: "alpha" }],
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("\x1b"));
    const result = yield* Fiber.join(fiber);

    expect(result).toBe(undefined);
  }),
);

it.effect("cleans up a cancelled standalone prompt", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    const failure = yield* service.prompt
      .custom(
        Screen.make("cancel test", ({ cancel }) => {
          queueMicrotask(cancel);
          return <Status>Waiting</Status>;
        }),
      )
      .pipe(Effect.flip);

    expect(failure).toBeInstanceOf(TerminalCancelled);
    expect(stdout.output).toContain("cancel test cancelled");
  }),
);

it.effect("releases the renderer when a running prompt is interrupted", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .custom(Screen.make("interrupted", () => <Status>Waiting</Status>))
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Fiber.interrupt(fiber);

    // The interrupted prompt must have released the renderer and the prompt
    // gate for the next interaction.
    const result = yield* service.prompt.custom(
      Screen.make("after interruption", ({ submit }) => {
        queueMicrotask(() => submit("ok"));
        return <Status>After</Status>;
      }),
    );
    expect(result).toBe("ok");
  }),
);

it.effect("closes leaked live handles when their scope closes", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* service.live.open(<Text>Leaky</Text>);
        // Deliberately no close — the enclosing scope must release the row
        // and unmount the renderer.
      }),
    );

    expect(stdout.output).toContain("[?25h");
  }),
);

it.effect("fails the active prompt when a screen throws during render", () =>
  Effect.gen(function* () {
    const { service } = yield* makeLive();
    const Broken = (): never => {
      throw new Error("screen render boom");
    };

    // Without exit observation this would hang forever: the screen's
    // submit/cancel can never run once the renderer has crashed.
    const exit = yield* service.prompt
      .custom(Screen.make("broken screen", () => <Broken />))
      .pipe(Effect.exit);

    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it.effect("cancels a screen with no cancel wiring on ctrl+c", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service, stdout } = yield* makeLive({ stdin });

    // The screen never touches the controller — the centralized handler in
    // the runtime must still turn Ctrl+C into a cancellation.
    const fiber = yield* service.prompt
      .custom(Screen.make("no cancel wiring", () => <Status>Waiting</Status>))
      .pipe(Effect.flip, Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("\x03"));
    const failure = yield* Fiber.join(fiber);

    expect(failure).toBeInstanceOf(TerminalCancelled);
    expect(stdout.output).toContain("no cancel wiring cancelled");
  }),
);

it.effect("keeps one renderer alive for an Effect-driven application", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    const result = yield* service.application(
      Effect.gen(function* () {
        const action = yield* service.prompt.custom(
          Screen.make("main menu", ({ submit }) => {
            queueMicrotask(() => submit("add"));
            return <Status>Main menu</Status>;
          }),
        );
        const name = yield* service.wizard(
          service.prompt.custom(
            Screen.make("auth flow", ({ submit }) => {
              queueMicrotask(() =>
                submit("cloudflare", <Status>Profile name</Status>),
              );
              return <Status>Cloudflare auth</Status>;
            }),
          ),
        );
        const done = yield* service.prompt.custom(
          Screen.make("returned menu", ({ submit }) => {
            queueMicrotask(() => submit(true));
            return <Status>Returned menu</Status>;
          }),
        );
        return { action, name, done };
      }),
    );

    expect(result).toEqual({
      action: "add",
      name: "cloudflare",
      done: true,
    });
    // Clearing an inline application first renders an empty frame. Its final
    // row must be reclaimed before teardown or the next shell prompt starts
    // one line too low.
    expect(stdout.output.slice(stdout.output.lastIndexOf("\n") + 1)).toContain(
      "\u001B[1A",
    );
  }),
);

it.effect("provides CliKit once as a scoped injectable service", () => {
  const stdout = new CaptureStream();
  return Effect.gen(function* () {
    const capabilities = yield* CliKit.useSync((cli) => cli.terminal);
    const cli = yield* CliKit;
    yield* cli.output.print("Injected");

    expect(capabilities.input).toBe(false);
    expect(capabilities.colors).toBe(false);
    expect(stdout.output).toContain("Injected");
  }).pipe(
    Effect.provide(
      cliKitLayer({
        input: false,
        stdout: stdout as unknown as NodeJS.WriteStream,
        captureConsole: false,
      }),
    ),
  );
});

it.effect("uses append-only progress when input is disabled on a TTY", () => {
  const stdout = new CaptureStream(true);
  return Effect.gen(function* () {
    const cli = yield* CliKit;
    const progress = yield* cli.live.progress({ label: "Deploying" });
    yield* progress.update({ label: "Uploading" });
    yield* progress.succeed("Deployed");

    expect(cli.terminal.input).toBe(false);
    expect(stdout.output).toContain("Deploying\n");
    expect(stdout.output).toContain("Deployed\n");
    expect(stdout.output).not.toContain("\u001B[");
  }).pipe(
    Effect.provide(
      cliKitLayer({
        input: false,
        stdout: stdout as unknown as NodeJS.WriteStream,
        captureConsole: false,
      }),
    ),
  );
});

it.effect(
  "renders the same semantic and component output without terminal input",
  () =>
    Effect.gen(function* () {
      const { service, stdout } = yield* makeLive({
        input: false,
        unicode: false,
      });

      yield* service.output.info("Resolving credentials");
      yield* service.output.success({
        message: "Authenticated",
        detail: "cloudflare",
      });
      yield* service.output.warning("Token expires soon");
      yield* service.output.error("Authentication failed");
      yield* service.output.print(
        <Alert variant="warning" title="Attention">
          Manual action required
        </Alert>,
      );
      yield* service.output.print(<Status>React output</Status>);

      expect(stdout.output).toContain("Resolving credentials\n");
      expect(stdout.output).toContain("Authenticated");
      expect(stdout.output).toContain("cloudflare");
      expect(stdout.output).toContain("Token expires soon");
      expect(stdout.output).toContain("Authentication failed");
      expect(stdout.output).toContain("Attention");
      expect(stdout.output).toContain("Manual action required");
      expect(stdout.output).toContain("React output");
    }),
);

it.effect(
  "renders application, transcript, live-work, and data primitives together",
  () =>
    Effect.gen(function* () {
      const { service } = makeStatic();
      const rendered = yield* service.output.render(
        <>
          <Tabs
            tabs={[
              { id: "dev", label: "dev" },
              { id: "prod", label: "prod", marked: true },
            ]}
            active="prod"
          />
          <AnsweredPrompt message="Account" answer="production" />
          <TaskRow spinning label="stack" />
          <TaskRow icon="+" label="worker" depth={1} />
          <ProgressGroup
            rows={[
              {
                id: "providers",
                label: "providers",
                completed: 2,
                total: 4,
              },
            ]}
          />
          <Status>q quit</Status>
        </>,
      );

      expect(rendered).toContain("prod");
      expect(rendered).toContain("production");
      expect(rendered).toContain("worker");
      expect(rendered).toContain("2/4");
    }),
);
