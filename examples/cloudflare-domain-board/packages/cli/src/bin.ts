#!/usr/bin/env bun
import * as Domain from "@alchemy.run/domain";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Command from "effect/cli/Command";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { board } from "./board.ts";

/** The deployed board's Api, from `BOARD_URL` (the Worker's URL). */
const BoardProtocol = Layer.unwrap(
  Effect.map(Config.String("BOARD_URL"), (url) =>
    Domain.protocolHttp(`${url.replace(/\/$/, "")}/api`),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

Command.run(board, { version: "1.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(BoardProtocol, BunServices.layer)),
  // A command answers once the views have applied it, so the next call reads it.
  Effect.provideService(Domain.DefaultConsistency, "strong"),
  BunRuntime.runMain,
);
