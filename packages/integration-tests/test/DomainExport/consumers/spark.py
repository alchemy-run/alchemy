"""Spark SQL by hand against the stable name, the catalog's Iceberg view
(which the store points at the live generation), served so a test can ask
after every write. One Spark session; each request is one query.

GET /answers?table=<name> -> the four answers, and whether the name is a view.
"""

import json
import os
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from pyspark.sql import SparkSession

namespace = os.environ["LAKE_NAMESPACE"]
early_before = datetime.fromisoformat(os.environ["LAKE_EARLY_BEFORE"]).isoformat()

spark = SparkSession.builder.appName("export-consumer").getOrCreate()
spark.sparkContext.setLogLevel("ERROR")


def answers(table: str) -> dict:
    name = f"lake.{namespace}.{table}"
    # One query, one resolution of the view: the four answers from the same snapshot.
    rows = spark.sql(f"SELECT key, position, envelope_at < TIMESTAMP '{early_before}' AS early, _export_memo IS NULL AS no_memo FROM {name}").collect()
    keys = sorted({row["key"] for row in rows})
    views = spark.sql(f"SHOW VIEWS IN lake.{namespace} LIKE '{table}'").count()
    return {
        "perKey": [{"key": key, "rows": sum(1 for row in rows if row["key"] == key)} for key in keys],
        "positions": sorted(
            ({"key": "a2", "position": row["position"]} for row in rows if row["key"] == "a2" and row["position"] >= 1),
            key=lambda row: row["position"],
        ),
        "early": sum(1 for row in rows if row["early"]),
        "noMemo": sum(1 for row in rows if row["no_memo"]),
        "views": views,
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        try:
            if url.path == "/health":
                body, status = {"ok": True}, 200
            elif url.path == "/answers":
                body, status = answers(parse_qs(url.query)["table"][0]), 200
            else:
                body, status = {"error": "not found"}, 404
        except Exception as error:  # the test reads the message as the failure
            body, status = {"error": str(error)}, 500
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
