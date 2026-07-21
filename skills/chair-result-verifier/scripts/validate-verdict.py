#!/usr/bin/env python3
"""Validate chair-result-verifier JSON and enforce deterministic routing precedence."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


VERDICTS = {"pass", "detail_repair", "regenerate", "manual_review"}
ACTIONS = {"detail_repair", "regenerate", "manual_review"}
CATEGORIES = {
    "product_identity", "armrest", "base_and_wheels", "backrest", "seat",
    "overall_color", "logo_placement", "chair_count", "person_anatomy",
    "scene_integrity", "physical_plausibility", "local_color", "stitching",
    "piping", "texture", "hardware_detail",
}
REPAIR_TARGETS = {"logo", "stitching", "piping", "texture", "hardware", "color", "other"}


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def validate_bbox(value: Any, path: str, errors: list[str]) -> None:
    require(isinstance(value, list) and len(value) == 4, f"{path} must contain four numbers", errors)
    if not isinstance(value, list) or len(value) != 4:
        return
    require(all(isinstance(v, (int, float)) and 0 <= v <= 1 for v in value), f"{path} values must be within 0..1", errors)
    if all(isinstance(v, (int, float)) for v in value):
        require(value[0] < value[2] and value[1] < value[3], f"{path} must satisfy x1<x2 and y1<y2", errors)


def expected_verdict(issues: list[dict[str, Any]], uncertainties: list[Any]) -> str:
    actions = {issue.get("action") for issue in issues}
    if "regenerate" in actions:
        return "regenerate"
    if "manual_review" in actions or uncertainties:
        return "manual_review"
    if "detail_repair" in actions:
        return "detail_repair"
    return "pass"


def validate(payload: Any) -> list[str]:
    errors: list[str] = []
    require(isinstance(payload, dict), "root must be a JSON object", errors)
    if not isinstance(payload, dict):
        return errors

    require(payload.get("schemaVersion") == "1.0", "schemaVersion must equal 1.0", errors)
    require(isinstance(payload.get("taskId"), str) and bool(payload.get("taskId", "").strip()), "taskId is required", errors)
    verdict = payload.get("verdict")
    require(verdict in VERDICTS, f"verdict must be one of {sorted(VERDICTS)}", errors)
    confidence = payload.get("confidence")
    require(isinstance(confidence, (int, float)) and 0 <= confidence <= 1, "confidence must be within 0..1", errors)
    require(isinstance(payload.get("summary"), str) and bool(payload.get("summary", "").strip()), "summary is required", errors)

    issues = payload.get("issues")
    uncertainties = payload.get("uncertainties")
    require(isinstance(issues, list), "issues must be an array", errors)
    require(isinstance(uncertainties, list), "uncertainties must be an array", errors)
    if not isinstance(issues, list) or not isinstance(uncertainties, list):
        return errors

    seen_ids: set[str] = set()
    for index, issue in enumerate(issues):
        prefix = f"issues[{index}]"
        require(isinstance(issue, dict), f"{prefix} must be an object", errors)
        if not isinstance(issue, dict):
            continue
        issue_id = issue.get("id")
        require(isinstance(issue_id, str) and bool(issue_id.strip()), f"{prefix}.id is required", errors)
        require(issue_id not in seen_ids, f"{prefix}.id must be unique", errors)
        if isinstance(issue_id, str):
            seen_ids.add(issue_id)
        require(issue.get("category") in CATEGORIES, f"{prefix}.category is invalid", errors)
        require(issue.get("severity") in {"critical", "major", "detail"}, f"{prefix}.severity is invalid", errors)
        require(issue.get("scope") in {"global", "local"}, f"{prefix}.scope is invalid", errors)
        action = issue.get("action")
        require(action in ACTIONS, f"{prefix}.action is invalid", errors)
        issue_confidence = issue.get("confidence")
        require(isinstance(issue_confidence, (int, float)) and 0 <= issue_confidence <= 1, f"{prefix}.confidence must be within 0..1", errors)
        if action == "detail_repair":
            require(issue.get("repairTarget") in REPAIR_TARGETS, f"{prefix}.repairTarget is required for detail repair", errors)
        evidence = issue.get("evidence")
        require(isinstance(evidence, dict), f"{prefix}.evidence is required", errors)
        if isinstance(evidence, dict):
            require(isinstance(evidence.get("observation"), str) and bool(evidence.get("observation", "").strip()), f"{prefix}.evidence.observation is required", errors)
            require(isinstance(evidence.get("referenceObservation"), str) and bool(evidence.get("referenceObservation", "").strip()), f"{prefix}.evidence.referenceObservation is required", errors)
            if "bbox" in evidence:
                validate_bbox(evidence["bbox"], f"{prefix}.evidence.bbox", errors)

    expected = expected_verdict(issues, uncertainties)
    require(verdict == expected, f"verdict must be {expected} according to routing precedence, got {verdict}", errors)
    if verdict == "pass":
        require(not issues and not uncertainties, "pass requires empty issues and uncertainties", errors)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Path to a verdict JSON file, or - for stdin")
    args = parser.parse_args()
    try:
        text = sys.stdin.read() if str(args.input) == "-" else args.input.read_text(encoding="utf-8")
        payload = json.loads(text)
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"valid": False, "errors": [str(exc)]}, ensure_ascii=False, indent=2))
        return 2
    errors = validate(payload)
    print(json.dumps({"valid": not errors, "errors": errors}, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
