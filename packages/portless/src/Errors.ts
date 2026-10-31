import * as Data from "effect/Data";

/** The proxy can't run on this operating system. */
export class ProxyUnsupportedPlatform extends Data.TaggedError("ProxyUnsupportedPlatform")<{
  readonly platform: string;
}> {
  override get message() {
    return `Portless.Proxy supports macOS and Linux; ${this.platform} has no supported trust-store setup. Run with PORTLESS=0 to skip the proxy on this machine.`;
  }
}

/** Portless needs Node.js 24 or newer, and `node` isn't that. */
export class ProxyNodeUnavailable extends Data.TaggedError("ProxyNodeUnavailable")<{
  readonly found: string | undefined;
}> {
  override get message() {
    const found =
      this.found === undefined
        ? "no `node` was found on PATH"
        : `\`node\` resolves to ${this.found}`;
    return `Portless needs Node.js 24 or newer, but ${found}. Install Node.js 24 and put it first on PATH.`;
  }
}

/** The Portless CLI isn't installed next to this package. */
export class PortlessNotInstalled extends Data.TaggedError("PortlessNotInstalled")<{
  readonly cause: unknown;
}> {
  override get message() {
    return `Couldn't find the Portless CLI next to @alchemy.run/portless: ${String(this.cause)}. Reinstall your dependencies.`;
  }
}

/** Linux won't let an unprivileged process listen on the proxy's port. */
export class ProxyPortUnprivileged extends Data.TaggedError("ProxyPortUnprivileged")<{
  readonly port: number;
  readonly unprivilegedPortStart: number | undefined;
}> {
  override get message() {
    const start =
      this.unprivilegedPortStart === undefined ? "unreadable" : String(this.unprivilegedPortStart);
    return [
      `Port ${this.port} is below net.ipv4.ip_unprivileged_port_start (${start}), so Portless can't listen on it without root. Alchemy never starts a root proxy.`,
      "Allow it once per machine:",
      `  sudo sysctl -w net.ipv4.ip_unprivileged_port_start=${this.port}`,
      "and keep it across reboots:",
      `  echo 'net.ipv4.ip_unprivileged_port_start=${this.port}' | sudo tee /etc/sysctl.d/99-portless.conf`,
      `Or set PORTLESS_PORT to a port above ${start}.`,
    ].join("\n");
  }
}

/** A process that isn't a Portless proxy holds the proxy's port. */
export class ProxyPortInUse extends Data.TaggedError("ProxyPortInUse")<{
  readonly port: number;
  /** Who holds it, such as `node (pid 4242)`, when something could say. */
  readonly holder: string | undefined;
}> {
  override get message() {
    return `Port ${this.port} is held by ${this.holder ?? "another process"}, which isn't a Portless proxy. Stop it, or set PORTLESS_PORT to another port.`;
  }
}

/** Floci's container, left over from an earlier session, publishes the proxy's port. */
export class ProxyPortHeldByFloci extends Data.TaggedError("ProxyPortHeldByFloci")<{
  readonly port: number;
  readonly container: string;
}> {
  override get message() {
    return [
      `Port ${this.port} is published by Floci's container "${this.container}" from an earlier alchemy dev session, so the Portless proxy can't listen on it.`,
      "Free the port yourself, then rerun (Floci starts without publishing it):",
      `  docker stop ${this.container}      # keeps the emulator's data`,
      `  docker rm -f ${this.container}     # resets the emulator`,
    ].join("\n");
  }
}

/** A running proxy can't serve this stack as it is configured. */
export class ProxyIncompatible extends Data.TaggedError("ProxyIncompatible")<{
  readonly stateDirectory: string;
  readonly port: number;
  readonly mismatches: ReadonlyArray<string>;
}> {
  override get message() {
    return [
      `The Portless proxy running from ${this.stateDirectory} on port ${this.port} can't serve this stack:`,
      ...this.mismatches.map((mismatch) => `  - ${mismatch}`),
      "Alchemy never stops or restarts a shared proxy. Stop it yourself (add sudo if it was started with sudo), then rerun:",
      `  PORTLESS_STATE_DIR=${this.stateDirectory} portless proxy stop`,
    ].join("\n");
  }
}

/** A Portless proxy answers on the port, but it isn't the one this state directory records. */
export class ProxyElsewhere extends Data.TaggedError("ProxyElsewhere")<{
  readonly port: number;
  readonly stateDirectory: string;
}> {
  override get message() {
    return `A Portless proxy answers on port ${this.port}, but ${this.stateDirectory} records no live proxy, so it runs from another state directory and routes written here would never reach it. Stop it with \`portless proxy stop\`, or point PORTLESS_STATE_DIR at its state directory.`;
  }
}

/** The recorded proxy process is alive, but nothing answers on its port. */
export class ProxyUnresponsive extends Data.TaggedError("ProxyUnresponsive")<{
  readonly pid: number;
  readonly port: number;
  readonly stateDirectory: string;
}> {
  override get message() {
    return `The Portless proxy recorded in ${this.stateDirectory} (pid ${this.pid}) is alive but doesn't answer on port ${this.port}. Alchemy never stops it. Read ${this.stateDirectory}/proxy.log, stop it with \`kill ${this.pid}\`, then rerun.`;
  }
}

/** `portless proxy start` failed. */
export class ProxyStartFailed extends Data.TaggedError("ProxyStartFailed")<{
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;
  readonly stateDirectory: string;
}> {
  override get message() {
    const output = this.output.trim();
    return [
      `\`${this.command}\` exited with ${this.exitCode}.`,
      ...(output === "" ? [] : [output.length <= 2_000 ? output : `${output.slice(0, 2_000)}...`]),
      `If the daemon failed after starting, read ${this.stateDirectory}/proxy.log.`,
    ].join("\n");
  }
}

/** `portless proxy start` succeeded, but no proxy answers afterwards. */
export class ProxyNotRunning extends Data.TaggedError("ProxyNotRunning")<{
  readonly port: number;
  readonly stateDirectory: string;
}> {
  override get message() {
    return `No Portless proxy answers on port ${this.port} after \`portless proxy start\`. Read ${this.stateDirectory}/proxy.log for why, then rerun.`;
  }
}

/** The proxy serves a certificate chain that its own CA file doesn't verify. */
export class ProxyCertificateMismatch extends Data.TaggedError("ProxyCertificateMismatch")<{
  readonly port: number;
  readonly certificateAuthority: string;
}> {
  override get message() {
    return `The Portless proxy on port ${this.port} serves certificates that ${this.certificateAuthority} doesn't verify: it was started before the CA was regenerated, or with a custom certificate. Alchemy never restarts it. Stop it with \`portless proxy stop\`, then rerun.`;
  }
}

/** Chromium can't be made to trust the Portless CA on Linux without `certutil`. */
export class ProxyTrustToolMissing extends Data.TaggedError("ProxyTrustToolMissing")<{
  readonly tool: string;
}> {
  override get message() {
    return `Portless.Proxy needs \`${this.tool}\` on Linux so Chromium trusts the Portless CA through its NSS database, and this machine has none. Install it (Debian and Ubuntu: apt install libnss3-tools; Fedora: dnf install nss-tools; Arch: pacman -S nss), then rerun.`;
  }
}

/** A trust-store command failed. */
export class ProxyTrustFailed extends Data.TaggedError("ProxyTrustFailed")<{
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;
}> {
  override get message() {
    const output = this.output.trim();
    return [
      `Trusting the Portless CA failed: \`${this.command}\` exited with ${this.exitCode}.`,
      ...(output === "" ? [] : [output.length <= 2_000 ? output : `${output.slice(0, 2_000)}...`]),
      this.command.startsWith("certutil")
        ? "Check that ~/.pki/nssdb is writable by your user, then rerun."
        : "Run `portless trust` yourself in a terminal (it asks for permission once per machine), then rerun.",
    ].join("\n");
  }
}

/** The CA still isn't trusted after `portless trust` succeeded. */
export class ProxyTrustNotEstablished extends Data.TaggedError("ProxyTrustNotEstablished")<{
  readonly certificateAuthority: string;
}> {
  override get message() {
    return `This machine still doesn't trust ${this.certificateAuthority} after \`portless trust\`. Run \`portless trust\` yourself in a terminal and approve the prompt, then rerun.`;
  }
}

/** A hostname can't be a Portless route. */
export class HostnameInvalid extends Data.TaggedError("HostnameInvalid")<{
  readonly hostname: string;
  readonly reason: string;
}> {
  override get message() {
    return `"${this.hostname}" can't be a Portless hostname: ${this.reason}. Use a shorter stage, id or domain made of lowercase letters, digits and hyphens.`;
  }
}

/** Another resource or process already routes this hostname. */
export class HostnameClaimed extends Data.TaggedError("HostnameClaimed")<{
  readonly hostname: string;
  /** The resource of this session that holds the route. */
  readonly fqn: string | undefined;
  /** The process that holds the route. */
  readonly pid: number | undefined;
}> {
  override get message() {
    const holder =
      this.fqn !== undefined
        ? `the resource ${this.fqn}`
        : `process ${this.pid ?? "unknown"}, outside this dev session`;
    return `${this.hostname} is already routed by ${holder}. Give this resource another id or name, or remove the other route first.`;
  }
}

/** A Portless route store operation failed. */
export class RouteStoreFailed extends Data.TaggedError("RouteStoreFailed")<{
  readonly operation: "add" | "load" | "remove" | "update";
  readonly stateDirectory: string;
  readonly hostname: string | undefined;
  readonly cause: unknown;
}> {
  override get message() {
    const target = this.hostname === undefined ? "" : ` for ${this.hostname}`;
    return `Portless route store ${this.operation}${target} failed in ${this.stateDirectory}: ${String(this.cause)}`;
  }
}

/** The port a Dev command must listen on is taken. */
export class DevPortInUse extends Data.TaggedError("DevPortInUse")<{
  readonly port: number;
  readonly command: string;
}> {
  override get message() {
    return `Port ${this.port} is already in use, so \`${this.command}\` can't listen on it. Stop what listens there or choose another port; a port you pass to Portless.Dev is never shifted.`;
  }
}

/** No free port could be found for a Dev command. */
export class DevPortUnavailable extends Data.TaggedError("DevPortUnavailable")<{
  readonly cause: unknown;
}> {
  override get message() {
    return `Couldn't find a free port on 127.0.0.1 for the command: ${String(this.cause)}. Pass \`port\` to choose one.`;
  }
}

/** An Alias url can't be routed to. */
export class AliasUrlInvalid extends Data.TaggedError("AliasUrlInvalid")<{
  readonly url: string;
  readonly reason: string;
}> {
  override get message() {
    return `Portless.Alias can't route to "${this.url}": ${this.reason}.`;
  }
}

/** `Portless.Origin` needs a port to build the `PORTLESS=0` origin. */
export class OriginPortRequired extends Data.TaggedError("OriginPortRequired")<{
  readonly id: string;
}> {
  override get message() {
    return `Portless.Origin("${this.id}") needs a \`port\` when PORTLESS=0, because the origin is then http://localhost:<port>.`;
  }
}
