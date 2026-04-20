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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBackfill = runBackfill;
exports.importBackfillResults = importBackfillResults;
exports.runBackfillWithProgress = runBackfillWithProgress;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const database_1 = require("./database");
const modelPricing_json_1 = __importDefault(require("../modelPricing.json"));
function getModelPricing(modelId) {
    if (!modelId)
        return modelPricing_json_1.default['default'];
    for (const [key, pricing] of Object.entries(modelPricing_json_1.default)) {
        if (modelId.includes(key) || key.includes(modelId)) {
            return pricing;
        }
    }
    if (modelId.includes('opus'))
        return modelPricing_json_1.default['claude-3-opus-20240229'];
    if (modelId.includes('haiku'))
        return modelPricing_json_1.default['claude-3-5-haiku-20241022'];
    return modelPricing_json_1.default['default'];
}
function calculateCost(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, modelId) {
    const pricing = getModelPricing(modelId);
    const cacheReadRate = pricing.input * 0.1; // 90% discount
    const cacheWriteRate = pricing.input * 1.25; // 25% premium
    return (inputTokens / 1000000) * pricing.input +
        (outputTokens / 1000000) * pricing.output +
        (cacheReadTokens / 1000000) * cacheReadRate +
        (cacheWriteTokens / 1000000) * cacheWriteRate;
}
/**
 * Run the JSONL backfill process
 * @param extensionPath Path to the extension folder (for finding the script)
 * @param incremental If true, only scan files changed since last run
 * @returns Promise with the backfill results
 */
async function runBackfill(extensionPath, incremental = false) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(extensionPath, 'tools', 'backfill-jsonl.js');
        const args = incremental ? ['--incremental'] : [];
        // Use VSCode's bundled Node.js runtime to avoid "spawn node ENOENT" errors
        // when Node.js is not in system PATH
        const nodePath = process.execPath;
        (0, child_process_1.execFile)(nodePath, [scriptPath, ...args], { timeout: 300000 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`Backfill script failed: ${error.message}`));
                return;
            }
            try {
                const result = JSON.parse(stdout.trim());
                if (result.error) {
                    reject(new Error(result.error));
                    return;
                }
                resolve(result);
            }
            catch (e) {
                reject(new Error(`Failed to parse backfill results: ${e}`));
            }
        });
    });
}
/**
 * Import backfill results into SQLite database
 * @param result The backfill result from runBackfill
 */
function importBackfillResults(result) {
    let daysImported = 0;
    let modelsImported = 0;
    for (const day of result.dailyStats) {
        // Save daily snapshot
        const snapshot = {
            date: day.date,
            cost: day.cost,
            messages: day.messages,
            tokens: day.totalTokens,
            sessions: day.sessions || 0 // Sessions counted from unique JSONL directories
        };
        (0, database_1.saveDailySnapshot)(snapshot);
        daysImported++;
        // Save model usage breakdown
        for (const model of day.models) {
            const usage = {
                date: day.date,
                model: model.model,
                inputTokens: model.inputTokens,
                outputTokens: model.outputTokens,
                cacheReadTokens: model.cacheReadTokens,
                cacheWriteTokens: model.cacheWriteTokens
            };
            (0, database_1.saveModelUsage)(usage);
            modelsImported++;
        }
    }
    // Persist to disk
    (0, database_1.saveDatabase)();
    return { daysImported, modelsImported };
}
/**
 * Run backfill with VS Code progress UI
 * @param extensionPath Path to the extension folder
 * @param incremental If true, only scan files changed since last run
 */
async function runBackfillWithProgress(extensionPath, incremental = false) {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: incremental ? 'Updating historical costs...' : 'Recalculating historical costs...',
        cancellable: false
    }, async (progress) => {
        progress.report({ message: 'Scanning JSONL files...' });
        try {
            const result = await runBackfill(extensionPath, incremental);
            progress.report({ message: `Importing ${result.dailyStats.length} days...` });
            const imported = importBackfillResults(result);
            return {
                daysImported: imported.daysImported,
                modelsImported: imported.modelsImported,
                filesScanned: result.filesScanned
            };
        }
        catch (error) {
            throw error;
        }
    });
}
//# sourceMappingURL=backfillManager.js.map