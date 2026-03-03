import type * as runtime from "@cloudflare/workers-types";
import type * as Stream from "effect/Stream";

export type UploadValue =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | runtime.Blob
  | runtime.ReadableStream
  | Stream.Stream<any>;
