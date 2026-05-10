#!/usr/bin/env python3
"""
aggregate.py — Upptime-format aggregator for molecule-ai-status.

Reads probe results from history/<slug>.jsonl files, computes rolling
uptime and response-time aggregates, and writes:

  history/<slug>.yml      — latest probe result (Upptime status-file format)
  history/summary.json   — per-site aggregates for day/week/month/year

Run after each probe run, before the git commit step.

Usage:
    python3 scripts/aggregate.py [--history-dir history]
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path


def parse_ts(ts: str) -> datetime:
    """Parse ISO-8601 timestamp with Z suffix."""
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def compute_uptime_pct(results: list[dict], since: datetime) -> tuple[float, int]:
    """
    Return (uptime_percent, minutes_down) for results since `since`.

    A 5-minute interval is "down" if the result at or after that minute
    had success=False.  minutes_down is the count of such 5-min slots.
    """
    now = datetime.now(timezone.utc)
    if not results:
        return 100.0, 0

    # Bucket results into 5-minute slots
    slots: dict[int, bool] = {}  # slot_minute -> any_success
    for r in results:
        if parse_ts(r["timestamp"]) < since:
            continue
        slot = int(parse_ts(r["timestamp"]).timestamp() // 300) * 300
        # If any probe in this slot succeeded, the slot is up
        if slots.get(slot, r["success"]):
            slots[slot] = r["success"]

    if not slots:
        return 100.0, 0

    total_slots = len(slots)
    up_slots = sum(1 for v in slots.values() if v)
    uptime_pct = (up_slots / total_slots) * 100
    minutes_down = total_slots - up_slots
    return round(uptime_pct, 2), minutes_down


def avg_response_time(results: list[dict], since: datetime) -> float | None:
    """Return average latency_ms for results since `since`."""
    latencies = [
        r["latency_ms"]
        for r in results
        if parse_ts(r["timestamp"]) >= since and r.get("latency_ms") is not None
    ]
    return round(sum(latencies) / len(latencies), 0) if latencies else None


def slug_from_name(name: str) -> str:
    """Derive slug from site name (matches Upptime convention)."""
    return name.lower().replace(" — ", "-").replace(" ", "-").replace(".", "")


def get_sites(upptimerc: Path) -> list[dict]:
    """Parse .upptimerc.yml to get site list (name, url)."""
    try:
        import yaml
    except ImportError:
        pass  # Fall back to simple parser below

    content = upptimerc.read_text()

    # Try yaml import first
    try:
        import yaml as _yaml
        data = _yaml.safe_load(content)
        raw_sites = data.get("sites", []) if data else []
        return [{"name": s["name"], "url": s["url"]} for s in raw_sites if s.get("name")]
    except Exception:
        pass

    # Fallback: simple line-based parser for indented - name: / url: pairs
    sites = []
    in_sites = False
    current = {}
    for line in content.splitlines():
        stripped = line.strip()
        indent = len(line) - len(stripped)
        if stripped == "sites:":
            in_sites = True
            continue
        if not in_sites:
            continue
        # Dedent back to top-level ends sites block
        if indent == 0 and stripped and not stripped.startswith("-"):
            break
        if stripped.startswith("- name:"):
            if current.get("name"):
                sites.append(current)
            current = {"name": stripped.split("name:", 1)[1].strip().lstrip("- ")}
        elif stripped.startswith("url:"):
            current["url"] = stripped.split("url:", 1)[1].strip()
    if current.get("name"):
        sites.append(current)
    return sites


def write_yml(slug: str, latest: dict | None, first_ts: str | None) -> str:
    """Write history/<slug>.yml in Upptime format."""
    if latest is None:
        # No probe results — leave as-is or write a placeholder
        return ""
    status = "up" if latest["success"] else "down"
    code = latest["status_code"]
    response_time = latest["latency_ms"]
    last_updated = latest["timestamp"]
    start_time = first_ts or last_updated
    yml = f"""\
url: {latest["url"]}
status: {status}
code: {code}
responseTime: {response_time}
lastUpdated: {last_updated}
startTime: {start_time}
generator: Upptime <https://github.com/upptime/upptime>
"""
    return yml


def write_summary_site_entry(name: str, url: str, slug: str,
                             results: list[dict],
                             start_time: datetime) -> dict:
    """Build a summary.json entry for one site."""
    now = datetime.now(timezone.utc)
    day_start = now - timedelta(days=1)
    week_start = now - timedelta(weeks=1)
    month_start = now - timedelta(days=30)
    year_start = now - timedelta(days=365)

    uptime, uptime_day, uptime_week, uptime_month, uptime_year = None, None, None, None, None
    rt, rt_day, rt_week, rt_month, rt_year = None, None, None, None, None

    # All-time
    uptime, _ = compute_uptime_pct(results, start_time)
    rt = avg_response_time(results, start_time)

    # Day
    uptime_day, _ = compute_uptime_pct(results, day_start)
    rt_day = avg_response_time(results, day_start)

    # Week
    uptime_week, _ = compute_uptime_pct(results, week_start)
    rt_week = avg_response_time(results, week_start)

    # Month
    uptime_month, _ = compute_uptime_pct(results, month_start)
    rt_month = avg_response_time(results, month_start)

    # Year
    uptime_year, _ = compute_uptime_pct(results, year_start)
    rt_year = avg_response_time(results, year_start)

    latest = results[-1] if results else {}
    status = "up" if latest.get("success", True) else "down"

    def fmt(val):
        if val is None:
            return None
        return f"{val:.2f}%" if isinstance(val, float) else val

    return {
        "name": name,
        "url": url,
        "slug": slug,
        "status": status,
        "uptime": fmt(uptime),
        "uptimeDay": fmt(uptime_day),
        "uptimeWeek": fmt(uptime_week),
        "uptimeMonth": fmt(uptime_month),
        "uptimeYear": fmt(uptime_year),
        "time": rt,
        "timeDay": rt_day,
        "timeWeek": rt_week,
        "timeMonth": rt_month,
        "timeYear": rt_year,
        "dailyMinutesDown": {},
    }


def main():
    parser = argparse.ArgumentParser(description="Aggregate upptime probe results")
    parser.add_argument("--history-dir", default="history", help="Path to history directory")
    args = parser.parse_args()

    history_dir = Path(args.history_dir)
    upptimerc = Path(".upptimerc.yml")

    if not history_dir.exists():
        print(f"No history directory: {history_dir}")
        sys.exit(1)

    sites = get_sites(upptimerc)
    print(f"Aggregating {len(sites)} sites from {history_dir}/")

    summary_entries = []
    written_ymls = 0

    for site in sites:
        name = site["name"]
        url = site["url"]
        slug = slug_from_name(name)
        jsonl_path = history_dir / f"{slug}.jsonl"

        results = []
        if jsonl_path.exists():
            for line in jsonl_path.read_text().strip().splitlines():
                if line.strip():
                    try:
                        results.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass

        # Sort by timestamp
        results.sort(key=lambda r: r.get("timestamp", ""))
        latest = results[-1] if results else None
        first_ts = results[0].get("timestamp") if results else None
        start_time = parse_ts(first_ts) if first_ts else datetime.now(timezone.utc)

        # Write .yml
        yml_content = write_yml(slug, latest, first_ts)
        if yml_content:
            yml_path = history_dir / f"{slug}.yml"
            yml_path.write_text(yml_content)
            written_ymls += 1
            status = "up" if latest.get("success") else "down"
            print(f"  {slug}: {status} ({len(results)} results, latest {latest.get('status_code') if latest else 'N/A'})")
        else:
            print(f"  {slug}: no results (skipped)")

        # Build summary entry
        entry = write_summary_site_entry(name, url, slug, results, start_time)
        summary_entries.append(entry)

    # Write summary.json
    summary_path = history_dir / "summary.json"
    summary_path.write_text(json.dumps(summary_entries, indent=2))
    print(f"\nWrote {written_ymls} .yml files + summary.json ({len(summary_entries)} entries)")


if __name__ == "__main__":
    main()
