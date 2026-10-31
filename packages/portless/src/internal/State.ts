import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { RouteStore, isProcessAlive, parsePort, resolveUserHome } from "portless";

/** The port Portless serves HTTPS on unless `PORTLESS_PORT` says otherwise. */
export const DEFAULT_PORT = 443;

export interface ProxySettings {
  /** The directory the proxy keeps its routes, certificates and markers in. */
  readonly stateDirectory: string;
  /** The port the proxy listens on. */
  readonly port: number;
}

/**
 * Where the proxy keeps its state and which port it serves, read from the
 * settings Portless itself reads: `PORTLESS_STATE_DIR` (default `~/.portless`)
 * and `PORTLESS_PORT` (default 443).
 */
export const settings = Effect.gen(function* () {
  const path = yield* Path.Path;
  const directory = yield* Config.String("PORTLESS_STATE_DIR").pipe(Config.option);
  const port = yield* Config.String("PORTLESS_PORT").pipe(Config.option);
  return {
    stateDirectory: Option.getOrElse(
      Option.filter(directory, (value) => value !== ""),
      () => path.join(resolveUserHome(), ".portless"),
    ),
    port: Option.flatMap(port, (value) => Option.fromNullishOr(parsePort(value))).pipe(
      Option.getOrElse(() => DEFAULT_PORT),
    ),
  } satisfies ProxySettings;
});

/** What a state directory records about the proxy that runs, or last ran, from it. */
export interface ProxyState {
  readonly pid: number | undefined;
  readonly port: number | undefined;
  readonly tls: boolean;
  readonly tlds: ReadonlyArray<string>;
  readonly unprivileged: boolean;
  readonly lan: boolean;
  readonly customCertificate: boolean;
  readonly certificateAuthority: string;
  readonly hasCertificateAuthority: boolean;
}

const integer = (text: string | undefined) => {
  const value = Number.parseInt(text?.trim() ?? "", 10);
  return Number.isNaN(value) ? undefined : value;
};

/**
 * Reads a state directory the way Portless writes it: the pid and port files
 * through the route store's public paths, and the markers by their file names
 * (Portless's, pinned to the version this package depends on).
 */
export const readState = Effect.fn(function* (stateDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = new RouteStore(stateDirectory);
  const read = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text): string | undefined => text),
      Effect.orElseSucceed(() => undefined),
    );
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const marker = (name: string) => exists(path.join(stateDirectory, name));

  const tlds = yield* read(path.join(stateDirectory, "proxy.tlds"));
  const legacyTld = yield* read(path.join(stateDirectory, "proxy.tld"));
  const lan = yield* read(path.join(stateDirectory, "proxy.lan"));
  const certificateAuthority = path.join(stateDirectory, "ca.pem");

  // One TLD per line; older versions wrote a JSON array or a single `proxy.tld`.
  const parsed = (tlds ?? legacyTld ?? "")
    .split(/[\s,[\]"']+/)
    .map((tld) => tld.toLowerCase())
    .filter((tld) => tld !== "");

  return {
    pid: integer(yield* read(store.pidPath)),
    port: integer(yield* read(store.portFilePath)),
    tls: yield* marker("proxy.tls"),
    tlds: parsed.length > 0 ? parsed : ["localhost"],
    unprivileged: yield* marker("proxy.unprivileged"),
    lan: (lan ?? "").trim() !== "",
    customCertificate: yield* marker("proxy.custom-cert"),
    certificateAuthority,
    hasCertificateAuthority: yield* exists(certificateAuthority),
  } satisfies ProxyState;
});

/**
 * What differs between the running proxy and the one this stack needs: HTTPS
 * on the settings' port, the `localhost` TLD only, unprivileged, not LAN, and
 * Portless's own certificate authority.
 */
export const mismatches = (state: ProxyState, port: number) => {
  const found: Array<string> = [];
  if (state.port !== port) {
    found.push(`it listens on port ${state.port ?? "unknown"}, this stack needs ${port}`);
  }
  if (!state.tls) found.push("it serves plain HTTP, this stack needs HTTPS");
  if (state.tlds.length !== 1 || state.tlds[0] !== "localhost") {
    found.push(
      `it serves ${state.tlds.map((tld) => `.${tld}`).join(", ")}, this stack needs .localhost only`,
    );
  }
  if (!state.unprivileged) {
    found.push("it was started with elevated rights, this stack needs an unprivileged proxy");
  }
  if (state.lan) found.push("it runs in LAN mode, which serves .local names");
  // Without TLS there is no CA to speak of; the line above already says so.
  if (state.tls && state.customCertificate) {
    found.push("it serves a custom certificate, this stack needs Portless's own CA");
  } else if (state.tls && !state.hasCertificateAuthority) {
    found.push(`${state.certificateAuthority} is missing`);
  }
  return found;
};

/** Whether the state directory records a proxy process that is still alive. */
export const recordsLiveProxy = (state: ProxyState) =>
  state.pid !== undefined && isProcessAlive(state.pid);
