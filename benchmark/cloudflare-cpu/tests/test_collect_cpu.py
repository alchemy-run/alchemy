"""Offline telemetry fixtures: no credentials, deployment, or network needed."""
from contextlib import redirect_stdout
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cpu = load_module("cpu", ROOT / "collect-cpu.py")
summary = load_module("summary", ROOT / "summarize.py")
remote = load_module("remote", ROOT / "deep" / "collect-remote.py")
VERSION = "11111111-1111-4111-8111-111111111111"
OTHER_VERSION = "22222222-2222-4222-8222-222222222222"
URL = "https://fixture.example"


def manifest():
    return {
        "runId": "offline-r1", "url": URL, "variant": "baseline", "revision": "fixture",
        "startedAt": "2026-01-01T00:00:00Z", "endedAt": "2026-01-01T00:00:01Z",
        "totalRequests": 2, "versionBefore": {"id": VERSION}, "versionAfter": {"id": VERSION},
        "versionStable": True, "allCorrect": True, "configuration": {},
        "workloads": [{"endpoint": "workflow-codec", "warmup": {"samples": []},
                       "measured": {"samples": [{}, {}]}, "summary": {"n": 2}}],
    }


def event(index, version=VERSION):
    return {
        "timestamp": 1767225600000 + index,
        "$metadata": {"requestId": f"request-{index}", "id": f"event-{index}"},
        "$workers": {
            "event": {"request": {"url": URL + "/workflow-codec?run=offline-r1&phase=measured&count=1"}},
            "scriptVersion": {"id": version}, "cpuTimeMs": index + 2,
            "wallTimeMs": index + 3, "outcome": "ok",
        },
    }


class VersionValidationTests(unittest.TestCase):
    def collect(self, events):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        prefix = Path(temporary.name) / "cohort"
        Path(str(prefix) + "-latency.json").write_text(json.dumps(manifest()))
        Path(str(prefix) + "-observer.json").write_text(json.dumps({
            "worker": "fixture-worker", "runId": "offline-r1", "origin": URL,
        }))
        with patch.object(cpu, "query", return_value=events), patch.object(cpu, "MAX_RETRIES", 0), redirect_stdout(io.StringIO()):
            accepted = cpu.collect(prefix, "unused-token", "0" * 32, time.monotonic() + 30)
        return prefix, accepted, json.loads(Path(str(prefix) + "-cpu.json").read_text())

    def test_same_version_complete_cohort_is_accepted(self):
        prefix, accepted, result = self.collect([event(0), event(1)])
        self.assertTrue(accepted)
        self.assertEqual(result["status"], "complete")
        self.assertTrue(result["coverage"]["complete"])
        self.assertEqual(result["coverage"]["mismatchedVersionInvocations"], 0)
        report = summary.summarize(prefix)
        self.assertTrue(report["valid"])
        self.assertEqual(report["workloads"]["workflow-codec"]["cpuMs"]["n"], 2)

    def test_mixed_version_is_invalid_with_diagnostics_and_no_cpu_summary(self):
        prefix, accepted, result = self.collect([event(0), event(1, OTHER_VERSION)])
        self.assertFalse(accepted)
        self.assertEqual(result["status"], "invalid")
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual(result["coverage"]["observedInvocations"], 2)
        self.assertEqual(result["coverage"]["invocationsWithCpu"], 1)
        self.assertEqual(result["coverage"]["mismatchedVersionInvocations"], 1)
        self.assertEqual(result["coverage"]["groups"][0]["mismatchedVersion"], 1)
        self.assertEqual(len(result["samples"]), 2)
        report = summary.summarize(prefix)
        self.assertFalse(report["valid"])
        self.assertEqual(report["workloads"], {})

    def test_missing_measured_invocation_is_incomplete_without_cpu_summary(self):
        prefix, accepted, result = self.collect([event(0)])
        self.assertFalse(accepted)
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual(result["coverage"]["observedInvocations"], 1)
        self.assertEqual(result["coverage"]["missingEvents"], 1)
        self.assertEqual(result["coverage"]["missingCpu"], 1)
        group = result["coverage"]["groups"][0]
        self.assertEqual(group["phase"], "measured")
        self.assertEqual(group["missingEvents"], 1)
        report = summary.summarize(prefix)
        self.assertFalse(report["valid"])
        self.assertFalse(report["coverage"]["complete"])
        self.assertEqual(report["workloads"], {})

    def test_present_measured_invocation_without_cpu_is_incomplete_without_cpu_summary(self):
        missing_cpu = event(1)
        missing_cpu["$workers"].pop("cpuTimeMs")
        prefix, accepted, result = self.collect([event(0), missing_cpu])
        self.assertFalse(accepted)
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual(result["coverage"]["observedInvocations"], 2)
        self.assertEqual(result["coverage"]["missingEvents"], 0)
        self.assertEqual(result["coverage"]["invocationsWithCpu"], 1)
        self.assertEqual(result["coverage"]["missingCpu"], 1)
        group = result["coverage"]["groups"][0]
        self.assertEqual(group["phase"], "measured")
        self.assertEqual(group["missingEvents"], 0)
        self.assertEqual(group["missingCpu"], 1)
        self.assertIsNone(result["samples"][1]["cpuTimeMs"])
        report = summary.summarize(prefix)
        self.assertFalse(report["valid"])
        self.assertFalse(report["coverage"]["complete"])
        self.assertEqual(report["workloads"], {})

    def test_historical_complete_flag_cannot_hide_wrong_version(self):
        prefix, _, result = self.collect([event(0), event(1, OTHER_VERSION)])
        result.update(schemaVersion=1, status="complete", coverage={"complete": True})
        for sample in result["samples"]:
            sample.pop("observedVersions", None)
            sample.pop("cpuVersion", None)
        Path(str(prefix) + "-cpu.json").write_text(json.dumps(result))
        self.assertFalse(summary.summarize(prefix)["valid"])
        with redirect_stdout(io.StringIO()):
            self.assertFalse(cpu.collect(prefix, "unused-token", "0" * 32, time.monotonic() + 30))

    def test_conflicting_duplicate_version_cannot_be_overwritten(self):
        _, accepted, result = self.collect([event(0, OTHER_VERSION), event(0), event(1)])
        self.assertFalse(accepted)
        self.assertEqual(result["coverage"]["mismatchedVersionInvocations"], 1)
        self.assertEqual(result["samples"][0]["observedVersions"], [VERSION, OTHER_VERSION])

    def test_missing_version_cannot_borrow_identity_from_version_only_row(self):
        without_version = event(0, None)
        version_only = event(0)
        version_only["$workers"].pop("cpuTimeMs")
        _, accepted, result = self.collect([without_version, version_only, event(1)])
        self.assertFalse(accepted)
        self.assertEqual(result["coverage"]["missingVersionInvocations"], 1)

    def test_unstable_manifest_is_rejected(self):
        client = manifest()
        client["versionAfter"]["id"] = OTHER_VERSION
        with self.assertRaisesRegex(ValueError, "stable"):
            cpu.manifest_version(client)

    def test_remote_collector_keeps_shared_parser_contract(self):
        # collect-remote imports this parser and performs its own front/remote
        # version checks. Preserve its four-argument signature and tuple shape.
        parsed = remote.cpu.sample_from_event(
            deepcopy(event(0)), cpu.origin(URL), "offline-r1", {("/workflow-codec", "measured"): 1},
        )
        self.assertEqual(parsed[0], "request:request-0")
        self.assertEqual(parsed[1]["version"], VERSION)
        self.assertEqual(remote.version_of({"scriptVersion": {"id": VERSION}}), VERSION)

    def test_remote_collector_still_joins_native_do_cpu(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        prefix = Path(temporary.name) / "remote"
        actor = "a" * 64
        client = manifest()
        client.update(harness="cloudflare-deep-v1", configuration={"operations": 100})
        client["workloads"] = [{
            "endpoint": "deep/sql", "warmup": {"samples": []},
            "measured": {"samples": [{
                "correct": True, "status": 200, "cfRay": "ray1-ABC", "sequence": 0,
                "body": json.dumps({"ok": True, "endpoint": "deep/sql", "count": 100,
                                    "checksum": 5050, "rows": 100, "actorId": actor,
                                    "version": {"id": VERSION}}),
            }]},
        }]
        Path(str(prefix) + "-latency.json").write_text(json.dumps(client))
        front = event(0)
        front["$metadata"].update(rayId="ray1", traceId="trace1")
        front["$workers"]["event"]["request"]["url"] = URL + "/deep/sql?run=offline-r1&phase=measured&count=100"
        receiving = {
            "timestamp": 1767225600001,
            "$metadata": {"id": "remote-event", "requestId": "remote-request", "traceId": "trace1"},
            "$workers": {"scriptVersion": {"id": VERSION}, "durableObjectId": actor,
                         "cpuTimeMs": 5, "wallTimeMs": 8, "outcome": "ok", "eventType": "jsrpc",
                         "event": {"rpcMethods": ["writeRead"], "rpcCallCount": 1}},
        }
        args = SimpleNamespace(prefix=prefix, endpoint="deep/sql", output=None,
                               front_worker="fixture-worker", remote_worker=None,
                               remote_version=None, actor_id=None)
        with patch.object(remote, "pages", side_effect=[
            ({"front": front}, [], None), ({"remote": receiving}, [], None),
        ]), redirect_stdout(io.StringIO()):
            self.assertTrue(remote.collect(args, "unused-token", "0" * 32))
        result = json.loads(Path(str(prefix) + "-deep-sql-remote-cpu.json").read_text())
        self.assertTrue(result["coverage"]["complete"])
        self.assertEqual(result["measuredSummary"]["completeRemoteCpuPerParent"]["meanMs"], 5)
        self.assertEqual(result["parents"][0]["frontCpuMs"], 2)


if __name__ == "__main__":
    unittest.main()
