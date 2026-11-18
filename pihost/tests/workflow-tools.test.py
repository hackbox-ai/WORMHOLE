"""Behavioral tests for the offline workflow helper; stdlib only."""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).parents[1] / "builtin-skills/wormhole-test-method/scripts/workflow_tools.py"
spec = importlib.util.spec_from_file_location("workflow_tools", SOURCE)
tools = importlib.util.module_from_spec(spec); spec.loader.exec_module(tools)


class WorkflowToolsTests(unittest.TestCase):
    def test_correlates_derived_token_without_disclosing_it(self):
        token = "private-derived-capability-123456"
        events = [{"evidence_ref": "traffic:10", "subject_ref": "s1", "identity_evidence": "traffic:1", "url": "https://example.invalid/jobs", "request": {}, "response": {"download_token": token}}, {"evidence_ref": "traffic:11", "subject_ref": "s2", "identity_evidence": "traffic:2", "url": "https://example.invalid/files?token=" + token, "request": {"download_token": token}, "response": {}}]
        result = tools.correlate(events)
        self.assertTrue(result["links"][0]["cross_subject"])
        self.assertNotIn(token, json.dumps(result))
        self.assertEqual(result["links"][0]["occurrences"][1]["direction"], "request")

    def test_rejects_response_owner_as_identity(self):
        with self.assertRaises(ValueError): tools.correlate([{"evidence_ref": "traffic:1", "response": {"owner_id": "someone"}}])

    def config(self):
        return {"subjects": [{"id": "a", "identity_evidence": "traffic:1"}, {"id": "b", "identity_evidence": "traffic:2"}], "objects": [{"id": "oa", "value": "file-a", "owner": "a", "ownership_evidence": "traffic:3"}, {"id": "ob", "value": "file-b", "owner": "b", "ownership_evidence": "traffic:4"}, {"id": "absent", "value": "missing-file", "exists": False, "absence_evidence": "traffic:5"}], "request_evidence": "traffic:3", "request": {"method": "POST", "url": "https://example.invalid/read", "body": {"resource_id": "file-a", "format": "text"}}, "object_pointer": "/body/resource_id", "regenerate": ["csrf"]}

    def test_matrix_preserves_valid_body_and_orders_baselines(self):
        result = tools.matrix(self.config())
        self.assertEqual(len(result["plans"]), 6)
        self.assertEqual(result["plans"][0]["category"], "baseline")
        self.assertEqual(result["plans"][-1]["category"], "cross_subject")
        self.assertTrue(all(p["request"]["body"]["format"] == "text" for p in result["plans"]))
        self.assertEqual(result["network_requests_sent"], 0)

    def test_matrix_refuses_cookie_and_unverified_owner(self):
        config = self.config();config["request"]["headers"] = {"Cookie": "secret"}
        with self.assertRaises(ValueError): tools.matrix(config)
        config = self.config();del config["objects"][0]["ownership_evidence"]
        with self.assertRaises(ValueError): tools.matrix(config)

    def test_matrix_requires_existing_mutation_target(self):
        config = self.config();config["object_pointer"] = "/body/not_present"
        with self.assertRaises(ValueError): tools.matrix(config)

    def test_matrix_rejects_secret_query(self):
        config = self.config();config["request"]["url"] += "?token=private"
        with self.assertRaises(ValueError): tools.matrix(config)

    def test_compare_filters_noise_and_keeps_effect(self):
        result = tools.compare({"balance": 100, "server_time": 1}, {"balance": 140, "server_time": 2}, {"balance": 100, "server_time": 3}, ["/server_time"])
        self.assertEqual([x["pointer"] for x in result["changes"]], ["/balance"])
        self.assertEqual(result["changes"][0]["control"], 100)

    def test_compare_does_not_disclose_password_or_cookie(self):
        result = tools.compare({"password": "old-private"}, {"password": "new-private"}, {"password": "other-private"})
        text = json.dumps(result)
        for value in ("old-private", "new-private", "other-private"): self.assertNotIn(value, text)

    def test_decimal_sum_does_not_invent_rounding_error(self):
        result = tools.check({"checks": [{"name": "budget", "kind": "sum_lte", "values": ["0.1", "0.2"], "limit": "0.3", "evidence_refs": ["traffic:8"]}]})
        self.assertTrue(result["checks"][0]["holds"])
        self.assertEqual(result["checks"][0]["excess"], "0")

    def test_reports_real_aggregate_excess(self):
        result = tools.check({"checks": [{"name": "budget", "kind": "sum_lte", "values": ["40", "70"], "limit": "100", "evidence_refs": ["traffic:8", "traffic:9"]}]})
        self.assertFalse(result["checks"][0]["holds"])
        self.assertEqual(result["checks"][0]["excess"], "10")

    def test_invalid_numeric_and_unknown_checks_fail(self):
        for value in (True, "NaN", "Infinity", "1e100000"):
            with self.assertRaises(ValueError): tools.number(value)
        with self.assertRaises(ValueError): tools.check({"checks": [{"name": "execute", "kind": "eval", "values": [], "evidence_refs": ["traffic:1"]}]})

    def test_json_pointer_escaping_and_bounds(self):
        value = {"a/b": {"~key": [1, 2]}}
        tools.replace_at(value, "/a~1b/~0key/1", 3)
        self.assertEqual(value["a/b"]["~key"], [1, 3])
        with self.assertRaises(ValueError): tools.parts("/bad~2escape")

    def test_candidates_expands_observed_variants_in_input_order(self):
        result = tools.candidates({"parts": [["org-a", "OrgA"], ["-", "_"], ["r1", "R1"]], "joins": ["", ""]})
        self.assertEqual(result["candidates"][0], "org-a-r1")
        self.assertEqual(result["count"], 8)
        self.assertIn("throttling", result["instructions"])

    def test_candidates_defaults_to_no_separator(self):
        for config in (
            {"parts": [["org-a", "OrgA"], ["01", "02"]]},
            {"parts": [["org-a", "OrgA"], ["01", "02"]], "joins": []},
        ):
            result = tools.candidates(config)
            self.assertEqual(result["candidates"], ["org-a01", "org-a02", "OrgA01", "OrgA02"])
            self.assertEqual(result["count"], 4)

    def test_candidates_cli_accepts_omitted_joins(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "input.json", Path(directory) / "output.json"
            source.write_text(json.dumps({"parts": [["sample"], ["01", "02"]]}), encoding="utf-8")
            result = subprocess.run([sys.executable, str(SOURCE), "candidates", "--input", str(source),
                                     "--output", str(target)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(output["candidates"], ["sample01", "sample02"])
            self.assertIn("input_sha256", output)

    def test_candidates_rejects_built_in_dictionaries_and_oversized_sets(self):
        with self.assertRaises(ValueError): tools.candidates({"parts": [["x", 3], ["y"]]})
        with self.assertRaises(ValueError): tools.candidates({"parts": [[str(i) for i in range(41)], ["z"]]})
        with self.assertRaises(ValueError): tools.candidates({"parts": [[c for c in "abcdefghij"] for _ in range(3)]})
        with self.assertRaises(ValueError): tools.candidates({"parts": [["a"], ["b"]], "joins": ["-", "x"]})


if __name__ == "__main__": unittest.main()
