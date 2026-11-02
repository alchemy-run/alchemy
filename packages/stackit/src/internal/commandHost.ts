import { constants, createCipheriv, createHash, publicEncrypt, randomBytes } from "node:crypto";
import * as runCommand from "@distilled.cloud/stackit/run_command";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { waitFor } from "./wait.ts";

/**
 * Installing a program on a STACKIT server through Run Command, which needs no SSH
 * path and no public address. `Stackit.IaaS.Service` is the only user.
 *
 * A script is capped at 10,000 characters and each command takes seconds, so the
 * program doesn't travel in a script: the server downloads an archive through a
 * presigned URL. Run Command's history keeps every script for anyone who can read
 * it, so nothing secret travels in one either: the server makes a key pair that
 * never leaves it, and the env file arrives in the archive, encrypted to that key.
 */

/** The STACKIT service id Run Command is enabled under. */
export const RUN_COMMAND_SERVICE_ID = "cloud.stackit.run-command";

/** Longest wait for a fresh server to finish its first boot and install the tools. */
export const PREPARE_TIMEOUT = "15 minutes";

/** Longest wait for a program to download and start. */
export const INSTALL_TIMEOUT = "10 minutes";

/** Longest wait for a program to be removed. */
export const REMOVE_TIMEOUT = "5 minutes";

/** The Linux template, whose `script` parameter holds a shell script. */
const SHELL_TEMPLATE = "RunShellScript";

/** Where bun is installed, once per server. */
const BUN_INSTALL = "/opt/alchemy-bun";

/** Names of the sealed env in the archive, next to the program. */
const SEALED_ENV_FILE = ".alchemy-env.enc";
const SEALED_ENV_KEY_FILE = ".alchemy-env.key";

export const appDirOf = (unitName: string) => `/opt/${unitName}`;

/** The unit's working directory, which outlives each release in {@link appDirOf}. */
export const stateDirOf = (unitName: string) => `/var/lib/${unitName}`;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * An env file for systemd's `EnvironmentFile=`: double quotes keep every value
 * literal once `"`, `\`, `` ` `` and `$` are escaped, and hold real newlines.
 */
export const renderEnvFile = (env: Readonly<Record<string, string>>): string =>
  Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}="${value.replaceAll(/(["\\`$])/g, "\\$1")}"`)
    .join("\n") + "\n";

/** The server's public key was missing from a command's output, or wasn't a key. */
export class ServerKeyUnusable extends Data.TaggedError("Stackit.IaaS.ServerKeyUnusable")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/** The env file, as the files that go in the archive and the IV the script needs. */
export interface SealedEnv {
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: Uint8Array }>;
  readonly iv: string;
}

/**
 * Encrypt an env file to the server's public key: AES-256-CBC under a fresh key, and
 * that key wrapped with RSA-OAEP-SHA256. The key is wrapped as hex, so the script
 * can pass what `openssl pkeyutl` prints straight to `openssl enc -K`. `openssl enc`
 * has no authenticated mode, and none is needed here: whoever could alter the
 * archive's URL in a command can already run anything on the server.
 */
export const sealEnv = (args: {
  readonly resourceName: string;
  readonly envFile: Redacted.Redacted<string>;
  readonly publicKey: string;
}): Effect.Effect<SealedEnv, ServerKeyUnusable> =>
  Effect.try({
    try: () => {
      const key = randomBytes(32);
      const iv = randomBytes(16);
      const cipher = createCipheriv("aes-256-cbc", key, iv);
      const sealed = Buffer.concat([
        cipher.update(Redacted.value(args.envFile), "utf8"),
        cipher.final(),
      ]);
      const wrapped = publicEncrypt(
        {
          key: args.publicKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(key.toString("hex"), "utf8"),
      );
      return {
        files: [
          { path: SEALED_ENV_FILE, content: sealed },
          { path: SEALED_ENV_KEY_FILE, content: wrapped },
        ],
        iv: iv.toString("hex"),
      };
    },
    // The cause could quote the env, so it isn't attached.
    catch: () =>
      new ServerKeyUnusable({
        resourceName: args.resourceName,
        message: `${args.resourceName}: could not encrypt the env file to the key the server reported`,
      }),
  });

export const sha256Hex = (content: Uint8Array) =>
  Effect.sync(() => createHash("sha256").update(content).digest("hex"));

/** The public key in the output of {@link prepareScript}. */
export const publicKeyInOutput = (output: string): string | undefined =>
  /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/.exec(output)?.[0];

/**
 * Wait out first boot, install the tools and bun if they are missing, make the
 * unit's key pair once, and print its public key. The output stays small: a command
 * prints only the tail of a failed step, and a tool's progress isn't kept. Services
 * on one fresh server prepare at the same time, so one lock covers bun's install,
 * which unpacks into a shared directory, and its wait is bounded.
 */
export const prepareScript = (unitName: string): string => {
  const app = quote(appDirOf(unitName));
  return `#!/bin/bash
set -euo pipefail
export HOME=/root
umask 077
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
quiet() { if ! "$@" >"$log" 2>&1; then tail -n 40 "$log"; exit 1; fi; }
if command -v cloud-init >/dev/null 2>&1; then cloud-init status --wait >/dev/null 2>&1 || true; fi
if ! command -v curl >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    quiet apt-get -o DPkg::Lock::Timeout=300 update
    quiet env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y curl unzip openssl ca-certificates
  elif command -v dnf >/dev/null 2>&1; then
    quiet dnf install -y curl unzip openssl ca-certificates
  else
    echo "no apt-get or dnf to install curl, unzip and openssl with" >&2
    exit 1
  fi
fi
if [ ! -x ${BUN_INSTALL}/bin/bun ]; then
  umask 022
  quiet flock -w 300 ${BUN_INSTALL}.lock bash -c 'set -o pipefail; [ -x ${BUN_INSTALL}/bin/bun ] || curl -fsSL https://bun.sh/install | BUN_INSTALL=${BUN_INSTALL} bash'
  umask 077
fi
mkdir -p ${app}
if [ ! -f ${app}/env-key.pem ]; then
  quiet openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ${app}/env-key.pem
fi
openssl pkey -in ${app}/env-key.pem -pubout
`;
};

/**
 * Download the archive, check it, swap it in, decrypt the env file, and restart the
 * unit. The AES key is on `openssl enc`'s command line for that moment, so another
 * local user could read it from the process list: a server hosts one tenant.
 *
 * With `probePort`, the unit is ready when it is active and answers on that port with
 * any HTTP response; without one, a program may listen on nothing, so active is enough.
 * Either has to hold for {@link READY_POLLS} polls in a row, about 16 seconds. A crash
 * leaves the unit inactive for `RestartSec`, longer than a poll, so a program that dies
 * within that window fails the deploy. One that dies later isn't noticed.
 *
 * The working directory is {@link stateDirOf}, and only the release is swapped, so what
 * a program writes to a relative path survives a deploy. {@link removeScript} deletes it.
 */
const READY_POLLS = 8;

export const installScript = (args: {
  readonly unitName: string;
  readonly url: string;
  readonly sha256: string;
  readonly iv: string;
  readonly probePort: number | undefined;
}): string => {
  const app = quote(appDirOf(args.unitName));
  const unit = `${args.unitName}.service`;
  const probe =
    args.probePort === undefined
      ? "true"
      : `curl -s -o /dev/null --max-time 2 http://127.0.0.1:${String(args.probePort)}/`;
  return `#!/bin/bash
set -euo pipefail
export HOME=/root
umask 077
release=${app}/release.$$
trap 'rm -rf "$release" ${app}/bundle.zip' EXIT
mkdir -p "$release"
curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o ${app}/bundle.zip ${quote(args.url)}
echo ${quote(`${args.sha256}  ${appDirOf(args.unitName)}/bundle.zip`)} | sha256sum -c --quiet -
unzip -q -o ${app}/bundle.zip -d "$release"
aes="$(openssl pkeyutl -decrypt -inkey ${app}/env-key.pem -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -in "$release/${SEALED_ENV_KEY_FILE}")"
openssl enc -d -aes-256-cbc -K "$aes" -iv ${args.iv} -in "$release/${SEALED_ENV_FILE}" -out ${app}/env.new
unset aes
mv ${app}/env.new ${app}/env
rm -f "$release/${SEALED_ENV_KEY_FILE}" "$release/${SEALED_ENV_FILE}"
rm -rf ${app}/current
mv "$release" ${app}/current
cat > /etc/systemd/system/${unit} <<'ALCHEMY_UNIT'
[Unit]
Description=Alchemy Stackit.IaaS.Service ${args.unitName}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
StateDirectory=${args.unitName}
WorkingDirectory=${stateDirOf(args.unitName)}
EnvironmentFile=${appDirOf(args.unitName)}/env
ExecStart=${BUN_INSTALL}/bin/bun ${appDirOf(args.unitName)}/current/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
ALCHEMY_UNIT
chmod 644 /etc/systemd/system/${unit}
systemctl daemon-reload
systemctl enable ${unit} >/dev/null 2>&1
systemctl restart ${unit}
healthy=0
for attempt in $(seq 1 40); do
  if systemctl is-active --quiet ${unit} && ${probe}; then
    healthy=$((healthy + 1))
    if [ "$healthy" -ge ${String(READY_POLLS)} ]; then exit 0; fi
  else
    healthy=0
  fi
  sleep 2
done
echo "unit ${args.unitName} did not become ready" >&2
systemctl status ${unit} --no-pager || true
journalctl -u ${unit} -n 40 --no-pager || true
exit 1
`;
};

/** Stop the unit and remove what {@link installScript} wrote. Bun stays for other units. */
export const removeScript = (unitName: string): string => {
  const unit = `${unitName}.service`;
  return `#!/bin/bash
export HOME=/root
systemctl disable --now ${unit} >/dev/null 2>&1 || true
rm -f /etc/systemd/system/${unit}
rm -rf ${quote(appDirOf(unitName))} ${quote(stateDirOf(unitName))}
systemctl daemon-reload || true
`;
};

/** A command's text, which the SDK keeps `Redacted`. */
export const commandOutput = (details: runCommand.CommandDetails): string => {
  const output = details.output ?? "";
  return Redacted.isRedacted(output) ? Redacted.value(output) : output;
};

/** The create response of a command carried no id; the spec marks it optional. */
export class CommandIdMissing extends Data.TaggedError("Stackit.IaaS.CommandIdMissing")<{
  readonly serverId: string;
  readonly message: string;
}> {}

const failure = (details: runCommand.CommandDetails) => {
  // These are this module's own scripts, and the tail of a failed step or the unit's
  // journal is what explains the failure.
  const tail = commandOutput(details).slice(-2000);
  return `exit code ${details.exitCode ?? "unknown"}${tail === "" ? "" : `: ${tail}`}`;
};

/**
 * Run a shell script on a server and wait for it to finish. A failed status and a
 * non-zero exit code both fail with `StackitResourceFailed`, and a command the server
 * never picks up fails with `StackitWaitTimeout` when the budget runs out.
 *
 * STACKIT documents no response for a server whose agent isn't up yet. This sends a
 * fixed template and a valid script, so a `BadRequest` is retried for two minutes in
 * case that is what it means; one that stays is reported.
 */
export const runScript = Effect.fn("Stackit.IaaS.runScript")(function* (args: {
  readonly projectId: string;
  readonly region: string;
  readonly serverId: string;
  readonly what: string;
  readonly script: string;
  readonly timeout: Duration.Input;
}) {
  const scope = { projectId: args.projectId, region: args.region, serverId: args.serverId };
  const { id } = yield* runCommand
    .createCommand({
      ...scope,
      commandTemplateName: SHELL_TEMPLATE,
      parameters: { script: args.script },
    })
    .pipe(
      Effect.retry({
        while: (error) => error._tag === "BadRequest",
        schedule: Schedule.spaced("15 seconds"),
        times: 8,
      }),
    );
  if (id === undefined) {
    return yield* new CommandIdMissing({
      serverId: args.serverId,
      message: `STACKIT accepted a command for server ${args.serverId} without returning its id`,
    });
  }
  return yield* waitFor({
    resource: `${args.what} on server ${args.serverId} (Run Command ${String(id)}; this needs the server's Server Agent)`,
    read: runCommand.getCommand({ ...scope, commandId: String(id) }),
    ready: (details) => details.status === "completed",
    failed: (details) =>
      details.status === "failed" ||
      (details.status === "completed" && (details.exitCode ?? 0) !== 0)
        ? failure(details)
        : undefined,
    state: (details) => details.status,
    timeout: args.timeout,
    interval: "3 seconds",
    maxInterval: "15 seconds",
  });
});
