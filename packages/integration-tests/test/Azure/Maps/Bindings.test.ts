import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as geolocation from "@distilled.cloud/azure/maps-geolocation";
import * as render from "@distilled.cloud/azure/maps-render";
import * as route from "@distilled.cloud/azure/maps-route";
import * as search from "@distilled.cloud/azure/maps-search";
import * as timezone from "@distilled.cloud/azure/maps-timezone";
import * as traffic from "@distilled.cloud/azure/maps-traffic";
import * as weather from "@distilled.cloud/azure/maps-weather";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import MapsBindingsFunction, { Maps } from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/**
 * Built-in **Azure Maps Data Read and Batch Role**: the deployer's out-of-band
 * data-plane access (Data Reader cannot call the `:batch` endpoints).
 */
const AZURE_MAPS_DATA_READ_AND_BATCH = "d6470a16-71bd-43ab-86b3-6f3a73f4e787";

/** Object ID (`oid` claim) of the identity running the tests. */
const deployerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureMapsBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* MapsBindingsFunction;
    const account = yield* Maps;
    // Lets the deployer make the same calls out of band.
    const deployer = yield* deployerObjectId.pipe(Effect.orDie);
    yield* Azure.Authorization.RoleAssignment("MapsBindingsDeployerReader", {
      scope: account.accountId,
      roleDefinitionId: AZURE_MAPS_DATA_READ_AND_BATCH,
      principalId: deployer,
      principalType: "ServicePrincipal",
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      accountId: account.accountId,
      clientId: account.uniqueId,
    };
  }),
);

// Gen2 Maps account (per-transaction billing within the free monthly
// allowance) + a Flex Consumption app; ~$0.01/run, ~5 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 900_000 });

/** Deployer credentials and environment for out-of-band calls. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string; tag?: string };

/** Maps answers 401/403 until a new role assignment propagates. */
const DENIED = ["Unauthorized", "Forbidden", "AuthorizationFailed"];

/**
 * Call a binding route with `request` until it answers `ok` or a failure
 * that is not role propagation (or a Flex Consumption cold start), then
 * return the last answer so a real failure shows its Maps error.
 */
const call = (binding: string, request: unknown) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const query = new URLSearchParams({ request: JSON.stringify(request) });
    return yield* HttpClient.get(`${url}/${binding}?${query}`).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) =>
        body?.ok || (body?.tag !== undefined && !DENIED.includes(body.tag))
          ? Effect.succeed(body)
          : Effect.fail(body),
      ),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** The deployer's Maps role can trail the deploy by a few minutes. */
const whileDenied = {
  while: (e: { readonly _tag: string }) => DENIED.includes(e._tag),
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

/** Bytes as the fixture answers them: size and first bytes. */
const toJson = (result: unknown): unknown => {
  const body = (result as { body?: unknown } | undefined)?.body;
  if (body instanceof Uint8Array) {
    return { bytes: body.byteLength, head: Buffer.from(body.subarray(0, 8)).toString("hex") };
  }
  return JSON.parse(JSON.stringify(result ?? null));
};

/** A distilled Maps operation, as the deployer calls it. */
type Op = (input: any) => Effect.Effect<unknown, { readonly _tag: string }, any>;

/** Call `op` as the deployer with the account's unique ID, answered like the fixture. */
const outOfBand = (op: Op, request: object) =>
  Effect.gen(function* () {
    const { clientId } = yield* stack;
    const result = yield* op({ ...request, xMsClientId: clientId }).pipe(Effect.retry(whileDenied));
    return toJson(result);
  });

/** Same, answering the failure tag. */
const outOfBandTag = (op: Op, request: object) =>
  Effect.gen(function* () {
    const { clientId } = yield* stack;
    return yield* op({ ...request, xMsClientId: clientId }).pipe(
      Effect.retry(whileDenied),
      Effect.flip,
      Effect.map((e) => e._tag),
    );
  });

const PNG = "89504e470d0a1a0a";

const live = { timeout: 600_000 };

/** A route job's answer, as the deployer reads it (JSON). */
type RouteJob = { id?: string; status?: string; operationLocation?: string };
const job = (value: unknown) => value as RouteJob;

/** One Maps binding exercised through the Function and checked out of band. */
interface Case {
  readonly binding: string;
  readonly title: string;
  readonly op: Op;
  readonly request: object;
  /** The part of the answer both calls must agree on. */
  readonly stable: (result: any) => unknown;
  /** What the stable part must be. */
  readonly check: (stable: any) => void;
  /** Skip the live case, with the exact platform error. */
  readonly skipped?: string;
}

const nonEmpty = (list: unknown) => {
  expect(Array.isArray(list)).toBe(true);
  expect((list as unknown[]).length).toBeGreaterThan(0);
};

const waypoint = (pointIndex: number, coordinates: number[]) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates },
  properties: { pointIndex, pointType: "waypoint" },
});

const directions = {
  type: "FeatureCollection",
  features: [waypoint(0, [-122.201399, 47.608678]), waypoint(1, [-122.20687, 47.612002])],
  travelMode: "walking",
};

const matrix = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "MultiPoint", coordinates: [[-122.201399, 47.608678]] },
      properties: { pointType: "origins" },
    },
    {
      type: "Feature",
      geometry: {
        type: "MultiPoint",
        coordinates: [
          [-122.20687, 47.612002],
          [-122.13887, 47.632346],
        ],
      },
      properties: { pointType: "destinations" },
    },
  ],
  travelMode: "walking",
};

const rangeOrigin = { type: "Point", coordinates: [-122.201399, 47.608678] };

const gps = {
  type: "FeatureCollection",
  features: [
    [-122.336729, 47.590868],
    [-122.336042, 47.590868],
    [-122.335355, 47.590868],
  ].map((coordinates) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties: {},
  })),
};

/** `latitude,longitude`, as the Weather `query` parameter takes it. */
const seattle = "47.632346,-122.13887";

/** Every route of a directions answer as its distance in meters. */
const routeDistances = (result: any) =>
  (result?.features ?? [])
    .filter((f: any) => f?.properties?.type === "RoutePath")
    .map((f: any) => f.properties.distanceInMeters);

const cases: Case[] = [
  {
    binding: "GetIPToLocation",
    title: "resolves a public IP to its country/region",
    op: geolocation.GetGeolocationIPToLocation,
    request: { format: "json", ip: "8.8.8.8" },
    stable: (r) => r.countryRegion?.isoCode,
    check: (iso) => expect(iso).toBe("US"),
  },
  {
    binding: "GetMapAttribution",
    title: "lists the attribution of a tileset area",
    op: render.GetRenderMapAttribution,
    request: {
      tilesetId: "microsoft.base",
      zoom: 6,
      bounds: "-122.414162,47.57949,-122.247157,47.668372",
    },
    stable: (r) => r.copyrights,
    check: nonEmpty,
  },
  {
    binding: "GetCopyrightCaption",
    title: "returns the copyright caption",
    op: render.GetRenderCopyrightCaption,
    request: { format: "json" },
    stable: (r) => r.copyrightsCaption,
    check: (caption) => expect(caption).toMatch(/©/),
  },
  {
    binding: "GetCopyrightForTile",
    title: "returns the copyright of a tile",
    op: render.GetRenderCopyrightForTile,
    request: { format: "json", zoom: 6, x: 9, y: 22 },
    stable: (r) => r,
    check: (copyright) => expect(typeof copyright.formatVersion).toBe("string"),
  },
  {
    binding: "GetCopyrightForWorld",
    title: "returns the copyright of the world",
    op: render.GetRenderCopyrightForWorld,
    request: { format: "json" },
    stable: (r) => r,
    check: (copyright) => nonEmpty(copyright.generalCopyrights),
  },
  {
    binding: "GetCopyrightFromBoundingBox",
    title: "returns the copyright of a bounding box",
    op: render.GetRenderCopyrightFromBoundingBox,
    request: {
      format: "json",
      mincoordinates: "52.41064,4.84228",
      maxcoordinates: "52.41072,4.84239",
    },
    stable: (r) => r,
    check: (copyright) => expect(typeof copyright.formatVersion).toBe("string"),
  },
  {
    binding: "GetMapStaticImage",
    title: "renders a PNG map image",
    op: render.GetRenderMapStaticImage,
    request: {
      tilesetId: "microsoft.base.road",
      zoom: 12,
      center: "-122.177621,47.613079",
      width: 256,
      height: 256,
    },
    stable: (r) => r.head,
    check: (head) => expect(head).toBe(PNG),
  },
  {
    binding: "GetMapTile",
    title: "returns a PNG raster tile",
    op: render.GetRenderMapTile,
    request: { tilesetId: "microsoft.base.road", zoom: 6, x: 10, y: 22 },
    stable: (r) => r,
    check: (tile) => {
      expect(tile.head).toBe(PNG);
      expect(tile.bytes).toBeGreaterThan(100);
    },
  },
  {
    binding: "GetMapTileset",
    title: "returns the TileJSON of a tileset",
    op: render.GetRenderMapTileset,
    request: { tilesetId: "microsoft.base" },
    stable: (r) => ({ tilejson: r.tilejson, name: r.name, tiles: r.tiles }),
    check: (tileset) => nonEmpty(tileset.tiles),
  },
  {
    binding: "GetRouteDirections",
    title: "computes a walking route",
    op: route.PostRouteRouteDirections,
    request: directions,
    stable: routeDistances,
    check: nonEmpty,
  },
  {
    binding: "GetRouteDirectionsBatch",
    title: "computes a batch of routes",
    op: route.PostRouteRouteDirectionsBatch,
    request: { batchItems: [{ optionalId: "a", ...directions }] },
    stable: (r) => ({
      summary: r.summary,
      routes: (r.batchItems ?? []).map((item: any) => routeDistances(item)),
    }),
    check: (batch) => expect(batch.summary).toEqual({ successfulRequests: 1, totalRequests: 1 }),
  },
  {
    binding: "GetRouteMatrix",
    title: "computes a walking route matrix",
    op: route.PostRouteRouteMatrix,
    request: matrix,
    stable: (r) => r.properties?.matrix?.map((cell: any) => cell.distanceInMeters),
    check: (distances) => expect(distances).toHaveLength(2),
  },
  {
    binding: "GetRouteRange",
    title: "computes a reachable range",
    op: route.PostRouteRouteRange,
    request: {
      type: "Feature",
      geometry: rangeOrigin,
      properties: { distanceBudgetInMeters: 2000 },
    },
    stable: (r) => r.features?.map((f: any) => f.geometry?.type),
    check: nonEmpty,
  },
  {
    binding: "GetRouteRangeBatch",
    title: "computes a batch of reachable ranges",
    // Skipped: called as the Function's managed identity, Maps answers 400
    // `{"message":"Bad Request"}`; the same request succeeds as the deployer
    // (client secret), on atlas, us.atlas and eu.atlas.
    skipped: "BadRequest: Bad Request (managed identity only)",
    op: route.PostRouteRouteRangeBatch,
    request: {
      batchItems: [
        {
          optionalId: "a",
          type: "Feature",
          geometry: rangeOrigin,
          properties: { distanceBudgetInMeters: 2000 },
        },
      ],
    },
    stable: (r) => r.summary,
    check: (summary) => expect(summary).toEqual({ successfulRequests: 1, totalRequests: 1 }),
  },
  {
    binding: "SnapToRoads",
    title: "snaps GPS points to a road",
    op: route.PostRouteSnapToRoads,
    request: gps,
    stable: (r) => r.features?.map((f: any) => f.properties?.name),
    check: nonEmpty,
  },
  {
    binding: "SnapToRoadsBatch",
    title: "snaps a batch of GPS traces",
    op: route.PostRouteSnapToRoadsBatch,
    request: { batchItems: [{ optionalId: "a", ...gps }] },
    stable: (r) => r.summary,
    check: (summary) => expect(summary).toEqual({ successfulRequests: 1, totalRequests: 1 }),
  },
  {
    binding: "Geocode",
    title: "geocodes an address",
    op: search.SearchGetGeocoding,
    request: { query: "1 Microsoft Way, Redmond, WA 98052" },
    stable: (r) => r.features?.[0]?.geometry?.coordinates,
    check: (coordinates) => expect(coordinates).toHaveLength(2),
  },
  {
    binding: "GeocodeAutocomplete",
    title: "suggests places for a partial address",
    op: search.SearchGetGeocodeAutocomplete,
    request: { query: "1 Microsoft Way, Redm", coordinates: "-122.13,47.64" },
    stable: (r) => r.features?.length,
    check: (count) => expect(count).toBeGreaterThan(0),
  },
  {
    binding: "GeocodeBatch",
    title: "geocodes a batch of addresses",
    op: search.SearchGetGeocodingBatch,
    request: { batchItems: [{ optionalId: "a", query: "1 Microsoft Way, Redmond, WA 98052" }] },
    stable: (r) => r.summary,
    check: (summary) => expect(summary).toEqual({ successfulRequests: 1, totalRequests: 1 }),
  },
  {
    binding: "ReverseGeocode",
    title: "reverse-geocodes a coordinate",
    op: search.SearchGetReverseGeocoding,
    request: { coordinates: "-122.138669,47.630356" },
    stable: (r) => r.features?.[0]?.properties?.address?.countryRegion?.ISO,
    check: (iso) => expect(iso).toBe("US"),
  },
  {
    binding: "ReverseGeocodeBatch",
    title: "reverse-geocodes a batch of coordinates",
    op: search.SearchGetReverseGeocodingBatch,
    request: { batchItems: [{ optionalId: "a", coordinates: [-122.138669, 47.630356] }] },
    stable: (r) => r.summary,
    check: (summary) => expect(summary).toEqual({ successfulRequests: 1, totalRequests: 1 }),
  },
  {
    binding: "GetPolygon",
    title: "returns the boundary of a city",
    op: search.SearchGetPolygon,
    request: { coordinates: "-122.204141,47.61256", resultType: "locality", resolution: "small" },
    stable: (r) => r.properties?.name,
    check: (name) => expect(name).toBe("Bellevue"),
  },
  {
    binding: "GetTimezoneByCoordinates",
    title: "returns the time zone of a coordinate",
    op: timezone.GetTimezoneTimezoneByCoordinates,
    request: { format: "json", query: "47.0,-122.0" },
    stable: (r) => r.timeZones?.map((z: any) => z.id),
    check: (ids) => expect(ids).toEqual(["America/Los_Angeles"]),
  },
  {
    binding: "GetTimezoneByID",
    title: "returns a time zone by IANA ID",
    op: timezone.GetTimezoneTimezoneByID,
    request: { format: "json", query: "Europe/Berlin" },
    stable: (r) => r.timeZones?.map((z: any) => z.id),
    check: (ids) => expect(ids).toEqual(["Europe/Berlin"]),
  },
  {
    binding: "GetTimezoneEnumIANA",
    title: "lists the IANA time zones",
    op: timezone.GetTimezoneTimezoneEnumIANA,
    request: { format: "json" },
    stable: (r) => (r as { id?: string; windowsId?: string }[]).map((z) => z.id).sort(),
    check: (ids) => expect(ids).toContain("Europe/Berlin"),
  },
  {
    binding: "GetTimezoneEnumWindows",
    title: "lists the Windows time zones",
    op: timezone.GetTimezoneTimezoneEnumWindows,
    request: { format: "json" },
    stable: (r) => (r as { id?: string; windowsId?: string }[]).map((z) => z.windowsId).sort(),
    check: (ids) => expect(ids).toContain("Pacific Standard Time"),
  },
  {
    binding: "GetTimezoneIANAVersion",
    title: "returns the IANA database version",
    op: timezone.GetTimezoneTimezoneIANAVersion,
    request: { format: "json" },
    stable: (r) => r.version,
    check: (version) => expect(version).toMatch(/^\d{4}[a-z]$/),
  },
  {
    binding: "GetTimezoneWindowsToIANA",
    title: "converts a Windows time zone to IANA",
    op: timezone.GetTimezoneTimezoneWindowsToIANA,
    request: { format: "json", query: "Pacific Standard Time" },
    stable: (r) => (r as { id?: string; windowsId?: string }[]).map((z) => z.id).sort(),
    check: (ids) => expect(ids).toContain("America/Los_Angeles"),
  },
  {
    binding: "GetTrafficIncident",
    title: "lists the traffic incidents of a bounding box",
    op: traffic.GetTrafficTrafficIncident,
    request: { bbox: "-122.4,47.5,-122.2,47.7" },
    stable: (r) => r.type,
    check: (type) => expect(type).toBe("FeatureCollection"),
  },
  {
    binding: "GetCurrentAirQuality",
    title: "returns the current air quality",
    op: weather.GetWeatherCurrentAirQuality,
    request: { format: "json", query: seattle },
    stable: (r) => r.results?.length,
    check: (count) => expect(count).toBe(1),
  },
  {
    binding: "GetAirQualityDailyForecasts",
    title: "returns daily air quality forecasts",
    op: weather.GetWeatherAirQualityDailyForecasts,
    request: { format: "json", query: seattle, duration: 1 },
    stable: (r) => r.results?.length,
    check: (count) => expect(count).toBe(1),
  },
  {
    binding: "GetAirQualityHourlyForecasts",
    title: "returns hourly air quality forecasts",
    op: weather.GetWeatherAirQualityHourlyForecasts,
    request: { format: "json", query: seattle, duration: 1 },
    stable: (r) => r.results?.length,
    check: (count) => expect(count).toBe(1),
  },
  {
    binding: "GetCurrentConditions",
    title: "returns the current conditions",
    op: weather.GetWeatherCurrentConditions,
    request: { format: "json", query: seattle },
    stable: (r) => r.results?.length,
    check: (count) => expect(count).toBe(1),
  },
  {
    binding: "GetDailyForecast",
    title: "returns daily forecasts",
    op: weather.GetWeatherDailyForecast,
    request: { format: "json", query: seattle, duration: 5 },
    stable: (r) => r.forecasts?.length,
    check: (count) => expect(count).toBe(5),
  },
  {
    binding: "GetHourlyForecast",
    title: "returns hourly forecasts",
    op: weather.GetWeatherHourlyForecast,
    request: { format: "json", query: seattle, duration: 12 },
    stable: (r) => r.forecasts?.length,
    check: (count) => expect(count).toBe(12),
  },
  {
    binding: "GetMinuteForecast",
    title: "returns minute forecasts",
    op: weather.GetWeatherMinuteForecast,
    request: { format: "json", query: seattle, interval: 15 },
    stable: (r) => r.intervals?.length,
    check: (count) => expect(count).toBe(8),
  },
  {
    binding: "GetQuarterDayForecast",
    title: "returns quarter-day forecasts",
    op: weather.GetWeatherQuarterDayForecast,
    request: { format: "json", query: seattle, duration: 1 },
    stable: (r) => r.forecasts?.length,
    check: (count) => expect(count).toBe(4),
  },
  {
    binding: "GetDailyHistoricalActuals",
    title: "returns observed weather for past dates",
    op: weather.GetWeatherDailyHistoricalActuals,
    request: {
      format: "json",
      query: "40.78,-77.89",
      startDate: "2012-01-20",
      endDate: "2012-01-22",
    },
    stable: (r) => r.results?.map((d: any) => d.date),
    check: (dates) => expect(dates).toHaveLength(3),
  },
  {
    binding: "GetDailyHistoricalNormals",
    title: "returns climatological normals",
    op: weather.GetWeatherDailyHistoricalNormals,
    request: {
      format: "json",
      query: "40.78,-77.89",
      startDate: "2012-01-20",
      endDate: "2012-01-22",
    },
    stable: (r) => r.results?.map((d: any) => d.date),
    check: (dates) => expect(dates).toHaveLength(3),
  },
  {
    binding: "GetDailyHistoricalRecords",
    title: "returns record temperatures",
    op: weather.GetWeatherDailyHistoricalRecords,
    request: {
      format: "json",
      query: "40.78,-77.89",
      startDate: "2012-01-20",
      endDate: "2012-01-22",
    },
    stable: (r) => r.results?.map((d: any) => d.date),
    check: (dates) => expect(dates).toHaveLength(3),
  },
  {
    binding: "GetDailyIndices",
    title: "returns daily weather indices",
    op: weather.GetWeatherDailyIndices,
    request: { format: "json", query: seattle, duration: 1, indexId: 2 },
    stable: (r) => r.results?.map((d: any) => d.indexId),
    check: (ids) => expect(ids).toEqual([2]),
  },
  {
    binding: "GetWeatherAlongRoute",
    title: "returns the weather along a route",
    op: weather.GetWeatherWeatherAlongRoute,
    request: { format: "json", query: "38.907,-77.037,0:38.907,-77.009,10.0" },
    stable: (r) => r.waypoints?.length,
    check: (count) => expect(count).toBe(2),
  },
  {
    binding: "GetSevereWeatherAlerts",
    title: "returns the severe weather alerts",
    op: weather.GetWeatherSevereWeatherAlerts,
    request: { format: "json", query: "48.057,-81.091" },
    stable: (r) => Array.isArray(r.results),
    check: (isList) => expect(isList).toBe(true),
  },
  {
    binding: "SearchTropicalStorms",
    title: "lists the tropical storms of a year",
    op: weather.WeatherGetTropicalStormSearch,
    request: { format: "json", year: 2021, basinId: "EP" },
    stable: (r) => r.results?.map((s: any) => s.govId),
    check: (ids) => expect(ids).toContain(13),
  },
  {
    binding: "GetActiveTropicalStorms",
    title: "lists the active tropical storms",
    op: weather.GetWeatherTropicalStormActive,
    request: { format: "json" },
    stable: (r) => Array.isArray(r.results),
    check: (isList) => expect(isList).toBe(true),
  },
  {
    binding: "GetTropicalStormForecast",
    title: "returns a past storm's forecast track",
    op: weather.GetWeatherTropicalStormForecast,
    request: { format: "json", year: 2021, basinId: "EP", govId: 13 },
    stable: (r) => r.results?.length,
    check: (count) => expect(count).toBeGreaterThan(0),
  },
  {
    binding: "GetTropicalStormLocations",
    title: "returns a past storm's positions",
    op: weather.GetWeatherTropicalStormLocations,
    request: { format: "json", year: 2021, basinId: "EP", govId: 13 },
    stable: (r) => r.results?.length,
    check: (count) => expect(count).toBeGreaterThan(0),
  },
];

/** The route-operation ID at the end of an `Operation-Location` URL. */
const operationIdOf = (location: string | undefined) =>
  new URL(location ?? "http://invalid/").pathname.split("/").pop() ?? "";

/** Every role on the Function's identity, as its actions, on the account. */
const grantsOn = (principalId: string, accountId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    const grants: string[] = [];
    for (const assignment of assignments) {
      if (assignment.properties?.scope?.toLowerCase() !== accountId.toLowerCase()) continue;
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      grants.push(
        (definition.properties?.permissions ?? [])
          .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
          .sort()
          .join("+"),
      );
    }
    return grants.sort();
  });

describe("Azure Maps bindings on an Azure Function", { tags: ["provider:azure", "live"] }, () => {
  describe("least privilege", () => {
    test(
      "grants one custom role per Maps data action, on the account only",
      Effect.gen(function* () {
        const { principalId, accountId } = yield* stack;
        // Role-assignment lists trail new assignments by seconds.
        const grants = yield* grantsOn(principalId ?? "", accountId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (found) => found.length >= 8,
            times: 12,
          }),
        );
        expect(grants).toEqual([
          "Microsoft.Maps/accounts/services/batch/action",
          "Microsoft.Maps/accounts/services/geolocation/read",
          "Microsoft.Maps/accounts/services/render/read",
          "Microsoft.Maps/accounts/services/route/read",
          "Microsoft.Maps/accounts/services/search/read",
          "Microsoft.Maps/accounts/services/timezone/read",
          "Microsoft.Maps/accounts/services/traffic/read",
          "Microsoft.Maps/accounts/services/weather/read",
        ]);
      }).pipe(Effect.provide(azure)),
      live,
    );
  });

  for (const c of cases) {
    describe(`Maps.${c.binding}`, () => {
      (c.skipped === undefined ? test : test.skip)(
        c.title,
        Effect.gen(function* () {
          const body = yield* call(c.binding, c.request);
          expectOk(body);
          const viaFunction = c.stable(body.result);
          c.check(viaFunction);
          const viaDeployer = c.stable(yield* outOfBand(c.op, c.request));
          expect(viaFunction).toEqual(viaDeployer);
        }).pipe(Effect.provide(azure)),
        live,
      );
    });
  }

  describe("Maps.GetMapStateTile", () => {
    // Creator (statesets) is retired, so no stateset can be created: the
    // binding must reach Maps authorized and get the same typed answer
    // for an unknown stateset as the deployer.
    test(
      "reaches Maps with the account's identity for an unknown stateset",
      Effect.gen(function* () {
        const request = {
          statesetId: "00000000-0000-0000-0000-000000000000",
          zoom: 6,
          x: 10,
          y: 22,
        };
        const body = yield* call("GetMapStateTile", request);
        expect(body.ok).toBe(false);
        const tag = yield* outOfBandTag(render.GetRenderMapStateTile, request);
        expect(DENIED).not.toContain(tag);
        expect(body.tag).toBe(tag);
      }).pipe(Effect.provide(azure)),
      live,
    );
  });

  describe("Maps.StartRouteMatrix", () => {
    test(
      "starts an async matrix job the deployer can read",
      Effect.gen(function* () {
        const body = yield* call("StartRouteMatrix", matrix);
        expectOk(body);
        const id = operationIdOf(body.result.operationLocation);
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        const status = yield* outOfBand(route.GetRouteRouteOperationsStatus, { id });
        expect(job(status).id).toBe(id);
      }).pipe(Effect.provide(azure)),
      live,
    );
  });

  describe("Maps.GetRouteOperationStatus", () => {
    test(
      "reads a job the deployer started until it completes",
      Effect.gen(function* () {
        const started = yield* outOfBand(route.PostRouteRouteMatrixAsync, matrix);
        const id = operationIdOf(job(started).operationLocation);
        const status = yield* call("GetRouteOperationStatus", { id }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (b) => !b.ok || b.result.status === "Completed" || b.result.status === "Failed",
            times: 20,
          }),
        );
        expectOk(status);
        expect({ id: status.result.id, status: status.result.status }).toEqual({
          id,
          status: "Completed",
        });
      }).pipe(Effect.provide(azure)),
      live,
    );
  });

  describe("Maps.GetRouteOperationResult", () => {
    test(
      "reads the result of a completed matrix job",
      Effect.gen(function* () {
        const started = yield* outOfBand(route.PostRouteRouteMatrixAsync, matrix);
        const id = operationIdOf(job(started).operationLocation);
        yield* outOfBand(route.GetRouteRouteOperationsStatus, { id }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (s) => job(s).status === "Completed" || job(s).status === "Failed",
            times: 20,
          }),
        );
        const body = yield* call("GetRouteOperationResult", { id });
        expectOk(body);
        const distances = (r: any) =>
          r.properties?.matrix?.map((cell: any) => cell.distanceInMeters);
        expect(distances(body.result)).toHaveLength(2);
        const viaDeployer = yield* outOfBand(route.GetRouteRouteOperationsResult, { id });
        expect(distances(body.result)).toEqual(distances(viaDeployer));
      }).pipe(Effect.provide(azure)),
      live,
    );
  });
});
