import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const encodeJsonLines = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(
    Stream.map((value) => `${JSON.stringify(value)}\n`),
    Stream.encodeText,
  );

const decodeJsonLines = <A>(readable: ReadableStream<Uint8Array>) =>
  Stream.fromReadableStream({
    evaluate: () => readable,
    onError: (error) => error,
  }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.map((line) => JSON.parse(line) as A),
  );

const currentLineDecoder = (readable: ReadableStream<Uint8Array>) =>
  Stream.fromReadableStream({
    evaluate: () => readable,
    onError: (error) => error,
  }).pipe(
    Stream.mapAccum(
      () => [new TextDecoder(), ""] as [TextDecoder, string],
      (
        [decoder, buffer],
        chunk,
      ): [[TextDecoder, string], ReadonlyArray<string>] => {
        const combined = buffer + decoder.decode(chunk, { stream: true });
        const lines = combined.split("\n");
        const remainder = lines.pop() ?? "";
        return [[decoder, remainder], lines];
      },
    ),
    Stream.flatMap((line: string) => Stream.fromIterable(line)),
  );

const rechunk = (readable: ReadableStream<Uint8Array>, size: number) =>
  new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = readable.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          for (let i = 0; i < value.length; i += size) {
            controller.enqueue(value.slice(i, i + size));
          }
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });

const collect = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const values: Array<A> = [];
    yield* Stream.runForEach(stream, (value) =>
      Effect.sync(() => {
        values.push(value);
      }),
    );
    return values;
  });

const values = Stream.make(
  "sam",
  { hello: "world" },
  { nested: ["a", "b", "c"] },
  "multi-byte: 😀",
);

const broken = values.pipe(
  Stream.map((value) => `${JSON.stringify(value)}\\n`),
  Stream.encodeText,
);

const fixed = encodeJsonLines(values);
const fixedSingle = encodeJsonLines(Stream.make("sam"));

const program = Effect.gen(function* () {
  const brokenResult = yield* collect(
    decodeJsonLines(rechunk(Stream.toReadableStream(broken), 1)),
  ).pipe(
    Effect.match({
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  );
  const fixedResult = yield* collect(
    decodeJsonLines(rechunk(Stream.toReadableStream(fixed), 1)),
  );
  const currentLineResult = yield* collect(
    currentLineDecoder(rechunk(Stream.toReadableStream(fixedSingle), 1)),
  );

  console.log("broken", brokenResult);
  console.log("fixed", fixedResult);
  console.log("currentLineResult", currentLineResult);
});

Effect.runPromise(program);
