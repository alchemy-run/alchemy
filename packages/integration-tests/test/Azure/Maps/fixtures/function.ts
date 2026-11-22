import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";

// The account every binding is bound to. Module-scope so the test stack
// yields the same declaration. Shared keys are off: every call must use
// Microsoft Entra ID with the account's unique ID.
export const Maps = Azure.Maps.Account("MapsBindingsAccount", { disableLocalAuth: true });

/** A binding's runtime callable, erased to a JSON request. */
type Call = (request: any) => Effect.Effect<unknown, unknown, RuntimeContext>;

/** Bytes answer as their size and first bytes (`hex`); everything else as JSON. */
const toJson = (result: unknown): unknown => {
  const body = (result as { body?: unknown } | undefined)?.body;
  if (body instanceof Uint8Array) {
    return { bytes: body.byteLength, head: Buffer.from(body.subarray(0, 8)).toString("hex") };
  }
  return result ?? null;
};

/** Answer `{ ok, result }`, or `{ ok: false, error, tag }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result: toJson(result) })),
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause) as { _tag?: unknown } | undefined;
      return HttpServerResponse.json(
        {
          ok: false,
          tag: typeof error?._tag === "string" ? error._tag : undefined,
          error: Cause.pretty(cause),
        },
        { status: 500 },
      );
    }),
  );

/**
 * Effect Function with one route per Azure Maps binding:
 * `GET /<Binding>?request=<JSON>` calls the binding with the decoded request
 * and answers `{ ok, result | error }` (500 on error, so a caller retries
 * through role propagation and a real failure shows the Maps error).
 */
export default class MapsBindingsFunction extends Azure.Functions.Function<MapsBindingsFunction>()(
  "MapsBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const account = yield* Maps;
    const calls: Record<string, Call> = {
      GetIPToLocation: yield* Azure.Maps.GetIPToLocation(account),
      GetMapAttribution: yield* Azure.Maps.GetMapAttribution(account),
      GetCopyrightCaption: yield* Azure.Maps.GetCopyrightCaption(account),
      GetCopyrightForTile: yield* Azure.Maps.GetCopyrightForTile(account),
      GetCopyrightForWorld: yield* Azure.Maps.GetCopyrightForWorld(account),
      GetCopyrightFromBoundingBox: yield* Azure.Maps.GetCopyrightFromBoundingBox(account),
      GetMapStateTile: yield* Azure.Maps.GetMapStateTile(account),
      GetMapStaticImage: yield* Azure.Maps.GetMapStaticImage(account),
      GetMapTile: yield* Azure.Maps.GetMapTile(account),
      GetMapTileset: yield* Azure.Maps.GetMapTileset(account),
      GetRouteDirections: yield* Azure.Maps.GetRouteDirections(account),
      GetRouteDirectionsBatch: yield* Azure.Maps.GetRouteDirectionsBatch(account),
      GetRouteMatrix: yield* Azure.Maps.GetRouteMatrix(account),
      StartRouteMatrix: yield* Azure.Maps.StartRouteMatrix(account),
      GetRouteOperationStatus: yield* Azure.Maps.GetRouteOperationStatus(account),
      GetRouteOperationResult: yield* Azure.Maps.GetRouteOperationResult(account),
      GetRouteRange: yield* Azure.Maps.GetRouteRange(account),
      GetRouteRangeBatch: yield* Azure.Maps.GetRouteRangeBatch(account),
      SnapToRoads: yield* Azure.Maps.SnapToRoads(account),
      SnapToRoadsBatch: yield* Azure.Maps.SnapToRoadsBatch(account),
      Geocode: yield* Azure.Maps.Geocode(account),
      GeocodeAutocomplete: yield* Azure.Maps.GeocodeAutocomplete(account),
      GeocodeBatch: yield* Azure.Maps.GeocodeBatch(account),
      ReverseGeocode: yield* Azure.Maps.ReverseGeocode(account),
      ReverseGeocodeBatch: yield* Azure.Maps.ReverseGeocodeBatch(account),
      GetPolygon: yield* Azure.Maps.GetPolygon(account),
      GetTimezoneByCoordinates: yield* Azure.Maps.GetTimezoneByCoordinates(account),
      GetTimezoneByID: yield* Azure.Maps.GetTimezoneByID(account),
      GetTimezoneEnumIANA: yield* Azure.Maps.GetTimezoneEnumIANA(account),
      GetTimezoneEnumWindows: yield* Azure.Maps.GetTimezoneEnumWindows(account),
      GetTimezoneIANAVersion: yield* Azure.Maps.GetTimezoneIANAVersion(account),
      GetTimezoneWindowsToIANA: yield* Azure.Maps.GetTimezoneWindowsToIANA(account),
      GetTrafficIncident: yield* Azure.Maps.GetTrafficIncident(account),
      GetCurrentAirQuality: yield* Azure.Maps.GetCurrentAirQuality(account),
      GetAirQualityDailyForecasts: yield* Azure.Maps.GetAirQualityDailyForecasts(account),
      GetAirQualityHourlyForecasts: yield* Azure.Maps.GetAirQualityHourlyForecasts(account),
      GetCurrentConditions: yield* Azure.Maps.GetCurrentConditions(account),
      GetDailyForecast: yield* Azure.Maps.GetDailyForecast(account),
      GetHourlyForecast: yield* Azure.Maps.GetHourlyForecast(account),
      GetMinuteForecast: yield* Azure.Maps.GetMinuteForecast(account),
      GetQuarterDayForecast: yield* Azure.Maps.GetQuarterDayForecast(account),
      GetDailyHistoricalActuals: yield* Azure.Maps.GetDailyHistoricalActuals(account),
      GetDailyHistoricalNormals: yield* Azure.Maps.GetDailyHistoricalNormals(account),
      GetDailyHistoricalRecords: yield* Azure.Maps.GetDailyHistoricalRecords(account),
      GetDailyIndices: yield* Azure.Maps.GetDailyIndices(account),
      GetWeatherAlongRoute: yield* Azure.Maps.GetWeatherAlongRoute(account),
      GetSevereWeatherAlerts: yield* Azure.Maps.GetSevereWeatherAlerts(account),
      SearchTropicalStorms: yield* Azure.Maps.SearchTropicalStorms(account),
      GetActiveTropicalStorms: yield* Azure.Maps.GetActiveTropicalStorms(account),
      GetTropicalStormForecast: yield* Azure.Maps.GetTropicalStormForecast(account),
      GetTropicalStormLocations: yield* Azure.Maps.GetTropicalStormLocations(account),
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const call = calls[url.pathname.slice(1)];
        if (call === undefined) return HttpServerResponse.text("not found", { status: 404 });
        const body = url.searchParams.get("request");
        const input = yield* Effect.try(() => (body ? JSON.parse(body) : {})).pipe(Effect.orDie);
        return yield* respond(call(input));
      }),
    };
  }).pipe(
    Effect.provide(
      // Two groups: one variadic call of 51 layers is past tsc's inference limit.
      Layer.mergeAll(
        Layer.mergeAll(
          Azure.Maps.GetIPToLocationHttp,
          Azure.Maps.GetMapAttributionHttp,
          Azure.Maps.GetCopyrightCaptionHttp,
          Azure.Maps.GetCopyrightForTileHttp,
          Azure.Maps.GetCopyrightForWorldHttp,
          Azure.Maps.GetCopyrightFromBoundingBoxHttp,
          Azure.Maps.GetMapStateTileHttp,
          Azure.Maps.GetMapStaticImageHttp,
          Azure.Maps.GetMapTileHttp,
          Azure.Maps.GetMapTilesetHttp,
          Azure.Maps.GetRouteDirectionsHttp,
          Azure.Maps.GetRouteDirectionsBatchHttp,
          Azure.Maps.GetRouteMatrixHttp,
          Azure.Maps.StartRouteMatrixHttp,
          Azure.Maps.GetRouteOperationStatusHttp,
          Azure.Maps.GetRouteOperationResultHttp,
          Azure.Maps.GetRouteRangeHttp,
          Azure.Maps.GetRouteRangeBatchHttp,
          Azure.Maps.SnapToRoadsHttp,
          Azure.Maps.SnapToRoadsBatchHttp,
          Azure.Maps.GeocodeHttp,
          Azure.Maps.GeocodeAutocompleteHttp,
          Azure.Maps.GeocodeBatchHttp,
          Azure.Maps.ReverseGeocodeHttp,
          Azure.Maps.ReverseGeocodeBatchHttp,
          Azure.Maps.GetPolygonHttp,
          Azure.Maps.GetTimezoneByCoordinatesHttp,
          Azure.Maps.GetTimezoneByIDHttp,
          Azure.Maps.GetTimezoneEnumIANAHttp,
          Azure.Maps.GetTimezoneEnumWindowsHttp,
          Azure.Maps.GetTimezoneIANAVersionHttp,
          Azure.Maps.GetTimezoneWindowsToIANAHttp,
          Azure.Maps.GetTrafficIncidentHttp,
        ),
        Layer.mergeAll(
          Azure.Maps.GetCurrentAirQualityHttp,
          Azure.Maps.GetAirQualityDailyForecastsHttp,
          Azure.Maps.GetAirQualityHourlyForecastsHttp,
          Azure.Maps.GetCurrentConditionsHttp,
          Azure.Maps.GetDailyForecastHttp,
          Azure.Maps.GetHourlyForecastHttp,
          Azure.Maps.GetMinuteForecastHttp,
          Azure.Maps.GetQuarterDayForecastHttp,
          Azure.Maps.GetDailyHistoricalActualsHttp,
          Azure.Maps.GetDailyHistoricalNormalsHttp,
          Azure.Maps.GetDailyHistoricalRecordsHttp,
          Azure.Maps.GetDailyIndicesHttp,
          Azure.Maps.GetWeatherAlongRouteHttp,
          Azure.Maps.GetSevereWeatherAlertsHttp,
          Azure.Maps.SearchTropicalStormsHttp,
          Azure.Maps.GetActiveTropicalStormsHttp,
          Azure.Maps.GetTropicalStormForecastHttp,
          Azure.Maps.GetTropicalStormLocationsHttp,
        ),
      ),
    ),
  ),
) {}
