import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ApiKey } from "./ApiKey.ts";
import type { GeofenceCollection } from "./GeofenceCollection.ts";
import type { Map } from "./Map.ts";
import type { PlaceIndex } from "./PlaceIndex.ts";
import type { RouteCalculator } from "./RouteCalculator.ts";
import type { Tracker } from "./Tracker.ts";
import type { TrackerConsumer } from "./TrackerConsumer.ts";

/**
 * Dashboard UI providers for AWS Location resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Front-End Web & Mobile (Location Service) brand pink. */
const COLOR = "#E7157B";

export const MapUI = UIProvider.succeed<Map>("AWS.Location.Map", {
  displayName: "Location Map",
  icon: "map",
  color: COLOR,
  category: "other",
  summary: (ctx) => ctx.attrs?.mapName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.mapName, copy: true },
    { label: "arn", value: ctx.attrs?.mapArn, mono: true, copy: true },
    { label: "style", value: ctx.attrs?.style },
    { label: "data source", value: ctx.attrs?.dataSource },
    { label: "political view", value: ctx.attrs?.politicalView },
  ],
});

export const PlaceIndexUI = UIProvider.succeed<PlaceIndex>(
  "AWS.Location.PlaceIndex",
  {
    displayName: "Location Place Index",
    icon: "search",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.indexName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.indexName, copy: true },
      { label: "arn", value: ctx.attrs?.indexArn, mono: true, copy: true },
      { label: "data source", value: ctx.attrs?.dataSource },
      { label: "intended use", value: ctx.attrs?.intendedUse },
    ],
  },
);

export const RouteCalculatorUI = UIProvider.succeed<RouteCalculator>(
  "AWS.Location.RouteCalculator",
  {
    displayName: "Location Route Calculator",
    icon: "route",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.calculatorName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.calculatorName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.calculatorArn,
        mono: true,
        copy: true,
      },
      { label: "data source", value: ctx.attrs?.dataSource },
    ],
  },
);

export const TrackerUI = UIProvider.succeed<Tracker>("AWS.Location.Tracker", {
  displayName: "Location Tracker",
  icon: "map-pin",
  color: COLOR,
  category: "other",
  summary: (ctx) => ctx.attrs?.trackerName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.trackerName, copy: true },
    { label: "arn", value: ctx.attrs?.trackerArn, mono: true, copy: true },
    { label: "position filtering", value: ctx.attrs?.positionFiltering },
    { label: "eventbridge", value: ctx.attrs?.eventBridgeEnabled },
    { label: "kms key", value: ctx.attrs?.kmsKeyId, mono: true },
  ],
});

export const GeofenceCollectionUI = UIProvider.succeed<GeofenceCollection>(
  "AWS.Location.GeofenceCollection",
  {
    displayName: "Location Geofence Collection",
    icon: "map-pin",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.collectionName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.collectionName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.collectionArn,
        mono: true,
        copy: true,
      },
      { label: "kms key", value: ctx.attrs?.kmsKeyId, mono: true },
    ],
  },
);

export const TrackerConsumerUI = UIProvider.succeed<TrackerConsumer>(
  "AWS.Location.TrackerConsumer",
  {
    displayName: "Location Tracker Consumer",
    icon: "link",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.trackerName,
    facts: (ctx) => [
      { label: "tracker", value: ctx.attrs?.trackerName, copy: true },
      {
        label: "consumer",
        value: ctx.attrs?.consumerArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ApiKeyUI = UIProvider.succeed<ApiKey>("AWS.Location.ApiKey", {
  displayName: "Location API Key",
  icon: "key-round",
  color: COLOR,
  category: "auth",
  summary: (ctx) => ctx.attrs?.keyName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.keyName, copy: true },
    { label: "arn", value: ctx.attrs?.keyArn, mono: true, copy: true },
    { label: "expires", value: ctx.attrs?.expireTime },
    { label: "description", value: ctx.attrs?.description },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    MapUI,
    PlaceIndexUI,
    RouteCalculatorUI,
    TrackerUI,
    GeofenceCollectionUI,
    TrackerConsumerUI,
    ApiKeyUI,
  );
