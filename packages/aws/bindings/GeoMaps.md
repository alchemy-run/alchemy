<!-- Docs for the generated AWS.GeoMaps bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetGlyphs

Runtime binding for `geo-maps:GetGlyphs` — fetch a glyph (font) PBF range
used to render map labels for a font stack.

geo-maps is a standalone, pay-per-call Amazon Location API with no resource
to manage: the binding takes no arguments and grants the function
`geo-maps:GetGlyphs`. Requests and responses are raw distilled types; the
glyph payload is returned as `Blob` (`Uint8Array`).

### Fetching Glyphs
Provide the `GetGlyphsHttp` implementation layer on the Function effect
(`.pipe(Effect.provide(AWS.GeoMaps.GetGlyphsHttp))`), bind in the init
phase, then call the client at runtime.

**Example:** Fetch a glyph range for a font stack
```typescript
// init
const getGlyphs = yield* AWS.GeoMaps.GetGlyphs();

// runtime — FontUnicodeRange is a 256-glyph PBF page like "0-255.pbf"
const glyphs = yield* getGlyphs({
  FontStack: "Amazon Ember Regular",
  FontUnicodeRange: "0-255.pbf",
});
const bytes = glyphs.Blob; // Uint8Array | undefined (PBF)
```

@binding

## GetSprites

Runtime binding for `geo-maps:GetSprites` — fetch a map style's sprite
sheet (PNG) or sprite index (JSON) used to render map iconography.

geo-maps is a standalone, pay-per-call Amazon Location API with no resource
to manage: the binding takes no arguments and grants the function
`geo-maps:GetSprites`. Requests and responses are raw distilled types; the
sprite payload is returned as `Blob` (`Uint8Array`).

### Fetching Sprites
Provide the `GetSpritesHttp` implementation layer on the Function effect
(`.pipe(Effect.provide(AWS.GeoMaps.GetSpritesHttp))`), bind in the init
phase, then call the client at runtime.

**Example:** Fetch the Standard style's sprite sheet
```typescript
// init
const getSprites = yield* AWS.GeoMaps.GetSprites();

// runtime — FileName follows `sprites(@2x)?.(png|json)`
const sprites = yield* getSprites({
  FileName: "sprites.png",
  Style: "Standard",
  ColorScheme: "Light",
  Variant: "Default",
});
const bytes = sprites.Blob; // Uint8Array | undefined (PNG or JSON)
```

@binding

## GetStaticMap

Runtime binding for `geo-maps:GetStaticMap` — render a static map image
with customizable size, center, zoom, and overlays.

geo-maps is a standalone, pay-per-call Amazon Location API with no resource
to manage: the binding takes no arguments and grants the function
`geo-maps:GetStaticMap`. Requests and responses are raw distilled types;
the image payload is returned as `Blob` (`Uint8Array`).

### Rendering Static Maps
Provide the `GetStaticMapHttp` implementation layer on the Function effect
(`.pipe(Effect.provide(AWS.GeoMaps.GetStaticMapHttp))`), bind in the init
phase, then call the client at runtime.

**Example:** Render a static map centered on a point
```typescript
// init
const getStaticMap = yield* AWS.GeoMaps.GetStaticMap();

// runtime — Center is "longitude,latitude"; FileName must be "map" or "map@2x"
const image = yield* getStaticMap({
  FileName: "map",
  Center: "-122.3493,47.6205",
  Zoom: 12,
  Width: 400,
  Height: 300,
});
const bytes = image.Blob; // Uint8Array | undefined (PNG)
```

@binding

## GetStyleDescriptor

Runtime binding for `geo-maps:GetStyleDescriptor` — fetch the MapLibre
style descriptor (JSON) for a map style, optionally customized with
political view, terrain, traffic, and building options.

geo-maps is a standalone, pay-per-call Amazon Location API with no resource
to manage: the binding takes no arguments and grants the function
`geo-maps:GetStyleDescriptor`. Requests and responses are raw distilled
types; the descriptor payload is returned as `Blob` (`Uint8Array` of JSON).

### Fetching Style Descriptors
Provide the `GetStyleDescriptorHttp` implementation layer on the Function
effect (`.pipe(Effect.provide(AWS.GeoMaps.GetStyleDescriptorHttp))`), bind
in the init phase, then call the client at runtime.

**Example:** Fetch the Standard style descriptor
```typescript
// init
const getStyleDescriptor = yield* AWS.GeoMaps.GetStyleDescriptor();

// runtime — Style is one of "Standard" | "Monochrome" | "Hybrid" | "Satellite"
const descriptor = yield* getStyleDescriptor({ Style: "Standard" });
const json = new TextDecoder().decode(descriptor.Blob); // MapLibre style JSON
```

@binding

## GetTile

Runtime binding for `geo-maps:GetTile` — fetch a single map tile addressed
by tileset, zoom level, and X/Y grid coordinates.

geo-maps is a standalone, pay-per-call Amazon Location API with no resource
to manage: the binding takes no arguments and grants the function
`geo-maps:GetTile`. Requests and responses are raw distilled types; the
tile payload is returned as `Blob` (`Uint8Array`).

### Fetching Map Tiles
Provide the `GetTileHttp` implementation layer on the Function effect
(`.pipe(Effect.provide(AWS.GeoMaps.GetTileHttp))`), bind in the init phase,
then call the client at runtime.

**Example:** Fetch a vector tile
```typescript
// init
const getTile = yield* AWS.GeoMaps.GetTile();

// runtime — Z/X/Y are string coordinates in the tile grid
const tile = yield* getTile({
  Tileset: "vector.basemap",
  Z: "0",
  X: "0",
  Y: "0",
});
const bytes = tile.Blob; // Uint8Array | undefined
```

@binding
