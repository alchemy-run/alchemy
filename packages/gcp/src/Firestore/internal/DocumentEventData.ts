/**
 * Decoder for `google.events.cloud.firestore.v1.DocumentEventData`, the
 * protobuf payload of Eventarc's Firestore events (they offer no JSON
 * encoding). Only the wire format is needed, so this reads it directly
 * instead of pulling in a protobuf runtime.
 */

/** A decoded Firestore document: field values as plain JS values. */
export interface DecodedDocument {
  name: string;
  fields: Record<string, unknown>;
}

export interface DecodedDocumentEventData {
  value: DecodedDocument | undefined;
  oldValue: DecodedDocument | undefined;
  updatedFields: string[];
}

/** One protobuf field: its number, wire type, and raw value. */
type Field =
  | { number: number; wire: 0; value: bigint }
  | { number: number; wire: 1; value: Uint8Array }
  | { number: number; wire: 2; value: Uint8Array }
  | { number: number; wire: 5; value: Uint8Array };

const readFields = (bytes: Uint8Array): Field[] => {
  const fields: Field[] = [];
  let offset = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    while (offset < bytes.length) {
      const byte = bytes[offset++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  };
  while (offset < bytes.length) {
    const key = Number(varint());
    const number = key >>> 3;
    const wire = key & 7;
    if (wire === 0) fields.push({ number, wire, value: varint() });
    else if (wire === 1) {
      fields.push({ number, wire, value: bytes.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wire === 2) {
      const length = Number(varint());
      fields.push({ number, wire, value: bytes.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 5) {
      fields.push({ number, wire, value: bytes.subarray(offset, offset + 4) });
      offset += 4;
    } else break; // groups (3/4) are not used by these messages
  }
  return fields;
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const double = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
/** int64 varints carry negatives as 64-bit two's complement. */
const int64 = (value: bigint) => BigInt.asIntN(64, value);

const timestamp = (bytes: Uint8Array) => {
  let seconds = 0n;
  let nanos = 0;
  for (const field of readFields(bytes)) {
    if (field.number === 1 && field.wire === 0) seconds = int64(field.value);
    if (field.number === 2 && field.wire === 0) nanos = Number(field.value);
  }
  return new Date(Number(seconds) * 1000 + Math.floor(nanos / 1e6)).toISOString();
};

/** `google.events.cloud.firestore.v1.Value` → a plain value, like `decodeValue`. */
const value = (bytes: Uint8Array): unknown => {
  for (const field of readFields(bytes)) {
    switch (field.number) {
      case 11:
        return null;
      case 1:
        return field.wire === 0 && field.value !== 0n;
      case 2:
        if (field.wire === 0) {
          const n = int64(field.value);
          return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(n)
            : n.toString();
        }
        break;
      case 3:
        if (field.wire === 1) return double(field.value);
        break;
      case 10:
        if (field.wire === 2) return timestamp(field.value);
        break;
      case 17:
      case 5:
        if (field.wire === 2) return text(field.value);
        break;
      case 18:
        if (field.wire === 2) return field.value.slice();
        break;
      case 8:
        if (field.wire === 2) {
          const point = { latitude: 0, longitude: 0 };
          for (const part of readFields(field.value)) {
            if (part.wire !== 1) continue;
            if (part.number === 1) point.latitude = double(part.value);
            if (part.number === 2) point.longitude = double(part.value);
          }
          return point;
        }
        break;
      case 9:
        if (field.wire === 2) {
          return readFields(field.value)
            .filter((item) => item.number === 1 && item.wire === 2)
            .map((item) => value(item.value as Uint8Array));
        }
        break;
      case 6:
        if (field.wire === 2) return fieldsOf(readFields(field.value));
        break;
    }
  }
  return null;
};

/** `map<string, Value> fields = N` entries → a record. */
const fieldsOf = (entries: Field[], number = 1) => {
  const record: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.number !== number || entry.wire !== 2) continue;
    let key = "";
    let item: unknown = null;
    for (const part of readFields(entry.value)) {
      if (part.number === 1 && part.wire === 2) key = text(part.value);
      if (part.number === 2 && part.wire === 2) item = value(part.value);
    }
    record[key] = item;
  }
  return record;
};

const document = (bytes: Uint8Array): DecodedDocument => {
  const fields = readFields(bytes);
  const name = fields.find((field) => field.number === 1 && field.wire === 2);
  return {
    name: name ? text(name.value as Uint8Array) : "",
    fields: fieldsOf(fields, 2),
  };
};

/** Decode an Eventarc Firestore event payload. */
export const decodeDocumentEventData = (bytes: Uint8Array): DecodedDocumentEventData => {
  const data: DecodedDocumentEventData = {
    value: undefined,
    oldValue: undefined,
    updatedFields: [],
  };
  for (const field of readFields(bytes)) {
    if (field.wire !== 2) continue;
    if (field.number === 1) data.value = document(field.value);
    if (field.number === 2) data.oldValue = document(field.value);
    if (field.number === 3) {
      data.updatedFields = readFields(field.value)
        .filter((path) => path.number === 1 && path.wire === 2)
        .map((path) => text(path.value as Uint8Array));
    }
  }
  return data;
};
