import Shop

/-- `lake exe shop graph [stage] [--why]`, `lake exe shop plan [stage]`, `lake exe shop plan [stage] after [stage]` -/
def main (args : List String) : IO UInt32 := Alchemy.AWS.cli Shop.ShopStack args
