import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { MACHINE_TYPE, slow, ubuntuImageId } from "./compute.ts";

const { test } = makeStackitTest();

// Needs a running server (g1.1 about EUR 0.02-0.03/h; this suite holds one
// for about 8 minutes, < EUR 0.01 per run): gated behind STACKIT_TEST_SLOW.
const options = {
  tags: stackitTags("iaas", "serverserviceaccountattachment"),
  timeout: 1_800_000,
} as const;

const serverAccounts = (projectId: string, region: string, serverId: string) =>
  iaas
    .listServerServiceAccounts({ projectId, region, serverId })
    .pipe(Effect.map(({ items }) => items));

// Both service accounts stay deployed across steps so the replacement never
// removes the dependency it is moving away from.
const attachStack = (imageId: string, which: "first" | "second") =>
  Effect.gen(function* () {
    const network = yield* Stackit.IaaS.Network("SaAttachNetwork", {
      ipv4: { prefix: "10.231.45.0/24" },
    });
    const first = yield* Stackit.IAM.ServiceAccount("SaAttachFirst", {});
    const second = yield* Stackit.IAM.ServiceAccount("SaAttachSecond", {});
    const server = yield* Stackit.IaaS.Server("SaAttachServer", {
      machineType: MACHINE_TYPE,
      bootVolume: { size: 10, source: { type: "image", id: imageId } },
      networking: { networkId: network.networkId },
    });
    const attachment = yield* Stackit.IaaS.ServerServiceAccountAttachment("SaAttach", {
      serverId: server.serverId,
      serviceAccountEmail: which === "first" ? first.email : second.email,
    });
    return { server, first, second, attachment };
  });

test.provider.skipIf(slow)(
  "attach a service account to a server, swap it, and detach it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const imageId = yield* ubuntuImageId(projectId, region);
      yield* stack.destroy();

      const created = yield* stack.deploy(attachStack(imageId, "first"));
      const { serverId } = created.server;
      expect(created.attachment.serviceAccountEmail).toEqual(created.first.email);
      expect(yield* serverAccounts(projectId, region, serverId)).toEqual([created.first.email]);

      // A different account replaces the attachment (the old one first:
      // a server holds one service account).
      const swapped = yield* stack.deploy(attachStack(imageId, "second"));
      expect(swapped.server.serverId).toEqual(serverId);
      expect(yield* serverAccounts(projectId, region, serverId)).toEqual([swapped.second.email]);

      yield* stack.destroy();
      const server = yield* iaas.getServer({ projectId, region, serverId }).pipe(
        Effect.as("present" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      );
      expect(server).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "an exclusive attachment names the account already on the server, and doesn't wait on it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const imageId = yield* ubuntuImageId(projectId, region);
      yield* stack.destroy();

      const program = (exclusive: boolean) =>
        Effect.gen(function* () {
          const network = yield* Stackit.IaaS.Network("SaTakenNetwork", {
            ipv4: { prefix: "10.231.46.0/24" },
          });
          const first = yield* Stackit.IAM.ServiceAccount("SaTakenFirst", {});
          const second = yield* Stackit.IAM.ServiceAccount("SaTakenSecond", {});
          const server = yield* Stackit.IaaS.Server("SaTakenServer", {
            machineType: MACHINE_TYPE,
            bootVolume: { size: 10, source: { type: "image", id: imageId } },
            networking: { networkId: network.networkId },
          });
          yield* Stackit.IaaS.ServerServiceAccountAttachment("SaTakenFirstAttachment", {
            serverId: server.serverId,
            serviceAccountEmail: first.email,
          });
          if (exclusive) {
            yield* Stackit.IaaS.ServerServiceAccountAttachment("SaTakenSecondAttachment", {
              serverId: server.serverId,
              serviceAccountEmail: second.email,
              exclusive,
            });
          }
          return { server, first, second };
        });

      const created = yield* stack.deploy(program(false));
      const refused = yield* stack.deploy(program(true)).pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "Stackit.IaaS.ServerServiceAccountTaken",
        serverId: created.server.serverId,
        attached: created.first.email,
        serviceAccountEmail: created.second.email,
      });
      expect(yield* serverAccounts(projectId, region, created.server.serverId)).toEqual([
        created.first.email,
      ]);

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
