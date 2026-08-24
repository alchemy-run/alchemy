/** @jsxImportSource react */
import { PassThrough } from "node:stream";
import {
  NonInteractiveTerminal,
  Application,
  Screen,
  TerminalCancelled,
  CliKit,
  hyperlink,
  stripAnsi,
  layer as cliKitLayer,
} from "@/Cli/CliKit/index.ts";
import {
  AnsweredPrompt,
  Alert,
  DescriptionList,
  Heading,
  LiveStore,
  ProgressGroup,
  SectionHeading,
  Status,
  Tabs,
  TaskRow,
  Text,
  TextField,
  useLiveStore,
} from "@/Cli/CliKit/components.ts";
import { makeRuntime } from "@/Cli/CliKit/SigilRuntime.tsx";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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
        },
        {
          input,
          columns: stdout.columns,
          rows: stdout.rows,
          colors: false,
          unicode: overrides.unicode ?? true,
          alternateScreen: input,
        },
      );
      return { ...runtime, stdout, stderr };
    }),
    ({ dispose }) => Effect.promise(dispose),
  );
};

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

it.effect("preserves zero in primitive-array views", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();
    const rendered = yield* service.output.render(["count: ", 0, false, null]);

    expect(rendered).toBe("count: 0");
  }),
);

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
    const { service } = yield* makeLive();

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
