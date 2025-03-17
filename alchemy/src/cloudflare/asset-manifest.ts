export type AssetManifest = AssetManifestEntry[];

export interface AssetManifestEntry {
  source: string;
  key: string;
  hash: string;
  cacheControl: string;
  contentType?: string;
}

export interface FileOption {
  files: string | string[];
  cacheControl: string;
  contentType?: string;
  ignore?: string[];
}
