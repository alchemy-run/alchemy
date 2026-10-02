import * as Layer from "effect/Layer";
import { Namespace, NamespaceProvider } from "./Namespace.ts";
import { Schema, SchemaProvider } from "./Schema.ts";
import { SchemaRegistry, SchemaRegistryProvider } from "./SchemaRegistry.ts";
import { SchemaVersion, SchemaVersionProvider } from "./SchemaVersion.ts";

export const resources = [Namespace, Schema, SchemaRegistry, SchemaVersion];
export const layers = () =>
  Layer.mergeAll(
    NamespaceProvider(),
    SchemaProvider(),
    SchemaRegistryProvider(),
    SchemaVersionProvider(),
  );
