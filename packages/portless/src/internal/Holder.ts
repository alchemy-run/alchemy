import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import { run } from "./Run.ts";

/**
 * The name of Floci's managed container (`DEFAULT_CONTAINER_NAME` in
 * `@alchemy.run/aws`'s `Local/Floci.ts`): Docker keeps it, and the ports it
 * published, across alchemy dev sessions.
 */
export const FLOCI_CONTAINER = "alchemy-floci";

/**
 * The container that publishes a host port, from `docker ps --format
 * "{{.Names}}\t{{.Ports}}"`: a `Ports` entry such as `0.0.0.0:443->443/tcp`
 * publishes host port 443.
 */
export const containerPublishing = (psOutput: string, port: number) => {
  const published = new RegExp(`(?:^|[\\s,]|:)${port}->`);
  return psOutput
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, ports]) => ports !== undefined && published.test(ports))?.[0];
};

/** A Docker container that publishes the host port, if Docker says so. */
export const dockerContainerPublishing = (port: number) =>
  run(ChildProcess.make("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"])).pipe(
    Effect.map((result) =>
      result.exitCode === 0 ? containerPublishing(result.stdout, port) : undefined,
    ),
    Effect.orElseSucceed(() => undefined),
  );

/** The process that listens on the port, as far as `lsof` tells. */
export const processListening = (port: number) =>
  run(ChildProcess.make("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"])).pipe(
    Effect.map((result) => {
      if (result.exitCode !== 0) return undefined;
      // `-F` prints one field per line: `p<pid>` opens a process, `c<command>` names it.
      const lines = result.stdout.split("\n");
      const pid = Number.parseInt(lines.find((line) => line.startsWith("p"))?.slice(1) ?? "", 10);
      const command = lines.find((line) => line.startsWith("c"))?.slice(1);
      return Number.isNaN(pid) ? undefined : { pid, command };
    }),
    Effect.orElseSucceed(() => undefined),
  );
