import * as Effect from "effect/Effect";
import * as Turso from "@/Turso";

export const BindingGroup = Turso.Group("BindingGroup", { location: "aws-us-east-1" });

export const BindingDb = Effect.gen(function* () {
  const group = yield* BindingGroup;
  return yield* Turso.Database("BindingDb", { group: group.name });
});

export const TenantGroup = Turso.Group("TenantGroup", { location: "aws-us-east-1" });
