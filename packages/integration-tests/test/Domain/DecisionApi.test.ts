import * as Domain from "@alchemy.run/domain";
import * as DomainAi from "@alchemy.run/domain/Ai";
import { toCli } from "@alchemy.run/domain/Cli";
import * as DomainHttp from "@alchemy.run/domain/Http";
import { InMemory } from "@alchemy.run/domain/InMemory";
import * as InMemoryPlatform from "@alchemy.run/domain/InMemory";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Terminal from "effect/Terminal";
import {
  Account,
  AccountId,
  Bank,
  CurrentActor,
  Customer,
  CustomerId,
  CustomerRegistered,
  Deposited,
  InsufficientFunds,
  NotOwner,
  Refund,
  RefundMoney,
  RegisterCustomer,
  Registration,
  Transfer,
  TransferMoney,
  TransferReceived,
  TransferSent,
  Username,
  UsernameClaim,
  UsernameClaimed,
  UsernameTaken,
} from "./decision-model.ts";

const a = AccountId.make("a");
const b = AccountId.make("b");

/** Commands an aggregate implements, next to ones a decision implements. */
class BankApi extends Domain.Api("DecisionBankApi", {
  model: Bank,
  commands: ["Deposit", "TransferMoney", "RegisterCustomer"],
  views: ["Balance"],
}) {}

const BankLive = Bank.layer(Layer.empty).pipe(Layer.provide(InMemory));

describe("Domain decision in a story", { tags: ["unit", "local"] }, () => {
  const story = Story.make(Bank);
  const sam = Username.make("sam");
  const c1 = CustomerId.make("c-1");
  const c2 = CustomerId.make("c-2");

  it.effect("a decision's command records on each instance, replies and rejects", () =>
    story(
      Story.given(Account.ref("a"), new Deposited({ amount: 100 })),
      Story.when(new TransferMoney({ from: a, to: b, amount: 30 })),
      Story.replied({ balance: 70 }),
      Story.then(Account.ref("a"), new TransferSent({ to: b, amount: 30 })),
      Story.then(Account.ref("b"), new TransferReceived({ from: a, amount: 30 })),
      Story.state(Account.ref("b"), { balance: 30 }),
      Story.when(new TransferMoney({ from: a, to: b, amount: 500 })),
      Story.rejected(new InsufficientFunds({ balance: 70 })),
      Story.then(Account.ref("a")),
      Story.then(Account.ref("b")),
    ),
  );

  it.effect("history on one instance decides a command about another", () =>
    story(
      Story.given(UsernameClaim.ref("sam"), new UsernameClaimed({ customerId: c1 })),
      Story.when(new RegisterCustomer({ customerId: c2, name: "Alex", username: sam })),
      Story.rejected(new UsernameTaken()),
      Story.then(Customer.ref("c-2")),
      Story.when(
        new RegisterCustomer({ customerId: c2, name: "Alex", username: Username.make("alex") }),
      ),
      Story.then(
        Customer.ref("c-2"),
        new CustomerRegistered({ name: "Alex", username: Username.make("alex") }),
      ),
      Story.then(UsernameClaim.ref("alex"), new UsernameClaimed({ customerId: c2 })),
    ),
  );

  it.effect("a decision's effectful decide reads what the story provides", () =>
    story(
      Story.given(Account.ref("a"), new Deposited({ amount: 100 })),
      Story.when(new RefundMoney({ from: a, to: b, amount: 10 })),
      Story.rejected(new NotOwner()),
      Story.provide(CurrentActor, { accountId: "a" }),
      Story.when(new RefundMoney({ from: a, to: b, amount: 10 })),
      Story.then(Account.ref("a"), new TransferSent({ to: b, amount: 10 })),
      Story.then(Account.ref("b"), new TransferReceived({ from: a, amount: 10 })),
    ),
  );
});

describe("Domain decision through an Api", { tags: ["unit", "local"] }, () => {
  it.effect("the typed client sends it like any command", () =>
    Effect.gen(function* () {
      const bank = yield* BankApi.clientInProcess;
      yield* bank.Deposit({ accountId: a, amount: 100 });
      const receipt = yield* bank.TransferMoney({ from: a, to: b, amount: 30 });
      expect(receipt).toEqual({
        reply: { balance: 70 },
        stream: "Account/a",
        version: 2,
        commits: [
          { stream: "Account/a", version: 2 },
          { stream: "Account/b", version: 1 },
        ],
      });
      // Sent again under one id, it answers the same and commits nothing new.
      const once = { commandId: "t-1" };
      const first = yield* bank.TransferMoney({ from: a, to: b, amount: 10 }, once);
      expect(yield* bank.TransferMoney({ from: a, to: b, amount: 10 }, once)).toEqual(first);
      const rejection = yield* Effect.flip(bank.TransferMoney({ from: a, to: b, amount: 500 }));
      expect(rejection).toEqual(new InsufficientFunds({ balance: 60 }));
    }).pipe(Effect.scoped, Effect.provide(BankLive)),
  );

  it.live("the client's reads wait for every instance a decision committed to", () => {
    // Nothing reaches the view until the platform drains.
    const hosted = InMemoryPlatform.make({ manual: true });
    const settle: Effect.Effect<void> = Effect.gen(function* () {
      while (true) {
        yield* hosted.control.drain;
        if (yield* hosted.control.idle) return;
        yield* Effect.sleep("1 millis");
      }
    });
    return Effect.gen(function* () {
      const bank = yield* BankApi.clientInProcess;
      yield* settle;
      yield* bank.Deposit({ accountId: a, amount: 100 });
      yield* settle;
      yield* bank.TransferMoney({ from: a, to: b, amount: 30 });
      // `b` is the second of the receipt's `commits`, not its `stream`.
      const read = yield* bank.Balance.get(b).pipe(Effect.forkChild);
      yield* Effect.sleep("100 millis");
      expect(read.pollUnsafe()).toBeUndefined();
      while (read.pollUnsafe() === undefined) {
        yield* settle;
        yield* Effect.sleep("5 millis");
      }
      expect(yield* Fiber.join(read)).toEqual({ balance: 30, transfers: 1 });
    }).pipe(
      Effect.scoped,
      Effect.provide(Bank.layer(Layer.empty).pipe(Layer.provide(hosted.layer))),
    );
  });

  it.live("plain HTTP takes its input as the body", () => {
    const http = DomainHttp.toHttpApi(BankApi, { expose: ["Deposit", "TransferMoney"] });
    const post = (path: string, body: unknown) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(
          HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
        );
        return { status: response.status, body: yield* response.json };
      });
    return Effect.gen(function* () {
      yield* post("/Deposit", { input: { accountId: "a", amount: 100 } });
      const sent = yield* post("/TransferMoney", { input: { from: "a", to: "b", amount: 30 } });
      expect(sent).toEqual({
        status: 200,
        body: {
          reply: { balance: 70 },
          stream: "Account/a",
          version: 2,
          commits: [
            { stream: "Account/a", version: 2 },
            { stream: "Account/b", version: 1 },
          ],
        },
      });
      const short = yield* post("/TransferMoney", { input: { from: "a", to: "b", amount: 500 } });
      expect(short.status).toBeGreaterThanOrEqual(400);
      expect(short.body).toMatchObject({ _tag: "InsufficientFunds", balance: 70 });
    }).pipe(
      Effect.provide(
        HttpRouter.serve(HttpApiBuilder.layer(http.api), {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(
          Layer.provide(http.layer),
          Layer.provideMerge(BankLive),
          Layer.provideMerge(BunHttpServer.layerTest),
        ),
      ),
    );
  });

  it.live("the CLI takes its input as flags", () => {
    const cli = toCli(BankApi, { name: "bank", expose: ["Deposit", "TransferMoney"] });
    const CliEnvironment = Layer.mergeAll(
      FileSystem.layerNoop({}),
      Path.layer,
      Stdio.layerTest({}),
      Layer.succeed(
        Terminal.Terminal,
        Terminal.make({
          columns: Effect.succeed(120),
          rows: Effect.succeed(24),
          size: Effect.die("unused"),
          readInput: Effect.die("unused"),
          readLine: Effect.die("unused"),
          display: () => Effect.void,
        }),
      ),
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("unused")),
      ),
    );
    return Effect.gen(function* () {
      const server = yield* BankApi;
      const handler = HttpEffect.toWebHandler(server.fetch as never);
      const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
        handler(new Request(input, init))) as typeof globalThis.fetch;
      const run = (args: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const stdout: Array<string> = [];
          const console: Console.Console = {
            ...globalThis.console,
            log: (...line: ReadonlyArray<unknown>) => void stdout.push(line.join(" ")),
            error: (...line: ReadonlyArray<unknown>) => void stdout.push(line.join(" ")),
          };
          yield* Command.runWith(cli, { version: "1.0.0" })(args).pipe(
            Effect.provide(Domain.protocolHttp("http://bank.test/")),
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, fetch),
            Effect.provide(CliEnvironment),
            Effect.provideService(Console.Console, console),
            Effect.exit,
          );
          return JSON.parse(stdout.join("\n")) as unknown;
        });
      yield* run(["deposit", "--account-id", "a", "--amount", "100"]);
      expect(yield* run(["transfer-money", "--from", "a", "--to", "b", "--amount", "30"])).toEqual({
        reply: { balance: 70 },
        stream: "Account/a",
        version: 2,
        commits: [
          { stream: "Account/a", version: 2 },
          { stream: "Account/b", version: 1 },
        ],
      });
    }).pipe(Effect.provide(BankLive));
  });

  it.live("an agent's tool takes its input", () => {
    const tools = DomainAi.toToolkit(BankApi, { expose: ["Deposit", "TransferMoney"] });
    const call = (name: string, params: unknown) =>
      Effect.gen(function* () {
        const toolkit = yield* tools.toolkit;
        const results = yield* toolkit.handle(name as never, params as never);
        const last = yield* Stream.runLast(results).pipe(Effect.flatMap(Effect.fromOption));
        return { isFailure: last.isFailure, encoded: last.encodedResult as unknown };
      });
    return Effect.gen(function* () {
      yield* call("DecisionBankApi_Deposit_send", { input: { accountId: "a", amount: 100 } });
      expect(
        yield* call("DecisionBankApi_TransferMoney_send", {
          input: { from: "a", to: "b", amount: 30 },
        }),
      ).toEqual({
        isFailure: false,
        encoded: {
          reply: { balance: 70 },
          stream: "Account/a",
          version: 2,
          commits: [
            { stream: "Account/a", version: 2 },
            { stream: "Account/b", version: 1 },
          ],
        },
      });
    }).pipe(Effect.provide(tools.layer.pipe(Layer.provideMerge(BankLive))));
  });
});
