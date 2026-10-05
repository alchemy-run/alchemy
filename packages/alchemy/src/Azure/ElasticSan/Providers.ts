import * as Layer from "effect/Layer";
import { ElasticSan, ElasticSanProvider } from "./ElasticSan.ts";
import { Snapshot, SnapshotProvider } from "./Snapshot.ts";
import { Volume, VolumeProvider } from "./Volume.ts";
import { VolumeGroup, VolumeGroupProvider } from "./VolumeGroup.ts";

export const resources = [ElasticSan, Snapshot, Volume, VolumeGroup];
export const layers = () =>
  Layer.mergeAll(
    ElasticSanProvider(),
    SnapshotProvider(),
    VolumeProvider(),
    VolumeGroupProvider(),
  );
