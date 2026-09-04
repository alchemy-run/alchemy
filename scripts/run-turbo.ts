#!/usr/bin/env bun
/**
 * Run turbo with pnpm_config_pm_on_fail=ignore so nested distilled
 * package.json pins (pnpm@11.21.0) do not download a broken @pnpm/exe
 * shim. Unix `VAR=value cmd` prefixes are not portable to Windows cmd.
 */
process.env.pnpm_config_pm_on_fail = "ignore";

const turbo = Bun.which("turbo");
if (turbo === null) {
  console.error("turbo not found on PATH");
  process.exit(1);
}

const proc = Bun.spawn([turbo, ...Bun.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
process.exit(await proc.exited);
