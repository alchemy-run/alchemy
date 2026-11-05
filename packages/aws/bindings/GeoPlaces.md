<!-- Docs for the generated AWS.GeoPlaces bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## Autocomplete

Runtime binding for `geo-places:Autocomplete` — complete potential places
and addresses as the user types, based on partial input.

geo-places is a standalone, pay-per-call Amazon Location API with no
resource to manage: the binding takes no arguments and grants the function
`geo-places:Autocomplete`. Requests and responses are raw distilled types
(no marshalling).

### Autocompleting Queries
Provide the `AutocompleteHttp` implementation layer on the Function effect
(`.pipe(Effect.provide(AWS.GeoPlaces.AutocompleteHttp))`), bind in the init
phase, then call the client at runtime.

**Example:** Autocomplete a partial address
```typescript
// init
const autocomplete = yield* AWS.GeoPlaces.Autocomplete();

// runtime
const result = yield* autocomplete({
  QueryText: "1600 Pennsylvania",
  MaxResults: 5,
});
const first = result.ResultItems?.[0]?.Title;
```

@binding

## Geocode

Runtime binding for `geo-places:Geocode` — convert an address or place
description into geographic coordinates.

geo-places is a standalone, pay-per-call Amazon Location API with no
resource to manage: the binding takes no arguments and grants the function
`geo-places:Geocode`. Requests and responses are raw distilled types (no
marshalling).

### Geocoding Addresses
Provide the `GeocodeHttp` implementation layer on the Function effect
(`.pipe(Effect.provide(AWS.GeoPlaces.GeocodeHttp))`), bind in the init
phase, then call the client at runtime.

**Example:** Geocode an address to coordinates
```typescript
// init
const geocode = yield* AWS.GeoPlaces.Geocode();

// runtime
const result = yield* geocode({
  QueryText: "1600 Pennsylvania Ave NW, Washington, DC",
});
const position = result.ResultItems?.[0]?.Position; // [lng, lat]
```

@binding

## GetPlace

Runtime binding for `geo-places:GetPlace` — fetch the full details of a
place (address, contacts, opening hours, time zone, …) by its `PlaceId`,
as returned by Geocode, SearchText, SearchNearby, Suggest, or
Autocomplete.

geo-places is a standalone, pay-per-call Amazon Location API with no
resource to manage: the binding takes no arguments and grants the function
`geo-places:GetPlace`. Requests and responses are raw distilled types (no
marshalling).

### Fetching Place Details
Provide the `GetPlaceHttp` implementation layer on the Function effect
(`.pipe(Effect.provide(AWS.GeoPlaces.GetPlaceHttp))`), bind in the init
phase, then call the client at runtime.

**Example:** Look up a place by its PlaceId
```typescript
// init
const geocode = yield* AWS.GeoPlaces.Geocode();
const getPlace = yield* AWS.GeoPlaces.GetPlace();

// runtime
const geocoded = yield* geocode({ QueryText: "Space Needle, Seattle" });
const placeId = geocoded.ResultItems?.[0]?.PlaceId;
const place = yield* getPlace({ PlaceId: placeId! });
const label = place.Address?.Label;
```

@binding

## ReverseGeocode

Runtime binding for `geo-places:ReverseGeocode` — convert geographic
coordinates into a human-readable address or place, with optional filtering
by place type and additional features such as time zones.

geo-places is a standalone, pay-per-call Amazon Location API with no
resource to manage: the binding takes no arguments and grants the function
`geo-places:ReverseGeocode`. Requests and responses are raw distilled types
(no marshalling).

### Reverse Geocoding
Provide the `ReverseGeocodeHttp` implementation layer on the Function effect
(`.pipe(Effect.provide(AWS.GeoPlaces.ReverseGeocodeHttp))`), bind in the
init phase, then call the client at runtime.

**Example:** Reverse geocode a position
```typescript
// init
const reverseGeocode = yield* AWS.GeoPlaces.ReverseGeocode();

// runtime
const result = yield* reverseGeocode({
  QueryPosition: [-122.3381, 47.6101], // [longitude, latitude]
  MaxResults: 1,
});
const address = result.ResultItems?.[0]?.Address?.Label;
```

@binding

## SearchNearby

Runtime binding for `geo-places:SearchNearby` — find places around a
geographic position, optionally filtered by radius, bounding box,
categories, or food types.

geo-places is a standalone, pay-per-call Amazon Location API with no
resource to manage: the binding takes no arguments and grants the function
`geo-places:SearchNearby`. Requests and responses are raw distilled types
(no marshalling).

### Searching Nearby Places
Provide the `SearchNearbyHttp` implementation layer on the Function effect
(`.pipe(Effect.provide(AWS.GeoPlaces.SearchNearbyHttp))`), bind in the
init phase, then call the client at runtime.

**Example:** Find places around a position
```typescript
// init
const searchNearby = yield* AWS.GeoPlaces.SearchNearby();

// runtime
const result = yield* searchNearby({
  QueryPosition: [-122.3493, 47.6205], // [lng, lat]
  QueryRadius: 1000,
  MaxResults: 5,
});
const titles = result.ResultItems?.map((item) => item.Title);
```

@binding

## SearchText

Runtime binding for `geo-places:SearchText` — free-form place search that
returns ranked results (POIs, addresses, streets) for a text query.

geo-places is a standalone, pay-per-call Amazon Location API with no
resource to manage: the binding takes no arguments and grants the function
`geo-places:SearchText`. Requests and responses are raw distilled types (no
marshalling).

### Searching Places
Provide the `SearchTextHttp` implementation layer on the Function effect
(`.pipe(Effect.provide(AWS.GeoPlaces.SearchTextHttp))`), bind in the init
phase, then call the client at runtime.

**Example:** Search for a place by text
```typescript
// init
const searchText = yield* AWS.GeoPlaces.SearchText();

// runtime
const result = yield* searchText({
  QueryText: "Space Needle, Seattle",
  MaxResults: 5,
});
const first = result.ResultItems?.[0];
```

@binding

## Suggest

Runtime binding for `geo-places:Suggest` — suggest places and query
refinements for a free-form (possibly misspelled or partial) query,
ranked by relevance. Unlike Autocomplete, Suggest returns place
suggestions (with `PlaceId`s) and query suggestions, tuned for
point-of-interest discovery.

geo-places is a standalone, pay-per-call Amazon Location API with no
resource to manage: the binding takes no arguments and grants the function
`geo-places:Suggest`. Requests and responses are raw distilled types (no
marshalling).

### Suggesting Places
Provide the `SuggestHttp` implementation layer on the Function effect
(`.pipe(Effect.provide(AWS.GeoPlaces.SuggestHttp))`), bind in the init
phase, then call the client at runtime.

**Example:** Suggest places for a free-form query
```typescript
// init
const suggest = yield* AWS.GeoPlaces.Suggest();

// runtime
const result = yield* suggest({
  QueryText: "coffee",
  BiasPosition: [-122.3493, 47.6205], // [lng, lat]
  MaxResults: 5,
});
const first = result.ResultItems?.[0]?.Title;
```

@binding
