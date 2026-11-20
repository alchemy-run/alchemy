<!-- Docs for the generated AWS.IoTFleetWise bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AssociateVehicleFleet

Runtime binding for the `AssociateVehicleFleet` operation (IAM action
`iotfleetwise:AssociateVehicleFleet`), scoped to one {@link Fleet}.

Adds a vehicle to the bound fleet at runtime — e.g. a provisioning
Lambda enrolling freshly-registered vehicles. Provide the implementation
with `Effect.provide(AWS.IoTFleetWise.AssociateVehicleFleetHttp)`.

### Fleet Membership
**Example:** Enroll a Vehicle into the Fleet
```typescript
const associateVehicleFleet = yield* IoTFleetWise.AssociateVehicleFleet(fleet);

yield* associateVehicleFleet({ vehicleName: "vin-1HGBH41JXMN109186" });
```

@binding

## AssociateVehicleFleet.Request

`AssociateVehicleFleet` request with `fleetId` injected from the bound
fleet.

## BatchCreateVehicle

Runtime binding for the `BatchCreateVehicle` operation (IAM action
`iotfleetwise:BatchCreateVehicle`), account-level.

Creates up to 10 vehicles in one call — the data plane of vehicle
provisioning pipelines (each item names its model and decoder manifest).
Per-item failures are returned in the response `errors` list, not the
error channel. Provide the implementation with
`Effect.provide(AWS.IoTFleetWise.BatchCreateVehicleHttp)`.

### Provisioning Vehicles
**Example:** Provision a Batch of Vehicles
```typescript
const batchCreateVehicle = yield* IoTFleetWise.BatchCreateVehicle();

const { vehicles, errors } = yield* batchCreateVehicle({
  vehicles: [
    {
      vehicleName: "vin-1HGBH41JXMN109186",
      modelManifestArn,
      decoderManifestArn,
    },
  ],
});
```

@binding

## BatchUpdateVehicle

Runtime binding for the `BatchUpdateVehicle` operation (IAM action
`iotfleetwise:BatchUpdateVehicle`), account-level.

Updates up to 10 vehicles in one call — attributes, manifest
associations, and state-template associations. Per-item failures are
returned in the response `errors` list, not the error channel. Provide
the implementation with
`Effect.provide(AWS.IoTFleetWise.BatchUpdateVehicleHttp)`.

### Provisioning Vehicles
**Example:** Update a Batch of Vehicle Attributes
```typescript
const batchUpdateVehicle = yield* IoTFleetWise.BatchUpdateVehicle();

yield* batchUpdateVehicle({
  vehicles: [
    {
      vehicleName: "vin-1HGBH41JXMN109186",
      attributes: { "Vehicle.Color": "red" },
      attributeUpdateMode: "Merge",
    },
  ],
});
```

@binding

## DisassociateVehicleFleet

Runtime binding for the `DisassociateVehicleFleet` operation (IAM action
`iotfleetwise:DisassociateVehicleFleet`), scoped to one {@link Fleet}.

Removes a vehicle from the bound fleet at runtime. Provide the
implementation with
`Effect.provide(AWS.IoTFleetWise.DisassociateVehicleFleetHttp)`.

### Fleet Membership
**Example:** Remove a Vehicle from the Fleet
```typescript
const disassociateVehicleFleet =
  yield* IoTFleetWise.DisassociateVehicleFleet(fleet);

yield* disassociateVehicleFleet({ vehicleName: "vin-1HGBH41JXMN109186" });
```

@binding

## DisassociateVehicleFleet.Request

`DisassociateVehicleFleet` request with `fleetId` injected from the bound
fleet.

## GetVehicleStatus

Runtime binding for the `GetVehicleStatus` operation (IAM action
`iotfleetwise:GetVehicleStatus`), scoped to one {@link Vehicle}.

Reads the deployment status of the campaigns, decoder manifests, and
state templates associated with the bound vehicle. Provide the
implementation with
`Effect.provide(AWS.IoTFleetWise.GetVehicleStatusHttp)`.

### Vehicle Status
**Example:** Check Campaign Deployment on a Vehicle
```typescript
const getVehicleStatus = yield* IoTFleetWise.GetVehicleStatus(vehicle);

const status = yield* getVehicleStatus();
for (const campaign of status.campaigns ?? []) {
  console.log(campaign.campaignName, campaign.status);
}
```

@binding

## GetVehicleStatus.Request

`GetVehicleStatus` request with `vehicleName` injected from the bound
vehicle.

## ListDecoderManifestSignals

Runtime binding for the `ListDecoderManifestSignals` operation (IAM
action `iotfleetwise:ListDecoderManifestSignals`), scoped to one
{@link DecoderManifest}.

Lists the signal decoders (CAN/OBD/message decoding rules) defined in
the bound decoder manifest. Provide the implementation with
`Effect.provide(AWS.IoTFleetWise.ListDecoderManifestSignalsHttp)`.

### Inspecting Signal Definitions
**Example:** List a Decoder's Signal Decoders
```typescript
const listDecoderSignals =
  yield* IoTFleetWise.ListDecoderManifestSignals(decoder);

const { signalDecoders } = yield* listDecoderSignals();
```

@binding

## ListDecoderManifestSignals.Request

`ListDecoderManifestSignals` request with `name` injected from the bound
decoder manifest.

## ListFleetsForVehicle

Runtime binding for the `ListFleetsForVehicle` operation (IAM action
`iotfleetwise:ListFleetsForVehicle`), scoped to one {@link Vehicle}.

Lists the IDs of the fleets the bound vehicle belongs to. Provide the
implementation with
`Effect.provide(AWS.IoTFleetWise.ListFleetsForVehicleHttp)`.

### Fleet Membership
**Example:** List the Fleets a Vehicle Belongs To
```typescript
const listFleetsForVehicle = yield* IoTFleetWise.ListFleetsForVehicle(vehicle);

const { fleets } = yield* listFleetsForVehicle();
```

@binding

## ListFleetsForVehicle.Request

`ListFleetsForVehicle` request with `vehicleName` injected from the bound
vehicle.

## ListModelManifestNodes

Runtime binding for the `ListModelManifestNodes` operation (IAM action
`iotfleetwise:ListModelManifestNodes`), scoped to one
{@link ModelManifest}.

Lists the signal nodes referenced by the bound vehicle model. Provide
the implementation with
`Effect.provide(AWS.IoTFleetWise.ListModelManifestNodesHttp)`.

### Inspecting Signal Definitions
**Example:** List a Vehicle Model's Signals
```typescript
const listModelManifestNodes =
  yield* IoTFleetWise.ListModelManifestNodes(model);

const { nodes } = yield* listModelManifestNodes();
```

@binding

## ListModelManifestNodes.Request

`ListModelManifestNodes` request with `name` injected from the bound
model manifest.

## ListSignalCatalogNodes

Runtime binding for the `ListSignalCatalogNodes` operation (IAM action
`iotfleetwise:ListSignalCatalogNodes`), scoped to one
{@link SignalCatalog}.

Lists the branches, sensors, actuators, and attributes in the bound
signal catalog. Provide the implementation with
`Effect.provide(AWS.IoTFleetWise.ListSignalCatalogNodesHttp)`.

### Inspecting Signal Definitions
**Example:** List the Catalog's Sensors
```typescript
const listSignalCatalogNodes =
  yield* IoTFleetWise.ListSignalCatalogNodes(catalog);

const { nodes } = yield* listSignalCatalogNodes({
  signalNodeType: "SENSOR",
});
```

@binding

## ListSignalCatalogNodes.Request

`ListSignalCatalogNodes` request with `name` injected from the bound
signal catalog.

## ListVehicles

Runtime binding for the `ListVehicles` operation (IAM action
`iotfleetwise:ListVehicles`), account-level.

Lists the vehicles in the account, optionally filtered by model
manifest or attribute values. Provide the implementation with
`Effect.provide(AWS.IoTFleetWise.ListVehiclesHttp)`.

### Provisioning Vehicles
**Example:** List Vehicles by Attribute
```typescript
const listVehicles = yield* IoTFleetWise.ListVehicles();

const { vehicleSummaries } = yield* listVehicles({
  attributeNames: ["Vehicle.Color"],
  attributeValues: ["red"],
});
```

@binding

## ListVehiclesInFleet

Runtime binding for the `ListVehiclesInFleet` operation (IAM action
`iotfleetwise:ListVehiclesInFleet`), scoped to one {@link Fleet}.

Lists the names of the vehicles associated with the bound fleet. Provide
the implementation with
`Effect.provide(AWS.IoTFleetWise.ListVehiclesInFleetHttp)`.

### Fleet Membership
**Example:** List the Vehicles in a Fleet
```typescript
const listVehiclesInFleet = yield* IoTFleetWise.ListVehiclesInFleet(fleet);

const { vehicles } = yield* listVehiclesInFleet();
```

@binding

## ListVehiclesInFleet.Request

`ListVehiclesInFleet` request with `fleetId` injected from the bound
fleet.

## UpdateCampaign

Runtime binding for the `UpdateCampaign` operation (IAM action
`iotfleetwise:UpdateCampaign`), scoped to one {@link Campaign}.

Approves, suspends, or resumes the bound campaign at runtime — e.g. an
operations Lambda pausing data collection during an incident. Provide
the implementation with
`Effect.provide(AWS.IoTFleetWise.UpdateCampaignHttp)`.

### Campaign Control
**Example:** Suspend and Resume a Campaign
```typescript
const updateCampaign = yield* IoTFleetWise.UpdateCampaign(campaign);

yield* updateCampaign({ action: "SUSPEND" });
yield* updateCampaign({ action: "RESUME" });
```

@binding

## UpdateCampaign.Request

`UpdateCampaign` request with `name` injected from the bound campaign.
