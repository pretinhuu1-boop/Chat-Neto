import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { connectWhatsApp, disconnectWhatsApp, getStatus, setAdminGroupJid, startGroupCapture, getAdminGroupJid } from './whatsapp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  readFileSync(join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch {}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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

  CREATE TABLE IF NOT EXISTS wa_price_alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    jid        TEXT    NOT NULL,
    message    TEXT    NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    handled    INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS wa_conversation_state (
    jid          TEXT PRIMARY KEY,
    state        TEXT NOT NULL,
    catalog_type TEXT,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
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

// Carrega grupo admin salvo
const savedGroup = db.prepare(`SELECT value FROM config WHERE key = 'admin_group_jid'`).get();
if (savedGroup?.value) setAdminGroupJid(savedGroup.value);

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

// ── ESTADO DA CONVERSA ────────────────────────────────────────────────────────

function getConversationState(jid) {
  return db.prepare(`
    SELECT state, catalog_type FROM wa_conversation_state
    WHERE jid = ? AND updated_at > datetime('now', '-24 hours')
  `).get(jid);
}

function setConversationState(jid, state, catalogType = null) {
  db.prepare(`
    INSERT INTO wa_conversation_state (jid, state, catalog_type, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(jid) DO UPDATE SET state=excluded.state, catalog_type=excluded.catalog_type, updated_at=CURRENT_TIMESTAMP
  `).run(jid, state, catalogType);
}

function clearConversationState(jid) {
  db.prepare('DELETE FROM wa_conversation_state WHERE jid = ?').run(jid);
}

function isAffirmative(text) {
  return /^\s*(sim|s|pode|claro|quero|manda|vai|ok|yes|yep|pode sim|quero sim|manda sim|manda aí|manda ai|com certeza|positivo|afirmativo|por favor|por fa|pf)\s*[!.]*\s*$/i.test(text.trim());
}

function getConfirmationQuestion(catalogType) {
  return catalogType === 'pods'
    ? 'oi, quer lista dos modelos disponíveis?'
    : 'oi, quer lista dos peptídeos disponíveis?';
}

// ── DETECÇÃO DE PERGUNTA DE PREÇO ─────────────────────────────────────────────

function isAskingForPrice(text) {
  return /pre[çc]o|valor(es)?|quanto (custa|fica|é|e|vale|cobr)|custo|promoç|desconto|tabela|me.{0,15}valor|me.{0,15}pre[çc]|quanto é|quanto e\b/i.test(text);
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

// ── RESPOSTA HUMANIZADA ───────────────────────────────────────────────────────

async function generateHumanizedResponse(messageText, catalogType) {
  const spent = getDailySpendBRL();
  if (spent >= DAILY_LIMIT_BRL) {
    console.log('WA: limite diário atingido — resposta humanizada pausada');
    return null;
  }

  const context = catalogType === 'pods'
    ? 'Você vende pods e vapes eletrônicos descartáveis (marcas: ELF BAR, BLACK SHEEP, IGNITE, LOST MARY, WAKA, VAPORESSO e outras). Já enviou a lista de produtos disponíveis para o cliente.'
    : 'Você vende peptídeos terapêuticos (Retatrutide, Tirzepatide, BPC-157, TB500, MOTS-C, CJC-1295, Epithalon, Semax). Já enviou o catálogo. Valores são tratados diretamente.';

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 120,
      system: `Você é um vendedor brasileiro que atende pelo WhatsApp. ${context}

Responda em 1 frase curta, casual, sem formalidade — como se fosse uma mensagem rápida mesmo.
Sem emojis. Sem "olá", "tudo bem", introduções. Va direto ao ponto.
Nunca mencione preços ou valores.
Se a mensagem não tiver nada a ver com os produtos, responda apenas: SKIP`,
      messages: [{ role: 'user', content: messageText }],
    });

    recordUsage(response.usage.input_tokens, response.usage.output_tokens);
    const reply = response.content[0].text.trim();
    return reply === 'SKIP' ? null : reply;
  } catch (e) {
    console.error('Claude humanized error:', e.message);
    return null;
  }
}

// ── HANDLER ADMIN (mensagens do próprio vendedor para si mesmo) ───────────────

async function parseAdminCommand(text) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: `Você interpreta comandos de gestão de estoque em português e retorna JSON válido.

Formatos possíveis (retorne APENAS o JSON, sem markdown):
{"action":"stock","search":"[nome ou sabor]","delta":N}      — atualiza quantidade (N pode ser negativo)
{"action":"add","brand":"...","flavor":"...","price":N,"stock":N}  — adiciona produto
{"action":"low_stock"}   — lista produtos com estoque baixo (≤5)
{"action":"list"}        — lista todos os produtos disponíveis
{"action":"unknown","message":"..."}   — comando não reconhecido

Exemplos:
"chegou 20 mango" → {"action":"stock","search":"mango","delta":20}
"vendeu 3 elf bar manga" → {"action":"stock","search":"elf bar manga","delta":-3}
"acabou o blue razz" → {"action":"stock","search":"blue razz","delta":-9999}
"add BLACK SHEEP | Morango | 25.90 | 10" → {"action":"add","brand":"BLACK SHEEP","flavor":"Morango","price":25.90,"stock":10}
"quais tão acabando" → {"action":"low_stock"}
"lista" ou "estoque" → {"action":"list"}`,
      messages: [{ role: 'user', content: text }],
    });
    const raw = response.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Admin parse error:', e.message);
    return { action: 'unknown', message: 'Não entendi o comando.' };
  }
}

async function transcribeAudio(audioBuffer) {
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'audio.ogg');
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('language', 'pt');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: formData,
  });
  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data = await res.json();
  return data.text?.trim() || '';
}

function detectMimeType(buffer) {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

async function parseImageProducts(imageBuffer) {
  try {
    if (!imageBuffer || imageBuffer.length === 0) return 'Imagem vazia ou nao baixada.';
    console.log(`Image parse: buffer ${imageBuffer.length} bytes`);
    const mimeType = detectMimeType(imageBuffer);
    const base64 = imageBuffer.toString('base64');
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: `Leia todos os produtos nesta imagem e retorne APENAS JSON valido sem markdown:
{"action":"bulk_add","products":[{"brand":"...","flavor":"...","price":N,"stock":N},...]}

Se nao conseguir identificar nenhum produto, retorne:
{"action":"unknown","message":"Nao consegui ler a lista"}

Regras: brand=marca do produto, flavor=sabor ou nome do produto, price=preco numerico (0 se nao visivel), stock=quantidade numerica (0 se nao visivel). Leia cada linha da lista.` }
        ]
      }]
    });
    recordUsage(response.usage.input_tokens, response.usage.output_tokens);
    const rawText = response.content[0]?.text?.trim() || '';
    console.log(`Image parse raw: ${rawText.slice(0, 200)}`);
    const raw = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    if (!raw) return 'Claude nao retornou resposta para a imagem.';
    const cmd = JSON.parse(raw);

    if (cmd.action === 'bulk_add' && cmd.products?.length) {
      const added = [];
      for (const p of cmd.products) {
        const name = `${p.brand || ''} ${p.flavor || ''}`.trim();
        if (!name) continue;
        db.prepare('INSERT INTO products (name, brand, flavor, price, stock) VALUES (?, ?, ?, ?, ?)')
          .run(name, p.brand || '', p.flavor || name, p.price || 0, p.stock || 0);
        added.push(`• ${name} — R$ ${(p.price || 0).toFixed(2)} — ${p.stock || 0} un`);
      }
      return `${added.length} produto(s) adicionado(s):\n${added.join('\n')}`;
    }

    return cmd.message || 'Nao consegui ler a lista.';
  } catch (e) {
    console.error('Image parse error:', e.message);
    return 'Erro ao processar a imagem.';
  }
}

async function waAdminHandler(messageText, imageBuffer = null, audioBuffer = null) {
  if (imageBuffer) return await parseImageProducts(imageBuffer);
  if (audioBuffer) {
    try {
      const transcribed = await transcribeAudio(audioBuffer);
      console.log(`WA admin audio transcrito: "${transcribed}"`);
      if (!transcribed) return 'Nao consegui entender o audio.';
      messageText = transcribed;
    } catch (e) {
      console.error('Transcription error:', e.message);
      return 'Erro ao transcrever o audio.';
    }
  }
  const cmd = await parseAdminCommand(messageText);

  if (cmd.action === 'stock') {
    const products = db.prepare(
      `SELECT id, name, flavor, stock FROM products WHERE (LOWER(name) LIKE ? OR LOWER(flavor) LIKE ?) AND stock >= 0`
    ).all(`%${cmd.search.toLowerCase()}%`, `%${cmd.search.toLowerCase()}%`);

    if (!products.length) return `❌ Nenhum produto encontrado para "${cmd.search}".`;

    const updated = [];
    for (const p of products) {
      const newStock = Math.max(0, p.stock + cmd.delta);
      db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, p.id);
      updated.push(`• ${p.flavor || p.name}: ${p.stock} → *${newStock}*`);
    }
    const acao = cmd.delta > 0 ? `+${cmd.delta}` : `${cmd.delta}`;
    return `Estoque atualizado (${acao}):\n${updated.join('\n')}`;
  }

  if (cmd.action === 'add') {
    const price = cmd.price > 0 ? cmd.price : 0;
    const name = `${cmd.brand} ${cmd.flavor}`.trim();
    db.prepare(
      'INSERT INTO products (name, brand, flavor, price, stock) VALUES (?, ?, ?, ?, ?)'
    ).run(name, cmd.brand || '', cmd.flavor || name, price, cmd.stock || 0);
    return `Produto adicionado:\n• *${name}*\n• Preco: R$ ${price.toFixed(2)}\n• Estoque: ${cmd.stock || 0} un.`;
  }

  if (cmd.action === 'low_stock') {
    const products = db.prepare(
      'SELECT name, flavor, stock FROM products WHERE stock <= 5 ORDER BY stock ASC'
    ).all();
    if (!products.length) return 'Nenhum produto com estoque baixo.';
    const lines = products.map(p => `• ${p.flavor || p.name}: *${p.stock}* un.`);
    return `*Estoque baixo (5 ou menos):*\n${lines.join('\n')}`;
  }

  if (cmd.action === 'list') {
    const products = db.prepare(
      'SELECT flavor, name, stock FROM products WHERE stock > 0 ORDER BY brand, flavor'
    ).all();
    if (!products.length) return 'Nenhum produto em estoque.';
    const lines = products.map(p => `• ${p.flavor || p.name}: ${p.stock} un.`);
    return `*Estoque atual:*\n${lines.join('\n')}`;
  }

  return `${cmd.message || 'Comando nao reconhecido.'}\n\nExemplos:\n• "chegou 20 mango"\n• "vendeu 3 elf bar manga"\n• "add BLACK SHEEP | Morango | 25.90 | 10"\n• "lista" ou "quais tao acabando"`;
}

// ── HANDLER PRINCIPAL DO WHATSAPP ─────────────────────────────────────────────

async function waMessageHandler(messageText, jid) {
  // ── 1. Aguardando confirmação do cliente ──────────────────────────────────
  const convState = getConversationState(jid);

  if (convState?.state === 'awaiting_confirmation') {
    if (isAffirmative(messageText)) {
      // Cliente confirmou — manda o catálogo
      const { catalog_type } = convState;
      clearConversationState(jid);

      let catalogText = null;
      if (catalog_type === 'pods') {
        const cfg = getConfig();
        const tplId = cfg.wa_template_id ? parseInt(cfg.wa_template_id) : null;
        catalogText = tplId ? generateCatalog(tplId) : null;
      } else if (catalog_type === 'peptideos') {
        catalogText = getPeptidesCatalog();
      }

      if (!catalogText) return null;
      db.prepare('INSERT INTO wa_catalog_sent (jid, catalog_type) VALUES (?, ?)').run(jid, catalog_type);
      console.log(`WA [${jid}] confirmou → catálogo "${catalog_type}" enviado`);
      return catalogText;
    } else {
      // Não confirmou — para tudo
      clearConversationState(jid);
      console.log(`WA [${jid}] não confirmou → encerrando`);
      return null;
    }
  }

  // ── 2. Follow-up: já recebeu catálogo nos últimos 7 dias ─────────────────
  const lastCatalog = db.prepare(`
    SELECT catalog_type FROM wa_catalog_sent
    WHERE jid = ? AND sent_at > datetime('now', '-7 days')
    ORDER BY sent_at DESC LIMIT 1
  `).get(jid);

  if (lastCatalog) {
    if (isAskingForPrice(messageText)) {
      const jaTemAlerta = db.prepare(
        'SELECT 1 FROM wa_price_alerts WHERE jid = ? AND handled = 0'
      ).get(jid);
      if (!jaTemAlerta) {
        db.prepare('INSERT INTO wa_price_alerts (jid, message) VALUES (?, ?)').run(jid, messageText);
      }
      console.log(`WA [${jid}] perguntou preço → alerta criado para vendedor`);
      return null;
    }

    const reply = await generateHumanizedResponse(messageText, lastCatalog.catalog_type);
    if (reply) console.log(`WA [${jid}] follow-up → respondendo humanizado`);
    return reply;
  }

  // ── 3. Novo contato — classifica e pergunta se quer a lista ──────────────
  const action = await classifyMessage(messageText);
  console.log(`WA [${jid}] "${messageText}" → ${action}`);
  if (action === 'none') return null;

  setConversationState(jid, 'awaiting_confirmation', action);
  console.log(`WA [${jid}] → perguntando confirmação para "${action}"`);
  return getConfirmationQuestion(action);
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

// ── PRICE ALERTS ─────────────────────────────────────────────────────────────

app.get('/api/price-alerts', (req, res) => {
  res.json(db.prepare(
    'SELECT * FROM wa_price_alerts WHERE handled = 0 ORDER BY created_at DESC'
  ).all());
});

app.patch('/api/price-alerts/:id/handled', (req, res) => {
  db.prepare('UPDATE wa_price_alerts SET handled = 1 WHERE id = ?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

// ── ADMIN GROUP ───────────────────────────────────────────────────────────────

app.get('/api/admin-group', (req, res) => {
  const jid = getAdminGroupJid();
  res.json({ jid: jid || null });
});

app.post('/api/admin-group/capture', (req, res) => {
  if (!getStatus().status === 'connected') return res.status(400).json({ error: 'WhatsApp desconectado' });
  startGroupCapture((jid) => {
    db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('admin_group_jid', ?)`).run(jid);
    setAdminGroupJid(jid);
    console.log('Grupo admin capturado:', jid);
  });
  res.json({ ok: true });
});

app.delete('/api/admin-group', (req, res) => {
  db.prepare(`DELETE FROM config WHERE key = 'admin_group_jid'`).run();
  setAdminGroupJid(null);
  res.json({ ok: true });
});

// ── WHATSAPP ──────────────────────────────────────────────────────────────────

app.get('/api/whatsapp/status', (req, res) => {
  res.json(getStatus());
});

app.post('/api/whatsapp/connect', async (req, res) => {
  try {
    await connectWhatsApp(waMessageHandler, db, waAdminHandler);
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
