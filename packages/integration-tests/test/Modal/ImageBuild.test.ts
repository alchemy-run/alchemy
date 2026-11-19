import * as BuildPlan from "@alchemy.run/docker/BuildPlan";
import { decodeCbor, encodeCbor } from "@alchemy.run/modal/Cbor";
import { checkCommands, MODAL_CAPABILITIES } from "@alchemy.run/modal/ImagePlan";
import { planRuntimeImage } from "@alchemy.run/modal/internal/Deploy";
import { describe, expect, it, layer } from "@alchemy.run/test";
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const tags = ["unit", "provider:modal", "local"];

const plan = (content: string) =>
  BuildPlan.plan({ dockerfile: { content } }, { capabilities: MODAL_CAPABILITIES });

layer(BunServices.layer)("Modal build capabilities", (it) => {
  it.effect(
    "plans a Dockerfile Modal's builder runs",
    () =>
      Effect.gen(function* () {
        const result = yield* plan(
          "FROM python:3.12\nENV A=1\nWORKDIR /app\nRUN pip install pandas\n",
        );
        expect(BuildPlan.renderLines(result)[0]).toBe("FROM python:3.12");
        expect(result.warnings).toEqual([]);
      }),
    { tags },
  );

  it.effect(
    "warns that USER is ignored",
    () =>
      Effect.gen(function* () {
        const result = yield* plan("FROM debian\nUSER nobody\n");
        expect(result.warnings.length).toBe(1);
        expect(result.warnings[0]).toContain("USER");
      }),
    { tags },
  );

  it.effect(
    "rejects an instruction Modal can't run, naming the line",
    () =>
      Effect.gen(function* () {
        const result = yield* plan("FROM debian\nRUN true\nHEALTHCHECK CMD true\n").pipe(
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result) && result.failure._tag === "UnsupportedDockerfile") {
          expect(result.failure.violations.map((v) => v.line)).toEqual([3]);
        }
      }),
    { tags },
  );

  it.effect(
    "rejects multi-stage builds",
    () =>
      Effect.gen(function* () {
        const result = yield* plan(
          "FROM node AS build\nRUN true\nFROM node\nCOPY --from=build /a /a\n",
        ).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
      }),
    { tags },
  );

  it.effect(
    "plans a Function image without the image's start command",
    () =>
      Effect.gen(function* () {
        const main = new URL("./fixtures/lifecycle-program.ts", import.meta.url).pathname;
        const planned = yield* planRuntimeImage(
          "Modal.Function",
          { main, commands: ["RUN echo extra"] },
          8000,
          undefined,
        );
        expect(planned.plan.base).toBe("oven/bun:1");
        expect(planned.command[0]).toBe("bun");
        expect(planned.python).toBe("3.12");
        const starts = planned.spec.commands.filter((line) => /^(ENTRYPOINT|CMD)\b/.test(line));
        expect(starts).toEqual(["ENTRYPOINT []"]);
        expect(planned.spec.commands).toContain("RUN echo extra");
        expect(planned.spec.commands.some((line) => line.startsWith("FROM"))).toBe(false);
      }),
    { tags },
  );

  it.effect(
    "checks appended commands the same way",
    () =>
      Effect.gen(function* () {
        expect(yield* checkCommands(["RUN apt-get update"])).toEqual(["RUN apt-get update"]);
        const bad = yield* checkCommands(["VOLUME /data"]).pipe(Effect.result);
        expect(Result.isFailure(bad)).toBe(true);
      }),
    { tags },
  );
});

describe("Modal CBOR codec", () => {
  it.effect(
    "round-trips the values Modal functions exchange",
    () =>
      Effect.sync(() => {
        const value = [
          ["hello", 42, -7, 1.5, true, false, null, new Uint8Array([1, 2, 3])],
          { nested: { list: [1, 2], n: 4294967296 } },
        ];
        expect(decodeCbor(encodeCbor(value))).toEqual(value);
      }),
    { tags },
  );

  it.effect(
    "encodes the RFC 8949 vectors",
    () =>
      Effect.sync(() => {
        const hex = (v: unknown) => Buffer.from(encodeCbor(v)).toString("hex");
        expect(hex(0)).toBe("00");
        expect(hex(100)).toBe("1864");
        expect(hex(-1)).toBe("20");
        expect(hex("a")).toBe("6161");
        expect(hex([1, [2, 3]])).toBe("8201820203");
        expect(hex({ a: 1 })).toBe("a1616101");
      }),
    { tags },
  );
});
