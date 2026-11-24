import Uploads

/-- `lake exe uploads graph [stage] [--why]`, `lake exe uploads plan [stage]` -/
def main (args : List String) : IO UInt32 := Alchemy.AWS.cli Uploads.UploadStack args
