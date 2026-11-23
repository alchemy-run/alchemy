// The proved bank on a Cloudflare Durable Object.
//
// `bend Server.bend -o durable-object/Server.mjs` writes the module this
// imports: the bank's pure functions, compiled from Bend. The object keeps the
// journal in its storage, one entry per request that changed the bank, and
// replays it when it wakes. So the bank is where it was, with every saga where
// it stood, and one object is one writer.
import Bank from "./Server.mjs";

const list = (items) => items.reduceRight((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
const key = (n) => "journal:" + String(n).padStart(12, "0");

export class BankObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.world = undefined;
    this.entries = 0;
  }

  async load() {
    if (this.world !== undefined) return;
    const stored = await this.state.storage.list({ prefix: "journal:" });
    const lines = [...stored.values()];
    this.entries = lines.length;
    this.world = Bank.replay(list(lines), Bank["Bank:start"]());
  }

  // Writes the entries to storage, then takes the world they lead to.
  async commit(lines, world) {
    if (lines.length > 0) {
      const writes = {};
      for (const line of lines) writes[key(this.entries++)] = line;
      await this.state.storage.put(writes);
    }
    this.world = world;
  }

  // FraudCheck.score and Payments.refund: the services at FRAUD_URL and
  // PAYMENTS_URL, or stand-ins when they are not set.
  async answer(call) {
    if (call.$ === "AskFraud") {
      const url = this.env.FRAUD_URL;
      const risk = url
        ? parseInt(await (await fetch(`${url}?account=${call.account}&amount=${call.total}`)).text(), 10)
        : Bank.stand_in_risk(call.total);
      return "answer/fraud/" + risk;
    }
    const url = this.env.PAYMENTS_URL;
    if (url) await fetch(`${url}?settlement=${call.settlement}&amount=${call.amount}`);
    return "answer/refund";
  }

  async fetch(request) {
    await this.load();
    const path = new URL(request.url).pathname;
    const lines = [];
    const ticked = Bank.tick(this.world, Math.floor(Date.now() / 1000));
    if (ticked.moved) lines.push(ticked.line);
    const handled = Bank.handle(ticked.world, Bank.asked(path));
    if (handled.journal) lines.push(path);
    // Call the outside systems the bank is waiting on. Each answer is a
    // journal line, so a replay never asks again.
    let world = handled.world;
    for (let call = Bank.call_waiting(world); call.$ !== "NoCall"; call = Bank.call_waiting(world)) {
      const line = await this.answer(call);
      lines.push(line);
      world = Bank.apply_line(world, line);
    }
    await this.commit(lines, world);
    return new Response(handled.answer.body, {
      status: parseInt(handled.answer.status, 10),
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

export default {
  fetch(request, env) {
    return env.BANK.get(env.BANK.idFromName("bank")).fetch(request);
  },
};
