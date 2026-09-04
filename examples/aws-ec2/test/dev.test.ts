/**
 * True `alchemy dev` end-to-end for the EC2 example: spawns the REAL CLI
 * and drives the stack against the floci emulator — no cloud credentials:
 *
 *   - VPC / subnets / routing / security groups → floci EC2
 *   - hosted `Server` instance                  → a real docker container
 *     whose userData boots the bundled `{ fetch }` program
 *   - `JobsQueue` + consumeQueueMessages        → floci SQS
 *
 * The instance's `url` is the emulator's host-routed address
 * (`http://i-….localhost.floci.io:3000`), which resolves to 127.0.0.1
 * and is served by floci's per-port mux. Interpolating `publicIpAddress`
 * is what used to produce an unreachable URL in dev.
 */
import { afterAll, expect, test } from "bun:test";
import { DevCli, fetchOk } from "alchemy-test/DevCli";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const STAGE = "dev-cli-test";
const cli = new DevCli({
  root,
  stage: STAGE,
  env: {
    // `CI=1` + dummy keys open the CLI session without a profile login.
    // `AWS_ACCOUNT_ID` skips STS GetCallerIdentity (dummy keys fail on
    // real AWS). Every resource in this stack is floci-dualized, so
    // `alchemy dev` / `destroy` never call the real cloud.
    CI: "1",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_DEFAULT_REGION: "us-east-1",
    AWS_ACCOUNT_ID: "000000000000",
    AWS_ENDPOINT_URL: "http://localhost:4566",
  },
});

const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

afterAll(async () => {
  await cli.stop();
  if (!process.env.NO_DESTROY && dockerAvailable) {
    cli.destroy({ timeout: 300_000 });
  }
}, 400_000);

test.skipIf(!dockerAvailable)(
  "alchemy dev serves the hosted EC2 instance at a reachable url",
  async () => {
    cli.start();

    const url = await cli.pollUntil(
      "url in stack outputs",
      () => cli.outputUrl("url"),
      {
        tries: 600,
        delayMs: 1000,
      },
    );
    const enqueueUrl = await cli.pollUntil("enqueueUrl in stack outputs", () =>
      cli.outputUrl("enqueueUrl"),
    );

    expect(url).toContain(".localhost.floci.io");
    expect(url).not.toContain("amazonaws.com");
    expect(cli.output).not.toContain("apply failed");

    const home = (await (
      await fetchOk(url, { tries: 120, delayMs: 2000 })
    ).json()) as {
      ok: boolean;
    };
    expect(home.ok).toBe(true);

    const enqueued = (await (
      await fetchOk(enqueueUrl, { tries: 30, delayMs: 1000 })
    ).json()) as { ok: boolean; messageId?: string };
    expect(enqueued.ok).toBe(true);
    expect(enqueued.messageId).toBeTruthy();
  },
  { timeout: 1_200_000 },
);
