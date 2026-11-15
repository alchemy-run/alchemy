"""The exported lake as a Python reader finds it.

The store keeps no Iceberg view these tools can read (PyIceberg and DuckDB
read tables, not views), so a reader resolves the live generation from the
store's control tables, as the view does:

- the latest promotion of the table's name in `_export_promoted` (highest `ord`);
- before any promotion, the first generation made: the earliest `<name>_v<n>`
  in `_export_generations`.

Settings come from the environment the test sets.
"""

import os
import re
from datetime import datetime

from pyiceberg.catalog import load_catalog
from pyiceberg.expressions import EqualTo

NAMESPACE = os.environ["LAKE_NAMESPACE"]
CATALOG_URI = os.environ["LAKE_CATALOG_URI"]
S3_ENDPOINT = os.environ["LAKE_S3_ENDPOINT"]
ACCESS_KEY = os.environ["AWS_ACCESS_KEY_ID"]
SECRET_KEY = os.environ["AWS_SECRET_ACCESS_KEY"]
# Rows whose envelope time is before this instant count as early.
EARLY_BEFORE = datetime.fromisoformat(os.environ["LAKE_EARLY_BEFORE"])


def catalog():
    return load_catalog(
        "lake",
        type="rest",
        uri=CATALOG_URI,
        **{
            "s3.endpoint": S3_ENDPOINT,
            "s3.access-key-id": ACCESS_KEY,
            "s3.secret-access-key": SECRET_KEY,
            "s3.region": "us-east-1",
            "s3.path-style-access": "true",
        },
    )


def live_generation(lake, table: str) -> str:
    """The generation table engines read now."""
    promoted = (
        lake.load_table((NAMESPACE, "_export_promoted"))
        .scan(row_filter=EqualTo("name", table))
        .to_arrow()
        .to_pylist()
    )
    if promoted:
        return max(promoted, key=lambda row: row["ord"])["generation"]
    own = re.compile(rf"^{re.escape(table)}_v\d+$")
    made = [
        row
        for row in lake.load_table((NAMESPACE, "_export_generations")).scan().to_arrow().to_pylist()
        if own.match(row["generation"])
    ]
    if not made:
        raise LookupError(f"{table} has no generation")
    return min(made, key=lambda row: row["ord"])["generation"]


def live_table(lake, table: str):
    return lake.load_table((NAMESPACE, live_generation(lake, table)))
