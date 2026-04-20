#!/usr/bin/env python3
"""
Extracts active dates from Forge CLI's SQLite database.
Outputs a JSON file that the extension can read for streak calculation.
"""

import sqlite3
import json
import os
from collections import defaultdict

FORGE_DB = os.path.expanduser("~/forge/.forge.db")
OUTPUT = os.path.expanduser("~/.claude/forge-active-dates.json")

def main():
    if not os.path.exists(FORGE_DB):
        print("Forge DB not found at", FORGE_DB)
        return

    conn = sqlite3.connect(FORGE_DB)
    cursor = conn.cursor()

    cursor.execute("SELECT created_at, updated_at FROM conversations ORDER BY created_at")

    daily = defaultdict(int)
    for row in cursor.fetchall():
        created, updated = row
        if created:
            date = created[:10]
            daily[date] += 1
        if updated:
            date = updated[:10]
            daily[date] += 1

    conn.close()

    dates = sorted(daily.keys())
    output = {
        "source": "forge",
        "dbPath": FORGE_DB,
        "activeDates": dates,
        "dailyCounts": dict(sorted(daily.items())),
        "generatedAt": __import__('datetime').datetime.now().isoformat()
    }

    with open(OUTPUT, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"Extracted {len(dates)} active dates from Forge DB")
    print(f"Dates: {', '.join(dates)}")
    print(f"Output: {OUTPUT}")

if __name__ == "__main__":
    main()
