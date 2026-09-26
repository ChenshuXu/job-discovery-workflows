#!/usr/bin/env python3
"""Run LinkedIn JobSpy discovery and persist one Markdown file per job."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any

from employer_exclusions import match_excluded_employer, validate_employer_exclusion_rules


def slug(value: Any, max_len: int = 90) -> str:
    text = str(value or "").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return (text[:max_len].strip("-") or "unknown")


def clean(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def linkedin_job_id(url: str) -> str:
    match = re.search(r"/jobs/view/(\d+)", url or "")
    return match.group(1) if match else slug(url or "no-id", 32)


def load_scan_config(config_file: Path) -> dict[str, Any]:
    try:
        config = json.loads(config_file.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read scan config {config_file}: {exc}") from exc
    if config.get("schema_version") != 1:
        raise ValueError(f"unsupported scan config schema in {config_file}")
    queries = config.get("queries")
    if not isinstance(queries, list) or not queries or not all(isinstance(item, str) and item.strip() for item in queries):
        raise ValueError(f"scan config queries must be a non-empty string array: {config_file}")
    for field in ("results_wanted", "max_post_age_hours"):
        if not isinstance(config.get(field), int) or config[field] <= 0:
            raise ValueError(f"scan config {field} must be a positive integer: {config_file}")
    if not isinstance(config.get("location"), str) or not config["location"].strip():
        raise ValueError(f"scan config location must be a non-empty string: {config_file}")
    validate_employer_exclusion_rules(config.get("employer_exclusions"))
    return config


def markdown_for_row(row: dict[str, Any], query: str, run_id: str) -> tuple[str, str]:
    url = clean(row.get("job_url") or row.get("job_url_direct") or row.get("url"))
    job_id = linkedin_job_id(url)
    company = clean(row.get("company"))
    title = clean(row.get("title"))
    location = clean(row.get("location"))
    posted = clean(row.get("date_posted"))
    description = clean(row.get("description"))
    direct_url = clean(row.get("job_url_direct"))
    employment_type = clean(row.get("job_type")) or "unknown"
    remote_heuristic = clean(row.get("is_remote")).lower() == "true"
    filename = f"linkedin-{job_id}-{slug(company, 35)}-{slug(title, 70)}.md"
    markdown = f"""# {company} - {title}

**URL:** {url}
**LinkedIn Job ID:** {job_id}
**Company:** {company}
**Role:** {title}
**Location:** {location}
**Employment Type:** {employment_type}
**Employment Type Source:** jobspy:linkedin-detail-job_type
**Workplace Type:** unknown
**Workplace Type Source:** jobspy:is_remote-heuristic
**Structured Remote Signal:** false
**Remote Heuristic:** {str(remote_heuristic).lower()}
**Posted:** {posted}
**Source:** JobSpy linkedin
**Search Query:** {query}
**Direct Job URL:** {direct_url}
**Discovery Run:** {run_id}

## Job Description

{description}
"""
    return filename, markdown


def parse_args() -> argparse.Namespace:
    script_path = Path(__file__).resolve()
    default_discovery_root = script_path.parents[1]
    default_workspace = default_discovery_root.parent
    parser = argparse.ArgumentParser(
        description="Discover recent LinkedIn jobs with JobSpy and write Job Discovery artifacts."
    )
    parser.add_argument("--discovery-root", type=Path, default=default_discovery_root)
    parser.add_argument("--jobspy-root", type=Path, default=default_workspace / "JobSpy")
    parser.add_argument("--config", type=Path, default=default_discovery_root / "config/jobspy-ego.json")
    parser.add_argument("--run-id", default=datetime.now().strftime("%Y%m%d-%H%M%S"))
    parser.add_argument("--dry-run", action="store_true", help="Print config without calling JobSpy.")
    parser.add_argument("--runtime-check", action="store_true", help="Verify and print the JobSpy Python runtime without scanning.")
    return parser.parse_args()


def ensure_jobspy_python(args: argparse.Namespace) -> None:
    """Re-exec under JobSpy's venv before importing JobSpy dependencies."""
    if args.dry_run:
        return
    jobspy_root = args.jobspy_root.expanduser().resolve()
    venv_root = jobspy_root / ".venv"
    python = venv_root / "bin" / "python"
    if Path(sys.prefix).resolve() == venv_root.resolve():
        return
    if not python.is_file():
        raise RuntimeError(f"JobSpy Python runtime missing: {python}")
    os.execv(str(python), [str(python), str(Path(__file__).resolve()), *sys.argv[1:]])


def main() -> int:
    args = parse_args()
    try:
        ensure_jobspy_python(args)
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    discovery_root = args.discovery_root.expanduser().resolve()
    jobspy_root = args.jobspy_root.expanduser().resolve()
    config_file = args.config.expanduser().resolve()
    if args.runtime_check:
        print(json.dumps({
            "jobspy_root": str(jobspy_root),
            "python": sys.executable,
            "prefix": sys.prefix,
            "venv": str(jobspy_root / ".venv"),
            "ok": Path(sys.prefix).resolve() == (jobspy_root / ".venv").resolve(),
        }, indent=2))
        return 0
    try:
        scan_config = load_scan_config(config_file)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    location = scan_config["location"]
    results_wanted = scan_config["results_wanted"]
    hours_old = scan_config["max_post_age_hours"]
    queries = list(scan_config["queries"])
    run_dir = discovery_root / "runs" / args.run_id / "sources" / "jobspy"
    jobs_dir = run_dir / "jobs"

    config = {
        "discovery_root": str(discovery_root),
        "jobspy_root": str(jobspy_root),
        "config": str(config_file),
        "run_id": args.run_id,
        "location": location,
        "results_wanted": results_wanted,
        "hours_old": hours_old,
        "queries": queries,
        "employer_exclusions": scan_config["employer_exclusions"],
        "output": str(run_dir),
    }
    if args.dry_run:
        print(json.dumps(config, indent=2))
        return 0

    if run_dir.exists():
        prior_status = "UNKNOWN"
        prior_summary = run_dir / "summary.json"
        if prior_summary.exists():
            try:
                prior_status = str(json.loads(prior_summary.read_text()).get("status", "UNKNOWN")).upper()
            except (json.JSONDecodeError, OSError):
                pass
        if prior_status == "SUCCESS":
            print(f"ERROR: successful JobSpy artifacts already exist for run {args.run_id}", file=sys.stderr)
            return 2
        attempts_dir = discovery_root / "runs" / args.run_id / "adapter-attempts"
        attempts_dir.mkdir(parents=True, exist_ok=True)
        archived = attempts_dir / f"jobspy-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}"
        shutil.move(str(run_dir), str(archived))

    jobs_dir.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(jobspy_root))
    try:
        from jobspy import scrape_jobs
    except Exception as exc:
        summary = {
            "schema_version": 1,
            "run_id": args.run_id,
            "adapter": "jobspy",
            "status": "FAILED",
            "raw_rows": 0,
            "unique_jobs": 0,
            "markdown_jobs": len(list(jobs_dir.glob("*.md"))),
            "errors": 1,
            "failure": repr(exc),
        }
        (run_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        (run_dir / "excluded-employers.json").write_text(json.dumps({
            "schema_version": 1, "run_id": args.run_id, "excluded_count": 0, "results": [],
        }, indent=2) + "\n")
        print(f"ERROR: could not import JobSpy from {jobspy_root}: {exc!r}", file=sys.stderr)
        return 2

    seen_urls: set[str] = set()
    excluded_urls: dict[str, dict[str, str]] = {}
    raw_rows = 0
    errors: list[dict[str, str]] = []

    for query in queries:
        print(f"=== LinkedIn query: {query} ===", flush=True)
        try:
            df = scrape_jobs(
                site_name=["linkedin"],
                search_term=query,
                location=location,
                results_wanted=results_wanted,
                hours_old=hours_old,
                linkedin_fetch_description=True,
                description_format="markdown",
            )
            rows = list(df.to_dict("records")) if hasattr(df, "to_dict") else []
            print(f"found {len(rows)}", flush=True)
            raw_rows += len(rows)
            for row in rows:
                url = clean(row.get("job_url") or row.get("job_url_direct") or row.get("url"))
                description = clean(row.get("description"))
                if not url or not description or url in seen_urls or url in excluded_urls:
                    continue
                company = clean(row.get("company"))
                exclusion = match_excluded_employer(company, description, scan_config["employer_exclusions"])
                if exclusion:
                    excluded_urls[url] = {
                        "jobId": linkedin_job_id(url),
                        "company": company,
                        "title": clean(row.get("title")),
                        "query": query,
                        "reason": exclusion["reason"],
                        "matchedSource": exclusion["source"],
                        "evidence": exclusion["evidence"],
                    }
                    continue
                filename, markdown = markdown_for_row(row, query, args.run_id)
                (jobs_dir / filename).write_text(markdown)
                seen_urls.add(url)
        except Exception as exc:
            errors.append(
                {
                    "query": query,
                    "error": repr(exc),
                    "traceback": traceback.format_exc(),
                }
            )
            print(f"ERROR {query}: {exc!r}", flush=True)

    if errors:
        (run_dir / "errors.log").write_text(
            "\n\n".join(
                f"{item['query']}\n{item['error']}\n{item['traceback']}" for item in errors
            )
        )
    (run_dir / "excluded-employers.json").write_text(json.dumps({
        "schema_version": 1,
        "run_id": args.run_id,
        "excluded_count": len(excluded_urls),
        "results": list(excluded_urls.values()),
    }, indent=2) + "\n")

    markdown_jobs = len(list(jobs_dir.glob("*.md")))
    status = "FAILED" if errors else ("SUCCESS" if seen_urls and markdown_jobs else "EMPTY")
    summary = {
        "schema_version": 1,
        "run_id": args.run_id,
        "adapter": "jobspy",
        "status": status,
        "raw_rows": raw_rows,
        "unique_jobs": len(seen_urls),
        "markdown_jobs": markdown_jobs,
        "errors": len(errors),
        "excluded_employers": len(excluded_urls),
    }
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")

    print(f"RUN_DIR={run_dir}", flush=True)
    print(f"RAW_ROWS={raw_rows}", flush=True)
    print(f"UNIQUE_JOBS={len(seen_urls)}", flush=True)
    print(f"MARKDOWN_JOBS={markdown_jobs}", flush=True)
    print(f"ERRORS={len(errors)}", flush=True)
    if status == "EMPTY":
        print("EMPTY_DISCOVERY=1", flush=True)
        return 3
    return 0 if status == "SUCCESS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
