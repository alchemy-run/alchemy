import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import {
  ProxyElsewhere,
  ProxyIncompatible,
  ProxyNotRunning,
  ProxyPortHeldByFloci,
  ProxyPortInUse,
  ProxyPortUnprivileged,
  ProxyStartFailed,
  ProxyUnresponsive,
  ProxyUnsupportedPlatform,
} from "../Errors.ts";
import * as Cli from "./Cli.ts";
import { FLOCI_CONTAINER, dockerContainerPublishing, processListening } from "./Holder.ts";
import * as Host from "./Host.ts";
import { isListening, isPortlessProxy } from "./Probe.ts";
import { outputOf, run } from "./Run.ts";
import {
  mismatches,
  readState,
  recordsLiveProxy,
  type ProxySettings,
  type ProxyState,
} from "./State.ts";
import { Trust } from "./Trust.ts";

/** A proxy that serves this stack, and where it keeps its state. */
export interface Acquired extends ProxySettings {
  /** The CA the proxy signs its certificates with. */
  readonly certificateAuthority: string;
}

/** Ports below this need root to listen on, unless the platform grants them (Portless's own boundary). */
const PRIVILEGED_PORT_THRESHOLD = 1024;

/**
 * The flags Alchemy starts the proxy with: HTTPS on `.localhost`, never a root
 * daemon, and no trust step of its own, because trusting the CA is checked
 * first and prompted for separately, never as a side effect of starting.
 */
const startFlags = (port: number) => [
  "--unprivileged",
  "--https",
  "--tld",
  "localhost",
  "--port",
  String(port),
  "--skip-trust",
];

/**
 * The environment pinned for the CLI, so a stray variable of the caller's
 * can't turn the flags above into another mode: `PORTLESS_LAN` would force
 * `.local`, `PORTLESS_HTTPS=0` would drop TLS, and `PORTLESS_SYNC_HOSTS=1`
 * would ask for the root that unprivileged mode never has.
 */
const startEnvironment = ({ stateDirectory, port }: ProxySettings) => ({
  PORTLESS_STATE_DIR: stateDirectory,
  PORTLESS_PORT: String(port),
  PORTLESS_HTTPS: "1",
  PORTLESS_TLD: "localhost",
  PORTLESS_LAN: "0",
  PORTLESS_UNPRIVILEGED: "1",
  PORTLESS_SYNC_HOSTS: "0",
});

/** On Linux, fails with the `sysctl` that lets an unprivileged process listen on the port. */
const assertPortAllowed = Effect.fn(function* (port: number) {
  if (Host.platform !== "linux" || port >= PRIVILEGED_PORT_THRESHOLD) return;
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString("/proc/sys/net/ipv4/ip_unprivileged_port_start")
    .pipe(Effect.orElseSucceed(() => ""));
  const start = Number.parseInt(text.trim(), 10);
  if (Number.isNaN(start) || port < start) {
    return yield* new ProxyPortUnprivileged({
      port,
      unprivilegedPortStart: Number.isNaN(start) ? undefined : start,
    });
  }
});

/** Fails naming whoever holds a port that no Portless proxy answers on. */
const failPortHeld = Effect.fn(function* (settings: ProxySettings, state: ProxyState) {
  const { port, stateDirectory } = settings;
  const container = yield* dockerContainerPublishing(port);
  if (container === FLOCI_CONTAINER) {
    return yield* new ProxyPortHeldByFloci({ port, container });
  }
  const holder = yield* processListening(port);
  if (holder !== undefined && recordsLiveProxy(state) && holder.pid === state.pid) {
    return yield* new ProxyUnresponsive({ pid: holder.pid, port, stateDirectory });
  }
  return yield* new ProxyPortInUse({
    port,
    holder:
      container !== undefined
        ? `the Docker container "${container}"`
        : holder === undefined
          ? undefined
          : `${holder.command ?? "a process"} (pid ${holder.pid})`,
  });
});

/**
 * Starts the shared proxy, or finds it running, and makes this machine trust
 * its CA. A proxy that already runs is never stopped, restarted or
 * reconfigured: one that can't serve this stack is rejected with what differs.
 */
export const acquire = Effect.fn("Portless.acquire")(function* (settings: ProxySettings) {
  if (Host.platform !== "darwin" && Host.platform !== "linux") {
    return yield* new ProxyUnsupportedPlatform({ platform: Host.platform });
  }
  const { port, stateDirectory } = settings;
  const path = yield* Path.Path;
  const trust = yield* Trust;
  yield* trust.preflight;
  const node = yield* Cli.node;
  const cli = yield* Cli.portless;

  const inspect = Effect.gen(function* () {
    const state = yield* readState(stateDirectory);
    return { state, answering: yield* isPortlessProxy(port) };
  });
  // The proxy that answers must be the one this state directory records, and able to serve this stack.
  const assertReusable = Effect.fn(function* (state: ProxyState) {
    if (state.port !== port) return yield* new ProxyElsewhere({ port, stateDirectory });
    const found = mismatches(state, port);
    if (found.length > 0) {
      return yield* new ProxyIncompatible({ stateDirectory, port, mismatches: found });
    }
  });

  const before = yield* inspect;
  if (before.answering) {
    yield* assertReusable(before.state);
  } else if (yield* isListening(port)) {
    return yield* failPortHeld(settings, before.state);
  } else {
    yield* assertPortAllowed(port);
    const command = `portless proxy start ${startFlags(port).join(" ")}`;
    const failed = (exitCode: number, output: string) =>
      new ProxyStartFailed({ command, exitCode, output, stateDirectory });
    const result = yield* run(
      ChildProcess.make(node, [cli, "proxy", "start", ...startFlags(port)], {
        env: startEnvironment(settings),
        extendEnv: true,
        stdin: "ignore",
      }),
    ).pipe(
      Effect.mapError((cause) => failed(-1, String(cause))),
      Effect.timeoutOrElse({
        duration: Duration.minutes(1),
        orElse: () => Effect.fail(failed(-1, "it did not finish within a minute")),
      }),
    );
    if (result.exitCode !== 0) return yield* failed(result.exitCode, outputOf(result));

    const after = yield* inspect;
    if (!after.answering) return yield* new ProxyNotRunning({ port, stateDirectory });
    // Another start may have won the race with other settings: that proxy isn't ours to use.
    yield* assertReusable(after.state);
  }

  const certificateAuthority = path.join(stateDirectory, "ca.pem");
  yield* trust.ensure({ node, cli, stateDirectory, certificateAuthority });
  return { stateDirectory, port, certificateAuthority } satisfies Acquired;
});
