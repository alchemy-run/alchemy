import * as Ssh from "@/Ssh";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface Issued {
  command: string;
  options: Ssh.ExecOptions;
}

/** An answer to one command, or the session dropping on it. */
export type Respond = (
  command: string,
  options: Ssh.ExecOptions,
) => Partial<Ssh.ExecResult> | Ssh.ConnectionLost | undefined;

export const ok = (stdout = ""): Partial<Ssh.ExecResult> => ({
  code: 0,
  stdout,
});

export const lost = () =>
  new Ssh.ConnectionLost({
    message: "ssh exited 255",
    host: "203.0.113.5",
    stderr: "",
  });

/** Answers commands in the order they arrive. */
export const inOrder = (
  answers: ReadonlyArray<Partial<Ssh.ExecResult> | Ssh.ConnectionLost>,
): Respond => {
  let index = 0;
  return () => answers[index++];
};

/**
 * A `Ssh.Client` that records every command and answers from `respond`, so a
 * step's decisions can be pinned without a host.
 */
export const fakeClient = (
  respond: Respond,
  options: {
    redact?: (value: string) => string;
    facts?: Partial<Ssh.Facts>;
  } = {},
) => {
  const issued: Issued[] = [];
  const facts = {
    distroId: "ubuntu",
    distroVersion: "24.04",
    arch: "x86_64",
    initSystem: "systemd",
    pkgManager: "apt",
    ...options.facts,
  };
  const client: Ssh.ClientShape = {
    host: "203.0.113.5",
    user: "ubuntu",
    exec: (command, execOptions = {}) =>
      Effect.suspend(() => {
        issued.push({ command, options: execOptions });
        if (command.startsWith(". /etc/os-release")) {
          return Effect.succeed({
            code: 0,
            stdout: [
              facts.distroId,
              facts.distroVersion,
              facts.arch,
              facts.initSystem ?? "-",
              facts.pkgManager ?? "-",
            ].join("\n"),
            stderr: "",
          });
        }
        const answer = respond(command, execOptions) ?? {};
        return answer instanceof Ssh.ConnectionLost
          ? Effect.fail(answer)
          : Effect.succeed({
              code: answer.code ?? 0,
              stdout: answer.stdout ?? "",
              stderr: answer.stderr ?? "",
            });
      }),
    upload: () => Effect.void,
    ping: Effect.void,
    redact: options.redact ?? ((value) => value),
  };
  return {
    client,
    issued,
    /** Run `body` as a recipe in `mode` against the fake client. */
    run: (
      body: Ssh.RecipeDefinition<any>["run"],
      mode: Ssh.Mode = "apply",
      handlers?: Ssh.RecipeDefinition<any>["handlers"],
    ) =>
      Ssh.run(
        Ssh.make({
          main: import.meta.url,
          name: "test",
          vars: Schema.Struct({}),
          handlers,
          run: body,
        }),
        { client, mode, vars: {} },
      ),
  };
};
