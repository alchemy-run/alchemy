<!-- Docs for the generated AWS.IoTWireless bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DeleteQueuedMessages

Runtime binding for `iotwireless:DeleteQueuedMessages` — delete queued
downlink messages for the bound wireless device from a deployed Lambda or
Task.

### Purging the Downlink Queue
Provide the `DeleteQueuedMessagesHttp` implementation layer on the
Function effect, bind the device in the init phase, then call the
returned client at runtime.

**Example:** Purge All Pending Downlinks
```typescript
// init
const deleteQueued = yield* AWS.IoTWireless.DeleteQueuedMessages(device);

// runtime — "*" deletes every queued message
yield* deleteQueued({ MessageId: "*" });
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTWireless.DeleteQueuedMessagesHttp))
```

@binding

## DeleteQueuedMessages.Request

Request for {@link DeleteQueuedMessages}. The bound device's id is
injected automatically. Pass `MessageId: "*"` to purge the whole queue.

## GetPositionEstimate

Runtime binding for `iotwireless:GetPositionEstimate` — resolve an
estimated position (as a GeoJSON payload stream) from raw measurement
data — WiFi access points, cell towers, GNSS scans, or an IP address —
using third-party solvers, from a deployed Lambda or Task. Account-level:
it is not tied to any registered device.

### Estimating a Position
Provide the `GetPositionEstimateHttp` implementation layer on the
Function effect, bind the capability in the init phase, then call the
returned client at runtime. The `GeoJsonPayload` is a byte `Stream` —
decode it with `Stream.mkString(Stream.decodeText(...))`.

**Example:** Solve a Position from WiFi Scans
```typescript
// init
const estimate = yield* AWS.IoTWireless.GetPositionEstimate();

// runtime
const { GeoJsonPayload } = yield* estimate({
  WiFiAccessPoints: [
    { MacAddress: "A0:EC:F9:1E:32:C1", Rss: -66 },
    { MacAddress: "A0:EC:F9:15:72:5E", Rss: -72 },
  ],
});
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTWireless.GetPositionEstimateHttp))
```

@binding

## GetResourcePosition

Runtime binding for `iotwireless:GetResourcePosition` — read the bound
wireless device's position (WGS84, returned as a GeoJSON payload stream)
from a deployed Lambda or Task.

### Reading Device Position
Provide the `GetResourcePositionHttp` implementation layer on the
Function effect, bind the device in the init phase, then call the
returned client at runtime. The `GeoJsonPayload` is a byte `Stream` —
decode it to a string with `Stream.mkString(Stream.decodeText(...))`.

**Example:** Read the Device's GeoJSON Position
```typescript
// init
const getPosition = yield* AWS.IoTWireless.GetResourcePosition(device);

// runtime
const { GeoJsonPayload } = yield* getPosition();
const geoJson = GeoJsonPayload === undefined
  ? undefined
  : yield* Stream.mkString(Stream.decodeText(GeoJsonPayload));
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTWireless.GetResourcePositionHttp))
```

@binding

## GetResourcePosition.Request

Request for {@link GetResourcePosition}. The bound device's id and the
`WirelessDevice` resource type are injected automatically, leaving
nothing else to supply.

## GetServiceEndpoint

Runtime binding for `iotwireless:GetServiceEndpoint` — read the
account's CUPS or LNS endpoint (and its server trust certificate) from a
deployed Lambda or Task. Useful for gateway provisioning flows.

### Reading the Service Endpoint
Provide the `GetServiceEndpointHttp` implementation layer on the Function
effect, bind the capability in the init phase, then call the returned
client at runtime.

**Example:** Read the LNS Endpoint
```typescript
// init
const getEndpoint = yield* AWS.IoTWireless.GetServiceEndpoint();

// runtime
const { ServiceEndpoint } = yield* getEndpoint({ ServiceType: "LNS" });
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTWireless.GetServiceEndpointHttp))
```

@binding

## GetWirelessDeviceStatistics

Runtime binding for `iotwireless:GetWirelessDeviceStatistics` — read the
bound wireless device's operating information (last uplink time, RSSI/SNR
gateway metadata, battery level, device state) from a deployed Lambda or
Task.

### Reading Device Statistics
Provide the `GetWirelessDeviceStatisticsHttp` implementation layer on the
Function effect, bind the device in the init phase, then call the
returned client at runtime.

**Example:** Check When the Device Last Reported
```typescript
// init
const getStats = yield* AWS.IoTWireless.GetWirelessDeviceStatistics(device);

// runtime
const stats = yield* getStats();
const lastSeen = stats.LastUplinkReceivedAt;
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTWireless.GetWirelessDeviceStatisticsHttp))
```

@binding

## GetWirelessDeviceStatistics.Request

Request for {@link GetWirelessDeviceStatistics}. The bound device's id is
injected automatically, leaving nothing else to supply.

## GetWirelessGatewayStatistics

Runtime binding for `iotwireless:GetWirelessGatewayStatistics` — read the
bound wireless gateway's operating information (connection status, last
uplink time) from a deployed Lambda or Task.

### Reading Gateway Statistics
Provide the `GetWirelessGatewayStatisticsHttp` implementation layer on
the Function effect, bind the gateway in the init phase, then call the
returned client at runtime.

**Example:** Check the Gateway's Connection Status
```typescript
// init
const getStats = yield* AWS.IoTWireless.GetWirelessGatewayStatistics(gateway);

// runtime
const stats = yield* getStats();
const online = stats.ConnectionStatus === "Connected";
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTWireless.GetWirelessGatewayStatisticsHttp))
```

@binding

## GetWirelessGatewayStatistics.Request

Request for {@link GetWirelessGatewayStatistics}. The bound gateway's id
is injected automatically, leaving nothing else to supply.

## ListQueuedMessages

Runtime binding for `iotwireless:ListQueuedMessages` — list the downlink
messages queued for the bound wireless device from a deployed Lambda or
Task.

### Inspecting the Downlink Queue
Provide the `ListQueuedMessagesHttp` implementation layer on the Function
effect, bind the device in the init phase, then call the returned client
at runtime.

**Example:** Count Pending Downlinks
```typescript
// init
const listQueued = yield* AWS.IoTWireless.ListQueuedMessages(device);

// runtime
const { DownlinkQueueMessagesList } = yield* listQueued();
const pending = DownlinkQueueMessagesList?.length ?? 0;
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTWireless.ListQueuedMessagesHttp))
```

@binding

## ListQueuedMessages.Request

Request for {@link ListQueuedMessages}. The bound device's id is injected
automatically.

## SendDataToWirelessDevice

Runtime binding for `iotwireless:SendDataToWirelessDevice` — queue a
downlink message to the bound wireless device from a deployed Lambda or
Task. The message is delivered the next time the device opens a receive
window.

### Sending Downlink Messages
Provide the `SendDataToWirelessDeviceHttp` implementation layer on the
Function effect, bind the device in the init phase, then call the
returned client at runtime.

**Example:** Queue a Downlink to a LoRaWAN Device
```typescript
// init
const sendData = yield* AWS.IoTWireless.SendDataToWirelessDevice(device);

// runtime — PayloadData is base64-encoded
const { MessageId } = yield* sendData({
  PayloadData: Buffer.from("hello").toString("base64"),
  TransmitMode: 1,
  WirelessMetadata: { LoRaWAN: { FPort: 1 } },
});
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTWireless.SendDataToWirelessDeviceHttp))
```

@binding

## SendDataToWirelessDevice.Request

Request for {@link SendDataToWirelessDevice}. The bound device's id is
injected automatically.

## TestWirelessDevice

Runtime binding for `iotwireless:TestWirelessDevice` — simulate a
provisioned device by sending an uplink data payload of `Hello` on behalf
of the bound wireless device, from a deployed Lambda or Task. Useful for
verifying a destination's routing without radio hardware.

### Simulating an Uplink
Provide the `TestWirelessDeviceHttp` implementation layer on the Function
effect, bind the device in the init phase, then call the returned client
at runtime.

**Example:** Send a Test Uplink
```typescript
// init
const testDevice = yield* AWS.IoTWireless.TestWirelessDevice(device);

// runtime
const { Result } = yield* testDevice();
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTWireless.TestWirelessDeviceHttp))
```

@binding

## TestWirelessDevice.Request

Request for {@link TestWirelessDevice}. The bound device's id is injected
automatically, leaving nothing else to supply.

## UpdateResourcePosition

Runtime binding for `iotwireless:UpdateResourcePosition` — set the bound
wireless device's static position (WGS84, as a GeoJSON payload) from a
deployed Lambda or Task.

### Updating Device Position
Provide the `UpdateResourcePositionHttp` implementation layer on the
Function effect, bind the device in the init phase, then call the
returned client at runtime.

**Example:** Set a Static GeoJSON Position
```typescript
// init
const updatePosition = yield* AWS.IoTWireless.UpdateResourcePosition(device);

// runtime — coordinates are [longitude, latitude, altitude]
yield* updatePosition({
  GeoJsonPayload: JSON.stringify({
    type: "Point",
    coordinates: [-122.33, 47.61, 10],
  }),
});
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTWireless.UpdateResourcePositionHttp))
```

@binding

## UpdateResourcePosition.Request

Request for {@link UpdateResourcePosition}. The bound device's id and the
`WirelessDevice` resource type are injected automatically; supply the
GeoJSON position payload (a string is accepted directly).
