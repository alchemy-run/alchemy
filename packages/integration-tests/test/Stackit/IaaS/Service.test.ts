import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as runCommand from "@distilled.cloud/stackit/run_command";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { slow } from "./compute.ts";
import EffectService from "./fixtures/service/effect-service.ts";
import { Box, EFFECT_PORT, makePing, makeServer, SECRET_VALUE } from "./fixtures/service/stack.ts";

const { test } = makeStackitTest();

const ASYNC_CIDR = "10.231.90.0/24";

// Each case boots a g1.1 server with a 10 GB boot volume and a public IP, billed per
// started hour: about EUR 0.05 per case, gated behind STACKIT_TEST_SLOW.
const options = { tags: stackitTags("iaas", "service"), timeout: 1_800_000 } as const;

const plainText = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? "" : Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** A shell command on the server, out of band: its printed output. */
const shell = (scope: { projectId: string; region: string; serverId: string }, script: string) =>
  Effect.gen(function* () {
    const { id } = yield* runCommand.createCommand({
      ...scope,
      commandTemplateName: "RunShellScript",
      parameters: { script },
    });
    const details = yield* runCommand.getCommand({ ...scope, commandId: String(id) }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (command) => command.status === "completed" || command.status === "failed",
        times: 60,
      }),
    );
    return plainText(details.output).trim();
  });

/** A program's answer, once a fresh address starts serving it. */
const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.timeout("10 seconds"),
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as any),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

/** The `ok` answer of a route, once the grant and the token have propagated. */
const getOk = (url: string) =>
  getJson(url).pipe(
    Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
    Effect.catch((body) => Effect.succeed(body)),
  );

const pingStack = (args: { greeting: string; labels?: Record<string, string> }) =>
  Effect.gen(function* () {
    const { server, address } = yield* makeServer("StackitServiceAsync", ASYNC_CIDR, args.labels);
    const ping = yield* makePing({ server, address, greeting: args.greeting });
    return { server, ping };
  });

test.provider.skipIf(slow)(
  "async: deploys, updates in place, survives a server update, and removes its unit",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(pingStack({ greeting: "one" }));
      const { serverId } = created.server;
      const scope = { projectId, region, serverId };
      expect(created.ping.serverId).toEqual(serverId);
      expect(created.ping.projectId).toEqual(projectId);
      expect(created.ping.url).toMatch(/^http:\/\/.+:3001$/);

      const first = yield* getJson(`${created.ping.url}/first`);
      expect(first).toEqual({
        form: "async",
        greeting: "one",
        secret: SECRET_VALUE,
        path: "/first",
      });

      // Out of band: the unit runs, its env is private, and no command holds the secret.
      const unit = `${created.ping.unitName}.service`;
      expect(yield* shell(scope, `systemctl is-active ${unit}`)).toEqual("active");
      expect(yield* shell(scope, `stat -c %a /opt/${created.ping.unitName}/env`)).toEqual("600");
      const { items } = yield* runCommand.listCommands(scope);
      expect((items ?? []).length).toBeGreaterThanOrEqual(2);
      for (const item of items ?? []) {
        const command = yield* runCommand.getCommand({ ...scope, commandId: String(item.id) });
        expect(plainText(command.script)).not.toContain(SECRET_VALUE);
        expect(plainText(command.output)).not.toContain(SECRET_VALUE);
      }

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(pingStack({ greeting: "one" }));
      expect(plan.resources.StackitServicePing).toMatchObject({ action: "noop" });

      // A new variable restarts the same unit on the same server.
      const updated = yield* stack.deploy(pingStack({ greeting: "two" }));
      expect(updated.ping.unitName).toEqual(created.ping.unitName);
      expect(updated.server.serverId).toEqual(serverId);
      expect((yield* getJson(`${updated.ping.url}/second`)).greeting).toEqual("two");

      // An in-place update of the server keeps the Service where it is.
      const relabeled = yield* stack.deploy(pingStack({ greeting: "two", labels: { team: "a" } }));
      expect(relabeled.server.serverId).toEqual(serverId);
      expect(relabeled.ping.unitName).toEqual(created.ping.unitName);
      expect(yield* shell(scope, `systemctl is-active ${unit}`)).toEqual("active");

      // Removing the Service removes the unit, and leaves the server running.
      yield* stack.deploy(makeServer("StackitServiceAsync", ASYNC_CIDR, { team: "a" }));
      const gone = yield* shell(
        scope,
        `test -e /etc/systemd/system/${unit} || test -e /opt/${created.ping.unitName}; echo $?`,
      );
      expect(gone).toEqual("1");
      const server = yield* iaas.getServer(scope);
      expect(server.status).toEqual("ACTIVE");

      yield* stack.destroy();
      const after = yield* iaas.getServer(scope).pipe(
        Effect.as("present" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      );
      expect(after).toEqual("gone");
    }).pipe(logLevel),
  options,
);

const TWO_CIDR = "10.231.92.0/24";

const twoServices = (greeting: string) =>
  Effect.gen(function* () {
    const { server, address } = yield* makeServer("StackitServiceTwo", TWO_CIDR);
    const first = yield* makePing({ server, address, greeting, id: "StackitServiceFirst" });
    const second = yield* makePing({
      server,
      address,
      greeting,
      id: "StackitServiceSecond",
      port: EFFECT_PORT,
    });
    return { server, first, second };
  });

test.provider.skipIf(slow)(
  "two Services prepare one fresh server at once, and a relative file survives a deploy",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(twoServices("one"));
      const scope = { projectId, region, serverId: created.server.serverId };
      expect((yield* getJson(`${created.first.url}/first`)).greeting).toEqual("one");
      expect((yield* getJson(`${created.second.url}/second`)).greeting).toEqual("one");

      // The unit's working directory stays across a deploy, while its program is swapped.
      const unit = created.first.unitName;
      expect(yield* shell(scope, `systemctl show -p WorkingDirectory --value ${unit}`)).toEqual(
        `/var/lib/${unit}`,
      );
      yield* shell(scope, `echo kept > /var/lib/${unit}/marker`);
      const updated = yield* stack.deploy(twoServices("two"));
      expect((yield* getJson(`${updated.first.url}/third`)).greeting).toEqual("two");
      expect(yield* shell(scope, `cat /var/lib/${unit}/marker`)).toEqual("kept");

      // Removing one Service removes its directory, and leaves the other running.
      yield* stack.deploy(
        Effect.gen(function* () {
          const { server, address } = yield* makeServer("StackitServiceTwo", TWO_CIDR);
          yield* makePing({
            server,
            address,
            greeting: "two",
            id: "StackitServiceSecond",
            port: EFFECT_PORT,
          });
        }),
      );
      expect(yield* shell(scope, `test -e /var/lib/${unit}; echo $?`)).toEqual("1");
      expect((yield* getJson(`${updated.second.url}/fourth`)).greeting).toEqual("two");

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

const REPLACED_CIDR = "10.231.93.0/24";

const onReplacedServer = (userData: string | undefined) =>
  Effect.gen(function* () {
    const { server, address } = yield* makeServer(
      "StackitServiceMoved",
      REPLACED_CIDR,
      {},
      userData,
    );
    const ping = yield* makePing({ server, address, greeting: "moved" });
    return { server, ping };
  });

test.provider.skipIf(slow)(
  "replacing the server installs the program on the new one",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(onReplacedServer(undefined));
      const moved = yield* stack.deploy(onReplacedServer("#cloud-config\npackages: []\n"));
      expect(moved.server.serverId).not.toEqual(created.server.serverId);
      expect(moved.ping.serverId).toEqual(moved.server.serverId);
      expect((yield* getJson(`${moved.ping.url}/moved`)).greeting).toEqual("moved");

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

const effectStack = Effect.gen(function* () {
  const { server } = yield* Box;
  const service = yield* EffectService;
  return { server, service };
});

test.provider.skipIf(slow)(
  "effect: serves the program, with bindings signing as the server's service account",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(effectStack);
      const { serverId } = deployed.server;
      const scope = { projectId, region, serverId };

      const hello = yield* getOk(`${deployed.service.url}/hello`);
      expect(hello.result).toMatchObject({
        form: "effect",
        greeting: "hello from effect",
        secret: SECRET_VALUE,
        hasKey: false,
      });

      // Out of band: the account the program names is the one attached to its server.
      const account = hello.result.account as string;
      expect(account).toMatch(/@sa\.stackit\.cloud$/);
      const attached = yield* iaas.listServerServiceAccounts(scope);
      expect(attached.items).toEqual([account]);

      // The binding works, which takes a metadata token and the account's grant.
      const listed = yield* getOk(`${deployed.service.url}/list-commands`);
      expect({ ok: listed.ok, error: listed.error }).toEqual({ ok: true });
      expect(listed.result.items.length).toBeGreaterThanOrEqual(2);

      // A second deploy must keep the grant and the attachment.
      const redeployed = yield* stack.deploy(effectStack);
      expect(redeployed.service.unitName).toEqual(deployed.service.unitName);
      const again = yield* getOk(`${deployed.service.url}/list-commands`);
      expect({ ok: again.ok, error: again.error }).toEqual({ ok: true });

      yield* stack.destroy();
      const after = yield* iaas.listServerServiceAccounts(scope).pipe(
        Effect.as("present" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      );
      expect(after).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "fails with a typed error on a server that isn't running",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const stopped = Effect.gen(function* () {
        const network = yield* Stackit.IaaS.Network("StackitServiceStoppedNetwork", {
          ipv4: { prefix: "10.231.92.0/24" },
        });
        const { projectId, region } = yield* Stackit.StackitEnvironment.current;
        const { items } = yield* iaas.listImages({ projectId, region, all: true });
        const image = items
          .filter((item) => item.scope === "public" && /ubuntu/i.test(item.name) && item.id)
          .sort((a, b) => b.name.localeCompare(a.name))[0]!.id!;
        const server = yield* Stackit.IaaS.Server("StackitServiceStoppedServer", {
          machineType: "g1.1",
          bootVolume: { size: 10, source: { type: "image", id: image } },
          networking: { networkId: network.networkId },
          desiredStatus: "inactive",
        });
        return yield* Stackit.IaaS.Service("StackitServiceStopped", {
          server,
          main: new URL("./fixtures/service/async-service.ts", import.meta.url).href,
        });
      });
      const error = yield* stack.deploy(stopped).pipe(Effect.flip);
      expect((error as { _tag: string })._tag).toEqual("Stackit.IaaS.ServiceServerNotRunning");
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
