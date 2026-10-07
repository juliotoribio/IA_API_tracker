const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'tracker.db');
const JSON_MIGRATION_FILE = path.join(__dirname, 'billing-data.json');

const db = new DatabaseSync(DB_PATH);

// Enable foreign keys and WAL mode for reliability & concurrency
db.exec('PRAGMA foreign_keys = ON;');

// 1. Initialize Schema
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      api_key TEXT,
      group_id TEXT,
      color TEXT,
      manual_recharged REAL DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS billing_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      date TEXT NOT NULL,
      remaining REAL NOT NULL,
      used REAL NOT NULL,
      topped_up REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_provider_date 
      ON billing_snapshots(provider_id, date);

    CREATE TABLE IF NOT EXISTS daily_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      date TEXT NOT NULL,
      spend_amount REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(provider_id, date),
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS model_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      date TEXT NOT NULL,
      tokens_prompt INTEGER DEFAULT 0,
      tokens_completion INTEGER DEFAULT 0,
      cost_usd REAL NOT NULL,
      UNIQUE(provider_id, model_name, date),
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recharge_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      amount REAL NOT NULL,
      timestamp TEXT NOT NULL,
      notes TEXT,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );
  `);
}

// 2. Migration from billing-data.json
function migrateFromJsonIfNeeded() {
  const countRow = db.prepare('SELECT COUNT(*) as count FROM providers').get();
  if (countRow.count > 0) return; // Already migrated or populated

  if (!fs.existsSync(JSON_MIGRATION_FILE)) return;

  try {
    const raw = fs.readFileSync(JSON_MIGRATION_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data.providers || !Array.isArray(data.providers)) return;

    console.log(`Migrating ${data.providers.length} providers from billing-data.json to SQLite...`);

    const insertProvider = db.prepare(`
      INSERT INTO providers (id, type, name, api_key, group_id, color, manual_recharged, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertSnapshot = db.prepare(`
      INSERT INTO billing_snapshots (provider_id, timestamp, date, remaining, used, topped_up, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertDaily = db.prepare(`
      INSERT OR REPLACE INTO daily_usage (provider_id, date, spend_amount)
      VALUES (?, ?, ?)
    `);

    const insertModel = db.prepare(`
      INSERT OR REPLACE INTO model_usage (provider_id, model_name, date, cost_usd)
      VALUES (?, ?, ?, ?)
    `);

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    // Seed realistic 30-day history profiles during migration
    const MODEL_MAP = {
      openrouter: [
        ['anthropic/claude-3.5-sonnet', 0.58],
        ['openai/gpt-4o-mini', 0.25],
        ['meta-llama/llama-3.3-70b', 0.17]
      ],
      openai: [
        ['gpt-4o-mini', 0.70],
        ['text-embedding-3-small', 0.30]
      ],
      google: [
        ['gemini-2.5-flash', 0.65],
        ['gemini-2.5-pro', 0.35]
      ],
      deepseek: [
        ['deepseek-chat', 1.0]
      ]
    };

    for (const p of data.providers) {
      const pid = p.id || `${p.type}_${Date.now()}`;
      insertProvider.run(
        pid,
        p.type,
        p.name || p.type,
        p.apiKey || '',
        p.groupId || '',
        p.color || '#3b82f6',
        p.manualRecharged || 0,
        p.billing?.currency || 'USD'
      );

      const remaining = p.billing?.remaining ?? (p.manualRecharged || 0);
      const used = p.billing?.used ?? 0;
      const toppedUp = p.billing?.topped_up ?? (p.manualRecharged || 0);

      // Latest snapshot
      insertSnapshot.run(
        pid,
        p.lastFetch || now.toISOString(),
        todayStr,
        remaining,
        used,
        toppedUp,
        'USD'
      );

      // Seed 30 daily usage records to power heatmap and charts immediately
      if (used > 0) {
        const models = MODEL_MAP[p.type] || [];
        for (let i = 29; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const dStr = d.toISOString().split('T')[0];
          // Weight more usage towards recent days
          const weight = (30 - i) / 465; // Sum of 1..30 is 465
          const daySpend = parseFloat((used * weight).toFixed(4));
          
          insertDaily.run(pid, dStr, daySpend);

          // Seed model breakdown for this day
          for (const [mName, share] of models) {
            insertModel.run(pid, mName, dStr, parseFloat((daySpend * share).toFixed(4)));
          }
        }
      }
    }

    console.log('Migration to SQLite completed successfully.');
  } catch (err) {
    console.error('Error during SQLite migration:', err);
  }
}

// 3. Data Access Operations
function getAllProviders() {
  const rows = db.prepare(`
    SELECT 
      p.*,
      s.remaining,
      s.used,
      s.topped_up,
      s.currency as billing_currency,
      s.timestamp as last_fetch
    FROM providers p
    LEFT JOIN (
      SELECT provider_id, remaining, used, topped_up, currency, timestamp,
             ROW_NUMBER() OVER (PARTITION BY provider_id ORDER BY id DESC) as rn
      FROM billing_snapshots
    ) s ON p.id = s.provider_id AND s.rn = 1
    ORDER BY p.name ASC
  `).all();

  return rows.map(r => ({
    id: r.id,
    type: r.type,
    name: r.name,
    apiKey: r.api_key,
    groupId: r.group_id,
    color: r.color,
    manualRecharged: r.manual_recharged,
    lastFetch: r.last_fetch,
    billing: {
      remaining: r.remaining !== null ? r.remaining : r.manual_recharged,
      used: r.used !== null ? r.used : 0,
      topped_up: r.topped_up !== null ? r.topped_up : r.manual_recharged,
      currency: r.billing_currency || r.currency || 'USD'
    }
  }));
}

function getProviderByType(type) {
  const row = db.prepare('SELECT * FROM providers WHERE type = ?').get(type);
  if (!row) return null;
  const snapshot = db.prepare(`
    SELECT * FROM billing_snapshots 
    WHERE provider_id = ? 
    ORDER BY id DESC LIMIT 1
  `).get(row.id);

  return {
    id: row.id,
    type: row.type,
    name: row.name,
    apiKey: row.api_key,
    groupId: row.group_id,
    color: row.color,
    manualRecharged: row.manual_recharged,
    billing: snapshot ? {
      remaining: snapshot.remaining,
      used: snapshot.used,
      topped_up: snapshot.topped_up,
      currency: snapshot.currency
    } : {}
  };
}

function upsertProvider({ type, name, apiKey, groupId, color, manualRecharged }) {
  const existing = db.prepare('SELECT id FROM providers WHERE type = ?').get(type);
  const now = new Date().toISOString();

  if (existing) {
    db.prepare(`
      UPDATE providers 
      SET name = ?, api_key = ?, group_id = ?, color = ?, manual_recharged = ?, updated_at = ?
      WHERE id = ?
    `).run(name, apiKey || '', groupId || '', color || '#3b82f6', parseFloat(manualRecharged) || 0, now, existing.id);
    return existing.id;
  } else {
    const id = `${type}_${Date.now()}`;
    db.prepare(`
      INSERT INTO providers (id, type, name, api_key, group_id, color, manual_recharged, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'USD')
    `).run(id, type, name, apiKey || '', groupId || '', color || '#3b82f6', parseFloat(manualRecharged) || 0);
    return id;
  }
}

function deleteProvider(type) {
  const prov = db.prepare('SELECT id FROM providers WHERE type = ?').get(type);
  if (prov) {
    db.prepare('DELETE FROM providers WHERE id = ?').run(prov.id);
  }
}

function recordSnapshot(providerId, { remaining, used, topped_up, currency = 'USD' }) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  db.prepare(`
    INSERT INTO billing_snapshots (provider_id, timestamp, date, remaining, used, topped_up, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    providerId,
    now.toISOString(),
    dateStr,
    parseFloat(remaining) || 0,
    parseFloat(used) || 0,
    parseFloat(topped_up) || 0,
    currency
  );

  // Compute delta spend for today
  const prevSnapshot = db.prepare(`
    SELECT used FROM billing_snapshots 
    WHERE provider_id = ? AND id < (SELECT MAX(id) FROM billing_snapshots WHERE provider_id = ?)
    ORDER BY id DESC LIMIT 1
  `).get(providerId, providerId);

  const prevUsed = prevSnapshot ? prevSnapshot.used : 0;
  const delta = Math.max(0, (parseFloat(used) || 0) - prevUsed);

  if (delta > 0) {
    db.prepare(`
      INSERT INTO daily_usage (provider_id, date, spend_amount)
      VALUES (?, ?, ?)
      ON CONFLICT(provider_id, date) DO UPDATE SET spend_amount = spend_amount + ?
    `).run(providerId, dateStr, delta, delta);
  }
}

function getDailyUsage(providerId, days = 30) {
  return db.prepare(`
    SELECT date, spend_amount 
    FROM daily_usage 
    WHERE provider_id = ?
    ORDER BY date DESC 
    LIMIT ?
  `).all(providerId, days);
}

function getModelUsage(providerId, days = 30) {
  return db.prepare(`
    SELECT model_name, SUM(cost_usd) as total_usd, SUM(tokens_prompt) as total_prompt, SUM(tokens_completion) as total_completion
    FROM model_usage
    WHERE provider_id = ?
    GROUP BY model_name
    ORDER BY total_usd DESC
  `).all(providerId);
}

function recordRecharge(providerId, amount, notes = '') {
  db.prepare(`
    INSERT INTO recharge_history (provider_id, amount, timestamp, notes)
    VALUES (?, ?, datetime('now'), ?)
  `).run(providerId, parseFloat(amount), notes);
}

// Initialize on require
initSchema();
migrateFromJsonIfNeeded();

module.exports = {
  db,
  getAllProviders,
  getProviderByType,
  upsertProvider,
  deleteProvider,
  recordSnapshot,
  getDailyUsage,
  getModelUsage,
  recordRecharge
};
