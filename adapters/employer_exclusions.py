#!/usr/bin/env python3
"""Shared LinkedIn-adapter employer exclusion classifier."""

from __future__ import annotations

import re
from typing import Any


def clean(value: Any) -> str:
    return str(value or "").replace("\u00a0", " ").strip()


def validate_employer_exclusion_rules(rules: Any) -> list[dict[str, Any]]:
    if not isinstance(rules, list):
        raise ValueError("employer_exclusions must be an array")
    ids: set[str] = set()
    for rule in rules:
        signals = rule.get("jd_signal_patterns") if isinstance(rule, dict) else None
        required = rule.get("required_jd_signal_count") if isinstance(rule, dict) else None
        if (
            not clean(rule.get("id"))
            or not clean(rule.get("reason"))
            or not clean(rule.get("company_pattern"))
            or not clean(rule.get("attribution_line_pattern"))
            or not isinstance(signals, list)
            or not signals
            or not isinstance(required, int)
            or required < 1
            or required > len(signals)
        ):
            raise ValueError("employer exclusion rules require id, reason, company/attribution patterns, signals, and a valid required signal count")
        if rule["id"] in ids:
            raise ValueError(f"duplicate employer exclusion id: {rule['id']}")
        ids.add(rule["id"])
        for pattern in [rule["company_pattern"], rule["attribution_line_pattern"], *signals]:
            re.compile(pattern, re.IGNORECASE | re.MULTILINE)
    return rules


def match_excluded_employer(company: Any, description: Any, rules: Any) -> dict[str, str] | None:
    validated = validate_employer_exclusion_rules(rules)
    company_text = clean(company)
    jd = str(description or "").replace("\r", "")
    lines = [clean(line) for line in jd.split("\n") if clean(line)]

    for rule in validated:
        if re.search(rule["company_pattern"], company_text, re.IGNORECASE | re.MULTILINE):
            return {"id": rule["id"], "reason": rule["reason"], "source": "company", "evidence": f"Company: {company_text}"}

        attribution = next(
            (line for line in lines if re.search(rule["attribution_line_pattern"], line, re.IGNORECASE | re.MULTILINE)),
            None,
        )
        if attribution:
            return {"id": rule["id"], "reason": rule["reason"], "source": "jd_attribution", "evidence": f"JD attribution: {attribution}"}

        signals = []
        for pattern in rule["jd_signal_patterns"]:
            match = re.search(pattern, jd, re.IGNORECASE | re.MULTILINE)
            if match:
                signals.append(clean(match.group(0)))
        if len(signals) >= rule["required_jd_signal_count"]:
            evidence = " | ".join(signals[: rule["required_jd_signal_count"]])
            return {"id": rule["id"], "reason": rule["reason"], "source": "jd_boilerplate", "evidence": f"JD employer signals: {evidence}"}
    return None
