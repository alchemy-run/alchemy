import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as Cluster from "@alchemy.run/effect-cluster";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { FIXTURE_DIR, HOST, POOL_NAME, SSH_OPTIONS, SUDO } from "./fixtures/nixos/cluster.ts";
import { Lives } from "./fixtures/nixos/index.ts";

const testOptions = { providers: Cluster.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const stack = Core.scratchStack(testOptions, "ClusterNixOS", import.meta.url);

const UNIT = `effect-cluster-${POOL_NAME}.service`;
const PROFILE = `/nix/var/nix/profiles/effect-cluster/${POOL_NAME}`;

/** Run `script` on the host as root; the gateway token stays there. */
const onHost = (script: string) =>
  execFileSync(
    "ssh",
    [
      ...SSH_OPTIONS,
      "-o",
      "BatchMode=yes",
      HOST!,
      SUDO ? `sudo -n sh -c '${script.replace(/'/g, `'\\''`)}'` : script,
    ],
    { encoding: "utf8" },
  );

/** Call `Greeter.Greet` through the gateway on the host, with the token from the runner's environment. */
const greet = (name: string) =>
  onHost(
    `set -a; . /var/lib/effect-cluster/${POOL_NAME}/runner.env; set +a; ` +
      `curl -fsS -X POST -H "Authorization: Bearer $CLUSTER_GATEWAY_TOKEN" -H 'Content-Type: application/json' ` +
      `--data '${JSON.stringify({
        _tag: "Request",
        id: "1",
        tag: "Greeter.Greet",
        payload: { entityId: "nixos", payload: { name }, headers: {} },
        headers: [],
      })}' http://127.0.0.1:34500/rpc`,
  );

const retry = { schedule: Schedule.spaced("1 second"), times: 90 } as const;

// The runner as NixOS runs it: a store path, a profile and a systemd unit
// from `nix/module.nix`. Without a host, a process pool writes the same
// runner to a directory: the fixture of the module's VM test.
describe("Effect Cluster on NixOS", { tags: ["provider:cluster", "local"] }, () => {
  beforeAll(
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* stack.deploy(Effect.void.pipe(Effect.provide(Lives)));
    }),
    { timeout: 600_000 },
  );

  afterAll(HOST === undefined ? Effect.void : stack.destroy(), { timeout: 120_000 });

  test.skipIf(HOST !== undefined)(
    "writes the runner with the greeter and the cron, the VM test's fixture",
    Effect.sync(() => {
      const runner = fs.readFileSync(path.join(FIXTURE_DIR, "runner.mjs"), "utf8");
      expect(runner).toContain("nixos-fixture tick");
      expect(fs.existsSync(path.join(FIXTURE_DIR, "runner.env"))).toBe(true);
    }),
  );

  test.skipIf(HOST === undefined)(
    "the host runs the runner from its profile",
    Effect.sync(() => {
      expect(onHost(`systemctl is-active ${UNIT}`).trim()).toBe("active");
      expect(onHost(`readlink -f ${PROFILE}`)).toMatch(
        /^\/nix\/store\/.*-effect-cluster-nixos-test/,
      );
      expect(onHost(`stat -c %a /var/lib/effect-cluster/${POOL_NAME}/runner.env`).trim()).toBe(
        "600",
      );
    }),
  );

  test.skipIf(HOST === undefined)(
    "a command through the gateway",
    Effect.gen(function* () {
      const response = yield* Effect.try(() => greet("nix")).pipe(Effect.retry(retry));
      expect(response).toContain("hello nix");
    }),
    { timeout: 120_000 },
  );

  test.skipIf(HOST === undefined)(
    "a cron runs on the runner",
    Effect.gen(function* () {
      const ticks = yield* Effect.try(() => {
        const out = onHost(
          `journalctl -u ${UNIT} --since '-60s' --no-pager -o cat | grep -c 'nixos-fixture tick'`,
        );
        if (Number(out.trim()) < 2) throw new Error(`ticks: ${out}`);
        return Number(out.trim());
      }).pipe(Effect.retry(retry));
      expect(ticks).toBeGreaterThanOrEqual(2);
    }),
    { timeout: 120_000 },
  );
});
