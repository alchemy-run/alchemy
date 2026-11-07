<!-- Docs for the generated AWS.IoTManagedIntegrations bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetCustomEndpoint

Runtime binding for `iotmanagedintegrations:GetCustomEndpoint`
(account-level).

Reads the account's custom MQTT endpoint address — the address devices
connect to for Managed integrations traffic. Provide the implementation
with `Effect.provide(AWS.IoTManagedIntegrations.GetCustomEndpointHttp)`.

### Connectivity
**Example:** Resolve the Custom Endpoint
```typescript
const getCustomEndpoint = yield* IoTManagedIntegrations.GetCustomEndpoint();

const { EndpointAddress } = yield* getCustomEndpoint();
```

@binding

## GetDeviceDiscovery

Runtime binding for `iotmanagedintegrations:GetDeviceDiscovery`
(account-level).

Reads the status of a discovery scan started with
{@link StartDeviceDiscovery}. Provide the implementation with
`Effect.provide(AWS.IoTManagedIntegrations.GetDeviceDiscoveryHttp)`.

### Discovering Devices
**Example:** Poll a Discovery Scan
```typescript
const getDiscovery = yield* IoTManagedIntegrations.GetDeviceDiscovery();

const { Status } = yield* getDiscovery({ Identifier: discoveryId });
```

@binding

## GetDeviceDiscovery.Request

Request for {@link GetDeviceDiscovery}.

## GetManagedThingCapabilities

Runtime binding for the `GetManagedThingCapabilities` operation (IAM
action `iotmanagedintegrations:GetManagedThingCapabilities`), scoped to
one {@link ManagedThing}.

Reads the capability report the bound device registered at onboarding —
the data model that {@link SendManagedThingCommand} commands are written
against. Provide the implementation with
`Effect.provide(AWS.IoTManagedIntegrations.GetManagedThingCapabilitiesHttp)`.

### Reading Device State
**Example:** Inspect the Device Capability Report
```typescript
const getCapabilities =
  yield* IoTManagedIntegrations.GetManagedThingCapabilities(thing);

const { CapabilityReport } = yield* getCapabilities();
// CapabilityReport?.endpoints[0].capabilities
```

@binding

## GetManagedThingCertificate

Runtime binding for the `GetManagedThingCertificate` operation (IAM
action `iotmanagedintegrations:GetManagedThingCertificate`), scoped to
one {@link ManagedThing}.

Reads the (public) certificate PEM the bound device authenticates with —
useful for fleet audit and certificate-rotation tooling. Provide the
implementation with
`Effect.provide(AWS.IoTManagedIntegrations.GetManagedThingCertificateHttp)`.

### Reading Device State
**Example:** Fetch the Device Certificate
```typescript
const getCertificate =
  yield* IoTManagedIntegrations.GetManagedThingCertificate(thing);

const { CertificatePem } = yield* getCertificate();
```

@binding

## GetManagedThingConnectivityData

Runtime binding for the `GetManagedThingConnectivityData` operation (IAM
action `iotmanagedintegrations:GetManagedThingConnectivityData`), scoped
to one {@link ManagedThing}.

Reads whether the bound device is currently connected, when its
connectivity last changed, and the disconnect reason if offline. Provide
the implementation with
`Effect.provide(AWS.IoTManagedIntegrations.GetManagedThingConnectivityDataHttp)`.

### Reading Device State
**Example:** Check Device Connectivity
```typescript
const getConnectivity =
  yield* IoTManagedIntegrations.GetManagedThingConnectivityData(thing);

const { Connected, DisconnectReason } = yield* getConnectivity();
```

@binding

## GetManagedThingMetaData

Runtime binding for the `GetManagedThingMetaData` operation (IAM action
`iotmanagedintegrations:GetManagedThingMetaData`), scoped to one
{@link ManagedThing}.

Reads the metadata key-value pairs attached to the bound managed thing.
Provide the implementation with
`Effect.provide(AWS.IoTManagedIntegrations.GetManagedThingMetaDataHttp)`.

### Reading Device State
**Example:** Read Device Metadata
```typescript
const getMetaData =
  yield* IoTManagedIntegrations.GetManagedThingMetaData(thing);

const { MetaData } = yield* getMetaData();
```

@binding

## GetManagedThingState

Runtime binding for the `GetManagedThingState` operation (IAM action
`iotmanagedintegrations:GetManagedThingState`), scoped to one
{@link ManagedThing}.

Reads the last-reported state of every endpoint/capability of the bound
device (e.g. whether a smart plug is on). Provide the implementation with
`Effect.provide(AWS.IoTManagedIntegrations.GetManagedThingStateHttp)`.

### Reading Device State
**Example:** Read the Current Device State
```typescript
const getState = yield* IoTManagedIntegrations.GetManagedThingState(thing);

const { Endpoints } = yield* getState();
// Endpoints[0].capabilities[0].properties
```

@binding

## GetSchemaVersion

Runtime binding for `iotmanagedintegrations:GetSchemaVersion`
(account-level).

Reads one version of a capability or definition schema from the Managed
integrations schema catalog — the vocabulary that device data models and
commands are expressed in. Provide the implementation with
`Effect.provide(AWS.IoTManagedIntegrations.GetSchemaVersionHttp)`.

### Working with the Schema Catalog
**Example:** Fetch the On/Off Capability Schema
```typescript
const getSchemaVersion = yield* IoTManagedIntegrations.GetSchemaVersion();

const { Schema } = yield* getSchemaVersion({
  Type: "capability",
  SchemaVersionedId: "matter.OnOff@1.4",
});
```

@binding

## GetSchemaVersion.Request

Request for {@link GetSchemaVersion}.

## ListDeviceDiscoveries

Runtime binding for `iotmanagedintegrations:ListDeviceDiscoveries`
(account-level).

Lists the discovery scans in the account, optionally filtered by type or
status — useful for finding a running scan before polling it with
{@link GetDeviceDiscovery}. Provide the implementation with
`Effect.provide(AWS.IoTManagedIntegrations.ListDeviceDiscoveriesHttp)`.

### Discovering Devices
**Example:** List Running Discovery Scans
```typescript
const listDiscoveries = yield* IoTManagedIntegrations.ListDeviceDiscoveries();

const { Items } = yield* listDiscoveries({ StatusFilter: "RUNNING" });
```

@binding

## ListDeviceDiscoveries.Request

Request for {@link ListDeviceDiscoveries}.

## ListDiscoveredDevices

Runtime binding for `iotmanagedintegrations:ListDiscoveredDevices`
(account-level).

Lists the devices found by a discovery scan, including the managed thing
id assigned to each already-onboarded device. Provide the implementation
with `Effect.provide(AWS.IoTManagedIntegrations.ListDiscoveredDevicesHttp)`.

### Discovering Devices
**Example:** List Devices Found by a Scan
```typescript
const listDiscovered = yield* IoTManagedIntegrations.ListDiscoveredDevices();

const { Items } = yield* listDiscovered({ Identifier: discoveryId });
```

@binding

## ListDiscoveredDevices.Request

Request for {@link ListDiscoveredDevices}.

## ListManagedThingSchemas

Runtime binding for the `ListManagedThingSchemas` operation (IAM action
`iotmanagedintegrations:ListManagedThingSchemas`), scoped to one
{@link ManagedThing}.

Lists the capability schemas of the bound device, optionally filtered by
endpoint or capability id. Provide the implementation with
`Effect.provide(AWS.IoTManagedIntegrations.ListManagedThingSchemasHttp)`.

### Reading Device State
**Example:** List Device Schemas
```typescript
const listSchemas =
  yield* IoTManagedIntegrations.ListManagedThingSchemas(thing);

const { Items } = yield* listSchemas({ EndpointIdFilter: "1" });
```

@binding

## ListManagedThingSchemas.Request

`ListManagedThingSchemas` request with `Identifier` injected from the
bound managed thing.

## ListSchemaVersions

Runtime binding for `iotmanagedintegrations:ListSchemaVersions`
(account-level).

Lists capability or definition schema versions in the Managed
integrations schema catalog, optionally filtered by namespace, schema id,
visibility, or semantic version. Provide the implementation with
`Effect.provide(AWS.IoTManagedIntegrations.ListSchemaVersionsHttp)`.

### Working with the Schema Catalog
**Example:** List Matter Capability Schemas
```typescript
const listSchemaVersions = yield* IoTManagedIntegrations.ListSchemaVersions();

const { Items } = yield* listSchemaVersions({
  Type: "capability",
  Namespace: "matter",
});
```

@binding

## ListSchemaVersions.Request

Request for {@link ListSchemaVersions}.

## SendConnectorEvent

Runtime binding for `iotmanagedintegrations:SendConnectorEvent`
(account-level).

The cloud-to-cloud connector data plane: a connector Lambda calls this to
push third-party device events (state reports, discovery results, command
responses) into Managed integrations. Provide the implementation with
`Effect.provide(AWS.IoTManagedIntegrations.SendConnectorEventHttp)`.

### Connectors
**Example:** Report a Device State Change from a Connector
```typescript
const sendConnectorEvent = yield* IoTManagedIntegrations.SendConnectorEvent();

yield* sendConnectorEvent({
  ConnectorId: connectorId,
  Operation: "DEVICE_EVENT",
  ConnectorDeviceId: "third-party-device-1",
  Devices: [
    {
      ConnectorDeviceId: "third-party-device-1",
      CapabilityReport: capabilityReport,
    },
  ],
});
```

@binding

## SendConnectorEvent.Request

Request for {@link SendConnectorEvent}.

## SendManagedThingCommand

Runtime binding for the `SendManagedThingCommand` operation (IAM action
`iotmanagedintegrations:SendManagedThingCommand`), scoped to one
{@link ManagedThing}.

Sends a command to the bound device using its Matter-derived capability
data model — the primary control-plane-to-device data path. Provide the
implementation with
`Effect.provide(AWS.IoTManagedIntegrations.SendManagedThingCommandHttp)`.

### Controlling Devices
**Example:** Toggle a Device On
```typescript
const sendCommand = yield* IoTManagedIntegrations.SendManagedThingCommand(thing);

const { TraceId } = yield* sendCommand({
  Endpoints: [
    {
      endpointId: "1",
      capabilities: [
        {
          id: "aws.OnOff",
          name: "On/Off",
          version: "1",
          actions: [{ name: "activate", actionTraceId: "req-1" }],
        },
      ],
    },
  ],
});
```

@binding

## SendManagedThingCommand.Request

`SendManagedThingCommand` request with `ManagedThingId` injected from the
bound managed thing.

## StartDeviceDiscovery

Runtime binding for `iotmanagedintegrations:StartDeviceDiscovery`
(account-level).

Starts a discovery scan for devices reachable through a controller
(`ZWAVE`/`ZIGBEE`), a cloud-to-cloud connector (`CLOUD`), or a custom
protocol. Provide the implementation with
`Effect.provide(AWS.IoTManagedIntegrations.StartDeviceDiscoveryHttp)`.

### Discovering Devices
**Example:** Start a Zigbee Discovery Scan
```typescript
// init — account-level binding takes no resource
const startDiscovery = yield* IoTManagedIntegrations.StartDeviceDiscovery();

// runtime
const { Id } = yield* startDiscovery({
  DiscoveryType: "ZIGBEE",
  ControllerIdentifier: controllerManagedThingId,
});
```

@binding

## StartDeviceDiscovery.Request

Request for {@link StartDeviceDiscovery}.
