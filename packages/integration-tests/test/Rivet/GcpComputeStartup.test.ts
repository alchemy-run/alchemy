import { startupScript } from "@alchemy.run/rivet/GCP/ComputeEnginePool";
import { describe, expect, it } from "@alchemy.run/test";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Stream from "effect/Stream";

interface Boot {
  /** Whether a node container already runs: a deploy reaching the node, not a boot. */
  readonly running: boolean;
  readonly index: number;
  readonly replicas?: number;
  /** Whether node `index - 1` has written its marker for this rollout. */
  readonly previousDone?: boolean;
  /** Nodes the control plane lists as connected and not stopping. */
  readonly connected?: number;
  readonly rolloutTimeout?: number;
  /** Secret versions in metadata, and the value each one holds (`undefined`: unreadable). */
  readonly secrets?: Record<string, { readonly version: string; readonly value?: string }>;
}

/**
 * Run a node's startup script up to the end of its first `start`, on this
 * machine, with `curl`, `docker` and `sleep` replaced by stubs that answer
 * as the metadata server, Cloud Storage, Secret Manager and the control
 * plane would, and log what the script asked for. Returns the log, what
 * the script printed, and the env file the node got.
 */
const boot = (options: Boot) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "rivet-node-" });
    const bin = path.join(dir, "bin");
    const app = path.join(dir, "app");
    const log = path.join(dir, "log");
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.makeDirectory(app, { recursive: true });
    yield* fs.writeFileString(log, "");
    const stub = Effect.fn(function* (name: string, body: string) {
      yield* fs.writeFileString(path.join(bin, name), `#!/bin/bash\n${body}\n`);
      yield* fs.chmod(path.join(bin, name), 0o755);
    });
    const replicas = options.replicas ?? 3;
    // The pool always hands its nodes the control plane's token as a secret.
    const secrets = Object.entries(
      options.secrets ?? {
        RIVET_TOKEN: { version: "projects/p/secrets/token/versions/1", value: "admin token" },
      },
    );
    const token = options.secrets?.RIVET_TOKEN?.value ?? "admin token";
    const node = (connected: boolean, stopping: boolean) =>
      `{"key":"k","pool":"p","namespace":"n","datacenter":"d","create_ts":1,"last_ping_ts":1,"connected":${connected},"stopping":${stopping}}`;
    // Connected nodes, plus one gone and one draining, which never count.
    const nodes = `{"nodes":[${[
      ...Array.from({ length: options.connected ?? replicas }, () => node(true, false)),
      node(false, false),
      node(true, true),
    ].join(",")}],"pagination":{"cursor":null}}`;
    const encode = (value: string) => Buffer.from(value).toString("base64");
    yield* stub(
      "curl",
      `url="\${@: -1}"
for a in "$@"; do
  [ "$prev" = "-X" ] && method="$a"
  [ "$prev" = "-H" ] && case "$a" in Authorization:*) auth="$a";; esac
  prev="$a"
done
case "$url" in
  *service-accounts/default/token) echo '{"access_token":"t"}';;
  *attributes/rivet-node-env) printf 'RIVET_ENDPOINT=http://engine\\nRIVET_POOL=p\\nRIVET_NAMESPACE=n';;
  *attributes/rivet-node-index) echo ${options.index};;
  *attributes/rivet-node-replicas) echo ${replicas};;
  *attributes/rivet-node-rollout) echo r1;;
  *attributes/rivet-node-secrets) printf '%s' '${secrets.map(([name, { version }]) => `${name}=${version}`).join("\n")}';;
${secrets
  .filter(([, secret]) => secret.value !== undefined)
  .map(
    ([, { version, value }]) =>
      `  *secretmanager.googleapis.com/v1/${version}:access) echo '{"payload": {"data": "${encode(value!)}"}}';;`,
  )
  .join("\n")}
  *node.mjs?alt=media|*node.tar?alt=media) for a in "$@"; do [ "$p" = "-o" ] && : > "$a"; p="$a"; done;;
  http://engine/pools/p/nodes?namespace=n*) [ "$auth" = "Authorization: Bearer ${token}" ] || exit 22; echo '${nodes}';;
  *upload/storage/v1/b/b/o*) echo "marker $(echo "$url" | sed 's/.*name=//')" >> ${log};;
  *storage/v1/b/b/o/rollout%2Fr1%2F${options.index - 1}) ${options.previousDone ? "exit 0" : "exit 22"};;
  *) exit 22;;
esac`,
    );
    yield* stub(
      "docker",
      `echo "docker $*" >> ${log}
for a in "$@"; do [ "$prev" = "-e" ] && echo "env $a=\${!a}" >> ${log}; prev="$a"; done
case "$1" in
  load) echo "Loaded image: rivet-node-p:latest";;
  inspect) ${options.running ? "exit 0" : "exit 1"};;
esac`,
    );
    yield* stub("sleep", `echo "sleep $1" >> ${log}`);
    // Each test sees one turn of the wait, so a timeout of 0 holds at once.
    const script = startupScript({
      bucket: "b",
      image: false,
      stopTimeout: 30,
      rolloutTimeout: options.rolloutTimeout ?? 600,
    })
      .replaceAll("/var/lib/rivet-node", app)
      .replaceAll("/dev/ttyS0", "/dev/stdout")
      .split("\nstart\n")[0];
    yield* fs.writeFileString(path.join(dir, "startup.sh"), `${script}\nstart\nexit 0\n`);
    const handle = yield* ChildProcess.make("bash", [path.join(dir, "startup.sh")], {
      env: { PATH: `${bin}:${process.env.PATH}` },
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output] = yield* Effect.all(
      [
        handle.stdout.pipe(
          Stream.decodeText,
          Stream.runCollect,
          Effect.map((chunks) => chunks.join("")),
        ),
        handle.stderr.pipe(Stream.runDrain),
        handle.exitCode,
      ],
      { concurrency: 3 },
    );
    const calls = (yield* fs.readFileString(log)).trim().split("\n").filter(Boolean);
    const envList = path.join(app, "env.list");
    const envFile = (yield* fs.exists(envList)) ? yield* fs.readFileString(envList) : undefined;
    return { calls, output, envFile };
  }).pipe(Effect.scoped, Effect.provide(PlatformServices));

const restarted = (calls: readonly string[]) =>
  calls.some((call) => call.startsWith("docker stop"));

describe("RivetGCP.ComputeEnginePool startup script", { tags: ["unit"] }, () => {
  it.live(
    "a deploy restarts node i once node i-1 runs the new program and every node is connected",
    () =>
      Effect.gen(function* () {
        const { calls } = yield* boot({ running: true, index: 2, previousDone: true });
        expect(calls).toEqual([
          "docker pull -q node:26-slim",
          "docker inspect rivet-node",
          "docker stop -t 30 rivet-node",
          "docker rm -f rivet-node",
          expect.stringMatching(
            /^docker run -d --name rivet-node --restart always --network host --init --stop-timeout 30 --env-file \S+ -e RIVET_TOKEN -v \S+node.mjs:\/program\/node.mjs:ro -w \/app node:26-slim sh -c .*rivetkit@3.0.0 /,
          ),
          "env RIVET_TOKEN=admin token",
          // Its own turn done, it tells node 3.
          "marker rollout%2Fr1%2F2",
        ]);
      }),
  );

  it.live("node i holds its program while node i-1 has not restarted", () =>
    Effect.gen(function* () {
      const { calls, output } = yield* boot({
        running: true,
        index: 2,
        previousDone: false,
        rolloutTimeout: 0,
      });
      expect(restarted(calls)).toBe(false);
      expect(calls.some((call) => call.startsWith("docker run"))).toBe(false);
      expect(calls.some((call) => call.startsWith("marker"))).toBe(false);
      expect(output).toContain(
        "rollout r1: node 1 did not come back within 0s; keeping this node on its current program",
      );
    }),
  );

  it.live("node i holds its program while the control plane lists a node missing", () =>
    Effect.gen(function* () {
      const { calls } = yield* boot({
        running: true,
        index: 1,
        previousDone: true,
        connected: 2,
        rolloutTimeout: 0,
      });
      expect(restarted(calls)).toBe(false);
    }),
  );

  it.live("the first node waits for the whole pool, not for a marker", () =>
    Effect.gen(function* () {
      expect(restarted((yield* boot({ running: true, index: 0 })).calls)).toBe(true);
      const short = yield* boot({ running: true, index: 0, connected: 2, rolloutTimeout: 0 });
      expect(restarted(short.calls)).toBe(false);
    }),
  );

  it.live("a node that boots starts at once", () =>
    Effect.gen(function* () {
      const { calls } = yield* boot({ running: false, index: 2 });
      expect(restarted(calls)).toBe(false);
      expect(calls.some((call) => call.startsWith("docker run"))).toBe(true);
    }),
  );

  it.live(
    "a node reads its secrets and the control plane's token from Secret Manager, not metadata",
    () =>
      Effect.gen(function* () {
        const { calls, envFile } = yield* boot({
          running: true,
          index: 1,
          previousDone: true,
          secrets: {
            RIVET_TOKEN: { version: "projects/p/secrets/rivet/versions/2", value: "admin token" },
            DATABASE_URL: {
              version: "projects/p/secrets/db/versions/7",
              value: "postgres://u:p@h/db?x=1",
            },
          },
        });
        // The node asked the control plane with the token it read: the
        // rollout went ahead.
        expect(restarted(calls)).toBe(true);
        const run = calls.findIndex((call) => call.startsWith("docker run"));
        expect(calls[run]).toContain(" -e RIVET_TOKEN -e DATABASE_URL ");
        expect(calls.slice(run + 1, run + 3)).toEqual([
          "env RIVET_TOKEN=admin token",
          "env DATABASE_URL=postgres://u:p@h/db?x=1",
        ]);
        expect(envFile).toBe("RIVET_ENDPOINT=http://engine\nRIVET_POOL=p\nRIVET_NAMESPACE=n");
      }),
  );

  it.live("a node that cannot read a secret keeps running what it ran", () =>
    Effect.gen(function* () {
      const { calls } = yield* boot({
        running: true,
        index: 0,
        secrets: { RIVET_TOKEN: { version: "projects/p/secrets/rivet/versions/3" } },
      });
      expect(restarted(calls)).toBe(false);
      expect(calls.some((call) => call.startsWith("docker run"))).toBe(false);
    }),
  );
});
