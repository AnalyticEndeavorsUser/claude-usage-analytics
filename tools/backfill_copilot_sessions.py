#!/usr/bin/env python3
"""
Backfill Copilot session data into claude-usage-analytics database.

Reads ~/.copilot/session-state/*/events.jsonl and imports per-day
interaction counts, token metrics, and cost into ~/.claude/analytics.db.

Two cost modes (--cost-mode):

  actual
      Copilot Business: $19/month flat + $0.04/request overage above 300/month.
      Monthly cost is distributed proportionally across active days.
      Reflects what you actually paid GitHub.

  api-equivalent (default)
      What the same token usage would have cost via direct Anthropic API calls.
      Uses real per-token Anthropic pricing for each model.
      Input tokens are available only for sessions with a shutdown event.
      For sessions without shutdown, input tokens are extrapolated using the
      164:1 input/output ratio and 155:1 cache-read/output ratio observed in
      the complete sessions.

NOTE: VS Code Copilot Chat panel usage is not logged to session-state
and is excluded from both modes.
"""

import argparse
import datetime
import glob
import json
import os
import shutil
import sqlite3
import sys
from collections import defaultdict

# ---------------------------------------------------------------------------
# Copilot Business plan constants (actual mode)
# ---------------------------------------------------------------------------
SUBSCRIPTION_COST = 19.00
INCLUDED_REQUESTS_PER_MONTH = 300
OVERAGE_RATE = 0.04  # USD per premium request (overage only)

MODEL_MULTIPLIERS = {
    "claude-opus-4.6": 3.0,
    "claude-opus-4.5": 3.0,
    "claude-opus-4": 3.0,
    "claude-opus": 3.0,
    "claude-sonnet-4.6": 1.0,
    "claude-sonnet-4.5": 1.0,
    "claude-sonnet-4": 1.0,
    "claude-sonnet": 1.0,
    "claude-haiku-4.5": 0.33,
    "claude-haiku-4": 0.33,
    "claude-haiku": 0.33,
    "_default": 1.0,
}

# ---------------------------------------------------------------------------
# Anthropic API pricing per 1M tokens (api-equivalent mode)
# Source: anthropic.com/pricing — April 2026
# ---------------------------------------------------------------------------
MODEL_API_PRICING = {
    # cache_write = 2.0x input (1-hour cache, Claude Code / Copilot default)
    "claude-opus-4.6": {"input": 5.00, "output": 25.00, "cache_read": 0.50, "cache_write": 10.00},
    "claude-opus-4.5": {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_write": 30.00},
    "claude-opus-4": {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_write": 30.00},
    "claude-opus": {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_write": 30.00},
    "claude-sonnet-4.6": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 6.00},
    "claude-sonnet-4.5": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 6.00},
    "claude-sonnet-4": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 6.00},
    "claude-sonnet": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 6.00},
    "claude-haiku-4.5": {"input": 1.00, "output": 5.00, "cache_read": 0.10, "cache_write": 2.00},
    "claude-haiku-4": {"input": 1.00, "output": 5.00, "cache_read": 0.10, "cache_write": 2.00},
    "claude-haiku": {"input": 1.00, "output": 5.00, "cache_read": 0.10, "cache_write": 2.00},
    "_default": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 6.00},
}

# Ratios derived from sessions that have full token data via shutdown events.
# Used to extrapolate input/cache tokens for sessions that only have output tokens.
INPUT_TO_OUTPUT_RATIO = 164.6
CACHE_READ_TO_OUTPUT_RATIO = 155.5


def get_multiplier(model: str) -> float:
    name = model.lower()
    if name in MODEL_MULTIPLIERS:
        return MODEL_MULTIPLIERS[name]
    for key in MODEL_MULTIPLIERS:
        if key != "_default" and name.startswith(key):
            return MODEL_MULTIPLIERS[key]
    return MODEL_MULTIPLIERS["_default"]


def get_api_pricing(model: str) -> dict:
    name = model.lower()
    if name in MODEL_API_PRICING:
        return MODEL_API_PRICING[name]
    for key in MODEL_API_PRICING:
        if key != "_default" and name.startswith(key):
            return MODEL_API_PRICING[key]
    return MODEL_API_PRICING["_default"]


def calc_api_cost(model: str, input_t: float, output_t: float, cache_read_t: float, cache_write_t: float) -> float:
    p = get_api_pricing(model)
    return (
        input_t * p["input"] / 1_000_000
        + output_t * p["output"] / 1_000_000
        + cache_read_t * p["cache_read"] / 1_000_000
        + cache_write_t * p["cache_write"] / 1_000_000
    )


def parse_ts(ts_raw: str) -> datetime.datetime | None:
    if not ts_raw:
        return None
    try:
        return datetime.datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Session loading
# ---------------------------------------------------------------------------


def load_all_sessions(session_dir: str) -> list[dict]:
    """
    Parse every session directory.

    Returns a list of session dicts with:
      session_id, date, month,
      interactions_by_model {model: count},
      output_tokens           — from assistant.message (all sessions)
      input_tokens            — from session.shutdown   (complete sessions only)
      cache_read_tokens       — from session.shutdown   (complete sessions only)
      cache_write_tokens      — from session.shutdown   (complete sessions only)
      has_full_token_data     — True when shutdown event was present
      model_metrics           — per-model token breakdown (shutdown sessions only)
    """
    sessions = []
    pattern = os.path.join(session_dir, "*/events.jsonl")

    for f in sorted(glob.glob(pattern)):
        session_id = os.path.basename(os.path.dirname(f))
        try:
            with open(f) as fh:
                events = []
                for raw in fh:
                    raw = raw.strip()
                    if raw:
                        try:
                            events.append(json.loads(raw))
                        except json.JSONDecodeError:
                            pass
        except OSError:
            continue

        if not events:
            continue

        start_event = next((e for e in events if e.get("type") == "session.start"), None)
        if not start_event:
            continue

        dt = parse_ts(start_event.get("timestamp", ""))
        if not dt:
            continue

        date_str = dt.strftime("%Y-%m-%d")
        month_str = dt.strftime("%Y-%m")

        start_data = start_event.get("data", {})
        current_model = start_data.get("selectedModel") or "claude-opus-4.6"

        interactions_by_model: dict[str, int] = {}
        output_tokens = 0

        for event in events:
            etype = event.get("type", "")

            if etype == "session.info":
                data = event.get("data", {})
                if data.get("infoType") == "model":
                    msg = data.get("message", "")
                    if "Model changed to:" in msg:
                        part = msg.split("Model changed to:")[-1].strip().split()[0]
                        current_model = part

            elif etype == "session.model_change":
                new_model = event.get("data", {}).get("model")
                if new_model:
                    current_model = new_model

            elif etype == "user.message":
                key = current_model or "claude-opus-4.6"
                interactions_by_model[key] = interactions_by_model.get(key, 0) + 1

            elif etype == "assistant.message":
                output_tokens += event.get("data", {}).get("outputTokens", 0)

        if not interactions_by_model:
            continue

        # Full token data from shutdown event when present
        model_metrics: dict[str, dict] = {}
        input_tokens = 0
        cache_read_tokens = 0
        cache_write_tokens = 0
        has_full_token_data = False

        shutdown = next((e for e in events if e.get("type") == "session.shutdown"), None)
        if shutdown:
            has_full_token_data = True
            for model, mdata in shutdown.get("data", {}).get("modelMetrics", {}).items():
                usage = mdata.get("usage", {})
                model_metrics[model] = {
                    "input_tokens": usage.get("inputTokens", 0),
                    "output_tokens": usage.get("outputTokens", 0),
                    "cache_read_tokens": usage.get("cacheReadTokens", 0),
                    "cache_write_tokens": usage.get("cacheWriteTokens", 0),
                }
                input_tokens += usage.get("inputTokens", 0)
                cache_read_tokens += usage.get("cacheReadTokens", 0)
                cache_write_tokens += usage.get("cacheWriteTokens", 0)

        sessions.append(
            {
                "session_id": session_id,
                "date": date_str,
                "month": month_str,
                "interactions_by_model": interactions_by_model,
                "output_tokens": output_tokens,
                "input_tokens": input_tokens,
                "cache_read_tokens": cache_read_tokens,
                "cache_write_tokens": cache_write_tokens,
                "has_full_token_data": has_full_token_data,
                "model_metrics": model_metrics,
            }
        )

    return sessions


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def aggregate_by_date(sessions: list[dict], cost_mode: str) -> dict:
    """
    Group sessions by date and compute cost according to cost_mode.

    cost_mode == "actual":
        Copilot Business subscription + overage, distributed by PR share.

    cost_mode == "api-equivalent":
        Anthropic API token pricing. For sessions without full token data,
        input and cache-read tokens are extrapolated from output tokens using
        the ratios derived from complete sessions.
    """
    by_date: dict[str, dict] = {}
    monthly_pr: dict[str, float] = defaultdict(float)

    for s in sessions:
        date = s["date"]
        month = s["month"]

        if date not in by_date:
            by_date[date] = {
                "month": month,
                "sessions": 0,
                "interactions": 0,
                "pr_equiv": 0.0,
                "cost": 0.0,
                "tokens": 0,
                "models": {},
            }

        day = by_date[date]
        day["sessions"] += 1

        # Token totals for the "tokens" column (used by extension charts)
        if s["has_full_token_data"]:
            day["tokens"] += s["input_tokens"] + s["output_tokens"] + s["cache_read_tokens"] + s["cache_write_tokens"]
        else:
            # Extrapolate from output tokens using observed ratios
            est_input = s["output_tokens"] * INPUT_TO_OUTPUT_RATIO
            est_cache_read = s["output_tokens"] * CACHE_READ_TO_OUTPUT_RATIO
            day["tokens"] += int(est_input + s["output_tokens"] + est_cache_read)

        for model, count in s["interactions_by_model"].items():
            mult = get_multiplier(model)
            pr = count * mult
            day["interactions"] += count
            day["pr_equiv"] += pr
            monthly_pr[month] += pr

            if model not in day["models"]:
                day["models"][model] = {
                    "interactions": 0,
                    "pr_equiv": 0.0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                }
            m = day["models"][model]
            m["interactions"] += count
            m["pr_equiv"] += pr

            if model in s["model_metrics"]:
                mt = s["model_metrics"][model]
                m["input_tokens"] += mt["input_tokens"]
                m["output_tokens"] += mt["output_tokens"]
                m["cache_read_tokens"] += mt["cache_read_tokens"]
                m["cache_write_tokens"] += mt["cache_write_tokens"]
            else:
                # Extrapolate per-model tokens proportionally from output tokens
                session_output = s["output_tokens"]
                if session_output > 0:
                    model_share = count / sum(s["interactions_by_model"].values())
                    model_output = session_output * model_share
                    m["output_tokens"] += int(model_output)
                    m["input_tokens"] += int(model_output * INPUT_TO_OUTPUT_RATIO)
                    m["cache_read_tokens"] += int(model_output * CACHE_READ_TO_OUTPUT_RATIO)

    # Second pass: compute cost per day
    if cost_mode == "actual":
        for date, day in by_date.items():
            month = day["month"]
            total_pr = monthly_pr[month]
            overage = max(0.0, total_pr - INCLUDED_REQUESTS_PER_MONTH)
            monthly_cost = SUBSCRIPTION_COST + overage * OVERAGE_RATE
            day["cost"] = monthly_cost * (day["pr_equiv"] / total_pr) if total_pr > 0 else 0.0
    else:  # api-equivalent
        for date, day in by_date.items():
            day_cost = 0.0
            for model, m in day["models"].items():
                day_cost += calc_api_cost(
                    model,
                    m["input_tokens"],
                    m["output_tokens"],
                    m["cache_read_tokens"],
                    m["cache_write_tokens"],
                )
            day["cost"] = day_cost

    return by_date


# ---------------------------------------------------------------------------
# Metadata helpers
# ---------------------------------------------------------------------------


def get_imported_session_ids(conn: sqlite3.Connection) -> set:
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM metadata WHERE key = 'copilot_imported_sessions'")
    row = cursor.fetchone()
    if not row or not row[0]:
        return set()
    return set(json.loads(row[0]))


def save_imported_session_ids(conn: sqlite3.Connection, ids: set) -> None:
    conn.cursor().execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('copilot_imported_sessions', ?)",
        (json.dumps(sorted(ids)),),
    )


# ---------------------------------------------------------------------------
# DB import
# ---------------------------------------------------------------------------


def import_to_db(
    db_path: str,
    by_date: dict,
    sessions: list[dict],
    cost_mode: str,
    dry_run: bool = False,
    reset: bool = False,
) -> dict:
    """
    Write session fingerprints to analytics.db (metadata table only) and
    write the full copilot data to the sidecar JSON file.

    The extension loads copilot_additions / copilot_model_additions from the
    sidecar at initDatabase() via INSERT OR REPLACE. Writing those rows to the
    on-disk SQLite file as well would cause them to be loaded twice (once from
    disk at startup, once from the sidecar), tripling the values after the
    next saveDatabase() cycle. The metadata table is safe to persist on disk
    because the extension never reads it for display totals.
    """
    stats = {"inserted": 0, "merged": 0, "skipped": 0, "dates": []}

    if dry_run:
        print("\n[DRY RUN — no changes written]")
        for date in sorted(by_date.keys()):
            d = by_date[date]
            print(
                f"  {date}: sessions={d['sessions']}, interactions={d['interactions']}, "
                f"cost=${d['cost']:.4f}, tokens={d['tokens']:,}"
            )
        return stats

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # Ensure schema exists (extension may not have run yet on a fresh install)
    cursor.executescript("""
        CREATE TABLE IF NOT EXISTS copilot_additions (
            date     TEXT PRIMARY KEY,
            cost     REAL    DEFAULT 0,
            messages INTEGER DEFAULT 0,
            tokens   INTEGER DEFAULT 0,
            sessions INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS copilot_model_additions (
            date               TEXT NOT NULL,
            model              TEXT NOT NULL,
            input_tokens       INTEGER DEFAULT 0,
            output_tokens      INTEGER DEFAULT 0,
            cache_read_tokens  INTEGER DEFAULT 0,
            cache_write_tokens INTEGER DEFAULT 0,
            PRIMARY KEY (date, model)
        );
    """)

    if reset:
        # Clear on-disk copilot rows and fingerprints so everything is re-imported
        cursor.execute("DELETE FROM copilot_additions")
        cursor.execute("DELETE FROM copilot_model_additions")
        cursor.execute("DELETE FROM metadata WHERE key = 'copilot_imported_sessions'")
        conn.commit()
        print("  Reset: cleared copilot_additions, copilot_model_additions, session fingerprints.")

    # Always ensure on-disk copilot tables are empty — the sidecar is the source of truth
    cursor.execute("DELETE FROM copilot_additions")
    cursor.execute("DELETE FROM copilot_model_additions")

    imported = get_imported_session_ids(conn)
    new_session_ids: set[str] = set()

    for s in sessions:
        sid = s["session_id"]
        if sid in imported:
            stats["skipped"] += 1
        else:
            new_session_ids.add(sid)
            stats["inserted"] += 1
            stats["dates"].append(s["date"])

    # Record fingerprints so future incremental runs skip already-seen sessions
    save_imported_session_ids(conn, imported | new_session_ids)
    conn.commit()
    conn.close()

    # Build sidecar JSON from the full by_date aggregation (all sessions)
    # This is what the extension loads at initDatabase() via INSERT OR REPLACE.
    sidecar_path = os.path.join(os.path.dirname(db_path), "copilot-additions.json")
    rows = []
    model_rows = []
    for date in sorted(by_date.keys()):
        d = by_date[date]
        rows.append(
            {
                "date": date,
                "cost": d["cost"],
                "messages": d["interactions"],
                "tokens": d["tokens"],
                "sessions": d["sessions"],
            }
        )
        for model, m in d["models"].items():
            # Normalize dots to hyphens so the extension's pricing check (e.g. '4-6')
            # matches correctly. Without this, 'claude-opus-4.6' falls through to the
            # generic $15/1M Opus tier instead of the $5/1M discounted rate.
            normalized_model = model.replace(".", "-")
            model_rows.append(
                {
                    "date": date,
                    "model": normalized_model,
                    "input_tokens": m["input_tokens"],
                    "output_tokens": m["output_tokens"],
                    "cache_read_tokens": m["cache_read_tokens"],
                    "cache_write_tokens": m["cache_write_tokens"],
                }
            )

    with open(sidecar_path, "w") as f:
        json.dump({"rows": rows, "modelRows": model_rows}, f)

    # Deduplicate dates for summary (sessions list may repeat dates)
    stats["dates"] = sorted(set(stats["dates"]))
    return stats


# ---------------------------------------------------------------------------
# Summary printer
# ---------------------------------------------------------------------------


def print_summary(by_date: dict, import_stats: dict, cost_mode: str) -> None:
    total_sessions = sum(d["sessions"] for d in by_date.values())
    total_interactions = sum(d["interactions"] for d in by_date.values())
    total_cost = sum(d["cost"] for d in by_date.values())
    total_tokens = sum(d["tokens"] for d in by_date.values())
    total_pr = sum(d["pr_equiv"] for d in by_date.values())

    model_totals: dict[str, dict] = {}
    for d in by_date.values():
        for model, m in d["models"].items():
            if model not in model_totals:
                model_totals[model] = {
                    "interactions": 0,
                    "pr_equiv": 0.0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_read_tokens": 0,
                }
            model_totals[model]["interactions"] += m["interactions"]
            model_totals[model]["pr_equiv"] += m["pr_equiv"]
            model_totals[model]["input_tokens"] += m["input_tokens"]
            model_totals[model]["output_tokens"] += m["output_tokens"]
            model_totals[model]["cache_read_tokens"] += m["cache_read_tokens"]

    monthly: dict[str, dict] = defaultdict(lambda: {"pr_equiv": 0.0, "cost": 0.0})
    for d in by_date.values():
        monthly[d["month"]]["pr_equiv"] += d["pr_equiv"]
        monthly[d["month"]]["cost"] += d["cost"]

    print("\n" + "=" * 68)
    print("COPILOT BACKFILL SUMMARY")
    print("=" * 68)

    if cost_mode == "actual":
        print(
            f"  Cost mode: actual  "
            f"(Copilot Business ${SUBSCRIPTION_COST:.2f}/month, "
            f"{INCLUDED_REQUESTS_PER_MONTH} incl. req/month, "
            f"${OVERAGE_RATE:.2f}/req overage)"
        )
    else:
        print("  Cost mode: api-equivalent  (Anthropic API token pricing)")
        print(f"  Input tokens extrapolated at {INPUT_TO_OUTPUT_RATIO:.0f}× output for sessions")
        print("  without shutdown events.")

    print()
    print(f"  Sessions processed:          {total_sessions:,}")
    print(f"  Active days:                 {len(by_date)}")
    print(f"  Total user interactions:     {total_interactions:,}")
    print(f"  Total premium req equiv:     {total_pr:.0f}")
    print(f"  Total tokens:                {total_tokens:,}")
    print(f"  Total cost:                  ${total_cost:,.2f}")
    print()

    print("  Monthly breakdown:")
    for month in sorted(monthly):
        pr = monthly[month]["pr_equiv"]
        cost = monthly[month]["cost"]
        if cost_mode == "actual":
            overage = max(0.0, pr - INCLUDED_REQUESTS_PER_MONTH)
            print(
                f"    {month}: {pr:.0f} premium req equiv  "
                f"(incl={min(pr, INCLUDED_REQUESTS_PER_MONTH):.0f}, "
                f"overage={overage:.0f})  → ${cost:.2f}"
            )
        else:
            print(f"    {month}: ${cost:,.2f}")
    print()

    print("  Per-model breakdown:")
    for model in sorted(model_totals.keys()):
        m = model_totals[model]
        mult = get_multiplier(model)
        if cost_mode == "actual":
            print(f"    {model} (×{mult}):  {m['interactions']:,} interactions = {m['pr_equiv']:.0f} premium reqs")
        else:
            cost = calc_api_cost(model, m["input_tokens"], m["output_tokens"], m["cache_read_tokens"], 0)
            print(
                f"    {model}:  "
                f"{m['interactions']:,} interactions  "
                f"in={m['input_tokens']:,}  out={m['output_tokens']:,}  "
                f"→ ${cost:,.2f}"
            )

    if import_stats["dates"]:
        print()
        print("  Database changes:")
        print(f"    Inserted (new dates): {import_stats['inserted']}")
        print(f"    Merged (updated):     {import_stats['merged']}")

    print()
    print("  NOTE: VS Code Copilot Chat panel usage is not captured in")
    print("  session-state logs and is excluded from these figures.")
    print("=" * 68)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill Copilot session data into claude-usage-analytics database.")
    parser.add_argument(
        "--session-dir",
        default=os.path.expanduser("~/.copilot/session-state"),
        help="Copilot session-state directory (default: ~/.copilot/session-state)",
    )
    parser.add_argument(
        "--db",
        default=os.path.expanduser("~/.claude/analytics.db"),
        help="Path to analytics.db (default: ~/.claude/analytics.db)",
    )
    parser.add_argument(
        "--cost-mode",
        choices=["actual", "api-equivalent"],
        default="api-equivalent",
        help=(
            "actual: Copilot Business subscription + overage pricing. "
            "api-equivalent: what the same tokens would cost via Anthropic API directly. "
            "(default: api-equivalent)"
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and summarise without writing to database",
    )
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Skip database backup (not recommended)",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Clear existing copilot rows and re-import everything from scratch",
    )
    args = parser.parse_args()

    if not os.path.isdir(args.session_dir):
        print(f"Error: session-state directory not found: {args.session_dir}", file=sys.stderr)
        sys.exit(1)

    if not args.dry_run and not os.path.exists(args.db):
        print(f"Error: analytics.db not found at {args.db}", file=sys.stderr)
        print("Open VS Code with the Claude Usage Analytics extension to create it first.")
        sys.exit(1)

    print("Copilot Backfill Tool")
    print("=" * 68)
    print(f"Session dir: {args.session_dir}")
    print(f"Database:    {args.db}")
    print(f"Cost mode:   {args.cost_mode}")

    print("\nLoading Copilot sessions...", end=" ", flush=True)
    sessions = load_all_sessions(args.session_dir)
    print(f"{len(sessions)} sessions found")

    if not sessions:
        print("No sessions with interaction data found. Nothing to import.")
        sys.exit(0)

    by_date = aggregate_by_date(sessions, args.cost_mode)
    print(f"Spanning {len(by_date)} unique days")

    if not args.dry_run and not args.no_backup:
        backup_path = args.db + ".copilot-backup"
        shutil.copy2(args.db, backup_path)
        print(f"Backup created: {backup_path}")

    import_stats = import_to_db(
        args.db,
        by_date,
        sessions,
        cost_mode=args.cost_mode,
        dry_run=args.dry_run,
        reset=args.reset,
    )

    print_summary(by_date, import_stats, args.cost_mode)

    if not args.dry_run:
        print("\nDone! Refresh the Claude Usage Analytics extension to see updated stats.")
        print("Keyboard shortcut: Ctrl+Alt+R (or Cmd+Alt+R on macOS)")


if __name__ == "__main__":
    main()
