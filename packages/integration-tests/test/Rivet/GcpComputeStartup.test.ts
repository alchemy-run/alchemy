import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startupScript } from "@alchemy.run/rivet/GCP/ComputeEnginePool";
import { describe, expect, test } from "@alchemy.run/test";

/**
 * Run a node's startup script up to its first `start`, on this machine, with
 * `curl`, `docker` and `sleep` replaced by stubs that log what the script
 * asked for. `running` says whether a node container already runs, as it does
 * when a deploy reaches a node rather than the node booting. Returns what the
 * stubs were asked for and the env file the node got.
 */
const boot = (options: {
  readonly running: boolean;
  readonly index: number;
  /** Secret versions in metadata, and the value each one holds (`undefined`: unreadable). */
  readonly secrets?: Record<string, { readonly version: string; readonly value?: string }>;
}) => {
  const dir = mkdtempSync(join(tmpdir(), "rivet-node-"));
  try {
    const bin = join(dir, "bin");
    const log = join(dir, "log");
    execFileSync("mkdir", ["-p", bin, join(dir, "app")]);
    writeFileSync(log, "");
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stub(
      "curl",
      `url="\${@: -1}"
case "$url" in
  *service-accounts/default/token) echo '{"access_token":"t"}';;
  *attributes/rivet-node-env) printf 'RIVET_POOL=p';;
  *attributes/rivet-node-index) echo ${options.index};;
  *attributes/rivet-node-secrets) printf '%s' '${Object.entries(options.secrets ?? {})
    .map(([name, { version }]) => `${name}=${version}`)
    .join("\n")}';;
${Object.values(options.secrets ?? {})
  .filter((secret) => secret.value !== undefined)
  .map(
    ({ version, value }) =>
      `  *secretmanager.googleapis.com/v1/${version}:access) echo '{"payload": {"data": "${Buffer.from(value!).toString("base64")}", "dataCrc32c": "1"}}';;`,
  )
  .join("\n")}
  *node.tar?alt=media) for a in "$@"; do [ "$prev" = "-o" ] && : > "$a"; prev="$a"; done;;
  *) exit 22;;
esac`,
    );
    stub(
      "docker",
      `echo "docker $*" >> ${log}
for a in "$@"; do [ "$prev" = "-e" ] && echo "env $a=\${!a}" >> ${log}; prev="$a"; done
case "$1" in
  load) echo "Loaded image: rivet-node-p:latest";;
  inspect) ${options.running ? "exit 0" : "exit 1"};;
esac`,
    );
    stub("sleep", `echo "sleep $1" >> ${log}`);
    const script = startupScript({ bucket: "b", image: true, stopTimeout: 30, rolloutInterval: 60 })
      .replaceAll("/var/lib/rivet-node", join(dir, "app"))
      .split("\nstart\n")[0];
    writeFileSync(join(dir, "startup.sh"), `${script}\nstart\nexit 0\n`);
    execFileSync("bash", [join(dir, "startup.sh")], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return {
      calls: readFileSync(log, "utf8").trim().split("\n"),
      envFile: existsSync(join(dir, "app", "env.list"))
        ? readFileSync(join(dir, "app", "env.list"), "utf8")
        : undefined,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("RivetGCP.ComputeEnginePool startup script", { tags: ["unit"] }, () => {
  test("a deploy restarts node i after i rollout intervals, with SIGTERM before SIGKILL", () => {
    expect(boot({ running: true, index: 2 }).calls).toEqual([
      expect.stringMatching(/^docker load -i \S+node.tar$/),
      "docker inspect rivet-node",
      "sleep 120",
      "docker stop -t 30 rivet-node",
      "docker rm -f rivet-node",
      expect.stringMatching(
        /^docker run -d --name rivet-node --restart always --network host --init --stop-timeout 30 --env-file \S+ rivet-node-p:latest$/,
      ),
    ]);
  });

  test("a node that boots starts at once", () => {
    const { calls } = boot({ running: false, index: 2 });
    expect(calls.some((call) => call.startsWith("sleep"))).toBe(false);
    expect(calls.some((call) => call.startsWith("docker stop"))).toBe(false);
    expect(calls.at(-1)).toMatch(/^docker run /);
  });

  test("a node reads its secrets from Secret Manager and hands them to the container, not the env file", () => {
    const { calls, envFile } = boot({
      running: false,
      index: 0,
      secrets: {
        RIVET_TOKEN: { version: "projects/p/secrets/rivet/versions/2", value: "admin token" },
        DATABASE_URL: { version: "projects/p/secrets/db/versions/7", value: "postgres://u:p@h/db?x=1" },
      },
    });
    expect(calls.at(-3)).toMatch(/ -e RIVET_TOKEN -e DATABASE_URL rivet-node-p:latest$/);
    expect(calls.slice(-2)).toEqual([
      "env RIVET_TOKEN=admin token",
      "env DATABASE_URL=postgres://u:p@h/db?x=1",
    ]);
    expect(envFile).toBe("RIVET_POOL=p");
  });

  test("a node that cannot read a secret keeps running what it ran", () => {
    const { calls } = boot({
      running: true,
      index: 0,
      secrets: { RIVET_TOKEN: { version: "projects/p/secrets/rivet/versions/3" } },
    });
    expect(calls.some((call) => call.startsWith("docker stop"))).toBe(false);
    expect(calls.some((call) => call.startsWith("docker run"))).toBe(false);
  });
});
