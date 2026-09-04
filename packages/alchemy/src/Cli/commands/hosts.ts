import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as HostsFile from "../../Local/HostsFile.ts";
import { UserInputError } from "./errors.ts";

/**
 * `alchemy hosts` — maintain the loopback entries `alchemy dev --domain
 * <custom>` needs in the system hosts file. The file is root-owned, so
 * `alchemy dev` never writes it: it detects missing hosts and prints the
 * `sudo alchemy hosts add …` line for the user to run. Entries live in a
 * marked block alchemy owns; nothing outside the block is touched.
 */

const file = Flag.file("file").pipe(
  Flag.withDescription(`Hosts file to edit (default: ${HostsFile.HOSTS_FILE})`),
  Flag.withDefault(HostsFile.HOSTS_FILE),
);

const hostArguments = Argument.string("host").pipe(
  Argument.withDescription(
    "Hostnames to map to the loopback, e.g. api.myapp.test web.myapp.test",
  ),
  Argument.atLeast(1),
);

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

const validate = (hosts: ReadonlyArray<string>) =>
  Effect.forEach(hosts, (host) =>
    HOSTNAME.test(host)
      ? Effect.succeed(host.toLowerCase())
      : Effect.fail(
          new UserInputError({ message: `'${host}' is not a valid hostname.` }),
        ),
  );

const permissionHint = (path: string, verb: string) =>
  `Could not ${verb} ${path} — it is owned by root. Re-run with sudo:\n  sudo alchemy hosts ${process.argv.slice(3).join(" ")}`;

const write = (path: string, content: string, verb: string) =>
  HostsFile.writeHostsFile(content, path).pipe(
    Effect.mapError(
      () => new UserInputError({ message: permissionHint(path, verb) }),
    ),
  );

const addCommand = Command.make(
  "add",
  { file, hosts: hostArguments },
  Effect.fn(function* ({ file, hosts }) {
    const valid = yield* validate(hosts);
    const content = yield* HostsFile.readHostsFile(file).pipe(
      Effect.mapError(
        () => new UserInputError({ message: `Could not read ${file}.` }),
      ),
    );
    const missing = HostsFile.missingHosts(content, valid);
    if (missing.length === 0) {
      yield* Console.log(`Every host is already mapped in ${file}.`);
      return;
    }
    yield* write(file, HostsFile.upsertHosts(content, missing), "write");
    yield* Console.log(
      `Added ${missing.join(", ")} → 127.0.0.1 / ::1 in ${file}.`,
    );
  }),
).pipe(
  Command.withDescription(
    "Map hostnames to the loopback in alchemy's block of the hosts file (idempotent; needs sudo)",
  ),
);

const removeCommand = Command.make(
  "remove",
  { file, hosts: hostArguments },
  Effect.fn(function* ({ file, hosts }) {
    const valid = yield* validate(hosts);
    const content = yield* HostsFile.readHostsFile(file).pipe(
      Effect.mapError(
        () => new UserInputError({ message: `Could not read ${file}.` }),
      ),
    );
    const managed = new Set(HostsFile.managedHosts(content));
    const present = valid.filter((host) => managed.has(host));
    if (present.length === 0) {
      yield* Console.log(
        `None of those hosts are in alchemy's block of ${file}.`,
      );
      return;
    }
    yield* write(file, HostsFile.removeHosts(content, present), "write");
    yield* Console.log(`Removed ${present.join(", ")} from ${file}.`);
  }),
).pipe(
  Command.withDescription(
    "Remove hostnames from alchemy's block of the hosts file (needs sudo)",
  ),
);

const listCommand = Command.make(
  "list",
  { file },
  Effect.fn(function* ({ file }) {
    const content = yield* HostsFile.readHostsFile(file).pipe(
      Effect.mapError(
        () => new UserInputError({ message: `Could not read ${file}.` }),
      ),
    );
    const managed = HostsFile.managedHosts(content);
    if (managed.length === 0) {
      yield* Console.log(`alchemy manages no hosts in ${file}.`);
      return;
    }
    for (const host of managed) yield* Console.log(host);
  }),
).pipe(
  Command.withDescription("List the hosts alchemy manages in the hosts file"),
);

export const hostsCommand = Command.make("hosts", {}, () =>
  Console.log(
    "Usage: alchemy hosts <add|remove|list> [hosts...]\n\n`alchemy dev --domain <custom>` prints the exact `sudo alchemy hosts add …` command it needs.",
  ),
).pipe(
  Command.withDescription(
    "Manage the hosts-file entries `alchemy dev --domain <custom>` needs (run with sudo)",
  ),
  Command.withSubcommands([addCommand, removeCommand, listCommand]),
);
