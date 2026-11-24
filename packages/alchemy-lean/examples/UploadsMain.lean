import Uploads

/-- `lake exe uploads graph [stage] [--why]`, `lake exe uploads plan [stage]` -/
def main (args : List String) : IO UInt32 :=
  Uploads.UploadStack.cli Alchemy.AWS.Control.providers Uploads.fresh Alchemy.AWS.describeGrant args
