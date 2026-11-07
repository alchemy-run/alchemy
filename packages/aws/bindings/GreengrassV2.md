<!-- Docs for the generated AWS.GreengrassV2 bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchAssociateClientDeviceWithCoreDevice

Runtime binding for `greengrass:BatchAssociateClientDeviceWithCoreDevice`.

Associates up to 100 client devices with a core device so they can use it
as their local MQTT broker — the write half of client-device fleet
management. The caller supplies the core device thing name and the client
device entries at runtime. Provide the implementation with
`Effect.provide(AWS.GreengrassV2.BatchAssociateClientDeviceWithCoreDeviceHttp)`.
### Managing Client Devices
**Example:** Associate Client Devices
```typescript
// init — account-level binding, no resource argument
const associateClientDevices =
  yield* AWS.GreengrassV2.BatchAssociateClientDeviceWithCoreDevice();

// runtime
const { errorEntries } = yield* associateClientDevices({
  coreDeviceThingName: "MyCore",
  entries: [{ thingName: "Sensor1" }, { thingName: "Sensor2" }],
});
```

@binding

## BatchDisassociateClientDeviceFromCoreDevice

Runtime binding for `greengrass:BatchDisassociateClientDeviceFromCoreDevice`.

Removes up to 100 client-device associations from a core device — the
cleanup half of client-device fleet management. The caller supplies the
core device thing name and the client device entries at runtime. Provide
the implementation with
`Effect.provide(AWS.GreengrassV2.BatchDisassociateClientDeviceFromCoreDeviceHttp)`.
### Managing Client Devices
**Example:** Disassociate Client Devices
```typescript
// init — account-level binding, no resource argument
const disassociateClientDevices =
  yield* AWS.GreengrassV2.BatchDisassociateClientDeviceFromCoreDevice();

// runtime
const { errorEntries } = yield* disassociateClientDevices({
  coreDeviceThingName: "MyCore",
  entries: [{ thingName: "RetiredSensor" }],
});
```

@binding

## CancelDeployment

Runtime binding for `greengrass:CancelDeployment`.

Halts the bound {@link Deployment}'s rollout: core devices that already
received it keep running its components, but devices that have not yet
applied it never will. The deployment id is injected from the binding —
the canonical emergency-stop for a bad rollout. Provide the implementation
with `Effect.provide(AWS.GreengrassV2.CancelDeploymentHttp)`.
### Monitoring Deployments
**Example:** Emergency-Stop A Rollout
```typescript
// init — bind the operation to the deployment
const cancelDeployment = yield* AWS.GreengrassV2.CancelDeployment(deployment);

// runtime
yield* cancelDeployment();
```

@binding

## DeleteCoreDevice

Runtime binding for `greengrass:DeleteCoreDevice`.

Deregisters a core device from IoT Greengrass (the backing IoT thing is
untouched) — the fleet-decommissioning primitive for automation that
retires devices. The caller supplies the core device thing name at
runtime. Provide the implementation with
`Effect.provide(AWS.GreengrassV2.DeleteCoreDeviceHttp)`.
### Managing Core Devices
**Example:** Decommission A Core Device
```typescript
// init — account-level binding, no resource argument
const deleteCoreDevice = yield* AWS.GreengrassV2.DeleteCoreDevice();

// runtime
yield* deleteCoreDevice({ coreDeviceThingName: "RetiredCore" });
```

@binding

## DescribeComponent

Runtime binding for `greengrass:DescribeComponent`.

Reads the bound {@link ComponentVersion}'s cloud metadata — publisher,
description, lifecycle `status` (`DEPLOYABLE`, `FAILED`, `DEPRECATED`),
platforms, and tags — so a function can audit component health before
rolling out a deployment. The component version ARN is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.GreengrassV2.DescribeComponentHttp)`.
### Reading Components
**Example:** Check A Component's State
```typescript
// init — bind the operation to the component version
const describeComponent = yield* AWS.GreengrassV2.DescribeComponent(component);

// runtime
const metadata = yield* describeComponent();
if (metadata.status?.componentState === "DEPRECATED") {
  yield* Effect.logWarning(`${metadata.componentName} is deprecated`);
}
```

@binding

## GetComponent

Runtime binding for `greengrass:GetComponent`.

Fetches the bound {@link ComponentVersion}'s recipe (JSON or YAML, as raw
bytes) so a function can inspect or mirror the component definition. The
component version ARN is injected from the binding. Provide the
implementation with `Effect.provide(AWS.GreengrassV2.GetComponentHttp)`.
### Reading Components
**Example:** Fetch A Component's Recipe
```typescript
// init — bind the operation to the component version
const getComponent = yield* AWS.GreengrassV2.GetComponent(component);

// runtime
const { recipe } = yield* getComponent({ recipeOutputFormat: "JSON" });
const text = new TextDecoder().decode(recipe);
```

@binding

## GetComponentVersionArtifact

Runtime binding for `greengrass:GetComponentVersionArtifact`.

Mints a pre-signed download URL for one of the bound
{@link ComponentVersion}'s artifacts (the same API core devices use to
fetch artifacts during installation). The component version ARN is
injected from the binding; the caller names the artifact. Provide the
implementation with
`Effect.provide(AWS.GreengrassV2.GetComponentVersionArtifactHttp)`.
### Reading Components
**Example:** Mint An Artifact Download URL
```typescript
// init — bind the operation to the component version
const getArtifact = yield* AWS.GreengrassV2.GetComponentVersionArtifact(component);

// runtime
const { preSignedUrl } = yield* getArtifact({ artifactName: "installer.zip" });
```

@binding

## GetConnectivityInfo

Runtime binding for `greengrass:GetConnectivityInfo`.

Reads a core device's connectivity information — the endpoints and ports
where client devices can reach the core's local MQTT broker (the same data
the IoT Greengrass discovery API serves). The caller supplies the core
device's thing name at runtime. Provide the implementation with
`Effect.provide(AWS.GreengrassV2.GetConnectivityInfoHttp)`.
### Managing Client Devices
**Example:** Read A Core's Broker Endpoints
```typescript
// init — account-level binding, no resource argument
const getConnectivityInfo = yield* AWS.GreengrassV2.GetConnectivityInfo();

// runtime
const { connectivityInfo } = yield* getConnectivityInfo({
  thingName: "MyCore",
});
```

@binding

## GetCoreDevice

Runtime binding for `greengrass:GetCoreDevice`.

Reads one core device's metadata — status (`HEALTHY` / `UNHEALTHY`),
nucleus version, platform, and last status-update timestamp. Core devices
register themselves (they are not Alchemy resources), so the caller
supplies the core device thing name at runtime. Provide the implementation
with `Effect.provide(AWS.GreengrassV2.GetCoreDeviceHttp)`.
### Managing Core Devices
**Example:** Check A Core Device's Health
```typescript
// init — account-level binding, no resource argument
const getCoreDevice = yield* AWS.GreengrassV2.GetCoreDevice();

// runtime
const device = yield* getCoreDevice({ coreDeviceThingName: "MyCore" });
yield* Effect.log(`${device.coreDeviceThingName} is ${device.status}`);
```

@binding

## GetDeployment

Runtime binding for `greengrass:GetDeployment`.

Reads the bound {@link Deployment}'s full detail — status (`ACTIVE`,
`COMPLETED`, `CANCELED`, `FAILED`), component specs, IoT job linkage, and
whether it is still the latest revision for its target — so a function can
monitor a rollout. The deployment id is injected from the binding. Provide
the implementation with
`Effect.provide(AWS.GreengrassV2.GetDeploymentHttp)`.
### Monitoring Deployments
**Example:** Check A Deployment's Status
```typescript
// init — bind the operation to the deployment
const getDeployment = yield* AWS.GreengrassV2.GetDeployment(deployment);

// runtime
const detail = yield* getDeployment();
yield* Effect.log(`rollout is ${detail.deploymentStatus}`);
```

@binding

## ListClientDevicesAssociatedWithCoreDevice

Runtime binding for `greengrass:ListClientDevicesAssociatedWithCoreDevice`.

Enumerates the client devices associated with a core device (the IoT
things allowed to connect to the core's local MQTT broker). The caller
supplies the core device thing name at runtime. Provide the implementation
with
`Effect.provide(AWS.GreengrassV2.ListClientDevicesAssociatedWithCoreDeviceHttp)`.
### Managing Client Devices
**Example:** List A Core's Client Devices
```typescript
// init — account-level binding, no resource argument
const listClientDevices =
  yield* AWS.GreengrassV2.ListClientDevicesAssociatedWithCoreDevice();

// runtime
const { associatedClientDevices } = yield* listClientDevices({
  coreDeviceThingName: "MyCore",
});
```

@binding

## ListComponentVersions

Runtime binding for `greengrass:ListComponentVersions`.

Enumerates every registered version of a component, newest first. The
caller supplies the component's base ARN
(`arn:aws:greengrass:…:components:{name}`, without the `:versions:`
suffix). Provide the implementation with
`Effect.provide(AWS.GreengrassV2.ListComponentVersionsHttp)`.
### Reading Components
**Example:** List A Component's Versions
```typescript
// init — account-level binding, no resource argument
const listComponentVersions = yield* AWS.GreengrassV2.ListComponentVersions();

// runtime
const { componentVersions } = yield* listComponentVersions({
  arn: componentBaseArn,
});
```

@binding

## ListComponents

Runtime binding for `greengrass:ListComponents`.

Enumerates the account's component definitions (latest version of each),
optionally scoped to `PRIVATE` or `PUBLIC` components — the entry point
for fleet-software inventory tooling. Provide the implementation with
`Effect.provide(AWS.GreengrassV2.ListComponentsHttp)`.
### Reading Components
**Example:** List Private Components
```typescript
// init — account-level binding, no resource argument
const listComponents = yield* AWS.GreengrassV2.ListComponents();

// runtime
const { components } = yield* listComponents({ scope: "PRIVATE" });
```

@binding

## ListCoreDevices

Runtime binding for `greengrass:ListCoreDevices`.

Enumerates the account's Greengrass core devices, optionally filtered by
status (`HEALTHY` / `UNHEALTHY`), thing group, or nucleus runtime — the
entry point for fleet-health dashboards. Provide the implementation with
`Effect.provide(AWS.GreengrassV2.ListCoreDevicesHttp)`.
### Managing Core Devices
**Example:** Find Unhealthy Core Devices
```typescript
// init — account-level binding, no resource argument
const listCoreDevices = yield* AWS.GreengrassV2.ListCoreDevices();

// runtime
const { coreDevices } = yield* listCoreDevices({ status: "UNHEALTHY" });
```

@binding

## ListDeployments

Runtime binding for `greengrass:ListDeployments`.

Enumerates the account's deployments, optionally filtered to one target
thing/thing group or to the latest revision per target — a fleet-wide view
of what is rolling out where. Provide the implementation with
`Effect.provide(AWS.GreengrassV2.ListDeploymentsHttp)`.
### Monitoring Deployments
**Example:** List The Latest Deployment Per Target
```typescript
// init — account-level binding, no resource argument
const listDeployments = yield* AWS.GreengrassV2.ListDeployments();

// runtime
const { deployments } = yield* listDeployments({
  historyFilter: "LATEST_ONLY",
});
```

@binding

## ListEffectiveDeployments

Runtime binding for `greengrass:ListEffectiveDeployments`.

Enumerates the deployments that apply to a core device, with each one's
per-device execution status (`SUCCEEDED`, `FAILED`, `IN_PROGRESS`, …) —
how a rollout monitor tracks a deployment landing on real hardware. The
caller supplies the core device thing name at runtime. Provide the
implementation with
`Effect.provide(AWS.GreengrassV2.ListEffectiveDeploymentsHttp)`.
### Managing Core Devices
**Example:** Track A Rollout On A Device
```typescript
// init — account-level binding, no resource argument
const listEffectiveDeployments = yield* AWS.GreengrassV2.ListEffectiveDeployments();

// runtime
const { effectiveDeployments } = yield* listEffectiveDeployments({
  coreDeviceThingName: "MyCore",
});
```

@binding

## ListInstalledComponents

Runtime binding for `greengrass:ListInstalledComponents`.

Enumerates the components actually installed on a core device (name,
version, lifecycle state such as `RUNNING` or `BROKEN`, and last status
report) — the ground truth for "what is this device really running". The
caller supplies the core device thing name at runtime. Provide the
implementation with
`Effect.provide(AWS.GreengrassV2.ListInstalledComponentsHttp)`.
### Managing Core Devices
**Example:** Audit A Device's Installed Components
```typescript
// init — account-level binding, no resource argument
const listInstalledComponents = yield* AWS.GreengrassV2.ListInstalledComponents();

// runtime
const { installedComponents } = yield* listInstalledComponents({
  coreDeviceThingName: "MyCore",
});
```

@binding

## ResolveComponentCandidates

Runtime binding for `greengrass:ResolveComponentCandidates`.

Resolves a set of component candidates against a target platform,
returning the exact component versions (and their recipes) that satisfy
the version requirements — the same dependency-resolution API the
Greengrass nucleus calls during a deployment. Provide the implementation
with `Effect.provide(AWS.GreengrassV2.ResolveComponentCandidatesHttp)`.

NOTE: per the AWS API reference, this operation must be called through the
Greengrass **data plane** endpoint authenticated with an AWS IoT device
certificate. Calls signed with plain IAM credentials (e.g. from a Lambda
role) are rejected with a typed `AccessDeniedException` even when the
`greengrass:ResolveComponentCandidates` permission is granted — use this
binding only from device-credentialed contexts.
### Reading Components
**Example:** Resolve Versions For A Platform
```typescript
// init — account-level binding, no resource argument
const resolveComponentCandidates =
  yield* AWS.GreengrassV2.ResolveComponentCandidates();

// runtime
const { resolvedComponentVersions } = yield* resolveComponentCandidates({
  platform: { attributes: { os: "linux", architecture: "amd64" } },
  componentCandidates: [
    { componentName: "com.example.Hello", versionRequirements: { req: ">=1.0.0" } },
  ],
});
```

@binding

## UpdateConnectivityInfo

Runtime binding for `greengrass:UpdateConnectivityInfo`.

Replaces a core device's connectivity information — the endpoints and
ports client devices use to reach the core's local MQTT broker. Typically
driven by automation that knows the core's current IP (e.g. reacting to a
DHCP change). The caller supplies the core device's thing name and the new
endpoint list at runtime. Provide the implementation with
`Effect.provide(AWS.GreengrassV2.UpdateConnectivityInfoHttp)`.
### Managing Client Devices
**Example:** Publish A Core's Broker Endpoint
```typescript
// init — account-level binding, no resource argument
const updateConnectivityInfo = yield* AWS.GreengrassV2.UpdateConnectivityInfo();

// runtime
yield* updateConnectivityInfo({
  thingName: "MyCore",
  connectivityInfo: [
    { id: "lan", hostAddress: "192.168.1.20", portNumber: 8883 },
  ],
});
```

@binding
