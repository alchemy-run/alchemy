import * as Drift from "@/Drift.ts";
import * as Provider from "@/Provider";
import * as Ssh from "@/Ssh";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { Sandbox } from "./fixtures/recipe/recipe.ts";

const { test } = Test.make({ providers: Ssh.providers() });

const FIXTURES = `${import.meta.dirname}/fixtures`;

/**
 * An sshd container for `distro` that accepts `publicKey` as user `alchemy`
 * (with passwordless sudo), removed with the scope. Returns its host port.
 */
const sandbox = Effect.fn(function* (
  distro: "ubuntu" | "fedora",
  publicKey: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const docker = (...args: string[]) =>
    spawner.string(ChildProcess.make("docker", args));
  const image = `alchemy-test-sshd-${distro}`;
  yield* docker("build", "-q", "-t", image, `${FIXTURES}/${distro}`);
  const id = (yield* docker(
    "run",
    "-d",
    "--rm",
    "-e",
    `AUTHORIZED_KEY=${publicKey}`,
    "-p",
    "127.0.0.1::22",
    image,
  )).trim();
  yield* Effect.addFinalizer(() => docker("rm", "-f", id).pipe(Effect.ignore));
  const mapped = (yield* docker("port", id, "22")).trim();
  return Number(mapped.split("\n")[0]!.split(":").at(-1));
});

test.provider(
  "list returns [] for non-listable Ssh.Provision",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Ssh.Provision);
      expect(yield* provider.list()).toEqual([]);
    }),
  { tags: ["unit", "local"] },
);

// Needs Docker and the `ssh` client.
for (const distro of ["ubuntu", "fedora"] as const) {
  test.provider.skipIf(!!process.env.FAST)(
    `converges a ${distro} host, detects drift, and re-runs on changed vars`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const key = yield* Ssh.generateKeyPair("alchemy-test");
        const token = Redacted.make("token-sentinel");

        const port = yield* sandbox(distro, key.publicKey);

        const deploy = (greeting: string) =>
          stack.deploy(
            Ssh.Provision("Recipe", {
              host: "127.0.0.1",
              port,
              user: "alchemy",
              privateKey: Redacted.make(key.privateKey),
              // A fresh container has a fresh host key; keep the developer's
              // known_hosts out of it.
              hostKeyPolicy: "off",
              recipe: Sandbox,
              vars: { greeting, token, publicKey: key.publicKey },
            }),
          );

        const first = yield* deploy("hello");
        expect(first.pending).toEqual([]);

        // One session for out-of-band checks, as root.
        const sh = (command: string) =>
          Effect.gen(function* () {
            const client = yield* Ssh.connect({
              host: "127.0.0.1",
              port,
              user: "alchemy",
              privateKey: Redacted.make(key.privateKey),
              hostKeyPolicy: "off",
            });
            return (yield* client.exec(command, { sudo: true })).stdout;
          }).pipe(Effect.scoped);
        const drift = (repair = false) =>
          (repair ? Drift.repair : Drift.detect)({
            name: stack.name,
            stage: stack.stage,
          }).pipe(
            Effect.provide(stack.state),
            Effect.map((result) => result.resources.Recipe),
          );

        expect(yield* sh("cat /srv/app/greeting")).toBe("hello\n");
        expect(yield* sh("stat -c %a /srv/app/token")).toBe("600\n");
        expect(yield* sh("git -C /srv/checkout describe --tags")).toBe("v1\n");
        expect(yield* sh("wc -l < /srv/app/greeted")).toBe("1\n");

        // Every step converged: a dry run from state finds nothing to do.
        expect((yield* drift())?.action).toBe("unchanged");

        // A change on the host is drift, with the handler a repair notifies.
        yield* sh("echo tampered > /srv/app/greeting");
        expect(yield* drift()).toMatchObject({
          action: "drifted",
          attr: { pending: ["file[/srv/app/greeting]", "handler[greeted]"] },
        });

        // Same recipe, same vars: the deploy is a noop and never opens a
        // session, so the tampered file is left as it is.
        yield* deploy("hello");
        expect(yield* sh("cat /srv/app/greeting")).toBe("tampered\n");

        // Repairing reloads the recipe from state and converges the host.
        expect((yield* drift(true))?.action).toBe("repaired");
        expect(yield* sh("cat /srv/app/greeting")).toBe("hello\n");
        expect(yield* sh("wc -l < /srv/app/greeted")).toBe("2\n");

        // A changed var re-runs the recipe.
        const changed = yield* deploy("bonjour");
        expect(changed.pending).toEqual([]);
        expect(yield* sh("cat /srv/app/greeting")).toBe("bonjour\n");
        expect(yield* sh("wc -l < /srv/app/greeted")).toBe("3\n");

        yield* stack.destroy();
      }).pipe(Effect.scoped),
    { timeout: 300_000 },
  );
}
