import Shop

/-- `lake exe shop graph [stage]`, `lake exe shop plan [stage]`, `lake exe shop plan [stage] after [stage]` -/
def main (args : List String) : IO UInt32 :=
  Shop.ShopStack.cli Alchemy.AWS.Control.providers Shop.fresh Alchemy.AWS.describeGrant args
