import {
  makeAttachmentMethods,
  readRpcMetadata,
  writeRpcMetadata,
} from "@/Workers/WebSocketAttachment.ts";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const storage = (initial: unknown = null) =>
  Effect.sync(() => {
    let value = initial;
    const native = {
      read: () => value,
      write: (next: unknown) => {
        value = next;
      },
    };
    return { native, socket: makeAttachmentMethods(native) };
  });

it.effect("shares codec transforms and unchecked attachment values", () =>
  Effect.gen(function* () {
    const { socket, native } = yield* storage();
    const Session = Schema.Struct({
      count: Schema.NumberFromString,
      joined: Schema.DateFromString,
    });
    const joined = yield* Effect.sync(
      () => new Date("2026-01-02T03:04:05.000Z"),
    );
    yield* socket.setAttachment(Session, { count: 42, joined });
    expect(native.read()).toEqual({
      count: "42",
      joined: joined.toISOString(),
    });
    const decoded = yield* socket.getAttachment(Session);
    expect(decoded.count).toBe(42);
    expect(decoded.joined).toBeInstanceOf(Date);
    yield* Effect.sync(() => socket.serializeAttachment("17"));
    expect(yield* socket.getAttachment(Schema.NumberFromString)).toBe(17);
  }),
);

it.effect(
  "preserves reserved RPC metadata across validated and unchecked replacement",
  () =>
    Effect.gen(function* () {
      const metadata = {
        version: 1,
        clientId: 7,
        pending: true,
        serialization: "application/json",
      };
      const { socket, native } = yield* storage(
        writeRpcMetadata("old", metadata),
      );
      expect(socket.deserializeAttachment()).toBe("old");
      yield* socket.setAttachment(Schema.NumberFromString, 42);
      expect(readRpcMetadata(native.read())).toEqual(metadata);
      expect(socket.deserializeAttachment()).toBe("42");
      yield* Effect.sync(() =>
        socket.serializeAttachment({
          __alchemyRpcWebSocket: "application-data",
        }),
      );
      expect(readRpcMetadata(native.read())).toEqual(metadata);
      expect(socket.deserializeAttachment()).toEqual({
        __alchemyRpcWebSocket: "application-data",
      });
    }),
);

it.effect(
  "reads the legacy RPC envelope and keeps application fields when metadata changes",
  () =>
    Effect.gen(function* () {
      const { socket, native } = yield* storage({
        __alchemyRpcWebSocket: { pending: false },
        count: "9",
      });
      expect(
        yield* socket.getAttachment(
          Schema.Struct({ count: Schema.NumberFromString }),
        ),
      ).toEqual({ count: 9 });
      yield* Effect.sync(() =>
        native.write(writeRpcMetadata(native.read(), { pending: true })),
      );
      expect(socket.deserializeAttachment()).toEqual({ count: "9" });
    }),
);

it.effect(
  "distinguishes missing, encode, decode, read, and write failures",
  () =>
    Effect.gen(function* () {
      const { socket, native } = yield* storage();
      const missing = yield* socket
        .getAttachment(Schema.Unknown)
        .pipe(Effect.result);
      expect(Result.isFailure(missing) && missing.failure.reason).toBe(
        "missing",
      );
      yield* socket.setAttachment(Schema.NumberFromString, 7);
      const encode = yield* socket
        .setAttachment(
          Schema.NumberFromString.check(Schema.isGreaterThan(0)),
          -1,
        )
        .pipe(Effect.result);
      expect(Result.isFailure(encode) && encode.failure.reason).toBe("encode");
      expect(native.read()).toBe("7");
      yield* Effect.sync(() => native.write({ invalid: true }));
      const decode = yield* socket
        .getAttachment(Schema.NumberFromString)
        .pipe(Effect.result);
      expect(Result.isFailure(decode) && decode.failure.reason).toBe("decode");
      const brokenRead = makeAttachmentMethods({
        read: () => {
          throw new Error("read");
        },
        write: () => {},
      });
      const read = yield* brokenRead
        .getAttachment(Schema.Unknown)
        .pipe(Effect.result);
      expect(Result.isFailure(read) && read.failure.reason).toBe("read");
      const brokenWrite = makeAttachmentMethods({
        read: () => null,
        write: () => {
          throw new Error("write");
        },
      });
      const write = yield* brokenWrite
        .setAttachment(Schema.String, "new")
        .pipe(Effect.result);
      expect(Result.isFailure(write) && write.failure.reason).toBe("write");
    }),
);
