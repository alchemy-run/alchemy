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
  AppShell,
  ConsoleFeed,
  ConsoleFeedView,
  DescriptionList,
  Heading,
  MasterDetail,
  Panel,
  ProgressGroup,
  Status,
  Table,
  Tabs,
  TaskTree,
  Text,
  TextField,
  Transcript,
  TranscriptStore,
  interceptConsole,
} from "@/Cli/CliKit/components.ts";
import type { CliKitService } from "@/Cli/CliKit/CliKit.ts";
import { makeRuntime } from "@/Cli/CliKit/InkRuntime.tsx";
import { isInProgress } from "@/Cli/views/statusStyle.ts";
import { makeResourceLogger, makeResourceOutput } from "@/Cli/Output.ts";
import { stackOutputsView } from "@/Cli/views/StackOutputs.tsx";
import {
  buildStageNodes,
  stateExplorerScreen,
  StateExplorerStore,
  type StateExplorerSource,
} from "@/Cli/views/StateExplorer.tsx";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import { expect, it } from "alchemy-test";

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
}

class InputStream extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  private resolveReady!: () => void;
  readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  setRawMode(mode: boolean) {
    this.isRaw = mode;
    if (mode) this.resolveReady();
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
      stdout: stdout as unknown as NodeJS.WriteStream,
      captureConsole: false,
    },
    {
      input: false,
      columns: stdout.columns,
      rows: stdout.rows,
      colors: false,
      unicode: true,
    },
  );
  return { ...runtime, stdout };
};

const makeExplorerSource = () => {
  const calls = { stacks: 0, stages: 0, resources: 0, files: 0 };
  const source: StateExplorerSource = {
    backend: "local",
    listStacks: async () => {
      calls.stacks++;
      return ["app"];
    },
    listStages: async () => {
      calls.stages++;
      return ["prod"];
    },
    listResources: async () => {
      calls.resources++;
      return ["Api/Worker"];
    },
    readFile: async () => {
      calls.files++;
      return { status: "created", url: "https://workers.dev" };
    },
    deleteNodes: async () => {},
  };
  return { calls, source };
};

const explorerSource = makeExplorerSource().source;

it("builds Finder-style namespace columns from FQN names", () => {
  const nodes = buildStageNodes("app", "prod", ["Api/Worker"]);
  expect(nodes.map((node) => node.name)).toEqual(["Api", "output.json"]);
  const api = nodes[0];
  expect(api?.kind).toBe("namespace");
  if (api?.kind === "namespace") {
    expect(api.children.map((node) => node.name)).toEqual(["Worker.json"]);
  }
});

it("loads state columns and file contents only when selected", async () => {
  const { calls, source } = makeExplorerSource();
  const store = new StateExplorerStore(source);
  store.loadRoot();
  await Promise.resolve();
  expect(calls).toEqual({ stacks: 1, stages: 0, resources: 0, files: 0 });

  const root = store.snapshot().root;
  expect(root.status).toBe("ready");
  if (root.status !== "ready") return;
  const stack = root.value[0]!;
  store.loadChildren(stack);
  await Promise.resolve();
  expect(calls).toEqual({ stacks: 1, stages: 1, resources: 0, files: 0 });

  const stages = store.snapshot().children.get(stack.id);
  if (stages?.status !== "ready") return;
  const stage = stages.value[0]!;
  store.loadChildren(stage);
  await Promise.resolve();
  expect(calls).toEqual({ stacks: 1, stages: 1, resources: 1, files: 0 });

  const state = store.snapshot().children.get(stage.id);
  if (state?.status !== "ready") return;
  const namespace = state.value.find((node) => node.kind === "namespace");
  if (namespace?.kind !== "namespace") return;
  store.loadFile(namespace.children[0]!);
  await Promise.resolve();
  expect(calls).toEqual({ stacks: 1, stages: 1, resources: 1, files: 1 });
});

it("formats stack outputs as labeled values instead of a raw object dump", () => {
  const { service } = makeStatic();
  const output = service.output.format(
    stackOutputsView({
      apiUrl: "https://example.com",
      metadata: { region: "us-east-1", replicas: 2 },
    }),
  );

  expect(output).toContain("Outputs");
  expect(output).toContain("apiUrl");
  expect(output).toContain("https://example.com");
  expect(output).toContain("metadata");
  expect(output).toContain("region");
});

/**
 * Scoped variant of `makeStatic` for tests that mount a persistent renderer.
 * Disposal runs as a finalizer, so a failing test never leaks an Ink
 * instance.
 */
const makeLive = (
  overrides: {
    readonly stdin?: InputStream;
    readonly captureConsole?: boolean;
    readonly input?: boolean;
    readonly unicode?: boolean;
  } = {},
) => {
  const input = overrides.input ?? true;
  return Effect.acquireRelease(
    Effect.sync(() => {
      const stdout = new CaptureStream(input);
      const runtime = makeRuntime(
        {
          input,
          stdin: overrides.stdin as unknown as NodeJS.ReadStream | undefined,
          stdout: stdout as unknown as NodeJS.WriteStream,
          captureConsole: overrides.captureConsole ?? false,
        },
        {
          input,
          columns: stdout.columns,
          rows: stdout.rows,
          colors: false,
          unicode: overrides.unicode ?? true,
        },
      );
      return { ...runtime, stdout };
    }),
    ({ dispose }) => Effect.promise(dispose),
  );
};

it.effect(
  "keeps the state explorer active while searching and quits cleanly",
  () =>
    Effect.gen(function* () {
      const stdin = new InputStream();
      const { service } = yield* makeLive({ stdin });
      const fiber = yield* service
        .application(service.prompt.custom(stateExplorerScreen(explorerSource)))
        .pipe(Application.alternate)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => stdin.ready);
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setTimeout(resolve, 75)),
      );

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
      <Panel title="Profile">
        <DescriptionList
          items={[
            { label: "Name", value: "production" },
            { label: "Status", value: "ready" },
          ]}
        />
      </Panel>,
    );

    expect(rendered).toContain("Profile");
    expect(rendered).toContain("production");
    expect(rendered).toContain("ready");
    expect(stdout.output).toBe("");
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

it.effect("prints tables and nested sections through one service", () =>
  Effect.gen(function* () {
    const { service, stdout } = makeStatic();
    yield* service.output.section(
      "Deployments",
      service.output.print(
        <Table
          rows={[
            { name: "api", status: "ready" },
            { name: "worker", status: "updating" },
          ]}
          columns={[
            {
              key: "name",
              header: "Resource",
              width: 20,
              cell: (row) => row.name,
            },
            {
              key: "status",
              header: "Status",
              grow: 1,
              cell: (row) => row.status,
            },
          ]}
          getKey={(row) => row.name}
        />,
      ),
    );

    expect(stdout.output).toContain("Deployments");
    expect(stdout.output).toContain("Resource");
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

it.effect("tears down mutable live views idempotently", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    const live = yield* service.live.open(<Text>Scanning</Text>);
    yield* live.update(<Text>Deleting</Text>);
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
    const second = yield* service.live.open(<Text>second</Text>, {
      persistOnClose: true,
    });
    yield* Fiber.join(closing);
    yield* second.update(<Text>second updated</Text>);
    yield* second.close;

    expect(stdout.output).toContain("second updated");
  }),
);

interface OrderingCase {
  readonly name: string;
  readonly captureConsole: boolean;
  readonly emit: (service: CliKitService) => Effect.Effect<void>;
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
    name: "keeps captured logs static and ordered before completed live views",
    captureConsole: true,
    emit: () => Effect.sync(() => console.log("runtime ready")),
    verify: (output) => {
      expect(output.match(/runtime ready/g)?.length).toBe(1);
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
    const { service, stdout } = yield* makeLive({ captureConsole });

    const live = yield* service.live.open(<Text>Deploying</Text>, {
      persistOnClose: true,
    });
    yield* emit(service);
    yield* live.update(<Text>Deployed</Text>);
    yield* live.close;

    verify(stdout.output);
  }),
);

it("restores nested console interceptors in any disposal order", () => {
  const original = console.log;
  const first: string[] = [];
  const second: string[] = [];
  const restoreFirst = interceptConsole((entry) => first.push(entry.text));
  const restoreSecond = interceptConsole((entry) => second.push(entry.text));
  try {
    console.log("second owns this");
    restoreFirst();
    console.log("second still owns this");
  } finally {
    restoreFirst();
    restoreSecond();
  }

  expect(first).toEqual([]);
  expect(second).toEqual(["second owns this", "second still owns this"]);
  expect(console.log).toBe(original);
});

it("keeps a foreign console wrapper functional after interception", () => {
  const platformConsole = console.log;
  const forwarded: string[] = [];
  console.log = (...args) => forwarded.push(args.join(" "));
  const restore = interceptConsole(() => undefined);
  const routedConsole = console.log;
  console.log = (...args) => routedConsole(...args);
  try {
    restore();
    console.log("still visible");
  } finally {
    restore();
    console.log = platformConsole;
  }

  expect(forwarded).toEqual(["still visible"]);
});

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
    expect(stdout.output).toContain("✖");
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
    expect(rendered).toContain("v Deploy");
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
    expect(rendered).not.toContain("✖");
  }),
);

it.effect("runs interactive components inside the owned session", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    const result = yield* service.prompt.custom(
      Screen.make("test screen", ({ submit }) => {
        setTimeout(() => submit("completed", <Status>Done</Status>), 0);
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
            setTimeout(() => submit(undefined), 0);
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

/** Let a written stdin chunk flow through Ink's input pipeline. */
const settleInput = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
);

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
          setTimeout(cancel, 0);
          return <Status>Waiting</Status>;
        }),
      )
      .pipe(Effect.flip);

    expect(failure).toBeInstanceOf(TerminalCancelled);
    expect(stdout.output).toContain("Cancelled");
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
    expect(stdout.output).toContain("Cancelled");
  }),
);

it.effect("keeps one renderer alive for an Effect-driven application", () =>
  Effect.gen(function* () {
    const { service } = yield* makeLive();

    const result = yield* service.application(
      Effect.gen(function* () {
        const action = yield* service.prompt.custom(
          Screen.make("main menu", ({ submit }) => {
            setTimeout(() => submit("add" as const), 0);
            return <Status>Main menu</Status>;
          }),
        );
        const name = yield* service.wizard(
          service.prompt.custom(
            Screen.make("auth flow", ({ submit }) => {
              setTimeout(
                () => submit("cloudflare", <Status>Profile name</Status>),
                0,
              );
              return <Status>Cloudflare auth</Status>;
            }),
          ),
        );
        const done = yield* service.prompt.custom(
          Screen.make("returned menu", ({ submit }) => {
            setTimeout(() => submit(true), 0);
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
    expect(stdout.output).toContain("success: Deployed\n");
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
      yield* service.output.alert({
        variant: "warning",
        title: "Attention",
        message: "Manual action required",
      });
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
      const transcript = new TranscriptStore();
      transcript.append(
        <AnsweredPrompt message="Account" answer="production" />,
      );
      const feed = new ConsoleFeed();
      feed.append("log", "Uploaded %d files", 3);
      feed.append("warn", "Retrying request");

      const rendered = yield* service.output.render(
        <AppShell
          header={
            <Tabs
              tabs={[
                { id: "dev", label: "dev" },
                { id: "prod", label: "prod", marked: true },
              ]}
              active="prod"
            />
          }
          footer={<Status>q quit</Status>}
        >
          <MasterDetail
            master={<Text>Profiles</Text>}
            detail={
              <>
                <Transcript store={transcript} />
                <TaskTree
                  tasks={[
                    {
                      id: "stack",
                      label: "stack",
                      status: "running",
                      children: [
                        { id: "worker", label: "worker", status: "success" },
                      ],
                    },
                  ]}
                />
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
                <ConsoleFeedView feed={feed} />
              </>
            }
          />
        </AppShell>,
      );

      expect(rendered).toContain("prod");
      expect(rendered).toContain("production");
      expect(rendered).toContain("worker");
      expect(rendered).toContain("2/4");
      expect(rendered).toContain("Uploaded 3 files");
      expect(rendered).toContain("Retrying request");
    }),
);
