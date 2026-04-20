#!/usr/bin/env node
/**
 * Scans Claude Code JSONL files for today's usage data
 * Outputs to ~/.claude/live-today-stats.json
 *
 * v3: Also extracts enriched data (tools, files, hours, project, cache details)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Model pricing per million tokens - shared with TypeScript modules
const MODEL_PRICING = require('../modelPricing.json');

function getModelPricing(modelId) {
    if (!modelId) return MODEL_PRICING['default'];
    for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
        if (modelId.includes(key) || key.includes(modelId)) {
            return pricing;
        }
    }
    if (modelId.includes('opus')) return MODEL_PRICING['claude-3-opus-20240229'];
    if (modelId.includes('haiku')) return MODEL_PRICING['claude-3-5-haiku-20241022'];
    return MODEL_PRICING['default'];
}

function calculateCost(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, modelId) {
    const pricing = getModelPricing(modelId);
    const cacheReadRate = pricing.input * 0.1;
    const cacheWriteRate = pricing.input * 1.25;

    return (inputTokens / 1_000_000) * pricing.input +
           (outputTokens / 1_000_000) * pricing.output +
           (cacheReadTokens / 1_000_000) * cacheReadRate +
           (cacheWriteTokens / 1_000_000) * cacheWriteRate;
}

function getFileExtension(filePath) {
    if (!filePath) return null;
    const ext = path.extname(filePath).toLowerCase();
    return ext || null;
}

function getTodayDateString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function scanJsonlFiles() {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    const today = getTodayDateString();

    const stats = {
        date: today,
        messages: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cost: 0,
        models: {},
        filesScanned: 0,
        conversations: 0,
        scanTime: new Date().toISOString(),
        // v3 enriched data
        enriched: {
            toolUsage: {},       // { project: { tool: { invocations, durationMs } } }
            fileTypes: {},       // { project: { ext: { read, edited, created } } }
            hourly: {},          // { hour: { messages, tokens, cost } }
            projectStats: {},    // { project: { messages, sessions } }
            cacheEfficiency: {}, // { project: { model: { totalInput, cacheRead, cacheWrite, eph5m, eph1h } } }
            sessions: []         // [{ sessionId, projectPath, ... }]
        }
    };

    if (!fs.existsSync(claudeDir)) {
        return stats;
    }

    // Track sessions we've seen
    const seenSessions = new Set();

    function processDirectory(dirPath) {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    processDirectory(fullPath);
                } else if (entry.name.endsWith('.jsonl')) {
                    try {
                        const stat = fs.statSync(fullPath);
                        const mdate = `${stat.mtime.getFullYear()}-${String(stat.mtime.getMonth() + 1).padStart(2, '0')}-${String(stat.mtime.getDate()).padStart(2, '0')}`;
                        if (mdate === today) {
                            processJsonlFile(fullPath);
                        }
                    } catch (_e) {
                        // Skip files we can't stat
                    }
                }
            }
        } catch (e) {
            // Skip directories we can't access
        }
    }

    function processJsonlFile(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n').filter(l => l.trim());
            let hasToday = false;

            // Per-file session tracking
            let fileSessionId = null;
            let fileProjectPath = null;
            let fileGitBranch = null;
            let fileClaudeVersion = null;
            let fileStartTime = null;
            let fileEndTime = null;
            let fileMessages = 0;
            const fileToolCounts = {};
            const fileModelSequence = [];

            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);

                    // Capture session metadata
                    if (!fileSessionId && entry.sessionId) fileSessionId = entry.sessionId;
                    if (!fileProjectPath && entry.cwd) fileProjectPath = entry.cwd;
                    if (!fileGitBranch && entry.gitBranch) fileGitBranch = entry.gitBranch;
                    if (!fileClaudeVersion && entry.version) fileClaudeVersion = entry.version;

                    const timestamp = entry.timestamp || entry.ts;
                    if (!timestamp) continue;

                    const entryDateObj = new Date(timestamp);
                    const entryDate = `${entryDateObj.getFullYear()}-${String(entryDateObj.getMonth() + 1).padStart(2, '0')}-${String(entryDateObj.getDate()).padStart(2, '0')}`;
                    if (entryDate !== today) continue;

                    hasToday = true;

                    if (!fileStartTime || timestamp < fileStartTime) fileStartTime = timestamp;
                    if (!fileEndTime || timestamp > fileEndTime) fileEndTime = timestamp;

                    const projKey = fileProjectPath || 'unknown';

                    // Extract tool names from assistant tool_use blocks
                    if ((entry.type === 'assistant' || entry.role === 'assistant') && entry.message?.content) {
                        for (const block of entry.message.content) {
                            if (block.type === 'tool_use' && block.name) {
                                fileToolCounts[block.name] = (fileToolCounts[block.name] || 0) + 1;

                                if (!stats.enriched.toolUsage[projKey]) stats.enriched.toolUsage[projKey] = {};
                                if (!stats.enriched.toolUsage[projKey][block.name]) {
                                    stats.enriched.toolUsage[projKey][block.name] = { invocations: 0, durationMs: 0 };
                                }
                                stats.enriched.toolUsage[projKey][block.name].invocations++;
                            }
                        }
                    }

                    // Extract tool results (file paths, durations)
                    if (entry.toolUseResult) {
                        const tr = entry.toolUseResult;
                        if (tr.durationMs && tr.type) {
                            if (!stats.enriched.toolUsage[projKey]) stats.enriched.toolUsage[projKey] = {};
                            if (!stats.enriched.toolUsage[projKey][tr.type]) {
                                stats.enriched.toolUsage[projKey][tr.type] = { invocations: 0, durationMs: 0 };
                            }
                            stats.enriched.toolUsage[projKey][tr.type].durationMs += tr.durationMs;
                        }

                        // File operations
                        const fp = tr.filePath || tr.file?.filePath;
                        if (fp) {
                            const ext = getFileExtension(fp);
                            if (ext) {
                                if (!stats.enriched.fileTypes[projKey]) stats.enriched.fileTypes[projKey] = {};
                                if (!stats.enriched.fileTypes[projKey][ext]) {
                                    stats.enriched.fileTypes[projKey][ext] = { read: 0, edited: 0, created: 0 };
                                }
                                if (tr.type === 'text' || tr.type === 'Read') {
                                    stats.enriched.fileTypes[projKey][ext].read++;
                                } else if (tr.oldString !== undefined || tr.structuredPatch) {
                                    stats.enriched.fileTypes[projKey][ext].edited++;
                                } else if (tr.type === 'Write') {
                                    stats.enriched.fileTypes[projKey][ext].created++;
                                }
                            }
                        }

                        if (tr.filenames && Array.isArray(tr.filenames)) {
                            for (const f of tr.filenames) {
                                const ext = getFileExtension(f);
                                if (ext) {
                                    if (!stats.enriched.fileTypes[projKey]) stats.enriched.fileTypes[projKey] = {};
                                    if (!stats.enriched.fileTypes[projKey][ext]) {
                                        stats.enriched.fileTypes[projKey][ext] = { read: 0, edited: 0, created: 0 };
                                    }
                                    stats.enriched.fileTypes[projKey][ext].read++;
                                }
                            }
                        }
                    }

                    // Count messages
                    if (entry.type === 'assistant' || entry.role === 'assistant') {
                        stats.messages++;
                        fileMessages++;

                        const usage = entry.message?.usage || entry.usage;
                        if (usage) {
                            const inputTokens = usage.input_tokens || 0;
                            const outputTokens = usage.output_tokens || 0;
                            const cacheReadTokens = usage.cache_read_input_tokens || 0;
                            const cacheWriteTokens = usage.cache_creation_input_tokens || 0;

                            stats.inputTokens += inputTokens;
                            stats.outputTokens += outputTokens;
                            stats.cacheReadTokens += cacheReadTokens;
                            stats.cacheWriteTokens += cacheWriteTokens;
                            stats.totalTokens += inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

                            const model = entry.message?.model || entry.model || 'default';
                            const cost = calculateCost(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, model);
                            stats.cost += cost;

                            fileModelSequence.push(model);

                            // Track by model
                            if (!stats.models[model]) {
                                stats.models[model] = {
                                    messages: 0, inputTokens: 0, outputTokens: 0,
                                    cacheReadTokens: 0, cacheWriteTokens: 0, tokens: 0, cost: 0
                                };
                            }
                            stats.models[model].messages++;
                            stats.models[model].inputTokens += inputTokens;
                            stats.models[model].outputTokens += outputTokens;
                            stats.models[model].cacheReadTokens += cacheReadTokens;
                            stats.models[model].cacheWriteTokens += cacheWriteTokens;
                            stats.models[model].tokens += inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
                            stats.models[model].cost += cost;

                            // Hourly distribution
                            const hour = entryDateObj.getHours();
                            if (!stats.enriched.hourly[hour]) stats.enriched.hourly[hour] = { messages: 0, tokens: 0, cost: 0 };
                            stats.enriched.hourly[hour].messages++;
                            stats.enriched.hourly[hour].tokens += inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
                            stats.enriched.hourly[hour].cost += cost;

                            // Cache efficiency
                            const eph5m = usage.cache_creation?.ephemeral_5m_input_tokens || 0;
                            const eph1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;

                            if (!stats.enriched.cacheEfficiency[projKey]) stats.enriched.cacheEfficiency[projKey] = {};
                            if (!stats.enriched.cacheEfficiency[projKey][model]) {
                                stats.enriched.cacheEfficiency[projKey][model] = { totalInput: 0, cacheRead: 0, cacheWrite: 0, eph5m: 0, eph1h: 0 };
                            }
                            stats.enriched.cacheEfficiency[projKey][model].totalInput += inputTokens;
                            stats.enriched.cacheEfficiency[projKey][model].cacheRead += cacheReadTokens;
                            stats.enriched.cacheEfficiency[projKey][model].cacheWrite += cacheWriteTokens;
                            stats.enriched.cacheEfficiency[projKey][model].eph5m += eph5m;
                            stats.enriched.cacheEfficiency[projKey][model].eph1h += eph1h;

                            // Project stats
                            if (!stats.enriched.projectStats[projKey]) {
                                stats.enriched.projectStats[projKey] = { messages: 0, sessions: 0 };
                            }
                            stats.enriched.projectStats[projKey].messages++;
                        }
                    }
                } catch (e) {
                    // Skip malformed lines
                }
            }

            if (hasToday) {
                stats.filesScanned++;
                stats.conversations++;

                // Count unique sessions per project
                if (fileSessionId && !seenSessions.has(fileSessionId)) {
                    seenSessions.add(fileSessionId);
                    const projKey = fileProjectPath || 'unknown';
                    if (stats.enriched.projectStats[projKey]) {
                        stats.enriched.projectStats[projKey].sessions++;
                    }
                }
            }
        } catch (e) {
            // Skip files we can't read
        }
    }

    processDirectory(claudeDir);

    // Round cost for display
    stats.cost = Math.round(stats.cost * 100) / 100;

    return stats;
}

// Main execution
const stats = scanJsonlFiles();
const outputPath = path.join(os.homedir(), '.claude', 'live-today-stats.json');

fs.writeFileSync(outputPath, JSON.stringify(stats, null, 2));

// Output for child process to capture
console.log(JSON.stringify(stats));
