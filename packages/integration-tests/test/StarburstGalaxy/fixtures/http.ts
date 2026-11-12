import { expect } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";

/**
 * GET a fixture Worker's route and decode its JSON. A fresh workers.dev
 * URL answers 404 until it propagates, so 404s are retried; a route that
 * failed answers 500 with the cause, which the assertion shows.
 */
export const getJson = <A>(url: string, path: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatus(
      yield* HttpClient.HttpClient,
      (status) => status !== 404,
    );
    const res = yield* client
      .get(`${url}${path}`)
      .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
    const text = yield* res.text;
    expect({ status: res.status, body: res.status === 200 ? "" : text }).toEqual({
      status: 200,
      body: "",
    });
    return JSON.parse(text) as A;
  });
