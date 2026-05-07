# Changelog

All notable changes to the Claude Usage Analytics extension will be documented in this file.

## [1.1.11] - 2026-05-06

### Added
- **Opus 4.7 pricing** - Added `claude-opus-4-7` to model pricing table at $5/$25 per MTok (verified against Anthropic pricing docs).
- **Accessibility (WCAG 2.1 AA) improvements** - ARIA tab pattern on dashboard tabs (`role="tablist"`, `role="tab"`, `role="tabpanel"`, `aria-selected`); SVG charts (bar, heatmap, pie) now have `role="img"` with descriptive `aria-label`; chart and data-source toggle buttons expose `aria-label` and `aria-pressed`; personality bars expose `role="progressbar"` with `aria-valuenow/min/max`; achievement badges and footer links have screen-reader-friendly `aria-label`s; section titles expose `role="heading" aria-level="2"`; visible `:focus-visible` outlines on tabs, toggles, and buttons; `prefers-reduced-motion` honoured.

### Fixed
- **Newly-released models invisible in pie chart** - The models breakdown was built only from Claude Code's `stats-cache.json`, which lags new model IDs. The pie chart now supplements with models from today's live JSONL scan, so models like Opus 4.7 appear immediately.
- **Model name version parsing** - `formatModelName()` no longer hardcodes "Opus 4.5" / "Sonnet 4.5"; it now extracts MAJOR.MINOR from the model id (e.g. Opus 4.7, Sonnet 4.6, Sonnet 3.5).
- **Cache savings used Sonnet rate for all models** - The Cache Savings stat now accumulates per-model savings (`input - cacheRead`) instead of a flat Sonnet estimate, so Opus-heavy users see accurate savings.
- **Today's cost showed $0.00 on extension startup** - Dashboard now hydrates `~/.claude/live-today-stats.json` synchronously on activation (when its date matches today) before the 3-second delayed scan fires.
- **Streak broke when stats-cache.json was stale** - `daysWithActivity` is now supplemented from SQLite `model_usage` records and today's live scan, so the streak no longer drops to 0 when Claude Code hasn't refreshed its cache.
- **"Scan failed" on large histories** - `tools/scan-today.js` now stats each JSONL file and skips ones whose mtime isn't today, dropping scan time from ~28s to ~1s on 4,400+ file histories. Scan execFile timeout raised from 30s to 60s as a safety margin.
- **Opus 4.7 fell through to legacy pricing** - `getPricingForModel()` (in `dataProvider.ts` and `database.ts`) now matches `4-7` alongside `4-5`/`4-6` for the new Opus pricing tier.
- **"1 msgs" pluralisation** - Longest Session stat now says "1 msg" / "N msgs".

## [1.1.10] - 2026-05-06

### Fixed
- **Subscription tier shows "N/A" on macOS** ([#7](https://github.com/AnalyticEndeavorsUser/claude-usage-analytics/issues/7)) - Claude Code on macOS stores credentials in the system Keychain (service `Claude Code-credentials`) rather than `~/.claude/.credentials.json`. The extension now reads from the Keychain via the `security` CLI on macOS, falling back to the on-disk file if no Keychain entry exists. The first read may trigger a one-time Keychain access prompt.

## [1.1.9] - 2026-04-09

### Added
- **External additions sidecar framework** - Import usage data from any external AI tool (Copilot CLI, Forge CLI, etc.) via a JSON file at `~/.claude/external-additions.json`. External data merges seamlessly into all dashboard views, streaks, and totals.

### Fixed
- **Incorrect model pricing** - Reverted Haiku 3.5 to correct $0.80/$4.00 (was wrongly changed to $1/$5). Fixed Opus 4.5 from $15/$75 to correct $5/$25. Added missing Opus 4.1 and Sonnet 4.5 model entries.
- **Haiku pricing missing from cost calculations** - Added Haiku tier pricing (4.5, 3.5, 3) to both dataProvider.ts and database.ts. Previously Haiku usage fell through to Sonnet pricing ($3/$15), overcharging by 3x or more.
- **Opus 4.5/4.6 overcharged in historical costs** - Split Opus pricing into new ($5/$25 for 4.5/4.6) vs legacy ($15/$75 for 4.1/4/3). Previously all Opus models were charged at the legacy rate.
- **README claimed open source** - Removed source code references, build-from-source instructions, and Development section. Extension is free forever but source is not distributed.
- **CHANGELOG claimed non-existent weeklyBudget feature** - Corrected to only reference `dailyBudget`
- **Broken BACKFILL_GUIDE.md link** - Replaced with reference to dashboard instructions
- **README version badge** - Updated from 1.1.5 to 1.1.9

## [1.1.8] - 2026-01-10

### Fixed
- **"Scan failed: Command failed" error on Windows** - Fixed critical bug where `process.execPath` returns VS Code's `Code.exe` instead of Node.js in the extension host environment. The scan command now correctly uses `node` from the system PATH. This reverts the problematic v1.1.6 fix that caused the regression.

## [1.1.7] - 2025-01-09

### Changed
- **Footer link updated** - Replaced YouTube link with Donate link (Buy Me a Coffee) in dashboard footer

## [1.1.6] - 2025-01-05

### Fixed
- **"Spawn node ENOENT" error on install** - Fixed error that occurred when users didn't have Node.js in their system PATH. Extension now uses VSCode's bundled Node.js runtime (`process.execPath`) instead of relying on a global `node` command.

## [1.1.5] - 2025-12-30

### Added
- **Context Overhead section** - Tokens tooltip now shows MCP servers, skills count, and tool calls under "Context Overhead" (below Cache Efficiency)
- **3 new visibility settings** - Toggle MCP status, tool calls, and skills count display independently

### Improved
- **Instant settings update** - Toggling any visibility setting now immediately refreshes the status bar (no reload required)
- **Top Language display** - Now shows comma-formatted count with label (e.g., "python - 42,600 blocks")

### Fixed
- **Realistic politeness thresholds** - Adjusted scoring for coding context (5%+ = Polite, 2%+ = Friendly, 1%+ = Neutral, <1% = All Business)
- **Clearer politeness display** - Tooltip now shows descriptive label with percentage (e.g., "Friendly (1.7%)")
- **Backfill script link** - Updated to new GitHub repository URL (analyticendeavors/claude-usage-analytics)

## [1.1.4] - 2025-12-29

### Improved
- **Enhanced Account Total tooltip** - Status bar tooltip now shows both API Total (from stats-cache.json) and Calculated Total (from SQLite + JSONL history), giving visibility into both data sources similar to the main dashboard view

## [1.1.3] - 2025-12-29

### Fixed
- **Yesterday cost showing N/A** - Fixed issue where "Yesterday" cost would incorrectly show N/A even when data existed. Added fallback logic to ensure yesterday's cost is calculated from SQLite or estimated from token data when the primary calculation returns zero.

## [1.1.2] - 2025-12-28

### Added
- **Open Settings command** - New "Claude Analytics: Open Settings" command for quick access to extension settings
- **Live config updates** - Changing refresh interval in settings now takes effect immediately without requiring a reload
- **Disable auto-refresh option** - Set refresh interval to 0 to disable auto-refresh entirely

### Fixed
- **Auto-refresh now scans live stats** - The auto-refresh interval now properly re-scans JSONL files for today's usage, fixing an issue where today's numbers stayed stale until manual refresh

### Changed
- **Refresh interval now in seconds** - Replaced `refreshIntervalMinutes` setting with `refreshIntervalSeconds` for finer control (0=disabled, 10-3600 seconds, default 900 = 15 minutes)

## [1.1.0] - 2025-12-27

### Added
- **SQLite persistence** - Usage history now preserved forever in a local SQLite database, surviving Claude Code's 30-day rolling window
- **Configurable refresh interval** - New `refreshIntervalMinutes` setting (1-60 min, default 15) to control auto-refresh frequency
- **Historical data import** - On first install, automatically imports existing data from stats-cache.json
- **Local history stats** - "Local History" totals now include full data from your local SQLite database, not just the last 30 days
- **7 new achievements** - Token Titan (1M+ tokens), $100 Club, $500 Spender, $1K Whale, Refactor Pro, Refactor King, Weekend Warrior
- **Export to CSV/JSON** - Export your usage data via dashboard button or view title menu
- **Budget tracking** - New `dailyBudget` setting with status bar color coding (green/yellow/red)
- **Cost alerts** - New `costAlertThreshold` setting triggers VS Code notifications when daily cost exceeds threshold
- **Date range filter** - Filter dashboard stats by Last 7 days, Last 30 days, This Month, or All Time
- **Session breakdown** - New section in Messages tab showing recent sessions with project, messages, tokens, and cost
- **Activity heatmap** - GitHub-style contribution calendar on Personality tab showing last 90 days of activity
- **Theme-aware colors** - All UI elements now adapt to light and dark VS Code themes
- **Backfill script** - Python script to import full Claude.ai conversation history from data export
- **Personality analytics** - Request types, sentiment tracking, and celebration moments
- **GitHub Gist sync** - Backup your analytics database to a private Gist for multi-machine sync
- **Status bar visibility settings** - 7 new settings to show/hide individual status bar items (lifetime cost, today cost, messages, tokens, personality, activity, rate limits)

### Changed
- Chart toggle buttons now use emojis (messages, cost, tokens)
- Footer includes Analytic Endeavors branding with logo and links

## [1.0.3] - 2025-12-21

### Added
- **Real-time today's cost** - Now reads directly from conversation JSONL files for accurate current-day statistics
- **Subscription tier display** - Shows Max 20x, Max, Pro, or Free tier instead of rate limit percentages
- **Improved tooltips** - All status bar widgets now show "Click to open [Tab Name]" for clarity

### Changed
- **Fully offline** - Removed all network API calls; extension operates completely locally
- **Fixed credentials reading** - Now correctly reads from `~/.claude/.credentials.json`

### Removed
- **Rate limit monitoring** - Removed Limits section and rate limit progress bars (obsolete after API changes)

## [1.0.0] - 2025-12-20

### Initial Release

First public release as a standalone VS Code extension.

### Features
- **4-Tab Dashboard** - Interactive sidebar with Overview, Cost, Messages, and Personality tabs
- **7 Status Bar Widgets** - Live statistics always visible:
  - Lifetime Cost with trend analysis
  - Today's Cost with comparisons
  - Total Messages with activity patterns
  - Token Count with cache efficiency
  - Personality Score with trait breakdown
  - Activity Stats with coding metrics
  - Subscription Tier display

- **Cost Analytics**
  - Accurate pricing using model-specific rates (Opus vs Sonnet)
  - Daily, weekly, and monthly trends
  - Cost projections and comparisons
  - Cache savings tracking

- **Personality Insights**
  - Politeness, frustration, and curiosity scores
  - Achievement badges for milestones
  - Expression style analysis
  - Mood and sentiment tracking

- **Activity Tracking**
  - Code block and line counts
  - Top languages used
  - Request type distribution (debug, feature, explain, etc.)
  - Peak hours and activity patterns

### Keyboard Shortcuts
- `Ctrl+Alt+C` (`Cmd+Alt+C` on Mac) - Show Analytics Panel
- `Ctrl+Alt+R` (`Cmd+Alt+R` on Mac) - Refresh Data

---

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
