import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

const Line = Schema.Struct({
  price: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  count: Schema.Int.check(Schema.isGreaterThan(0)),
});

export class LinesAdded extends Domain.Event("LinesAdded", {
  lines: Schema.Array(Line),
  cost: Schema.Int,
  units: Schema.Int,
}) {}

export class AddLines extends Domain.Command("AddLines", {
  target: Schema.String,
  input: { lines: Schema.Array(Line) },
  events: [LinesAdded],
}) {}

/** A basket that keeps its total next to its lines. */
export class Basket extends Domain.Aggregate("Basket", {
  id: Schema.String,
  state: Schema.Struct({
    lines: Schema.Array(Line),
    total: Schema.Int,
    units: Schema.Int,
  }),
  initial: { lines: [], total: 0, units: 0 },
  invariants: {
    TheTotalIsTheSumOfTheLines: (basket) => {
      let total = 0;
      for (const line of basket.lines) total += line.price * line.count;
      return basket.total === total;
    },
    NeverFewerUnitsThanLines: (basket) => basket.units >= basket.lines.length,
  },
  commands: [AddLines],
  decide: {
    AddLines: (_state, command) => {
      let cost = 0;
      let units = 0;
      const kept = [];
      for (const line of command.lines) {
        if (line.price === 0) continue;
        cost += line.price * line.count;
        for (let unit = 0; unit < 2; unit++) units++;
        units += line.count - 2;
        kept.push(line);
      }
      return kept.length === 0 ? [] : [new LinesAdded({ lines: kept, cost, units })];
    },
  },
  evolve: {
    LinesAdded: (state, event) => ({
      lines: [...state.lines, ...event.lines],
      total: state.total + event.cost,
      units: state.units + event.units,
    }),
  },
}) {}
