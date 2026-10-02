import * as Layer from "effect/Layer";
import {
  ConfigurationStore,
  ConfigurationStoreProvider,
} from "./ConfigurationStore.ts";
import { KeyValue, KeyValueProvider } from "./KeyValue.ts";
import { Replica, ReplicaProvider } from "./Replica.ts";
import { Snapshot, SnapshotProvider } from "./Snapshot.ts";

export const resources = [ConfigurationStore, KeyValue, Replica, Snapshot];
export const layers = () =>
  Layer.mergeAll(
    ConfigurationStoreProvider(),
    KeyValueProvider(),
    ReplicaProvider(),
    SnapshotProvider(),
  );
