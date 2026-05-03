import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { connectWhatsApp, disconnectWhatsApp, getStatus } from './whatsapp.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3011;

// ── DATABASE ──────────────────────────────────────────────────────────────────

const db = new DatabaseSync(join(__dirname, 'database.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL DEFAULT '',
    brand     TEXT             DEFAULT '',
    flavor    TEXT             DEFAULT '',
    cost_usd  REAL             DEFAULT 0,
    price     REAL             DEFAULT 0,
    stock     INTEGER          DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS wa_contacts (
    jid        TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS api_daily_usage (
    date     TEXT PRIMARY KEY,
    cost_usd REAL    DEFAULT 0,
    calls    INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS wa_catalog_sent (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    jid          TEXT    NOT NULL,
    catalog_type TEXT    NOT NULL,
    sent_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS catalog_templates (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL DEFAULT 'Modelo',
    header       TEXT DEFAULT '',
    brand_format TEXT DEFAULT '*{brand}*',
    item_format  TEXT DEFAULT '  • {flavor} — R\${price}',
    separator    TEXT DEFAULT '',
    footer       TEXT DEFAULT ''
  );
`);

db.prepare(`INSERT OR IGNORE INTO config (key, value) VALUES ('cambio', '5.50')`).run();
db.prepare(`INSERT OR IGNORE INTO config (key, value) VALUES ('margem', '100')`).run();

// ── HELPERS ───────────────────────────────────────────────────────────────────

function getConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function generateCatalog(templateId) {
  const tpl = db.prepare('SELECT * FROM catalog_templates WHERE id = ?').get(templateId);
  if (!tpl) return null;

  const products = db
    .prepare('SELECT * FROM products WHERE stock > 0 ORDER BY brand, flavor')
    .all();

  const byBrand = {};
  for (const p of products) {
    const brand = p.brand || p.name;
    if (!byBrand[brand]) byBrand[brand] = [];
    byBrand[brand].push(p);
  }

  const lines = [];
  if (tpl.header) lines.push(tpl.header);

  const brandEntries = Object.entries(byBrand);
  brandEntries.forEach(([brand, items], bi) => {
    lines.push((tpl.brand_format || '*{brand}*').replace('{brand}', brand));
    for (const item of items) {
      const priceStr = (parseFloat(item.price) || 0).toLocaleString('pt-BR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      lines.push(
        (tpl.item_format || '  • {flavor} — R${price}')
          .replace('{flavor}', item.flavor || item.name)
          .replace('{price}', priceStr)
      );
    }
    if (tpl.separator && bi < brandEntries.length - 1) lines.push(tpl.separator);
  });

  if (tpl.footer) lines.push(tpl.footer);
  return lines.join('\n');
}

// ── CATÁLOGO DE PEPTÍDEOS (sem preços) ───────────────────────────────────────

function getPeptidesCatalog() {
  return `🧬 *Thera Genetics — Peptídeos Terapêuticos*
Produtos originais • Pronta entrega

⚖️ *Emagrecimento & Metabolismo*
  ▸ Retatrutide 40mg
  ▸ Retatrutide 10mg
  ▸ Tirzepatide 15mg

🔄 *Regeneração & Anti-inflamatório*
  ▸ BPC-157 10mg (10 ampolas)
  ▸ TB 500 10mg (10 ampolas)

⚡ *Performance Mitocondrial*
  ▸ MOTS-C 40mg (10 ampolas)

💉 *Hormônio & Recuperação*
  ▸ CJC-1295 10mg (10 ampolas)

♾️ *Longevidade*
  ▸ Epithalon 40mg (10 ampolas)

🎯 *Cognição & Foco*
  ▸ Semax 5mg (10 ampolas)

Entre em contato para valores e disponibilidade.`;
}

// ── CONTROLE DE CUSTO DIÁRIO ──────────────────────────────────────────────────

const DAILY_LIMIT_BRL  = 3.0;
// Preços conservadores Claude Haiku (USD por milhão de tokens)
const PRICE_INPUT_MTK  = 1.0;
const PRICE_OUTPUT_MTK = 5.0;

function todayDate() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function getDailySpendBRL() {
  const cfg    = getConfig();
  const cambio = parseFloat(cfg.cambio) || 5.5;
  const row    = db.prepare('SELECT cost_usd FROM api_daily_usage WHERE date = ?').get(todayDate());
  return row ? row.cost_usd * cambio : 0;
}

function recordUsage(inputTokens, outputTokens) {
  const costUsd = (inputTokens  * PRICE_INPUT_MTK  / 1_000_000)
                + (outputTokens * PRICE_OUTPUT_MTK / 1_000_000);
  db.prepare(`
    INSERT INTO api_daily_usage (date, cost_usd, calls) VALUES (?, ?, 1)
    ON CONFLICT(date) DO UPDATE SET
      cost_usd = cost_usd + excluded.cost_usd,
      calls    = calls + 1
  `).run(todayDate(), costUsd);
}

// ── CLASSIFICAÇÃO COM IA ──────────────────────────────────────────────────────

async function classifyMessage(text) {
  // Verifica limite diário ANTES de chamar a API
  const spent = getDailySpendBRL();
  if (spent >= DAILY_LIMIT_BRL) {
    console.log(`WA: limite diário de R$${DAILY_LIMIT_BRL.toFixed(2)} atingido (gasto hoje: R$${spent.toFixed(4)}) — IA pausada até amanhã`);
    return 'none';
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 10,
      system: `Você classifica mensagens recebidas em um WhatsApp pessoal de vendas.
Os produtos vendidos são:
- PODS: vapes descartáveis, pods eletrônicos, cigarros eletrônicos (marcas: ELF BAR, BLACK SHEEP, IGNITE, LOST MARY, WAKA, VAPORESSO, etc.)
- PEPTIDEOS: peptídeos terapêuticos (Retatrutide, Tirzepatide, BPC-157, TB500, MOTS-C, CJC-1295, Epithalon, Semax). Relacionados a emagrecimento, GH, regeneração, longevidade, performance.

Responda APENAS com uma palavra:
- "pods" → se pergunta sobre vapes/pods/cigarros eletrônicos/disposables
- "peptideos" → se pergunta sobre peptídeos/emagrecimento/GH/regeneração/longevidade
- "none" → qualquer outra coisa (saudação genérica, conversa pessoal, assunto não relacionado)

Na dúvida, responda "none". Seja conservador.`,
      messages: [{ role: 'user', content: text }],
    });

    // Registra custo APÓS chamada bem-sucedida
    recordUsage(response.usage.input_tokens, response.usage.output_tokens);

    const result = response.content[0].text.trim().toLowerCase();
    if (['pods', 'peptideos'].includes(result)) return result;
    return 'none';
  } catch (e) {
    console.error('Claude classify error:', e.message);
    return 'none';
  }
}

// ── HANDLER PRINCIPAL DO WHATSAPP ─────────────────────────────────────────────

async function waMessageHandler(messageText, jid) {
  // 1. Classifica com IA
  const action = await classifyMessage(messageText);
  console.log(`WA [${jid}] "${messageText}" → ${action}`);
  if (action === 'none') return null;

  // 2. Verifica se já enviou esse catálogo pra esse contato nas últimas 24h
  const recentlySent = db.prepare(`
    SELECT 1 FROM wa_catalog_sent
    WHERE jid = ? AND catalog_type = ?
    AND sent_at > datetime('now', '-24 hours')
  `).get(jid, action);
  if (recentlySent) {
    console.log(`WA [${jid}] catálogo "${action}" já enviado recentemente — ignorando`);
    return null;
  }

  // 3. Gera o catálogo correto
  let catalogText = null;
  if (action === 'pods') {
    const cfg = getConfig();
    const tplId = cfg.wa_template_id ? parseInt(cfg.wa_template_id) : null;
    catalogText = tplId ? generateCatalog(tplId) : null;
  } else if (action === 'peptideos') {
    catalogText = getPeptidesCatalog();
  }

  if (!catalogText) return null;

  // 4. Registra envio
  db.prepare('INSERT INTO wa_catalog_sent (jid, catalog_type) VALUES (?, ?)').run(jid, action);
  return catalogText;
}

// ── EXPRESS ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Serve UI com dados injetados
app.get('/', (req, res) => {
  const html = readFileSync(join(__dirname, 'gestor.html'), 'utf8');
  const products = db.prepare('SELECT * FROM products ORDER BY brand, flavor').all();
  const config = getConfig();
  const injection = `<script>var PRODUCTS=${JSON.stringify(products)};var CONFIG=${JSON.stringify(config)};</script>`;
  res.send(html.replace('</head>', injection + '</head>'));
});

// ── PRODUCTS ──────────────────────────────────────────────────────────────────

app.get('/api/products', (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY brand, flavor').all());
});

app.post('/api/products', (req, res) => {
  const { name = 'Novo Produto', brand = '', flavor = '', cost_usd = 0, price = 0, stock = 0 } = req.body;
  const result = db
    .prepare('INSERT INTO products (name, brand, flavor, cost_usd, price, stock) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, brand, flavor || name, cost_usd, price, stock);
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid));
});

app.post('/api/products/import', (req, res) => {
  const { items, mode = 'merge' } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be array' });

  const cfg = getConfig();
  const cambio = parseFloat(cfg.cambio) || 5.5;
  const margem = parseFloat(cfg.margem) || 100;

  let created = 0, updated = 0;

  const insert = db.prepare(
    'INSERT INTO products (name, brand, flavor, cost_usd, price, stock) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const update = db.prepare(
    'UPDATE products SET brand=?, flavor=?, cost_usd=?, price=?, stock=? WHERE name=?'
  );
  const find = db.prepare('SELECT id FROM products WHERE name = ?');

  db.exec('BEGIN');
  try {
    for (const item of items) {
      const name     = item.name || item.flavor || '';
      const brand    = item.brand || '';
      const flavor   = item.flavor || name;
      const cost_usd = parseFloat(item.cost_usd) || 0;
      const stock    = parseInt(item.avulsas ?? item.stock) || 0;
      const price    = item.price_override
        ? parseFloat(item.price_override)
        : cost_usd > 0
          ? Math.round(cost_usd * cambio * (1 + margem / 100) * 100) / 100
          : 0;

      if (mode === 'merge' && find.get(name)) {
        update.run(brand, flavor, cost_usd, price, stock, name);
        updated++;
      } else {
        insert.run(name, brand, flavor, cost_usd, price, stock);
        created++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  res.json({ created, updated });
});

app.patch('/api/products/bulk', (req, res) => {
  const { ids, updates } = req.body;
  if (!Array.isArray(ids) || !ids.length || !updates)
    return res.status(400).json({ error: 'Invalid payload' });

  const allowed = ['cost_usd', 'price', 'stock'];
  const safe = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(safe).length) return res.status(400).json({ error: 'No valid fields' });

  const setClauses   = Object.keys(safe).map(k => `${k} = ?`).join(', ');
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(`UPDATE products SET ${setClauses} WHERE id IN (${placeholders})`)
    .run(...Object.values(safe), ...ids);

  res.json({ ok: true });
});

app.put('/api/products/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const allowed = ['name', 'brand', 'flavor', 'cost_usd', 'price', 'stock'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(updates).length) return res.json(existing);

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE products SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), id);
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

app.delete('/api/products/:id', (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

// ── CONFIG ────────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json(getConfig());
});

app.put('/api/config', (req, res) => {
  const allowed = ['cambio', 'margem', 'wa_template_id'];
  const upsert = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k)) upsert.run(k, String(v));
  }
  res.json(getConfig());
});

// ── CATALOG TEMPLATES ─────────────────────────────────────────────────────────

app.get('/api/catalog-templates', (req, res) => {
  res.json(db.prepare('SELECT * FROM catalog_templates ORDER BY id').all());
});

app.post('/api/catalog-templates', (req, res) => {
  const {
    name         = 'Modelo',
    header       = '',
    brand_format = '*{brand}*',
    item_format  = '  • {flavor} — R${price}',
    separator    = '',
    footer       = '',
  } = req.body;
  const result = db
    .prepare(
      'INSERT INTO catalog_templates (name, header, brand_format, item_format, separator, footer) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(name, header, brand_format, item_format, separator, footer);
  res.status(201).json(
    db.prepare('SELECT * FROM catalog_templates WHERE id = ?').get(result.lastInsertRowid)
  );
});

app.put('/api/catalog-templates/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const existing = db.prepare('SELECT * FROM catalog_templates WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { name, header, brand_format, item_format, separator, footer } = req.body;
  db.prepare(
    'UPDATE catalog_templates SET name=?, header=?, brand_format=?, item_format=?, separator=?, footer=? WHERE id=?'
  ).run(
    name         ?? existing.name,
    header       ?? existing.header,
    brand_format ?? existing.brand_format,
    item_format  ?? existing.item_format,
    separator    ?? existing.separator,
    footer       ?? existing.footer,
    id
  );
  res.json(db.prepare('SELECT * FROM catalog_templates WHERE id = ?').get(id));
});

app.delete('/api/catalog-templates/:id', (req, res) => {
  db.prepare('DELETE FROM catalog_templates WHERE id = ?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

// ── CATALOG GENERATE ──────────────────────────────────────────────────────────

app.get('/api/catalog', (req, res) => {
  const templateId = parseInt(req.query.template);
  if (!templateId) return res.status(400).json({ error: 'template required' });
  const text = generateCatalog(templateId);
  if (text === null) return res.status(404).json({ error: 'Template not found' });
  res.json({ text });
});

// ── WHATSAPP ──────────────────────────────────────────────────────────────────

app.get('/api/whatsapp/status', (req, res) => {
  res.json(getStatus());
});

app.post('/api/whatsapp/connect', async (req, res) => {
  try {
    await connectWhatsApp(waMessageHandler, db);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    await disconnectWhatsApp();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\nEncerrando...');
  try { await disconnectWhatsApp(); } catch {}
  db.close();
  process.exit(0);
});

// ── START ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`SaleMaker rodando em http://localhost:${PORT}`);
});
