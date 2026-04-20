#!/usr/bin/env node
/**
 * Generates conversation-stats-cache.json by analyzing message content
 * from Claude Code JSONL files. This populates the Personality tab,
 * Request Types, and hourCounts in the claude-usage-analytics extension.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const claudeDir = path.join(os.homedir(), '.claude', 'projects');
const outputPath = path.join(os.homedir(), '.claude', 'conversation-stats-cache.json');

// Request type patterns (matches the Python backfill patterns)
const REQUEST_PATTERNS = {
    debugging: /\b(debug|error|bug|fix|issue|problem|broken|crash|fail|exception|traceback|stack\s*trace|not\s*working|doesn'?t\s*work)\b/i,
    features: /\b(add|create|implement|build|new\s*feature|feature|functionality|capability|make\s*a|write\s*a|generate)\b/i,
    explain: /\b(explain|how\s*does|what\s*is|what\s*does|why\s*does|understand|clarify|describe|what'?s\s*the\s*difference|can\s*you\s*tell\s*me)\b/i,
    refactor: /\b(refactor|clean\s*up|reorganize|restructure|improve|optimize|simplify|rewrite|dry|duplication)\b/i,
    review: /\b(review|check|look\s*at|examine|audit|inspect|feedback|code\s*review|pr\s*review)\b/i,
    testing: /\b(test|testing|unit\s*test|spec|coverage|assert|mock|pytest|jest|e2e|integration\s*test)\b/i
};

// Sentiment patterns
const SENTIMENT_PATTERNS = {
    positive: /\b(great|awesome|perfect|thanks|thank\s*you|nice|good\s*job|well\s*done|love\s*it|excellent|amazing|wonderful|brilliant|fantastic)\b/i,
    negative: /\b(terrible|awful|horrible|hate|worst|annoying|frustrated|useless|waste|stupid|dumb|sucks|disappointed)\b/i,
    urgent: /\b(urgent|asap|immediately|critical|emergency|deadline|rush|hurry|right\s*now|quickly|fast)\b/i,
    confused: /\b(confused|don'?t\s*understand|makes?\s*no\s*sense|what\s*do\s*you\s*mean|unclear|lost|huh|wait\s*what|i'?m\s*not\s*sure)\b/i
};

// Stats accumulator
const stats = {
    curseWords: 0,
    totalWords: 0,
    longestMessage: 0,
    questionsAsked: 0,
    exclamations: 0,
    thanksCount: 0,
    sorryCount: 0,
    emojiCount: 0,
    capsLockMessages: 0,
    codeBlocks: 0,
    linesOfCode: 0,
    topLanguages: {},
    requestTypes: { debugging: 0, features: 0, explain: 0, refactor: 0, review: 0, testing: 0 },
    sentiment: { positive: 0, negative: 0, urgent: 0, confused: 0 },
    pleaseCount: 0,
    lolCount: 0,
    facepalms: 0,
    celebrationMoments: 0
};

const hourCounts = {};
let totalMessages = 0;

// Curse word patterns
const CURSE_PATTERN = /\b(damn|shit|fuck|crap|hell|ass|bloody|wtf|ffs|omfg|stfu)\b/i;
const EMOJI_PATTERN = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
const CELEBRATION_PATTERN = /\b(yay|woohoo|hurray|hooray|wahoo|woot|yes!|awesome!|finally!|it\s*works|nailed\s*it|got\s*it)\b/i;
const FACEPALM_PATTERN = /\b(facepalm|smh|ugh|argh|doh|oops|my\s*bad|silly\s*me|i'?m\s*an?\s*idiot)\b/i;

function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(c => typeof c === 'object' && c.type === 'text' && c.text)
            .map(c => c.text)
            .join(' ');
    }
    return '';
}

function analyzeMessage(text) {
    if (!text || text.length === 0) return;

    const words = text.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;
    stats.totalWords += wordCount;

    if (wordCount > stats.longestMessage) {
        stats.longestMessage = wordCount;
    }

    // Questions
    const questionMarks = (text.match(/\?/g) || []).length;
    stats.questionsAsked += questionMarks;

    // Exclamations
    const exclamationMarks = (text.match(/!/g) || []).length;
    stats.exclamations += exclamationMarks;

    // Thanks
    if (/\b(thanks|thank\s*you|thx|ty)\b/i.test(text)) stats.thanksCount++;

    // Please
    if (/\bplease\b/i.test(text)) stats.pleaseCount++;

    // Sorry
    if (/\b(sorry|apolog)/i.test(text)) stats.sorryCount++;

    // LOL
    if (/\b(lol|lmao|rofl|haha|hehe)\b/i.test(text)) stats.lolCount++;

    // Curse words
    const curseMatches = text.match(new RegExp(CURSE_PATTERN.source, 'gi'));
    if (curseMatches) stats.curseWords += curseMatches.length;

    // Emojis
    const emojiMatches = text.match(EMOJI_PATTERN);
    if (emojiMatches) stats.emojiCount += emojiMatches.length;

    // CAPS LOCK messages (more than 50% uppercase, at least 10 chars)
    if (text.length >= 10) {
        const upperChars = (text.match(/[A-Z]/g) || []).length;
        const letterChars = (text.match(/[a-zA-Z]/g) || []).length;
        if (letterChars > 0 && (upperChars / letterChars) > 0.5) {
            stats.capsLockMessages++;
        }
    }

    // Celebrations
    if (CELEBRATION_PATTERN.test(text)) stats.celebrationMoments++;

    // Facepalms
    if (FACEPALM_PATTERN.test(text)) stats.facepalms++;

    // Request types
    for (const [type, pattern] of Object.entries(REQUEST_PATTERNS)) {
        if (pattern.test(text)) stats.requestTypes[type]++;
    }

    // Sentiment
    for (const [type, pattern] of Object.entries(SENTIMENT_PATTERNS)) {
        if (pattern.test(text)) stats.sentiment[type]++;
    }

    // Code blocks (in assistant messages we'd count these, but for user messages count requests for code)
    const codeBlockMatches = text.match(/```(\w*)/g);
    if (codeBlockMatches) {
        stats.codeBlocks += codeBlockMatches.length;
        for (const match of codeBlockMatches) {
            const lang = match.replace('```', '').trim();
            if (lang) {
                stats.topLanguages[lang] = (stats.topLanguages[lang] || 0) + 1;
            }
        }
    }

    // Lines of code (rough estimate from code blocks)
    const codeBlocks = text.match(/```[\s\S]*?```/g);
    if (codeBlocks) {
        for (const block of codeBlocks) {
            stats.linesOfCode += block.split('\n').length - 2; // minus the ``` lines
        }
    }
}

function findJsonlFiles(dir, files = []) {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                findJsonlFiles(fullPath, files);
            } else if (entry.name.endsWith('.jsonl')) {
                files.push(fullPath);
            }
        }
    } catch (e) { }
    return files;
}

async function processFile(filePath) {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({
            input: fs.createReadStream(filePath),
            crlfDelay: Infinity
        });

        rl.on('line', (line) => {
            if (!line.trim()) return;
            try {
                const entry = JSON.parse(line);
                const timestamp = entry.timestamp || entry.ts;

                // Analyze user/human messages for personality
                if (entry.type === 'user' || entry.role === 'user') {
                    const content = entry.message?.content || entry.content;
                    const text = extractText(content);
                    if (text) {
                        analyzeMessage(text);
                        totalMessages++;
                    }
                }

                // Track hour counts from all messages with timestamps
                if (timestamp) {
                    const date = new Date(timestamp);
                    const hour = date.getHours();
                    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
                }

                // Count code blocks and lines from assistant messages too
                if (entry.type === 'assistant' || entry.role === 'assistant') {
                    const content = entry.message?.content || entry.content;
                    const text = extractText(content);
                    if (text) {
                        const codeBlockMatches = text.match(/```(\w*)/g);
                        if (codeBlockMatches) {
                            stats.codeBlocks += codeBlockMatches.length;
                            for (const match of codeBlockMatches) {
                                const lang = match.replace('```', '').trim();
                                if (lang) {
                                    stats.topLanguages[lang] = (stats.topLanguages[lang] || 0) + 1;
                                }
                            }
                        }
                        const codeBlocks = text.match(/```[\s\S]*?```/g);
                        if (codeBlocks) {
                            for (const block of codeBlocks) {
                                stats.linesOfCode += block.split('\n').length - 2;
                            }
                        }
                    }
                }
            } catch (e) { }
        });

        rl.on('close', () => resolve());
        rl.on('error', (err) => reject(err));
    });
}

async function main() {
    if (!fs.existsSync(claudeDir)) {
        console.error('Claude projects directory not found');
        process.exit(1);
    }

    const files = findJsonlFiles(claudeDir);
    console.error(`Found ${files.length} JSONL files to analyze...`);

    let processed = 0;
    for (const file of files) {
        try {
            await processFile(file);
            processed++;
            if (processed % 100 === 0) {
                console.error(`Processed ${processed}/${files.length} files...`);
            }
        } catch (e) { }
    }

    // Sort top languages, keep top 10
    const sortedLangs = Object.entries(stats.topLanguages)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    stats.topLanguages = Object.fromEntries(sortedLangs);

    const output = {
        stats,
        hourCounts,
        totalMessages,
        generatedAt: new Date().toISOString()
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.error(`\nDone! Analyzed ${processed} files, ${totalMessages} user messages.`);
    console.error(`Output written to ${outputPath}`);
    console.log(JSON.stringify({ success: true, messages: totalMessages, file: outputPath }));
}

main().catch(err => {
    console.error('Failed:', err);
    process.exit(1);
});
