/**
 * The routes of the contract model, under `/contract`. Every route is a GET
 * that answers JSON.
 *
 * - `/contract/job/:id` starts a job; its saga sends `Note` to the mark `:id` in each step
 * - `/contract/mark/:id` reads the mark
 * - `/contract/add/:id?by=n` adds to the tally `:id`
 */
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Add, Job, Mark, StartJob, Tally } from "./contract-model.ts";

export const contractApp = Effect.gen(function* () {
  const jobs = yield* Job;
  const marks = yield* Mark;
  const tallies = yield* Tally;
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const url = new URL(request.url, "http://front");
    const [, , action, raw] = url.pathname.split("/");
    const id = decodeURIComponent(raw ?? "");
    switch (action) {
      case "job":
        yield* jobs.send(id, new StartJob());
        return yield* HttpServerResponse.json(yield* jobs.get(id));
      case "mark":
        return yield* HttpServerResponse.json(yield* marks.get(id));
      case "add": {
        const by = Number(url.searchParams.get("by") ?? "1");
        const receipt = yield* tallies.send(id, new Add({ by }));
        return yield* HttpServerResponse.json({ stream: receipt.stream, version: receipt.version });
      }
      default:
        return HttpServerResponse.text("Not Found", { status: 404 });
    }
  });
});
