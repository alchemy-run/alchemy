import * as Domain from "@alchemy.run/domain";
import * as View from "@alchemy.run/domain/View";
import * as Schema from "effect/Schema";

const EntityId = Schema.String.pipe(Schema.brand("OptionalContractsEntityId"));
class NoReadAggregate extends Domain.Aggregate("NoReadAggregate", {
  id: EntityId,
  state: Schema.Struct({}),
  initial: {},
  commands: [],
  decide: {},
  evolve: {},
}) {}

const aggregate: Domain.Aggregate.Any = NoReadAggregate;
const ref = NoReadAggregate.ref("one");
const typedRef: Domain.Aggregate.Ref<typeof NoReadAggregate> = ref;
const id: typeof EntityId.Type = ref.id;
const aggregateName: "NoReadAggregate" = ref.aggregate;
// @ts-expect-error refs accept the id schema's encoded string, not a number
NoReadAggregate.ref(1);
// @ts-expect-error ref ids retain their decoded brand
const unbrandedId: typeof ref.id = "one";

class StatelessView extends View.make("StatelessView", {
  key: NoReadAggregate,
  from: [NoReadAggregate],
}) {}
const view: View.Any = StatelessView;
class OptionalContracts extends Domain.Model("OptionalContracts", {
  aggregates: [NoReadAggregate],
  views: [StatelessView],
}) {}

void aggregate;
void typedRef;
void id;
void aggregateName;
void unbrandedId;
void view;
void OptionalContracts;
