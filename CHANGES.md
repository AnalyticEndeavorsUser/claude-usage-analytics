# Changes from Original

This is a modified fork of [claude-usage-analytics](https://github.com/AnalyticEndeavorsUser/claude-usage-analytics) (v1.1.8) by [Reid Havens / Analytic Endeavors](https://analyticendeavors.com/).

## Modifications

### Model Support (Opus 4.6 / Sonnet 4.6 / Haiku 4.5)

- **Updated `formatModelName()`** in `dataProvider.js` to correctly display "Opus 4.6" and "Sonnet 4.6" for new model IDs (falls back to legacy names for older models)
- **Added model entries** in both `modelPricing.json` files for `claude-opus-4-6` ($5/$25), `claude-sonnet-4-6` ($3/$15), and `claude-haiku-4-5-20251001` ($1/$5)
- **Fixed dot-notation model matching** — Copilot API returns model names like `claude-opus-4.6` (dot) while Claude Code uses `claude-opus-4-6` (hyphen). `getPricingForModel()` and `formatModelName()` now match both formats.

### Pricing Fixes

- **Fixed 1-hour cache write rate** — Claude Code uses 1-hour caching by default, which costs 2.0x the base input price (not 1.25x which is the 5-minute rate). The original code used 1.25x everywhere, underestimating cache write costs by ~37%.
- **Added 5m vs 1h cache write distinction** — `backfill-jsonl.js` and `scan-today.js` now read `cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` from the JSONL usage objects for precise billing.
- **Fixed Haiku 4.5 pricing** — was $0.80/$4.00 per MTok, corrected to $1.00/$5.00 per official Anthropic pricing.
- **Added web search cost tracking** — each web search costs $0.01; now extracted from `server_tool_use.web_search_requests` in usage objects.
- **Fixed `MODEL_PRICING` in `dataProvider.js` and `database.js`** — added Opus 4.6 ($5/$25), Sonnet 4.6, and Haiku pricing tiers with correct cache read/write rates.
- **Fixed `cacheSavings` calculation** — now computes per-model savings using actual pricing instead of hardcoded Sonnet rates.

#### Correct Pricing Table (per 1M tokens)

| Model | Input | Output | Cache Read (0.1x) | Cache Write 5m (1.25x) | Cache Write 1h (2.0x) |
|---|---|---|---|---|---|
| Opus 4.6 | $5 | $25 | $0.50 | $6.25 | $10.00 |
| Sonnet 4.6 | $3 | $15 | $0.30 | $3.75 | $6.00 |
| Haiku 4.5 | $1 | $5 | $0.10 | $1.25 | $2.00 |

### Data Population Fixes

- **Fixed `allTime.cacheTokens`** — was hardcoded to 0 with a "Can't determine" comment; now sums `cacheReadInputTokens` + `cacheCreationInputTokens` from modelUsage
- **Added `live-today-stats.json` auto-load on startup** — the scan-today.js script writes this file, but the extension never read it back; now loads persisted live stats on init if they're from today
- **Added `backfill-results.json` auto-import** — on startup, if a backfill results file exists, automatically imports into SQLite and renames to `.imported`

### New Tool: Conversation Stats Generator

- **Added `tools/generate-conversation-stats.js`** — a Node.js script that scans all JSONL files and generates `~/.claude/conversation-stats-cache.json` with:
  - Personality analysis (politeness, frustration, curiosity scores)
  - Request type classification (debugging, features, explain, refactor, review, testing)
  - Sentiment analysis (positive, negative, urgent, confused)
  - Code statistics (code blocks, lines of code, top languages)
  - Expression tracking (questions, exclamations, thanks, celebrations, etc.)
  - Hour-of-day activity counts for peak hour / night owl / early bird scores

  The original extension only populated these fields via the Python backfill script (`backfill_claude_export.py`) which requires a Claude.ai data export. This new script extracts the same data directly from Claude Code's local JSONL files.

### Streak & Forge CLI Integration

- **Fixed streak calculation** — live stats (from JSONL scan) now correctly add today to `daysWithActivity`, and today is added to `dailyHistory` if missing. Previously the streak could show 0 even when actively using Claude Code today.
- **Added Forge CLI support** — new `tools/extract-forge-dates.py` reads Forge's SQLite DB (`~/forge/.forge.db`) and exports active dates to `~/.claude/forge-active-dates.json`. The extension merges these into `daysWithActivity` so days where only Forge was used still count toward the streak.

### Bug Fixes

- **Fixed scan-today.js node path** — `extension.js` used bare `'node'` which isn't available in VS Code's remote extension host PATH. Now resolves the `node` binary from the same directory as `process.execPath`.
- **Fixed broken emoji** — replaced `🪙` (Unicode 13.0 coin emoji, often broken on Linux servers) with `🔢` (widely supported) in status bar tooltips and dashboard toggle button.
- **Increased scan timeout** — from 30s to 120s. Large repos with 3000+ JSONL files can take 20+ seconds to scan, causing timeouts under VS Code load.
- **Fixed model breakdown display** — the model pie chart was built only from `stats-cache.json` (which can be stale), missing models like Sonnet entirely. Now builds from SQLite when it has more complete data. Display limit bumped from 5 to 10 models.

### Copilot/Forge CLI Integration (from PR #1)

- **Added `copilot_additions` and `copilot_model_additions` DB tables** — tracks usage from Copilot CLI and other external tools separately, surviving `saveDatabase()` overwrites via a sidecar JSON pattern.
- **Added `tools/backfill_copilot_sessions.py`** — reads `~/.copilot/session-state/*/events.jsonl`, aggregates by date, writes to DB tables and sidecar JSON. Idempotent via session directory fingerprints.
- **SQL UNION merges** — `getAllDailySnapshots`, `getTotalStats`, and `getAllModelUsage` queries now merge copilot_additions data automatically.

### Copilot Backfill Improvements (from PR #2)

- **Dual cost modes** (`--cost-mode` flag):
  - `api-equivalent` (default) — what the same token usage would cost via direct Anthropic API calls
  - `actual` — Copilot Business pricing ($19/month + $0.04/request overage above 300/month), distributed proportionally across active days
- **User message counting** — switched from shutdown-event-only to `user.message` event counting, covering all sessions (not just those with a clean shutdown)
- **Token extrapolation** — for sessions without shutdown events (no full token data), input/cache tokens are estimated using observed 164:1 input/output and 155:1 cache-read/output ratios from complete sessions
- **`--reset` flag** — clears and re-imports from scratch
- **Model name normalization** — normalizes dot notation (`claude-opus-4.6`) to hyphen (`claude-opus-4-6`) in sidecar output for consistent pricing matching
