/**
 * The HTTP front of the conformance suite: a Docker service on the control
 * plane's network that calls the Durable Objects through the gateway.
 */
import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as StreamFormat from "@alchemy.run/rivet/StreamFormat";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { conformanceFetch } from "../../Cloudflare/Workers/conformance/routes.ts";
import { BinaryLog, ChatLog } from "./chat-log.ts";
import { Cluster, FRONT_PORT, Services } from "./cluster.ts";
import Counter from "./counter.ts";
import GatedTally from "./gated-tally.ts";
import Greeter from "./greeter.ts";
import { Reentrant } from "./reentrant-declaration.ts";
import Room from "./room.ts";
import SocketRoom from "./socket-room.ts";
import Tally from "./tally.ts";

export default class Front extends Docker.Service<Front>()(
  "RivetFront",
  Effect.gen(function* () {
    const cluster = yield* Rivet.Cluster;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ external: FRONT_PORT, internal: 3000 }],
      networks: cluster.network?.kind === "docker" ? [{ name: cluster.network.name }] : [],
      // Only the nodes load RivetKit; the front reaches actors over HTTP.
      build: { input: { external: ["rivetkit", /^rivetkit\//, /^@rivetkit\//] } },
    };
  }).pipe(Effect.provide(Cluster)),
  Effect.gen(function* () {
    const counters = yield* Counter;
    const greeters = yield* Greeter;
    const parallelTallies = yield* Tally;
    const gatedTallies = yield* GatedTally;
    const reentrants = yield* Reentrant;
    const rooms = yield* Room;
    const socketRooms = yield* SocketRoom;
    const chat = yield* ChatLog;
    const binary = yield* BinaryLog;
    const conformance = conformanceFetch(counters);
    // Durable Streams: `/durable-stream/<key>/<case>`. Each returns what it saw,
    // with failures as their tags.
    const streamCase = Effect.fn(function* (name: string, which: string | undefined) {
      const say = (user: string, text: string) => ({ user, text });
      if (which === "roundtrip") {
        yield* chat.append(name, say("a", "one"));
        yield* chat.appendAll(name, [say("b", "two"), say("a", "three")]);
        const first = yield* chat.read(name);
        yield* chat.append(name, say("b", "four"));
        const second = yield* chat.read(name, { from: first.next });
        return yield* HttpServerResponse.json({ first, second });
      }
      if (which === "tail") {
        yield* chat.appendAll(name, [say("a", "1"), say("a", "2")]);
        const live = yield* chat
          .tail(name)
          .pipe(Stream.take(4), Stream.runCollect, Effect.forkChild);
        yield* Effect.sleep("1 second");
        yield* chat.appendAll(name, [say("a", "3"), say("a", "4")]);
        const messages = yield* Fiber.join(live).pipe(Effect.timeout("30 seconds"));
        return yield* HttpServerResponse.json({ messages });
      }
      if (which === "closed") {
        yield* chat.append(name, say("a", "last"));
        yield* chat.close(name);
        const after = yield* chat.append(name, say("a", "late")).pipe(
          Effect.as("appended"),
          Effect.catchTag("Rivet.DurableStreamConflict", (e) => Effect.succeed(e._tag)),
        );
        const read = yield* chat.read(name);
        const tailed = yield* chat.tail(name).pipe(Stream.runCollect, Effect.timeout("30 seconds"));
        return yield* HttpServerResponse.json({ after, read, tailed });
      }
      if (which === "binary") {
        yield* binary.appendAll(name, [say("a", "één"), say("b", "two")]);
        const read = yield* binary.read(name);
        yield* binary.append(name, say("a", "three"));
        const live = yield* binary
          .tail(name)
          .pipe(Stream.take(3), Stream.runCollect, Effect.timeout("30 seconds"));
        return yield* HttpServerResponse.json({ read, live });
      }
      if (which === "producer") {
        const producer = { id: "writer", epoch: 1, seq: 0 };
        yield* chat.append(name, say("a", "once"), { producer });
        yield* chat.append(name, say("a", "once"), { producer });
        const stale = yield* chat
          .append(name, say("a", "stale"), { producer: { ...producer, epoch: 0, seq: 1 } })
          .pipe(
            Effect.as("appended"),
            Effect.catchTags({
              "Rivet.DurableStreamStaleProducer": (e) => Effect.succeed(e._tag),
              "Rivet.DurableStreamRequestError": (e) => Effect.succeed(`${e._tag} ${e.status}`),
            }),
          );
        return yield* HttpServerResponse.json({ read: yield* chat.read(name), stale });
      }
      if (which === "missing") {
        const read = yield* chat.read(name).pipe(
          Effect.as("found"),
          Effect.catchTag("Rivet.DurableStreamNotFound", (e) => Effect.succeed(e._tag)),
        );
        yield* chat.delete(name);
        return yield* HttpServerResponse.json({ read });
      }
      if (which === "deleted") {
        yield* chat.append(name, say("a", "gone"));
        yield* chat.delete(name);
        const read = yield* chat.read(name).pipe(
          Effect.as("found"),
          Effect.catchTag("Rivet.DurableStreamNotFound", (e) => Effect.succeed(e._tag)),
        );
        return yield* HttpServerResponse.json({ read });
      }
      if (which === "room") {
        const room = rooms.getByName(name);
        yield* room.say(name, "a", "from a room");
        yield* room.say(name, "b", "and again");
        return yield* HttpServerResponse.json(yield* chat.read(name));
      }

      return HttpServerResponse.text("unknown case", { status: 404 });
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://front");
        const [group, name] = url.pathname.split("/").filter((segment) => segment.length > 0);
        // `?gated=1` sends a tally route to the class given `Workers.InputGate`.
        const tallies = url.searchParams.get("gated") === "1" ? gatedTallies : parallelTallies;
        if (group === "durable-stream" && name !== undefined) {
          return yield* streamCase(
            name,
            url.pathname.split("/").filter((segment) => segment.length > 0)[2],
          ).pipe(Effect.orDie);
        }
        // `/socket/<room>?user=<u>`: a WebSocket to the room's instance,
        // with a header the front adds.
        if (group === "socket" && name !== undefined) {
          return yield* socketRooms
            .getByName(name)
            .fetch(request.modify({ headers: Headers.set(request.headers, "x-room", name) }))
            .pipe(Effect.orDie);
        }
        if (group === "socket-count" && name !== undefined) {
          return yield* HttpServerResponse.json({
            sockets: yield* socketRooms.getByName(name).sockets().pipe(Effect.orDie),
          });
        }
        if (group === "greet" && name !== undefined) {
          const greeting = yield* greeters.getByName("front").greet(name);
          return yield* HttpServerResponse.json({ greeting });
        }
        // `n` concurrent increments on one instance; returns its final count.
        // `?tx=1` makes each one a transaction.
        if (group === "race" && name !== undefined) {
          const n = Number(url.searchParams.get("n") ?? "50");
          const tally = tallies.getByName(name);
          const tx = url.searchParams.get("tx") === "1";
          yield* Effect.forEach(
            Array.from({ length: n }, () =>
              tx ? tally.incrementInTransaction("count") : tally.increment("count"),
            ),
            (call) => call,
            { concurrency: "unbounded", discard: true },
          );
          return yield* HttpServerResponse.json({ count: yield* tally.read("count") });
        }
        // `n` increments spread over the background loop's run; returns the
        // final count once the loop is done.
        if (group === "background" && name !== undefined) {
          const n = Number(url.searchParams.get("n") ?? "50");
          const tally = tallies.getByName(name);
          yield* Effect.forEach(
            Array.from({ length: n }, (_, i) => i),
            (i) => Effect.andThen(Effect.sleep(`${i * 5} millis`), tally.increment("background")),
            { concurrency: "unbounded", discard: true },
          );
          yield* tally.backgroundDone().pipe(
            Effect.repeat({
              schedule: Schedule.spaced("200 millis"),
              until: (done) => done,
              times: 50,
            }),
          );
          return yield* HttpServerResponse.json({ count: yield* tally.read("background") });
        }
        // A burst of `n` writes and, once it has started, one read from
        // another call: returns how many writes had finished when the read
        // did.
        if (group === "overlap" && name !== undefined) {
          const n = Number(url.searchParams.get("n") ?? "500");
          const tally = tallies.getByName(name);
          const [, seen] = yield* Effect.all([tally.burst(n), tally.probe()], {
            concurrency: "unbounded",
          });
          return yield* HttpServerResponse.json({ seen, n });
        }
        // An alarm replaced while it fires; returns what's left afterwards.
        if (group === "alarm-replaced" && name !== undefined) {
          const tally = tallies.getByName(name);
          yield* tally.replaceFiringAlarm();
          // Give the fired alarm's call time to run once the transaction ends.
          yield* Effect.sleep("3 seconds");
          return yield* HttpServerResponse.json(yield* tally.alarmState());
        }
        // Calls that could deadlock on a transaction (see reentrant.ts).
        // Each returns how the instance saw it end, then what it holds.
        if (group === "reentrant" && name !== undefined) {
          const which = url.pathname.split("/").filter((segment) => segment.length > 0)[2];
          const instance = reentrants.getByName(name);
          // An instance a deadlock wedged hangs every later call too.
          const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.timeoutOrElse(effect, {
              duration: "60 seconds",
              orElse: () => Effect.die(new Error("hung")),
            });
          const after = Effect.gen(function* () {
            return {
              touched: yield* bounded(instance.touch()),
              tx: yield* bounded(instance.read("tx")),
            };
          });
          if (which === "constructor") {
            return yield* HttpServerResponse.json({
              constructed: yield* bounded(instance.constructed()),
              ...(yield* after),
            });
          }
          if (which === "self") {
            const result = yield* bounded(instance.selfCallInTransaction());
            return yield* HttpServerResponse.json({ result, ...(yield* after) });
          }
          if (which === "peer") {
            const result = yield* bounded(instance.peerCallInTransaction(`${name}-peer`));
            return yield* HttpServerResponse.json({ result, ...(yield* after) });
          }
          if (which === "ping") {
            const result = yield* bounded(instance.selfPingInTransaction());
            return yield* HttpServerResponse.json({ result, ...(yield* after) });
          }
          if (which === "outside") {
            const result = yield* bounded(instance.selfCallOutsideTransaction());
            return yield* HttpServerResponse.json({ result, ...(yield* after) });
          }
          if (which === "await") {
            const [result, release] = yield* Effect.all(
              [
                bounded(instance.awaitReleaseInTransaction()),
                Effect.andThen(Effect.sleep("300 millis"), bounded(instance.release())),
              ],
              { concurrency: "unbounded" },
            );
            return yield* HttpServerResponse.json({
              result,
              release,
              released: yield* bounded(instance.read("released")),
              ...(yield* after),
            });
          }
          if (which === "late") {
            const result = yield* bounded(instance.writeAfterTimeout());
            // Past when the transaction's code would have written.
            yield* Effect.sleep("4 seconds");
            return yield* HttpServerResponse.json({
              result,
              late: yield* bounded(instance.read("late")),
              ...(yield* after),
            });
          }
          if (which === "outlive") {
            const result = yield* bounded(instance.outliveTransaction());
            yield* Effect.sleep("1500 millis");
            return yield* HttpServerResponse.json({
              result,
              waited: yield* bounded(instance.read("waited")),
              forked: yield* bounded(instance.read("forked")),
              ...(yield* after),
            });
          }
          if (which === "flaky-alarm" || which === "slow-alarm") {
            yield* bounded(
              which === "flaky-alarm" ? instance.armFlakyAlarm(2) : instance.armSlowAlarm(),
            );
            const final = yield* bounded(instance.alarmState()).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (alarm) => alarm.done > 0,
                times: 110,
              }),
            );
            // Long enough for a duplicate run to show.
            yield* Effect.sleep("5 seconds");
            return yield* HttpServerResponse.json({
              before: final,
              alarm: yield* bounded(instance.alarmState()),
            });
          }
        }
        // A slow transaction racing `n` increments, then a rolled-back one.
        // `?tx=1` makes each increment a transaction.
        if (group === "transaction" && name !== undefined) {
          const n = Number(url.searchParams.get("n") ?? "10");
          const tally = tallies.getByName(name);
          const tx = url.searchParams.get("tx") === "1";
          yield* Effect.all(
            [
              tally.addSlowly("count", 100, 300),
              Effect.forEach(
                Array.from({ length: n }, () =>
                  tx ? tally.incrementInTransaction("count") : tally.increment("count"),
                ),
                (call) => Effect.andThen(Effect.sleep("20 millis"), call),
                { concurrency: "unbounded", discard: true },
              ),
            ],
            { concurrency: "unbounded" },
          );
          const aborted = yield* tally.addThenAbort("count", 1000).pipe(
            Effect.as(false),
            Effect.catchTag("TallyAborted", () => Effect.succeed(true)),
          );
          return yield* HttpServerResponse.json({
            count: yield* tally.read("count"),
            aborted,
          });
        }
        return yield* conformance;
      }),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Services, StreamFormat.Json))),
) {}
