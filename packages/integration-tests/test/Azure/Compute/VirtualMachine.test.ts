import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { withPublicIps, withVcpus } from "../gates.ts";
import { AsyncVm, AsyncVmContainer } from "./fixtures/async-stack.ts";
import EffectVm, { VmFiles } from "./fixtures/effect-vm.ts";
import {
  logLevel,
  PUBLIC_KEY_1,
  subscriptionId,
  tags,
  untilGone,
  VM_LOCATION,
  VM_SIZE,
  VM_SIZE_ALT,
  vmNetwork,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVm = (resourceGroupName: string, vmName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetVirtualMachine({ subscriptionId, resourceGroupName, vmName }),
  );

const getReleaseCommand = (resourceGroupName: string, vmName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetVirtualMachineRunCommandByVirtualMachine({
      subscriptionId,
      resourceGroupName,
      vmName,
      runCommandName: "alchemy-release",
      _expand: "instanceView",
    }),
  );

/** Role GUIDs `principalId` holds on `scope` (assigned there or above). */
const rolesOn = (scope: string, principalId: string) =>
  authorization
    .ListRoleAssignmentForScope({ scope, _filter: `principalId eq '${principalId}'` })
    .pipe(
      Effect.map((page) =>
        page.value
          .filter((a) => a.properties?.scope?.toLowerCase() === scope.toLowerCase())
          .map((a) => a.properties?.roleDefinitionId?.split("/").pop() ?? "")
          .sort(),
      ),
    );

/** Role assignments `principalId` holds anywhere in the subscription. */
const assignmentsOf = (principalId: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    authorization
      .ListRoleAssignmentForSubscription({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      })
      .pipe(Effect.map((page) => page.value.map((a) => a.name ?? ""))),
  );

/**
 * Poll {@link rolesOn} until `done` holds: role-assignment reads trail
 * writes by up to a minute or two (10 s apart, 3 minutes at most).
 */
const rolesOnUntil = (scope: string, principalId: string, done: (roles: string[]) => boolean) =>
  rolesOn(scope, principalId).pipe(
    Effect.repeat({ schedule: Schedule.spaced("10 seconds"), until: done, times: 18 }),
  );

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body: string }> {}

/**
 * `GET url` until it answers 200: the program is up when the deploy
 * returns, but blob role assignments take a minute or two to apply
 * (10 s apart, 5 minutes at most).
 */
const fetchOk = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        Effect.flatMap(res.text, (body) =>
          res.status === 200
            ? Effect.succeed(body)
            : Effect.fail(new NotReady({ status: res.status, body: body.slice(0, 300) })),
        ),
      ),
      Effect.mapError((e) =>
        e._tag === "NotReady" ? e : new NotReady({ status: 0, body: String(e) }),
      ),
      Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
    );
  });

// 1-vCPU F-series v7 VMs (~$0.04/hour) without a public IP for ~10
// minutes: well under $0.05 per run.
const program = (props: {
  vmSize: string;
  adminUsername: string;
  bootDiagnostics: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, nic } = yield* vmNetwork();
    const vm = yield* Azure.Compute.VirtualMachine("Vm", {
      resourceGroup: group.resourceGroupName,
      location: VM_LOCATION,
      vmSize: props.vmSize,
      networkInterfaceIds: [nic.networkInterfaceId],
      adminUsername: props.adminUsername,
      sshPublicKeys: [PUBLIC_KEY_1],
      bootDiagnostics: props.bootDiagnostics,
      identity: { systemAssigned: props.bootDiagnostics },
      tags: props.tags,
    });
    return { group, nic, vm };
  });

test.provider(
  "create, update, replace, and delete a virtual machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, nic, vm } = yield* stack.deploy(
        program({
          vmSize: VM_SIZE,
          adminUsername: "azureuser",
          bootDiagnostics: false,
          tags: { env: "test" },
        }),
      );
      expect(vm.vmId).toMatch(/^[0-9a-f-]{36}$/);
      expect(vm.vmSize).toEqual(VM_SIZE);
      expect(vm.networkInterfaceIds.map((id) => id.toLowerCase())).toEqual([
        nic.networkInterfaceId.toLowerCase(),
      ]);
      expect(vm.principalId).toBeUndefined();
      expect(vm.privateIpAddress).toMatch(/^10\.0\.1\.\d+$/);
      expect(vm.url).toBeUndefined();
      const observed = yield* getVm(group.resourceGroupName, vm.virtualMachineName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.osProfile?.adminUsername).toEqual("azureuser");
      expect(
        observed.properties?.osProfile?.linuxConfiguration?.disablePasswordAuthentication,
      ).toEqual(true);
      expect(observed.properties?.storageProfile?.osDisk?.deleteOption).toEqual("Delete");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Vm");

      // In place: resize, boot diagnostics, system identity, tags.
      const updated = yield* stack.deploy(
        program({
          vmSize: VM_SIZE_ALT,
          adminUsername: "azureuser",
          bootDiagnostics: true,
          tags: { env: "prod" },
        }),
      );
      expect(updated.vm.vmId).toEqual(vm.vmId);
      expect(updated.vm.vmSize).toEqual(VM_SIZE_ALT);
      expect(updated.vm.principalId).toMatch(/^[0-9a-f-]{36}$/);
      const reobserved = yield* getVm(group.resourceGroupName, vm.virtualMachineName);
      expect(reobserved.properties?.hardwareProfile?.vmSize).toEqual(VM_SIZE_ALT);
      expect(reobserved.properties?.diagnosticsProfile?.bootDiagnostics?.enabled).toEqual(true);
      expect(reobserved.identity?.type).toEqual("SystemAssigned");
      expect(reobserved.tags?.env).toEqual("prod");

      // The admin user is fixed at creation: replacement (delete-first, the
      // NIC is reused).
      const replaced = yield* stack.deploy(
        program({
          vmSize: VM_SIZE_ALT,
          adminUsername: "operator",
          bootDiagnostics: true,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.vm.virtualMachineName).not.toEqual(vm.virtualMachineName);
      expect(replaced.vm.vmId).not.toEqual(vm.vmId);
      const replacedVm = yield* getVm(group.resourceGroupName, replaced.vm.virtualMachineName);
      expect(replacedVm.properties?.osProfile?.adminUsername).toEqual("operator");
      expect(yield* untilGone(getVm(group.resourceGroupName, vm.virtualMachineName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* untilGone(getVm(group.resourceGroupName, replaced.vm.virtualMachineName)),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);

// One 1-vCPU F-series v7 VM (~$0.04/hour) with a Standard public IP (~$0.005/hour)
// for ~10 minutes: under $0.01 per run.
test.provider(
  "async VM program serves fetch with literal, secret, and resource env",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const vm = yield* AsyncVm;
          const container = yield* AsyncVmContainer;
          return {
            url: vm.url,
            name: vm.virtualMachineName,
            resourceGroup: vm.resourceGroup,
            unitName: vm.unitName,
            container: container.containerName,
          };
        }),
      );
      expect(out.url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:3000$/);
      expect(out.unitName).toEqual("alchemy-asyncvm");

      // Out of band: the VM runs as its system-assigned identity, and the
      // release command ran to success.
      const observed = yield* getVm(out.resourceGroup, out.name);
      expect(observed.identity?.type).toEqual("SystemAssigned");
      const release = yield* getReleaseCommand(out.resourceGroup, out.name);
      expect(release.properties?.instanceView?.executionState).toEqual("Succeeded");
      expect(release.properties?.instanceView?.exitCode).toEqual(0);

      const body = JSON.parse(yield* fetchOk(`${out.url}/greet?name=azure`)) as {
        message: string;
        secretLength: number;
        container: string;
        path: string;
        node: string;
      };
      expect(body.message).toEqual("hello azure");
      expect(body.secretLength).toEqual("s3cret".length);
      expect(body.container).toEqual(out.container);
      expect(body.path).toEqual("/greet");
      expect(body.node).toMatch(/^22\./);

      yield* stack.destroy();
      expect(yield* untilGone(getVm(out.resourceGroup, out.name))).toEqual("gone");
    }).pipe(withVcpus(1), withPublicIps(1), logLevel),
  { tags, timeout: 1_800_000 },
);

const effectProgram = Effect.gen(function* () {
  const vm = yield* EffectVm;
  const files = yield* VmFiles;
  return {
    url: vm.url,
    name: vm.virtualMachineName,
    resourceGroup: vm.resourceGroup,
    vmId: vm.vmId,
    principalId: vm.principalId,
    releaseHash: vm.releaseHash,
    filesId: files.containerId,
  };
});

// One 1-vCPU F-series v7 VM (~$0.04/hour) with a Standard public IP (~$0.005/hour)
// for ~15 minutes: under $0.01 per run.
test.provider(
  // Keep the name short: `SecurityRule` puts the scratch stack name (file +
  // test name) in a description Azure caps at 140 characters.
  "effect VM program serves fetch, a loop, and a blob binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(effectProgram);
      expect(out.url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:3000$/);
      expect(out.principalId).toMatch(/^[0-9a-f-]{36}$/);

      expect(yield* fetchOk(`${out.url}/hello`)).toEqual("hello from a vm");
      expect(Number(yield* fetchOk(`${out.url}/ticks`))).toBeGreaterThan(0);

      // The program calls Blob storage with the VM's identity…
      const written = JSON.parse(yield* fetchOk(`${out.url}/blob?key=vm.txt&value=from-vm`)) as {
        result: { text: string };
      };
      expect(written.result.text).toEqual("from-vm");
      // …which holds exactly the container-scoped data role the binding asked for.
      const contributor = Azure.Authorization.BuiltInRole.StorageBlobDataContributor;
      expect(
        yield* rolesOnUntil(out.filesId, out.principalId!, (roles) => roles.length > 0),
      ).toEqual([contributor]);

      // A changed env value restarts the program in place on the same VM.
      const config = yield* ConfigProvider.ConfigProvider;
      const redeployed = yield* stack
        .deploy(effectProgram)
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.orElse(
              ConfigProvider.fromEnv({ env: { AZURE_VM_EFFECT_GREETING: "hi" } }),
              config,
            ),
          ),
        );
      expect(redeployed.vmId).toEqual(out.vmId);
      expect(redeployed.releaseHash).not.toEqual(out.releaseHash);
      expect(yield* fetchOk(`${out.url}/hello`)).toEqual("hi from a vm");
      expect(
        yield* rolesOnUntil(out.filesId, out.principalId!, (roles) => roles.length > 0),
      ).toEqual([contributor]);
      const reread = JSON.parse(yield* fetchOk(`${out.url}/blob?key=vm.txt&value=again`)) as {
        result: { text: string };
      };
      expect(reread.result.text).toEqual("again");

      yield* stack.destroy();
      expect(yield* untilGone(getVm(out.resourceGroup, out.name))).toEqual("gone");
      // Destroy revoked the binding's grant (role assignments outlive their principal).
      expect(
        yield* assignmentsOf(out.principalId!).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (names) => names.length === 0,
            times: 18,
          }),
        ),
      ).toEqual([]);
    }).pipe(withVcpus(1), withPublicIps(1), logLevel),
  { tags, timeout: 1_800_000 },
);
