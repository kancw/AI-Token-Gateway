require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_gateway_signing_key_32bytes';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. PERSISTENT STORAGE (SQLite in WAL mode)
// ==========================================
const db = new Database(path.join(__dirname, 'usage.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS token_usage (
    user_id TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, model)
  );
  CREATE INDEX IF NOT EXISTS idx_user ON token_usage(user_id);
`);

const stmtGetUsage = db.prepare('SELECT model, tokens_used FROM token_usage WHERE user_id = ?');
const stmtUpsertUsage = db.prepare(`
  INSERT INTO token_usage (user_id, model, tokens_used, updated_at)
  VALUES (@user_id, @model, @tokens_used, CURRENT_TIMESTAMP)
  ON CONFLICT(user_id, model) DO UPDATE SET
    tokens_used = tokens_used + excluded.tokens_used,
    updated_at = CURRENT_TIMESTAMP
`);

function getUserUsage(userId) {
    const rows = stmtGetUsage.all(userId.toString());
    const usage = { 'gemini-flash': 0, 'gemini-pro': 0 };
    for (const r of rows) {
        usage[r.model] = r.tokens_used;
    }
    return usage;
}

function recordTokenUsage(userId, model, tokens) {
    stmtUpsertUsage.run({
        user_id: userId.toString(),
        model: model,
        tokens_used: Math.round(tokens)
    });
}

// ==========================================
// 2. TIER CONFIGURATION & MODEL MAPPING
// ==========================================
const MODEL_MAPPING = {
    'gemini-flash': process.env.GEMINI_MODEL_FLASH || 'gemini-2.5-flash',
    'gemini-pro': process.env.GEMINI_MODEL_PRO || 'gemini-2.5-pro'
};

const TIER_CONFIG = {
    1: {
        name: 'Starter (Tier 1)',
        allowedModels: ['gemini-flash'],
        limits: { 'gemini-flash': 100000 } // 100k tokens
    },
    2: {
        name: 'Developer (Tier 2)',
        allowedModels: ['gemini-flash'],
        limits: { 'gemini-flash': 500000 } // 500k tokens
    },
    3: {
        name: 'Enterprise (Tier 3)',
        allowedModels: ['gemini-flash', 'gemini-pro'],
        limits: { 'gemini-flash': 2000000, 'gemini-pro': 500000 } // 2M Flash, 500k Pro
    }
};

// ==========================================
// 3. AUTHENTICATION & DEMO TOKEN ISSUER
// ==========================================
function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: 'Missing Bearer authentication token.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid or expired authentication token.' });
    }
}

// Instant token generation for UI testing
app.post('/api/auth/demo-token', (req, res) => {
    const tier = parseInt(req.body.tier, 10) || 1;
    const userId = req.body.userId || `user_tier_${tier}`;
    
    if (!TIER_CONFIG[tier]) {
        return res.status(400).json({ error: 'Invalid tier specified (must be 1, 2, or 3).' });
    }

    const payload = {
        user_id: userId,
        user_tier: tier,
        issued_at: Date.now()
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user_id: userId, user_tier: tier, tier_name: TIER_CONFIG[tier].name });
});

// ==========================================
// 4. CHAT ROUTING & GEMINI STREAMING PROXY
// ==========================================
app.post('/api/chat', authenticateToken, async (req, res) => {
    try {
        const { query, model = 'gemini-flash', history = [] } = req.body;
        const userId = req.user.user_id;
        const userTier = req.user.user_tier || 1;

        if (!GEMINI_API_KEY) {
            return res.status(500).json({
                error: 'GEMINI_API_KEY is not configured in .env. Get a free API key at https://aistudio.google.com and add it to .env.'
            });
        }

        const tierConfig = TIER_CONFIG[userTier];
        if (!tierConfig || !tierConfig.allowedModels.includes(model)) {
            return res.status(403).json({
                error: `Tier ${userTier} (${tierConfig?.name || 'Unknown'}) is not authorized to use '${model}'. Please switch to an allowed model or upgrade your tier.`
            });
        }

        const currentUsage = getUserUsage(userId);
        const maxLimit = tierConfig.limits[model] || 0;
        if (currentUsage[model] >= maxLimit) {
            return res.status(429).json({
                error: `Token quota exceeded for model '${model}'. Used: ${currentUsage[model]} / ${maxLimit} tokens.`
            });
        }

        const actualGeminiModel = MODEL_MAPPING[model] || 'gemini-2.5-flash';
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${actualGeminiModel}:streamGenerateContent?alt=sse`;

        // Format conversational contents for Gemini API
        const contents = [];
        if (Array.isArray(history) && history.length > 0) {
            for (const item of history) {
                if (item.role && item.text) {
                    contents.push({
                        role: item.role === 'user' ? 'user' : 'model',
                        parts: [{ text: item.text }]
                    });
                }
            }
        }
        contents.push({
            role: 'user',
            parts: [{ text: query }]
        });

        const geminiResponse = await fetch(geminiUrl, {
            method: 'POST',
            headers: {
                'x-goog-api-key': GEMINI_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: contents,
                generationConfig: {
                    temperature: 0.7
                }
            })
        });

        if (!geminiResponse.ok) {
            const errText = await geminiResponse.text();
            console.error('Gemini API Error:', errText);
            return res.status(geminiResponse.status).json({
                error: `Google Gemini API error (${geminiResponse.status}): ${errText}`
            });
        }

        // Set up SSE headers for client streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let streamBuffer = '';
        let totalTokensReported = null;

        for await (const chunk of geminiResponse.body) {
            streamBuffer += Buffer.from(chunk).toString('utf8');
            const lines = streamBuffer.split(/\r?\n/);
            streamBuffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const parsed = JSON.parse(line.slice(6));
                    
                    // Extract streaming text chunk
                    const candidate = parsed.candidates?.[0];
                    const partText = candidate?.content?.parts?.[0]?.text;
                    if (partText) {
                        res.write(`data: ${JSON.stringify({ text: partText })}\n\n`);
                    }

                    // Extract exact token counts from Gemini metadata
                    if (parsed.usageMetadata?.totalTokenCount) {
                        totalTokensReported = parsed.usageMetadata.totalTokenCount;
                    }
                } catch (e) {
                    // Skip malformed chunk
                }
            }
        }

        // If Gemini provided exact token counts, record them in SQLite
        if (totalTokensReported) {
            recordTokenUsage(userId, model, totalTokensReported);
            console.log(`[Usage Recorded] User '${userId}' consumed ${totalTokensReported} tokens on ${model}.`);
        } else {
            // Fallback estimation if usageMetadata was omitted
            const estimatedTokens = Math.max(10, Math.round(query.length / 4));
            recordTokenUsage(userId, model, estimatedTokens);
        }

        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();

    } catch (error) {
        console.error('Gateway Streaming Error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal gateway error processing Gemini stream.' });
        } else {
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        }
    }
});

// ==========================================
// 5. TOKEN USAGE & ANALYTICS ENDPOINT
// ==========================================
app.get('/api/usage', authenticateToken, (req, res) => {
    const userTier = req.user.user_tier || 1;
    const tierConfig = TIER_CONFIG[userTier];
    if (!tierConfig) return res.status(403).json({ error: 'Unrecognized user tier.' });

    const userUsage = getUserUsage(req.user.user_id);
    const usage = {};
    tierConfig.allowedModels.forEach(model => {
        const limit = tierConfig.limits[model] || 0;
        const used = userUsage[model] || 0;
        usage[model] = {
            used,
            limit,
            remaining: Math.max(0, limit - used)
        };
    });

    res.json({
        userId: req.user.user_id,
        userTier: userTier,
        tierName: tierConfig.name,
        allowedModels: tierConfig.allowedModels,
        usage: usage
    });
});

app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`⚡ OmniGateway is running at http://localhost:${PORT}`);
    console.log(`🔑 Connected to Google Gemini API: ${GEMINI_API_KEY ? 'Configured ✅' : 'Missing API Key ⚠️'}`);
    console.log(`======================================================\n`);
});
