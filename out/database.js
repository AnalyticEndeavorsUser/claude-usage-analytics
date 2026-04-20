"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMachineId = getMachineId;
exports.initDatabase = initDatabase;
exports.getDbMetadata = getDbMetadata;
exports.setDbMetadata = setDbMetadata;
exports.saveDatabase = saveDatabase;
exports.closeDatabase = closeDatabase;
exports.loadExternalAdditions = loadExternalAdditions;
exports.saveDailySnapshot = saveDailySnapshot;
exports.saveModelUsage = saveModelUsage;
exports.getAllDailySnapshots = getAllDailySnapshots;
exports.getModelUsageForDate = getModelUsageForDate;
exports.getAllModelUsage = getAllModelUsage;
exports.hasData = hasData;
exports.getOldestDate = getOldestDate;
exports.getNewestDate = getNewestDate;
exports.getTotalStats = getTotalStats;
exports.getExistingDates = getExistingDates;
exports.importFromCache = importFromCache;
exports.getOrCreateProject = getOrCreateProject;
exports.getAllProjects = getAllProjects;
exports.saveProjectDailyStats = saveProjectDailyStats;
exports.getProjectDailyStats = getProjectDailyStats;
exports.saveSession = saveSession;
exports.getSessions = getSessions;
exports.saveToolUsageDaily = saveToolUsageDaily;
exports.getToolUsageDaily = getToolUsageDaily;
exports.saveWorkClassificationDaily = saveWorkClassificationDaily;
exports.getWorkClassificationDaily = getWorkClassificationDaily;
exports.saveFileTypeDaily = saveFileTypeDaily;
exports.getFileTypeDaily = getFileTypeDaily;
exports.saveHourlyDistribution = saveHourlyDistribution;
exports.getHourlyDistribution = getHourlyDistribution;
exports.saveModelSwitch = saveModelSwitch;
exports.getModelSwitches = getModelSwitches;
exports.saveCacheEfficiencyDaily = saveCacheEfficiencyDaily;
exports.getCacheEfficiencyDaily = getCacheEfficiencyDaily;
exports.clearHistoryBeforeDate = clearHistoryBeforeDate;
exports.truncateAllData = truncateAllData;
exports.exportForGistSync = exportForGistSync;
exports.importAndMergeFromGist = importAndMergeFromGist;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
// Use ASM version (pure JS, no WASM needed) for VS Code extension compatibility
// eslint-disable-next-line @typescript-eslint/no-var-requires
const initSqlJs = require('sql.js/dist/sql-asm.js');
// Database singleton
let db = null;
let dbInitPromise = null;
let dbInitFailed = false;
// Database file path
function getDbPath() {
    return path.join(os.homedir(), '.claude', 'analytics.db');
}
// Schema version for migrations
const SCHEMA_VERSION = 4;
// Machine ID for multi-computer sync
let machineId = null;
/**
 * Get or generate a unique machine ID
 */
function getMachineId() {
    if (machineId)
        return machineId;
    if (db) {
        const stored = getMetadata(db, 'machine_id');
        if (stored) {
            machineId = stored;
            return machineId;
        }
    }
    // Generate new machine ID based on hostname + random suffix
    const hostname = os.hostname();
    const random = Math.random().toString(36).substring(2, 8);
    machineId = `${hostname}-${random}`;
    if (db) {
        setMetadata(db, 'machine_id', machineId);
    }
    return machineId;
}
/**
 * Initialize the SQLite database (creates tables if needed)
 * Returns null if initialization fails - extension continues without persistence
 */
async function initDatabase() {
    // Don't retry if already failed
    if (dbInitFailed) {
        return null;
    }
    // Return existing promise if initialization is in progress
    if (dbInitPromise) {
        return dbInitPromise;
    }
    // Return existing database if already initialized
    if (db) {
        return db;
    }
    dbInitPromise = (async () => {
        try {
            // Initialize sql.js (ASM version - pure JS, no WASM)
            const SQL = await initSqlJs();
            const dbPath = getDbPath();
            const dbDir = path.dirname(dbPath);
            // Ensure .claude directory exists
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }
            // Load existing database or create new one
            if (fs.existsSync(dbPath)) {
                const fileBuffer = fs.readFileSync(dbPath);
                db = new SQL.Database(fileBuffer);
            }
            else {
                db = new SQL.Database();
            }
            // Create schema if needed
            createSchema(db);
            // Check and run migrations
            runMigrations(db);
            // Load external additions from sidecar JSON
            loadExternalAdditions();
            console.log('Claude Analytics: Database initialized successfully');
            return db;
        }
        catch (error) {
            console.error('Claude Analytics: Failed to initialize database:', error);
            dbInitFailed = true;
            db = null;
            dbInitPromise = null;
            return null;
        }
    })();
    return dbInitPromise;
}
/**
 * Create database schema
 */
function createSchema(database) {
    // Daily snapshots table
    database.run(`
        CREATE TABLE IF NOT EXISTS daily_snapshots (
            date TEXT PRIMARY KEY,
            cost REAL DEFAULT 0,
            messages INTEGER DEFAULT 0,
            tokens INTEGER DEFAULT 0,
            sessions INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);
    // Model usage per day
    database.run(`
        CREATE TABLE IF NOT EXISTS model_usage (
            date TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cache_read_tokens INTEGER DEFAULT 0,
            cache_write_tokens INTEGER DEFAULT 0,
            PRIMARY KEY (date, model)
        )
    `);
    // Metadata table for schema version, settings, etc.
    database.run(`
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `);
    // v3: Projects lookup table
    database.run(`
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL UNIQUE,
            project_name TEXT NOT NULL,
            first_seen TEXT NOT NULL,
            last_seen TEXT NOT NULL
        )
    `);
    // v3: Per-project daily stats
    database.run(`
        CREATE TABLE IF NOT EXISTS project_daily_stats (
            date TEXT NOT NULL,
            project_id INTEGER NOT NULL,
            cost REAL DEFAULT 0,
            messages INTEGER DEFAULT 0,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cache_read_tokens INTEGER DEFAULT 0,
            cache_write_tokens INTEGER DEFAULT 0,
            sessions INTEGER DEFAULT 0,
            PRIMARY KEY (date, project_id),
            FOREIGN KEY (project_id) REFERENCES projects(id)
        )
    `);
    // v3: Session-level tracking
    database.run(`
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            project_id INTEGER,
            date TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT,
            duration_minutes REAL DEFAULT 0,
            messages INTEGER DEFAULT 0,
            cost REAL DEFAULT 0,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cache_read_tokens INTEGER DEFAULT 0,
            cache_write_tokens INTEGER DEFAULT 0,
            git_branch TEXT,
            claude_version TEXT,
            primary_model TEXT,
            subagent_count INTEGER DEFAULT 0,
            subagent_messages INTEGER DEFAULT 0,
            work_type TEXT,
            FOREIGN KEY (project_id) REFERENCES projects(id)
        )
    `);
    // v3: Tool usage per day per project
    database.run(`
        CREATE TABLE IF NOT EXISTS tool_usage_daily (
            date TEXT NOT NULL,
            project_id INTEGER NOT NULL,
            tool_name TEXT NOT NULL,
            invocations INTEGER DEFAULT 0,
            total_duration_ms INTEGER DEFAULT 0,
            PRIMARY KEY (date, project_id, tool_name),
            FOREIGN KEY (project_id) REFERENCES projects(id)
        )
    `);
    // v3: Work classification per day per project
    database.run(`
        CREATE TABLE IF NOT EXISTS work_classification_daily (
            date TEXT NOT NULL,
            project_id INTEGER NOT NULL,
            work_type TEXT NOT NULL,
            session_count INTEGER DEFAULT 0,
            messages INTEGER DEFAULT 0,
            cost REAL DEFAULT 0,
            PRIMARY KEY (date, project_id, work_type),
            FOREIGN KEY (project_id) REFERENCES projects(id)
        )
    `);
    // v3: File type usage per day per project
    database.run(`
        CREATE TABLE IF NOT EXISTS file_type_daily (
            date TEXT NOT NULL,
            project_id INTEGER NOT NULL,
            file_extension TEXT NOT NULL,
            files_read INTEGER DEFAULT 0,
            files_edited INTEGER DEFAULT 0,
            files_created INTEGER DEFAULT 0,
            PRIMARY KEY (date, project_id, file_extension),
            FOREIGN KEY (project_id) REFERENCES projects(id)
        )
    `);
    // v3: Hourly message/cost distribution
    database.run(`
        CREATE TABLE IF NOT EXISTS hourly_distribution (
            date TEXT NOT NULL,
            hour INTEGER NOT NULL,
            messages INTEGER DEFAULT 0,
            cost REAL DEFAULT 0,
            tokens INTEGER DEFAULT 0,
            PRIMARY KEY (date, hour)
        )
    `);
    // v3: Model switch tracking per session
    database.run(`
        CREATE TABLE IF NOT EXISTS model_switches (
            date TEXT NOT NULL,
            session_id TEXT NOT NULL,
            from_model TEXT NOT NULL,
            to_model TEXT NOT NULL,
            switch_count INTEGER DEFAULT 1,
            PRIMARY KEY (date, session_id, from_model, to_model)
        )
    `);
    // v3: Cache efficiency per day per project per model
    database.run(`
        CREATE TABLE IF NOT EXISTS cache_efficiency_daily (
            date TEXT NOT NULL,
            project_id INTEGER NOT NULL,
            model TEXT NOT NULL,
            total_input_tokens INTEGER DEFAULT 0,
            cache_read_tokens INTEGER DEFAULT 0,
            cache_write_tokens INTEGER DEFAULT 0,
            ephemeral_5m_tokens INTEGER DEFAULT 0,
            ephemeral_1h_tokens INTEGER DEFAULT 0,
            cache_hit_ratio REAL DEFAULT 0,
            estimated_savings REAL DEFAULT 0,
            PRIMARY KEY (date, project_id, model),
            FOREIGN KEY (project_id) REFERENCES projects(id)
        )
    `);
    // v4: External additions (sidecar JSON framework)
    database.run(`
        CREATE TABLE IF NOT EXISTS external_additions (
            date TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'external',
            cost REAL DEFAULT 0,
            messages INTEGER DEFAULT 0,
            tokens INTEGER DEFAULT 0,
            sessions INTEGER DEFAULT 0,
            PRIMARY KEY (date, source)
        )
    `);
    database.run(`
        CREATE TABLE IF NOT EXISTS external_model_additions (
            date TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'external',
            model TEXT NOT NULL,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cache_read_tokens INTEGER DEFAULT 0,
            cache_write_tokens INTEGER DEFAULT 0,
            PRIMARY KEY (date, source, model)
        )
    `);
    // Create indexes for faster queries
    database.run(`CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_snapshots(date)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_model_date ON model_usage(date)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(project_path)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_proj_daily_date ON project_daily_stats(date)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_proj_daily_project ON project_daily_stats(project_id)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_tool_daily_date ON tool_usage_daily(date)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_tool_daily_tool ON tool_usage_daily(tool_name)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_work_class_date ON work_classification_daily(date)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_filetype_date ON file_type_daily(date)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_hourly_date ON hourly_distribution(date)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_model_switch_date ON model_switches(date)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_cache_eff_date ON cache_efficiency_daily(date)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_ext_additions_date ON external_additions(date)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_ext_model_date ON external_model_additions(date)`);
}
/**
 * Run schema migrations
 */
function runMigrations(database) {
    const currentVersion = getMetadata(database, 'schema_version');
    const version = currentVersion ? parseInt(currentVersion, 10) : 0;
    if (version < SCHEMA_VERSION) {
        // Migration to v2: Add machine_id column
        if (version < 2) {
            try {
                database.run(`ALTER TABLE daily_snapshots ADD COLUMN machine_id TEXT DEFAULT 'local'`);
                database.run(`ALTER TABLE model_usage ADD COLUMN machine_id TEXT DEFAULT 'local'`);
            }
            catch (e) {
                // Column may already exist
            }
        }
        // Migration to v3: New tables created by createSchema() above (CREATE IF NOT EXISTS).
        if (version < 3) {
            console.log('Claude Analytics: Migrated to schema v3 (enriched tracking tables)');
        }
        // Migration to v4: External additions tables created by createSchema() above.
        if (version < 4) {
            console.log('Claude Analytics: Migrated to schema v4 (external additions sidecar)');
        }
        setMetadata(database, 'schema_version', SCHEMA_VERSION.toString());
    }
    // Ensure machine ID is stored
    if (!getMetadata(database, 'machine_id')) {
        const hostname = os.hostname();
        const random = Math.random().toString(36).substring(2, 8);
        machineId = `${hostname}-${random}`;
        setMetadata(database, 'machine_id', machineId);
    }
    else {
        machineId = getMetadata(database, 'machine_id');
    }
}
/**
 * Get metadata value (internal - uses provided database)
 */
function getMetadata(database, key) {
    const result = database.exec(`SELECT value FROM metadata WHERE key = ?`, [key]);
    if (result.length > 0 && result[0].values.length > 0) {
        return result[0].values[0][0];
    }
    return null;
}
/**
 * Set metadata value (internal - uses provided database)
 */
function setMetadata(database, key, value) {
    database.run(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`, [key, value]);
}
/**
 * Get metadata value (public - uses singleton db)
 */
function getDbMetadata(key) {
    if (!db)
        return null;
    return getMetadata(db, key);
}
/**
 * Set metadata value (public - uses singleton db)
 */
function setDbMetadata(key, value) {
    if (!db)
        return;
    setMetadata(db, key, value);
}
/**
 * Save database to disk
 */
function saveDatabase() {
    if (!db)
        return;
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(getDbPath(), buffer);
    }
    catch (error) {
        console.error('Failed to save database:', error);
    }
}
/**
 * Close the database connection
 */
function closeDatabase() {
    if (db) {
        saveDatabase();
        db.close();
        db = null;
        dbInitPromise = null;
    }
}
/**
 * Load external additions from sidecar JSON file (~/.claude/external-additions.json).
 * The JSON is the source of truth; DB tables are re-populated from it on every init.
 */
function loadExternalAdditions() {
    if (!db)
        return { loaded: 0, errors: ['Database not initialized'] };
    const errors = [];
    let loaded = 0;
    const filePath = path.join(os.homedir(), '.claude', 'external-additions.json');
    if (!fs.existsSync(filePath)) {
        return { loaded: 0, errors: [] };
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        if (!data.source || typeof data.source !== 'string') {
            return { loaded: 0, errors: ['Missing or invalid "source" field in external-additions.json'] };
        }
        if (!Array.isArray(data.rows)) {
            return { loaded: 0, errors: ['Missing or invalid "rows" array in external-additions.json'] };
        }
        const source = data.source.trim();
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        // Clear existing data for this source (full re-populate from JSON)
        db.run(`DELETE FROM external_additions WHERE source = ?`, [source]);
        db.run(`DELETE FROM external_model_additions WHERE source = ?`, [source]);
        // Insert daily rows
        for (const row of data.rows) {
            if (!row.date || !dateRegex.test(row.date)) {
                errors.push(`Skipped row with invalid date: ${JSON.stringify(row.date)}`);
                continue;
            }
            const cost = typeof row.cost === 'number' ? row.cost : 0;
            const messages = typeof row.messages === 'number' ? Math.round(row.messages) : 0;
            const tokens = typeof row.tokens === 'number' ? Math.round(row.tokens) : 0;
            const sessions = typeof row.sessions === 'number' ? Math.round(row.sessions) : 0;
            if (cost === 0 && messages === 0 && tokens === 0 && sessions === 0)
                continue;
            db.run(`
                INSERT OR REPLACE INTO external_additions (date, source, cost, messages, tokens, sessions)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [row.date, source, cost, messages, tokens, sessions]);
            loaded++;
        }
        // Insert model rows
        if (Array.isArray(data.modelRows)) {
            for (const mRow of data.modelRows) {
                if (!mRow.date || !dateRegex.test(mRow.date)) {
                    errors.push(`Skipped model row with invalid date: ${JSON.stringify(mRow.date)}`);
                    continue;
                }
                if (!mRow.model || typeof mRow.model !== 'string') {
                    errors.push(`Skipped model row with missing model name on ${mRow.date}`);
                    continue;
                }
                db.run(`
                    INSERT OR REPLACE INTO external_model_additions
                    (date, source, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    mRow.date, source, mRow.model.trim(),
                    typeof mRow.input_tokens === 'number' ? Math.round(mRow.input_tokens) : 0,
                    typeof mRow.output_tokens === 'number' ? Math.round(mRow.output_tokens) : 0,
                    typeof mRow.cache_read_tokens === 'number' ? Math.round(mRow.cache_read_tokens) : 0,
                    typeof mRow.cache_write_tokens === 'number' ? Math.round(mRow.cache_write_tokens) : 0
                ]);
            }
        }
        console.log(`Claude Analytics: Loaded ${loaded} external addition rows from "${source}"`);
        if (errors.length > 0) {
            console.warn(`Claude Analytics: ${errors.length} validation warnings loading external additions`);
        }
    }
    catch (e) {
        if (e instanceof SyntaxError) {
            errors.push(`Malformed JSON in external-additions.json: ${e.message}`);
        }
        else {
            errors.push(`Failed to load external-additions.json: ${e.message}`);
        }
        console.error('Claude Analytics: Error loading external additions:', e);
    }
    return { loaded, errors };
}
// ============ CRUD Operations ============
/**
 * Save or update a daily snapshot
 */
function saveDailySnapshot(snapshot) {
    if (!db)
        return;
    db.run(`
        INSERT OR REPLACE INTO daily_snapshots (date, cost, messages, tokens, sessions)
        VALUES (?, ?, ?, ?, ?)
    `, [snapshot.date, snapshot.cost, snapshot.messages, snapshot.tokens, snapshot.sessions]);
}
/**
 * Save or update model usage for a day
 */
function saveModelUsage(usage) {
    if (!db)
        return;
    db.run(`
        INSERT OR REPLACE INTO model_usage (date, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [usage.date, usage.model, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]);
}
/**
 * Get all daily snapshots from database
 */
function getAllDailySnapshots() {
    if (!db)
        return [];
    const result = db.exec(`
        SELECT date, SUM(cost) as cost, SUM(messages) as messages,
               SUM(tokens) as tokens, SUM(sessions) as sessions
        FROM (
            SELECT date, cost, messages, tokens, sessions FROM daily_snapshots
            UNION ALL
            SELECT date, cost, messages, tokens, sessions FROM external_additions
        ) combined
        GROUP BY date
        ORDER BY date ASC
    `);
    if (result.length === 0 || result[0].values.length === 0) {
        return [];
    }
    return result[0].values.map((row) => ({
        date: row[0],
        cost: row[1],
        messages: row[2],
        tokens: row[3],
        sessions: row[4]
    }));
}
/**
 * Get model usage for a specific date
 */
function getModelUsageForDate(date) {
    if (!db)
        return [];
    const result = db.exec(`
        SELECT date, model,
               SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
               SUM(cache_read_tokens) as cache_read_tokens, SUM(cache_write_tokens) as cache_write_tokens
        FROM (
            SELECT date, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
            FROM model_usage WHERE date = ?
            UNION ALL
            SELECT date, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
            FROM external_model_additions WHERE date = ?
        ) combined
        GROUP BY date, model
    `, [date, date]);
    if (result.length === 0 || result[0].values.length === 0) {
        return [];
    }
    return result[0].values.map((row) => ({
        date: row[0],
        model: row[1],
        inputTokens: row[2],
        outputTokens: row[3],
        cacheReadTokens: row[4],
        cacheWriteTokens: row[5]
    }));
}
/**
 * Get all model usage records
 */
function getAllModelUsage() {
    if (!db)
        return [];
    const result = db.exec(`
        SELECT date, model,
               SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
               SUM(cache_read_tokens) as cache_read_tokens, SUM(cache_write_tokens) as cache_write_tokens
        FROM (
            SELECT date, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
            FROM model_usage
            UNION ALL
            SELECT date, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
            FROM external_model_additions
        ) combined
        GROUP BY date, model
        ORDER BY date ASC
    `);
    if (result.length === 0 || result[0].values.length === 0) {
        return [];
    }
    return result[0].values.map((row) => ({
        date: row[0],
        model: row[1],
        inputTokens: row[2],
        outputTokens: row[3],
        cacheReadTokens: row[4],
        cacheWriteTokens: row[5]
    }));
}
/**
 * Check if database has any data
 */
function hasData() {
    if (!db)
        return false;
    const result = db.exec(`
        SELECT COUNT(*) FROM (
            SELECT date FROM daily_snapshots
            UNION
            SELECT date FROM external_additions
        )
    `);
    if (result.length > 0 && result[0].values.length > 0) {
        return result[0].values[0][0] > 0;
    }
    return false;
}
/**
 * Get the date of the oldest record
 */
function getOldestDate() {
    if (!db)
        return null;
    const result = db.exec(`SELECT MIN(date) FROM (SELECT date FROM daily_snapshots UNION SELECT date FROM external_additions)`);
    if (result.length > 0 && result[0].values.length > 0 && result[0].values[0][0]) {
        return result[0].values[0][0];
    }
    return null;
}
/**
 * Get the date of the newest record
 */
function getNewestDate() {
    if (!db)
        return null;
    const result = db.exec(`SELECT MAX(date) FROM (SELECT date FROM daily_snapshots UNION SELECT date FROM external_additions)`);
    if (result.length > 0 && result[0].values.length > 0 && result[0].values[0][0]) {
        return result[0].values[0][0];
    }
    return null;
}
/**
 * Get total statistics from database
 */
function getTotalStats() {
    if (!db)
        return { totalCost: 0, totalMessages: 0, totalTokens: 0, totalSessions: 0, daysCount: 0 };
    const result = db.exec(`
        SELECT
            COALESCE(SUM(cost), 0) as total_cost,
            COALESCE(SUM(messages), 0) as total_messages,
            COALESCE(SUM(tokens), 0) as total_tokens,
            COALESCE(SUM(sessions), 0) as total_sessions,
            COUNT(*) as days_count
        FROM (
            SELECT date, SUM(cost) as cost, SUM(messages) as messages,
                   SUM(tokens) as tokens, SUM(sessions) as sessions
            FROM (
                SELECT date, cost, messages, tokens, sessions FROM daily_snapshots
                UNION ALL
                SELECT date, cost, messages, tokens, sessions FROM external_additions
            ) combined
            GROUP BY date
        ) daily_totals
    `);
    if (result.length > 0 && result[0].values.length > 0) {
        const row = result[0].values[0];
        return {
            totalCost: row[0],
            totalMessages: row[1],
            totalTokens: row[2],
            totalSessions: row[3],
            daysCount: row[4]
        };
    }
    return { totalCost: 0, totalMessages: 0, totalTokens: 0, totalSessions: 0, daysCount: 0 };
}
/**
 * Get dates that exist in the database
 */
function getExistingDates() {
    if (!db)
        return new Set();
    const result = db.exec(`SELECT date FROM daily_snapshots UNION SELECT date FROM external_additions`);
    const dates = new Set();
    if (result.length > 0) {
        for (const row of result[0].values) {
            dates.add(row[0]);
        }
    }
    return dates;
}
/**
 * Import data from stats-cache.json (first run or manual import)
 */
async function importFromCache(statsCache) {
    if (!db) {
        await initDatabase();
    }
    if (!db)
        return { imported: 0, skipped: 0 };
    let imported = 0;
    let skipped = 0;
    const existingDates = getExistingDates();
    // Import daily activity
    if (statsCache.dailyActivity && Array.isArray(statsCache.dailyActivity)) {
        // Build a map of date -> tokens by model for cost calculation
        const dailyTokensMap = {};
        if (statsCache.dailyModelTokens && Array.isArray(statsCache.dailyModelTokens)) {
            for (const day of statsCache.dailyModelTokens) {
                if (day.date && day.tokensByModel) {
                    dailyTokensMap[day.date] = day.tokensByModel;
                }
            }
        }
        for (const day of statsCache.dailyActivity) {
            if (!day.date)
                continue;
            // Skip if we already have this date
            if (existingDates.has(day.date)) {
                skipped++;
                continue;
            }
            const messages = day.messageCount || 0;
            const tokensByModel = dailyTokensMap[day.date] || {};
            const dayTokens = Object.values(tokensByModel).reduce((sum, t) => sum + (t || 0), 0);
            // Calculate cost using model pricing
            let cost = 0;
            for (const [model, tokens] of Object.entries(tokensByModel)) {
                const pricing = getPricingForModel(model);
                // Approximate split: 30% input, 10% output, 50% cache read, 10% cache write
                const avgRate = (pricing.input * 0.3 + pricing.output * 0.1 + pricing.cacheRead * 0.5 + pricing.cacheWrite * 0.1);
                cost += (tokens / 1000000) * avgRate;
            }
            saveDailySnapshot({
                date: day.date,
                cost,
                messages,
                tokens: dayTokens,
                sessions: day.sessionCount || 0
            });
            // Save model usage breakdown
            for (const [model, tokens] of Object.entries(tokensByModel)) {
                saveModelUsage({
                    date: day.date,
                    model,
                    inputTokens: Math.round(tokens * 0.3),
                    outputTokens: Math.round(tokens * 0.1),
                    cacheReadTokens: Math.round(tokens * 0.5),
                    cacheWriteTokens: Math.round(tokens * 0.1)
                });
            }
            imported++;
        }
    }
    // Save changes to disk
    saveDatabase();
    return { imported, skipped };
}
// ============ CRUD Operations: v3 Enriched Tables ============
/**
 * Get or create a project record, returning the project ID
 */
function getOrCreateProject(projectPath, date) {
    if (!db)
        return -1;
    const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const projectName = path.basename(normalized);
    const existing = db.exec(`SELECT id FROM projects WHERE project_path = ?`, [normalized]);
    if (existing.length > 0 && existing[0].values.length > 0) {
        const id = existing[0].values[0][0];
        db.run(`UPDATE projects SET last_seen = ? WHERE id = ? AND last_seen < ?`, [date, id, date]);
        return id;
    }
    db.run(`INSERT INTO projects (project_path, project_name, first_seen, last_seen) VALUES (?, ?, ?, ?)`, [normalized, projectName, date, date]);
    const result = db.exec(`SELECT last_insert_rowid()`);
    return result[0].values[0][0];
}
/**
 * Get all projects
 */
function getAllProjects() {
    if (!db)
        return [];
    const result = db.exec(`SELECT id, project_path, project_name, first_seen, last_seen FROM projects ORDER BY last_seen DESC`);
    if (result.length === 0 || result[0].values.length === 0)
        return [];
    return result[0].values.map((row) => ({
        id: row[0], projectPath: row[1], projectName: row[2],
        firstSeen: row[3], lastSeen: row[4]
    }));
}
/**
 * Save or update project daily stats
 */
function saveProjectDailyStats(record) {
    if (!db)
        return;
    db.run(`
        INSERT INTO project_daily_stats (date, project_id, cost, messages, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, sessions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, project_id) DO UPDATE SET
            cost = excluded.cost, messages = excluded.messages,
            input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
            cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
            sessions = excluded.sessions
    `, [record.date, record.projectId, record.cost, record.messages,
        record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.sessions]);
}
/**
 * Get project daily stats for a date range
 */
function getProjectDailyStats(startDate, endDate) {
    if (!db)
        return [];
    let query = `
        SELECT pds.date, pds.project_id, pds.cost, pds.messages, pds.input_tokens, pds.output_tokens,
               pds.cache_read_tokens, pds.cache_write_tokens, pds.sessions, p.project_name
        FROM project_daily_stats pds JOIN projects p ON p.id = pds.project_id`;
    const params = [];
    if (startDate && endDate) {
        query += ` WHERE pds.date >= ? AND pds.date <= ?`;
        params.push(startDate, endDate);
    }
    else if (startDate) {
        query += ` WHERE pds.date >= ?`;
        params.push(startDate);
    }
    query += ` ORDER BY pds.date ASC`;
    const result = db.exec(query, params);
    if (result.length === 0 || result[0].values.length === 0)
        return [];
    return result[0].values.map((row) => ({
        date: row[0], projectId: row[1], cost: row[2], messages: row[3],
        inputTokens: row[4], outputTokens: row[5], cacheReadTokens: row[6], cacheWriteTokens: row[7],
        sessions: row[8], projectName: row[9]
    }));
}
/**
 * Save a session record
 */
function saveSession(record) {
    if (!db)
        return;
    db.run(`
        INSERT OR REPLACE INTO sessions
        (session_id, project_id, date, start_time, end_time, duration_minutes, messages, cost,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         git_branch, claude_version, primary_model, subagent_count, subagent_messages, work_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [record.sessionId, record.projectId, record.date, record.startTime, record.endTime,
        record.durationMinutes, record.messages, record.cost,
        record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheWriteTokens,
        record.gitBranch, record.claudeVersion, record.primaryModel,
        record.subagentCount, record.subagentMessages, record.workType]);
}
/**
 * Get sessions for a date range
 */
function getSessions(startDate, endDate) {
    if (!db)
        return [];
    let query = `SELECT session_id, project_id, date, start_time, end_time, duration_minutes, messages, cost,
                        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                        git_branch, claude_version, primary_model, subagent_count, subagent_messages, work_type
                 FROM sessions`;
    const params = [];
    if (startDate && endDate) {
        query += ` WHERE date >= ? AND date <= ?`;
        params.push(startDate, endDate);
    }
    else if (startDate) {
        query += ` WHERE date >= ?`;
        params.push(startDate);
    }
    query += ` ORDER BY start_time ASC`;
    const result = db.exec(query, params);
    if (result.length === 0 || result[0].values.length === 0)
        return [];
    return result[0].values.map((row) => ({
        sessionId: row[0], projectId: row[1], date: row[2], startTime: row[3], endTime: row[4],
        durationMinutes: row[5], messages: row[6], cost: row[7],
        inputTokens: row[8], outputTokens: row[9], cacheReadTokens: row[10], cacheWriteTokens: row[11],
        gitBranch: row[12], claudeVersion: row[13], primaryModel: row[14],
        subagentCount: row[15], subagentMessages: row[16], workType: row[17]
    }));
}
/**
 * Save tool usage daily record
 */
function saveToolUsageDaily(record) {
    if (!db)
        return;
    db.run(`
        INSERT INTO tool_usage_daily (date, project_id, tool_name, invocations, total_duration_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date, project_id, tool_name) DO UPDATE SET
            invocations = excluded.invocations, total_duration_ms = excluded.total_duration_ms
    `, [record.date, record.projectId, record.toolName, record.invocations, record.totalDurationMs]);
}
/**
 * Get tool usage for a date range
 */
function getToolUsageDaily(startDate, endDate) {
    if (!db)
        return [];
    let query = `SELECT date, project_id, tool_name, invocations, total_duration_ms FROM tool_usage_daily`;
    const params = [];
    if (startDate && endDate) {
        query += ` WHERE date >= ? AND date <= ?`;
        params.push(startDate, endDate);
    }
    else if (startDate) {
        query += ` WHERE date >= ?`;
        params.push(startDate);
    }
    query += ` ORDER BY date ASC`;
    const result = db.exec(query, params);
    if (result.length === 0 || result[0].values.length === 0)
        return [];
    return result[0].values.map((row) => ({
        date: row[0], projectId: row[1], toolName: row[2], invocations: row[3], totalDurationMs: row[4]
    }));
}
/**
 * Save work classification daily record
 */
function saveWorkClassificationDaily(record) {
    if (!db)
        return;
    db.run(`
        INSERT INTO work_classification_daily (date, project_id, work_type, session_count, messages, cost)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, project_id, work_type) DO UPDATE SET
            session_count = excluded.session_count, messages = excluded.messages, cost = excluded.cost
    `, [record.date, record.projectId, record.workType, record.sessionCount, record.messages, record.cost]);
}
/**
 * Get work classification for a date range
 */
function getWorkClassificationDaily(startDate, endDate) {
    if (!db)
        return [];
    let query = `SELECT date, project_id, work_type, session_count, messages, cost FROM work_classification_daily`;
    const params = [];
    if (startDate && endDate) {
        query += ` WHERE date >= ? AND date <= ?`;
        params.push(startDate, endDate);
    }
    else if (startDate) {
        query += ` WHERE date >= ?`;
        params.push(startDate);
    }
    query += ` ORDER BY date ASC`;
    const result = db.exec(query, params);
    if (result.length === 0 || result[0].values.length === 0)
        return [];
    return result[0].values.map((row) => ({
        date: row[0], projectId: row[1], workType: row[2], sessionCount: row[3], messages: row[4], cost: row[5]
    }));
}
/**
 * Save file type daily record
 */
function saveFileTypeDaily(record) {
    if (!db)
        return;
    db.run(`
        INSERT INTO file_type_daily (date, project_id, file_extension, files_read, files_edited, files_created)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, project_id, file_extension) DO UPDATE SET
            files_read = excluded.files_read, files_edited = excluded.files_edited, files_created = excluded.files_created
    `, [record.date, record.projectId, record.fileExtension, record.filesRead, record.filesEdited, record.filesCreated]);
}
/**
 * Get file type usage for a date range
 */
function getFileTypeDaily(startDate, endDate) {
    if (!db)
        return [];
    let query = `SELECT date, project_id, file_extension, files_read, files_edited, files_created FROM file_type_daily`;
    const params = [];
    if (startDate && endDate) {
        query += ` WHERE date >= ? AND date <= ?`;
        params.push(startDate, endDate);
    }
    else if (startDate) {
        query += ` WHERE date >= ?`;
        params.push(startDate);
    }
    query += ` ORDER BY date ASC`;
    const result = db.exec(query, params);
    if (result.length === 0 || result[0].values.length === 0)
        return [];
    return result[0].values.map((row) => ({
        date: row[0], projectId: row[1], fileExtension: row[2], filesRead: row[3], filesEdited: row[4], filesCreated: row[5]
    }));
}
/**
 * Save hourly distribution record
 */
function saveHourlyDistribution(record) {
    if (!db)
        return;
    db.run(`
        INSERT INTO hourly_distribution (date, hour, messages, cost, tokens)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date, hour) DO UPDATE SET
            messages = excluded.messages, cost = excluded.cost, tokens = excluded.tokens
    `, [record.date, record.hour, record.messages, record.cost, record.tokens]);
}
/**
 * Get hourly distribution for a date range
 */
function getHourlyDistribution(startDate, endDate) {
    if (!db)
        return [];
    let query = `SELECT date, hour, messages, cost, tokens FROM hourly_distribution`;
    const params = [];
    if (startDate && endDate) {
        query += ` WHERE date >= ? AND date <= ?`;
        params.push(startDate, endDate);
    }
    else if (startDate) {
        query += ` WHERE date >= ?`;
        params.push(startDate);
    }
    query += ` ORDER BY date ASC, hour ASC`;
    const result = db.exec(query, params);
    if (result.length === 0 || result[0].values.length === 0)
        return [];
    return result[0].values.map((row) => ({
        date: row[0], hour: row[1], messages: row[2], cost: row[3], tokens: row[4]
    }));
}
/**
 * Save model switch record
 */
function saveModelSwitch(record) {
    if (!db)
        return;
    db.run(`
        INSERT INTO model_switches (date, session_id, from_model, to_model, switch_count)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date, session_id, from_model, to_model) DO UPDATE SET
            switch_count = excluded.switch_count
    `, [record.date, record.sessionId, record.fromModel, record.toModel, record.switchCount]);
}
/**
 * Get model switches for a date range
 */
function getModelSwitches(startDate, endDate) {
    if (!db)
        return [];
    let query = `SELECT date, session_id, from_model, to_model, switch_count FROM model_switches`;
    const params = [];
    if (startDate && endDate) {
        query += ` WHERE date >= ? AND date <= ?`;
        params.push(startDate, endDate);
    }
    else if (startDate) {
        query += ` WHERE date >= ?`;
        params.push(startDate);
    }
    query += ` ORDER BY date ASC`;
    const result = db.exec(query, params);
    if (result.length === 0 || result[0].values.length === 0)
        return [];
    return result[0].values.map((row) => ({
        date: row[0], sessionId: row[1], fromModel: row[2], toModel: row[3], switchCount: row[4]
    }));
}
/**
 * Save cache efficiency daily record
 */
function saveCacheEfficiencyDaily(record) {
    if (!db)
        return;
    db.run(`
        INSERT INTO cache_efficiency_daily (date, project_id, model, total_input_tokens, cache_read_tokens,
            cache_write_tokens, ephemeral_5m_tokens, ephemeral_1h_tokens, cache_hit_ratio, estimated_savings)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, project_id, model) DO UPDATE SET
            total_input_tokens = excluded.total_input_tokens, cache_read_tokens = excluded.cache_read_tokens,
            cache_write_tokens = excluded.cache_write_tokens, ephemeral_5m_tokens = excluded.ephemeral_5m_tokens,
            ephemeral_1h_tokens = excluded.ephemeral_1h_tokens, cache_hit_ratio = excluded.cache_hit_ratio,
            estimated_savings = excluded.estimated_savings
    `, [record.date, record.projectId, record.model, record.totalInputTokens,
        record.cacheReadTokens, record.cacheWriteTokens, record.ephemeral5mTokens, record.ephemeral1hTokens,
        record.cacheHitRatio, record.estimatedSavings]);
}
/**
 * Get cache efficiency for a date range
 */
function getCacheEfficiencyDaily(startDate, endDate) {
    if (!db)
        return [];
    let query = `SELECT date, project_id, model, total_input_tokens, cache_read_tokens, cache_write_tokens,
                        ephemeral_5m_tokens, ephemeral_1h_tokens, cache_hit_ratio, estimated_savings
                 FROM cache_efficiency_daily`;
    const params = [];
    if (startDate && endDate) {
        query += ` WHERE date >= ? AND date <= ?`;
        params.push(startDate, endDate);
    }
    else if (startDate) {
        query += ` WHERE date >= ?`;
        params.push(startDate);
    }
    query += ` ORDER BY date ASC`;
    const result = db.exec(query, params);
    if (result.length === 0 || result[0].values.length === 0)
        return [];
    return result[0].values.map((row) => ({
        date: row[0], projectId: row[1], model: row[2], totalInputTokens: row[3],
        cacheReadTokens: row[4], cacheWriteTokens: row[5], ephemeral5mTokens: row[6],
        ephemeral1hTokens: row[7], cacheHitRatio: row[8], estimatedSavings: row[9]
    }));
}
/**
 * Clear history before a specified date
 * @param beforeDate Date string in YYYY-MM-DD format
 * @returns Number of days deleted from daily_snapshots
 */
function clearHistoryBeforeDate(beforeDate) {
    if (!db)
        return 0;
    try {
        // Count records to be deleted
        const countResult = db.exec(`SELECT COUNT(*) FROM daily_snapshots WHERE date < ?`, [beforeDate]);
        const deleteCount = countResult.length > 0 ? countResult[0].values[0][0] : 0;
        if (deleteCount === 0) {
            return 0;
        }
        // Delete from all date-keyed tables
        db.run(`DELETE FROM daily_snapshots WHERE date < ?`, [beforeDate]);
        db.run(`DELETE FROM model_usage WHERE date < ?`, [beforeDate]);
        db.run(`DELETE FROM project_daily_stats WHERE date < ?`, [beforeDate]);
        db.run(`DELETE FROM sessions WHERE date < ?`, [beforeDate]);
        db.run(`DELETE FROM tool_usage_daily WHERE date < ?`, [beforeDate]);
        db.run(`DELETE FROM work_classification_daily WHERE date < ?`, [beforeDate]);
        db.run(`DELETE FROM file_type_daily WHERE date < ?`, [beforeDate]);
        db.run(`DELETE FROM hourly_distribution WHERE date < ?`, [beforeDate]);
        db.run(`DELETE FROM model_switches WHERE date < ?`, [beforeDate]);
        db.run(`DELETE FROM cache_efficiency_daily WHERE date < ?`, [beforeDate]);
        // external_additions and external_model_additions are NOT cleared here;
        // they are managed by the sidecar JSON file and re-loaded on init.
        // Save changes to disk
        saveDatabase();
        return deleteCount;
    }
    catch (error) {
        console.error('Claude Analytics: Failed to clear history:', error);
        return 0;
    }
}
// Model pricing helper (duplicated from dataProvider to avoid circular deps)
// Cache rates: cache_read = input * 0.1 (90% discount), cache_write = input * 1.25 (25% premium)
const MODEL_PRICING = {
    opus_new: { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
    opus_legacy: { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
    sonnet: { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
    haiku_45: { input: 1, output: 5, cacheRead: 0.10, cacheWrite: 1.25 },
    haiku_35: { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1.00 },
    haiku_3: { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.3125 },
    default: { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 }
};
function getPricingForModel(modelName) {
    const lower = modelName.toLowerCase();
    if (lower.includes('opus')) {
        if (lower.includes('4-5') || lower.includes('4-6') || lower.includes('4-7'))
            return MODEL_PRICING.opus_new;
        return MODEL_PRICING.opus_legacy;
    }
    if (lower.includes('haiku')) {
        if (lower.includes('4-5') || lower.includes('4.5'))
            return MODEL_PRICING.haiku_45;
        if (lower.includes('3-5') || lower.includes('3.5'))
            return MODEL_PRICING.haiku_35;
        if (lower.includes('3-haiku'))
            return MODEL_PRICING.haiku_3;
        return MODEL_PRICING.haiku_45;
    }
    if (lower.includes('sonnet'))
        return MODEL_PRICING.sonnet;
    return MODEL_PRICING.default;
}
/**
 * Truncate all data (for recalculate/reset)
 */
function truncateAllData() {
    if (!db)
        return;
    try {
        db.run(`DELETE FROM daily_snapshots`);
        db.run(`DELETE FROM model_usage`);
        db.run(`DELETE FROM project_daily_stats`);
        db.run(`DELETE FROM sessions`);
        db.run(`DELETE FROM tool_usage_daily`);
        db.run(`DELETE FROM work_classification_daily`);
        db.run(`DELETE FROM file_type_daily`);
        db.run(`DELETE FROM hourly_distribution`);
        db.run(`DELETE FROM model_switches`);
        db.run(`DELETE FROM cache_efficiency_daily`);
        // Keep projects table (lookup, not time-series)
        // Keep external_additions and external_model_additions (managed by sidecar JSON)
        saveDatabase();
        console.log('Claude Analytics: Database truncated');
    }
    catch (error) {
        console.error('Claude Analytics: Failed to truncate database:', error);
    }
}
/**
 * Export all data for Gist sync (with machine ID)
 */
function exportForGistSync() {
    const currentMachineId = getMachineId();
    const snapshots = getAllDailySnapshots().map(s => ({
        ...s,
        machine_id: currentMachineId
    }));
    const modelUsage = getAllModelUsage().map(m => ({
        ...m,
        machine_id: currentMachineId
    }));
    return {
        snapshots,
        modelUsage,
        projects: getAllProjects(),
        sessions: getSessions(),
        toolUsage: getToolUsageDaily(),
        workClassification: getWorkClassificationDaily(),
        fileTypes: getFileTypeDaily(),
        hourlyDistribution: getHourlyDistribution(),
        modelSwitches: getModelSwitches(),
        cacheEfficiency: getCacheEfficiencyDaily(),
        machineId: currentMachineId,
        metadata: {
            exportedAt: new Date().toISOString(),
            version: '3.0'
        }
    };
}
/**
 * Import and merge data from Gist (combines data from multiple machines)
 */
function importAndMergeFromGist(gistData) {
    if (!db)
        return { imported: 0, merged: 0 };
    const currentMachineId = getMachineId();
    let imported = 0;
    let merged = 0;
    // Get existing dates for this machine
    const existingDates = getExistingDates();
    // Process snapshots - add data from other machines
    for (const snapshot of gistData.snapshots || []) {
        const remoteMachineId = snapshot.machine_id || gistData.machineId || 'unknown';
        // Skip if this is our own data (we already have it)
        if (remoteMachineId === currentMachineId) {
            continue;
        }
        // Check if we have this date already
        if (existingDates.has(snapshot.date)) {
            // Merge: update existing record by adding remote values
            const existing = db.exec(`SELECT cost, messages, tokens, sessions FROM daily_snapshots WHERE date = ?`, [snapshot.date]);
            if (existing.length > 0 && existing[0].values.length > 0) {
                const row = existing[0].values[0];
                const newCost = row[0] + (snapshot.cost || 0);
                const newMessages = row[1] + (snapshot.messages || 0);
                const newTokens = row[2] + (snapshot.tokens || 0);
                const newSessions = row[3] + (snapshot.sessions || 0);
                db.run(`UPDATE daily_snapshots SET cost = ?, messages = ?, tokens = ?, sessions = ? WHERE date = ?`, [newCost, newMessages, newTokens, newSessions, snapshot.date]);
                merged++;
            }
        }
        else {
            // Insert new record
            saveDailySnapshot({
                date: snapshot.date,
                cost: snapshot.cost || 0,
                messages: snapshot.messages || 0,
                tokens: snapshot.tokens || 0,
                sessions: snapshot.sessions || 0
            });
            imported++;
        }
    }
    // Process model usage similarly
    for (const usage of gistData.modelUsage || []) {
        const remoteMachineId = usage.machine_id || gistData.machineId || 'unknown';
        if (remoteMachineId === currentMachineId) {
            continue;
        }
        // Check existing
        const existing = db.exec(`SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM model_usage WHERE date = ? AND model = ?`, [usage.date, usage.model]);
        if (existing.length > 0 && existing[0].values.length > 0) {
            // Merge by adding
            const row = existing[0].values[0];
            db.run(`UPDATE model_usage SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ? WHERE date = ? AND model = ?`, [row[0] + (usage.inputTokens || 0),
                row[1] + (usage.outputTokens || 0),
                row[2] + (usage.cacheReadTokens || 0),
                row[3] + (usage.cacheWriteTokens || 0),
                usage.date, usage.model]);
        }
        else {
            saveModelUsage({
                date: usage.date,
                model: usage.model,
                inputTokens: usage.inputTokens || 0,
                outputTokens: usage.outputTokens || 0,
                cacheReadTokens: usage.cacheReadTokens || 0,
                cacheWriteTokens: usage.cacheWriteTokens || 0
            });
        }
    }
    saveDatabase();
    return { imported, merged };
}
//# sourceMappingURL=database.js.map