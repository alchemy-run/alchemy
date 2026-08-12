/**
 * side-band-64k multiplexing.
 *
 * When `side-band-64k` is negotiated, binary data is carried as pkt-lines
 * whose first payload byte is the band:
 *
 * - **band 1** — pack data (or the receive-pack report)
 * - **band 2** — progress messages (client prints to stderr as `remote: `)
 * - **band 3** — fatal error message; the client aborts
 *
 * Frame arithmetic: max pkt-line total 65520 = 4 length bytes + 1 band byte
 * + **65515** data bytes, so every frame carries at most 65515 payload bytes.
 * Legacy `side-band` (1000-byte packets) is never advertised.
 */
import * as Stream from "effect/Stream";
import { concatBytes, utf8Encode } from "./ObjectCodec.ts";
import { pktLine } from "./Pkt.ts";

/**
 * Maximum data bytes per side-band-64k frame (65520 − 4 length − 1 band).
 */
export const SIDEBAND_DATA_MAX = 65515;

/**
 * The three side-band channels.
 */
export type SidebandBand = 1 | 2 | 3;

/**
 * Encodes a single side-band frame. The data must be at most
 * {@link SIDEBAND_DATA_MAX} bytes — use {@link sidebandFrames} to split
 * arbitrary payloads.
 */
export const sidebandFrame = (
  band: SidebandBand,
  data: Uint8Array,
): Uint8Array => {
  const payload = new Uint8Array(1 + data.length);
  payload[0] = band;
  payload.set(data, 1);
  return pktLine(payload);
};

/**
 * Splits a payload into as many side-band frames as needed (each carrying at
 * most {@link SIDEBAND_DATA_MAX} data bytes). An empty payload produces no
 * frames.
 */
export const sidebandFrames = (
  band: SidebandBand,
  data: Uint8Array,
): Array<Uint8Array> => {
  const frames: Array<Uint8Array> = [];
  for (let pos = 0; pos < data.length; pos += SIDEBAND_DATA_MAX) {
    frames.push(
      sidebandFrame(band, data.subarray(pos, pos + SIDEBAND_DATA_MAX)),
    );
  }
  return frames;
};

/**
 * Stream transform: wraps every chunk of a byte stream into side-band frames
 * on the given band. Used to mux the pack stream (band 1) into the response
 * body; the caller appends the outer flush-pkt after the wrapped stream.
 */
export const wrapSideband =
  (band: SidebandBand) =>
  <E, R>(
    stream: Stream.Stream<Uint8Array, E, R>,
  ): Stream.Stream<Uint8Array, E, R> =>
    Stream.flatMap(stream, (chunk) =>
      chunk.length === 0
        ? Stream.empty
        : Stream.fromArray(sidebandFrames(band, chunk)),
    );

/**
 * Encodes a band-2 progress message (e.g. `Counting objects: 42, done.`).
 * A trailing newline is appended when missing so the client's stderr stays
 * line-buffered.
 */
export const progressMessage = (message: string): Uint8Array =>
  concatBytes(
    sidebandFrames(
      2,
      utf8Encode(
        message.endsWith("\n") || message.endsWith("\r")
          ? message
          : `${message}\n`,
      ),
    ),
  );

/**
 * Encodes a band-3 fatal error message. The client prints it and aborts the
 * transfer; the server should end the response after sending it.
 */
export const sidebandError = (message: string): Uint8Array =>
  concatBytes(
    sidebandFrames(
      3,
      utf8Encode(message.endsWith("\n") ? message : `${message}\n`),
    ),
  );
