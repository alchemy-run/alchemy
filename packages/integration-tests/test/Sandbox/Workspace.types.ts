import * as Sandbox from "@alchemy.run/sandbox";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class Workspace extends Sandbox.Workspace<Workspace>()("WorkspaceTypes") {}
class Other extends Sandbox.Workspace<Other>()("OtherTypes") {}

class TestsFailed extends Data.TaggedError("TestsFailed")<{ readonly stderr: string }> {}

export const program = Effect.gen(function* () {
  const workspace = yield* Workspace;

  // `open` provides the session: it's gone from R, the effect's error stays.
  const opened = workspace.open(
    "issue-42",
    {},
    Effect.gen(function* () {
      const box = yield* Workspace.Session;
      const [, tests] = yield* Effect.all([box.exec("pnpm install"), box.exec("pnpm test")], {
        concurrency: "unbounded",
      });
      if (tests.exitCode !== 0) return yield* new TestsFailed({ stderr: tests.stderr });
      return tests.stdout;
    }),
  );
  type _opened = Assert<
    Equal<
      typeof opened,
      Effect.Effect<string, TestsFailed | Sandbox.WorkspaceError, RuntimeContext>
    >
  >;

  // A session outside its `open` stays in R.
  const outside = Effect.flatMap(Workspace.Session, (box) => box.exec("ls"));
  type _outside = Assert<
    Equal<Effect.Services<typeof outside>, Sandbox.Workspace.Session<Workspace> | RuntimeContext>
  >;

  // Another workspace's open doesn't provide this one's session.
  const crossed = workspace.open("issue-42", {}, Workspace.Session);
  const other = (yield* Other).open("issue-42", {}, Workspace.Session);
  type _crossed = Assert<Equal<Effect.Services<typeof crossed>, RuntimeContext>>;
  type _other = Assert<
    Equal<Effect.Services<typeof other>, Sandbox.Workspace.Session<Workspace> | RuntimeContext>
  >;

  const output = workspace.exec("issue-42", "git status");
  type _output = Assert<
    Equal<
      typeof output,
      Effect.Effect<Sandbox.WorkspaceExecOutput, Sandbox.WorkspaceError, RuntimeContext>
    >
  >;

  return { opened, outside, crossed, other, output };
});

// Yielding a workspace needs its host on the stack.
type _host = Assert<
  Equal<
    Effect.Services<typeof program>,
    Sandbox.Workspace.Host<Workspace> | Sandbox.Workspace.Host<Other>
  >
>;
