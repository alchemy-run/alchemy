import * as Ssh from "@/Ssh";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const describe = layer(NodeServices.layer);

interface Call {
  bin: string;
  args: ReadonlyArray<string>;
  stdin: string | undefined;
}

interface Answer {
  code?: number;
  stdout?: string;
  stderr?: string;
}

/** What the remote shell prints for a command that wrote `stdout` and exited `code`. */
const reported = (code: number, stdout = "", options?: { sudo?: boolean }) =>
  `${options?.sudo ? "__alchemy_ssh_sudo\n" : ""}${stdout}\n__alchemy_ssh_rc=${code}\n`;

/** An `ssh`/`scp` stand-in that records every invocation and answers from `respond`. */
const fakeSsh = (respond: (call: Call) => Answer = () => ({})) => {
  const calls: Call[] = [];
  const encode = (text: string) => new TextEncoder().encode(text);
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert(command._tag === "StandardCommand");
      const input = command.options.stdin;
      const stdin = Stream.isStream(input)
        ? new TextDecoder().decode(
            Buffer.concat(yield* Stream.runCollect(input)),
          )
        : undefined;
      const call = { bin: command.command, args: command.args, stdin };
      calls.push(call);
      const answer = respond(call);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(
          ChildProcessSpawner.ExitCode(answer.code ?? 0),
        ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encode(answer.stdout ?? "")),
        stderr: Stream.make(encode(answer.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  return {
    calls,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  };
};

const connect = (options?: Partial<Ssh.ConnectOptions>) =>
  Ssh.connect({ host: "203.0.113.5", user: "ubuntu", ...options });

describe("Ssh.Client", (it) => {
  it.effect(
    "returns the remote exit code instead of ssh's",
    () =>
      Effect.gen(function* () {
        const fake = fakeSsh(() => ({ stdout: reported(3, "out") }));
        const result = yield* Effect.gen(function* () {
          const client = yield* connect();
          return yield* client.exec("false", { cwd: "/srv" });
        }).pipe(Effect.scoped, Effect.provide(fake.layer));

        expect(result).toEqual({ code: 3, stdout: "out", stderr: "" });
        const [call] = fake.calls;
        expect(call!.bin).toBe("ssh");
        expect(call!.args).toContain("BatchMode=yes");
        expect(call!.args).toContain("StrictHostKeyChecking=accept-new");
        expect(call!.args.slice(-3)).toEqual([
          "ubuntu@203.0.113.5",
          "--",
          Ssh.remoteScript("false", { cwd: "/srv" }),
        ]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "classifies a session that never reached the remote shell",
    () =>
      Effect.gen(function* () {
        const failure = (stderr: string) => {
          const fake = fakeSsh(() => ({ code: 255, stderr }));
          return Effect.gen(function* () {
            const client = yield* connect();
            return yield* Effect.flip(client.exec("true"));
          }).pipe(Effect.scoped, Effect.provide(fake.layer));
        };

        expect(
          (yield* failure("ubuntu@203.0.113.5: Permission denied (publickey)."))
            ._tag,
        ).toBe("Ssh.AuthenticationFailed");
        expect((yield* failure("Host key verification failed."))._tag).toBe(
          "Ssh.HostKeyMismatch",
        );
        expect(
          (yield* failure(
            "ssh: connect to host 203.0.113.5: Connection refused",
          ))._tag,
        ).toBe("Ssh.ConnectionLost");
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "tells a refused sudo apart from the command failing",
    () =>
      Effect.gen(function* () {
        const run = (answer: Answer) => {
          const fake = fakeSsh(() => answer);
          return Effect.gen(function* () {
            const client = yield* connect();
            return yield* Effect.result(client.exec("id -u", { sudo: true }));
          }).pipe(Effect.scoped, Effect.provide(fake.layer));
        };

        const ran = yield* run({ stdout: reported(1, "0", { sudo: true }) });
        assert(ran._tag === "Success");
        expect(ran.success).toEqual({ code: 1, stdout: "0", stderr: "" });

        const refused = yield* run({
          stdout: reported(1),
          stderr: "sudo: a password is required\n",
        });
        assert(refused._tag === "Failure");
        expect(refused.failure._tag).toBe("Ssh.SudoRefused");
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "keeps Redacted env values out of errors",
    () =>
      Effect.gen(function* () {
        const secret = "hunter2-sentinel";
        const fake = fakeSsh(() => ({ code: 255, stderr: `echo ${secret}` }));
        const error = yield* Effect.gen(function* () {
          const client = yield* connect();
          return yield* Effect.flip(
            client.exec("deploy", { env: { TOKEN: Redacted.make(secret) } }),
          );
        }).pipe(Effect.scoped, Effect.provide(fake.layer));

        // Sent over stdin, never on a command line.
        expect(fake.calls[0]!.args.join(" ")).not.toContain(secret);
        expect(fake.calls[0]!.stdin).toBe(`export TOKEN='${secret}'\n`);
        expect(error.message).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "offers only the given private key",
    () =>
      Effect.gen(function* () {
        const fake = fakeSsh(() => ({ stdout: reported(0) }));
        yield* Effect.gen(function* () {
          const client = yield* connect({
            privateKey: Redacted.make("-----BEGIN KEY-----"),
            port: 2222,
          });
          yield* client.exec("true");
        }).pipe(Effect.scoped, Effect.provide(fake.layer));

        const args = fake.calls[0]!.args;
        expect(args[args.indexOf("-i") + 1]).toMatch(/alchemy-ssh-.*\/id$/);
        expect(args).toContain("IdentitiesOnly=yes");
        expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual([
          "-p",
          "2222",
        ]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "uploads bytes after creating the remote directory",
    () =>
      Effect.gen(function* () {
        const fake = fakeSsh(({ bin }) =>
          bin === "ssh" ? { stdout: reported(0) } : {},
        );
        yield* Effect.gen(function* () {
          const client = yield* connect();
          yield* client.upload(new TextEncoder().encode("hi"), "/opt/app/env");
        }).pipe(Effect.scoped, Effect.provide(fake.layer));

        expect(fake.calls.map((call) => call.bin)).toEqual(["ssh", "scp"]);
        expect(fake.calls[0]!.args.at(-1)).toBe(
          Ssh.remoteScript("mkdir -p '/opt/app'"),
        );
        expect(fake.calls[1]!.args.at(-1)).toBe(
          "ubuntu@203.0.113.5:/opt/app/env",
        );
        expect(fake.calls[1]!.args).toContain("-P");
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "waitForSsh does not retry an authentication failure",
    () =>
      Effect.gen(function* () {
        const fake = fakeSsh(() => ({
          code: 255,
          stderr: "Permission denied (publickey).",
        }));
        const error = yield* Effect.gen(function* () {
          const client = yield* connect();
          return yield* Effect.flip(
            Ssh.waitForSsh(client, {
              timeout: "1 minute",
              interval: "1 millis",
            }),
          );
        }).pipe(Effect.scoped, Effect.provide(fake.layer));

        expect(error._tag).toBe("Ssh.AuthenticationFailed");
        expect(fake.calls).toHaveLength(1);
      }),
    { tags: ["unit", "local"] },
  );
});
