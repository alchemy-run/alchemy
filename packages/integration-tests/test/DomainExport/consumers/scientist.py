"""A data scientist's notebook over the exported ledger, served so a test
can ask it again after every write: the same four questions in pandas,
Polars, and DuckDB.

    rows per key; a2's rows at position 1 or later; rows before a cutoff;
    rows with no memo.

Each tool resolves the live generation itself and answers from one read.
"""

import duckdb
import polars as pl
from fastapi import FastAPI

from lake import (
    ACCESS_KEY,
    CATALOG_URI,
    EARLY_BEFORE,
    NAMESPACE,
    S3_ENDPOINT,
    SECRET_KEY,
    catalog,
    live_generation,
    live_table,
)

app = FastAPI()
lake = catalog()


def with_pandas(table: str) -> dict:
    frame = live_table(lake, table).scan().to_pandas()
    per_key = frame.groupby("key").size().sort_index()
    a2 = frame[(frame["key"] == "a2") & (frame["position"] >= 1)].sort_values("position")
    return {
        "perKey": [{"key": key, "rows": int(rows)} for key, rows in per_key.items()],
        "positions": [{"key": "a2", "position": int(p)} for p in a2["position"]],
        "early": int((frame["envelope_at"] < EARLY_BEFORE).sum()),
        "noMemo": int(frame["_export_memo"].isna().sum()),
    }


def with_polars(table: str) -> dict:
    frame = pl.from_arrow(live_table(lake, table).scan().to_arrow())
    per_key = frame.group_by("key").len().sort("key")
    a2 = frame.filter((pl.col("key") == "a2") & (pl.col("position") >= 1)).sort("position")
    return {
        "perKey": [{"key": row["key"], "rows": row["len"]} for row in per_key.iter_rows(named=True)],
        "positions": [{"key": "a2", "position": p} for p in a2["position"].to_list()],
        "early": frame.filter(pl.col("envelope_at") < EARLY_BEFORE).height,
        "noMemo": frame.filter(pl.col("_export_memo").is_null()).height,
    }


def with_duckdb(table: str) -> dict:
    con = duckdb.connect()
    # Installed in the image (python.Dockerfile): loading never downloads.
    con.execute("LOAD iceberg; LOAD httpfs;")
    endpoint = S3_ENDPOINT.removeprefix("http://")
    con.execute(
        f"CREATE SECRET s3 (TYPE s3, KEY_ID '{ACCESS_KEY}', SECRET '{SECRET_KEY}', "
        f"ENDPOINT '{endpoint}', URL_STYLE 'path', USE_SSL false, REGION 'us-east-1')"
    )
    con.execute(f"ATTACH '' AS lake (TYPE iceberg, ENDPOINT '{CATALOG_URI}', AUTHORIZATION_TYPE 'none')")
    name = f'lake."{NAMESPACE}"."{live_generation(lake, table)}"'
    # One snapshot for all four questions: a temporary copy, as an analyst would pin a frame.
    con.execute(f"CREATE TEMP TABLE t AS SELECT key, position, envelope_at, _export_memo FROM {name}")
    per_key = con.execute("SELECT key, count(*) FROM t GROUP BY key ORDER BY key").fetchall()
    positions = con.execute("SELECT position FROM t WHERE key = 'a2' AND position >= 1 ORDER BY position").fetchall()
    (early,) = con.execute("SELECT count(*) FROM t WHERE envelope_at < ?", [EARLY_BEFORE]).fetchone()
    (no_memo,) = con.execute("SELECT count(*) FROM t WHERE _export_memo IS NULL").fetchone()
    con.close()
    return {
        "perKey": [{"key": key, "rows": rows} for key, rows in per_key],
        "positions": [{"key": "a2", "position": p} for (p,) in positions],
        "early": early,
        "noMemo": no_memo,
    }


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/pandas")
def pandas_answers(table: str) -> dict:
    return with_pandas(table)


@app.get("/polars")
def polars_answers(table: str) -> dict:
    return with_polars(table)


@app.get("/duckdb")
def duckdb_answers(table: str) -> dict:
    return with_duckdb(table)
