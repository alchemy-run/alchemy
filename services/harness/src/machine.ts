import type { ContainerClient } from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type { Machine } from "./rpcs.ts";

/** The Cloudflare Containers size sessions run on. */
export const INSTANCE = "standard-4";

/**
 * `standard-4` (Cloudflare's largest: 4 vCPU, 12 GiB, 20 GB disk); live
 * figures from the machine replace these while it runs.
 */
const SPECS = { vcpus: 4, memoryBytes: 12 * 1024 ** 3, diskBytes: 20 * 1000 ** 3 };

/** `key=value` lines describing the machine, from inside it. */
const STATS_SCRIPT = `echo "cpus=$(nproc)"
awk '/^MemTotal:/ {print "mem_total=" $2 * 1024} /^MemAvailable:/ {print "mem_available=" $2 * 1024}' /proc/meminfo
df -kP / | awk 'NR == 2 {print "disk_total=" $2 * 1024; print "disk_used=" $3 * 1024}'
echo "uptime=$(cut -d' ' -f1 /proc/uptime)"
if [ -z "$KNOWN_LOCATION" ]; then
  curl -s --max-time 2 https://www.cloudflare.com/cdn-cgi/trace | grep -E '^(colo|loc)='
fi`;

/** The session's machine: whether it runs, its size, where, and live usage. */
export const makeMachine = (
  sandbox: ContainerClient,
  /** A start or stop in progress, if any. */
  transition: () => "starting" | "suspending" | undefined,
) => {
  /** Where it last ran (read once per container, kept across suspends). */
  let location: string | undefined;

  const read = Effect.scoped(
    Effect.gen(function* () {
      const child = yield* sandbox.exec(["sh", "-c", STATS_SCRIPT], {
        env: location ? { KNOWN_LOCATION: "1" } : {},
      });
      const output = yield* child.output();
      return Object.fromEntries(
        new TextDecoder()
          .decode(output.stdout)
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
    }),
  );

  return (options: { readonly stats?: boolean } = {}) =>
    Effect.gen(function* () {
      const running = yield* sandbox.running.pipe(Effect.orElseSucceed(() => false));
      const base: Machine = {
        state: transition() ?? (running ? "running" : "suspended"),
        platform: "Cloudflare Container",
        instance: INSTANCE,
        ...SPECS,
        ...(location ? { location } : {}),
      };
      if (!running || !options.stats) return base;
      const facts = yield* read.pipe(Effect.orElseSucceed(() => ({}) as Record<string, string>));
      const number = (key: string) => (facts[key] ? Number(facts[key]) : undefined);
      if (facts.colo) location = facts.loc ? `${facts.colo} (${facts.loc})` : facts.colo;
      const memoryTotal = number("mem_total");
      const memoryAvailable = number("mem_available");
      const diskTotal = number("disk_total");
      return {
        ...base,
        ...(number("cpus") ? { vcpus: number("cpus")! } : {}),
        ...(memoryTotal ? { memoryBytes: memoryTotal } : {}),
        ...(diskTotal ? { diskBytes: diskTotal } : {}),
        ...(location ? { location } : {}),
        ...(memoryTotal !== undefined && memoryAvailable !== undefined
          ? {
              usage: {
                memoryUsedBytes: memoryTotal - memoryAvailable,
                diskUsedBytes: number("disk_used") ?? 0,
                uptimeSeconds: Math.round(number("uptime") ?? 0),
              },
            }
          : {}),
      } satisfies Machine;
    });
};
