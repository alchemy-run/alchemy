"""A FastAPI service over the exported ledger, as an app team would write
one: each request reads the live generation through PyIceberg, filters
pushed down to the scan. The table is a query parameter, so one service
answers for every table a test writes.
"""

from fastapi import FastAPI
from pyiceberg.expressions import And, EqualTo, GreaterThanOrEqual, IsNull, LessThan

from lake import EARLY_BEFORE, catalog, live_table

app = FastAPI()
lake = catalog()


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/accounts")
def accounts(table: str) -> list[dict]:
    """Rows per account key."""
    keys = live_table(lake, table).scan(selected_fields=("key",)).to_arrow().column("key").to_pylist()
    return [{"key": key, "rows": keys.count(key)} for key in sorted(set(keys))]


@app.get("/accounts/{key}/positions")
def positions(key: str, table: str, since: int = 0) -> list[dict]:
    """An account's rows at `since` or later, by position."""
    rows = (
        live_table(lake, table)
        .scan(
            row_filter=And(EqualTo("key", key), GreaterThanOrEqual("position", since)),
            selected_fields=("key", "position"),
        )
        .to_arrow()
        .to_pylist()
    )
    return sorted(({"key": row["key"], "position": row["position"]} for row in rows), key=lambda row: row["position"])


@app.get("/stats")
def stats(table: str) -> dict:
    """Rows before the cutoff, and rows with no memo, from one snapshot of the table."""
    live = live_table(lake, table)
    early = live.scan(row_filter=LessThan("envelope_at", EARLY_BEFORE.isoformat()), selected_fields=("key",))
    no_memo = live.scan(row_filter=IsNull("_export_memo"), selected_fields=("key",))
    return {"early": early.to_arrow().num_rows, "noMemo": no_memo.to_arrow().num_rows}


@app.get("/answers")
def answers(table: str) -> dict:
    """All four answers from one resolution of the live generation and one snapshot."""
    live = live_table(lake, table)
    rows = live.scan(selected_fields=("key", "position", "envelope_at", "_export_memo")).to_arrow().to_pylist()
    keys = sorted({row["key"] for row in rows})
    return {
        "perKey": [{"key": key, "rows": sum(1 for row in rows if row["key"] == key)} for key in keys],
        "positions": sorted(
            ({"key": "a2", "position": row["position"]} for row in rows if row["key"] == "a2" and row["position"] >= 1),
            key=lambda row: row["position"],
        ),
        "early": sum(1 for row in rows if row["envelope_at"] < EARLY_BEFORE),
        "noMemo": sum(1 for row in rows if row["_export_memo"] is None),
    }
