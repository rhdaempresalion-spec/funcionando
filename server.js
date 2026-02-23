// ═══════════════════════════════════════════════════════════════
//  DHR Lead Capture → CRM DataCrazy
//  Busca transações via Shield API (Basic Auth) + Envia Leads
// ═══════════════════════════════════════════════════════════════

import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { decodePIX } from './pix-decoder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CONFIG ───
const CONFIG = {
  PORT: process.env.PORT || 3005,
  DHR_PUBLIC_KEY: process.env.DHR_PUBLIC_KEY || 'pk_WNNg2i_r8_iqeG3XrdJFI_q1I8ihd1yLoUa08Ip0LKaqxXxE',
  DHR_SECRET_KEY: process.env.DHR_SECRET_KEY || 'sk_jz1yyIaa0Dw2OWhMH0r16gUgWZ7N2PCpb6aK1crKPIFq02aD',
  DHR_API_URL: process.env.DHR_API_URL || 'https://api.shieldtecnologia.com/v1',
  CRM_WEBHOOK_URL: process.env.CRM_WEBHOOK_URL || 'https://api.datacrazy.io/v1/crm/api/crm/flows/webhooks/a3161e6d-6f4d-4b16-a1b5-16bcb9641994/76e41ac2-564a-4ff6-9e28-ceee490c6544',
  POLL_INTERVAL: 10000,       // Buscar novas transações a cada 10s
  AUTO_SEND_CRM: true,        // Enviar automaticamente ao CRM
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
};

// ─── FILES ───
const FILES = {
  cache: path.join(__dirname, 'transactions_cache.json'),
  leads: path.join(__dirname, 'leads_sent.json'),
  logs: path.join(__dirname, 'system_logs.json'),
};

// ─── STATE ───
let txCache = { data: [], lastUpdate: 0, isLoading: false };
let leadsSent = {};  // { txId: { sentAt, crmResponse } }
let systemLogs = [];
let wss;
const wsClients = new Set();

// ═══════════════════════════════════════
//  UTILITÁRIOS
// ═══════════════════════════════════════

async function loadJSON(filepath, fallback = null) {
  try { return JSON.parse(await fs.readFile(filepath, 'utf-8')); }
  catch { return fallback; }
}

async function saveJSON(filepath, data) {
  try { await fs.writeFile(filepath, JSON.stringify(data)); }
  catch (e) { console.error(`Erro salvando ${filepath}:`, e.message); }
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  wsClients.forEach(ws => { if (ws.readyState === 1) ws.send(str); });
}

function addLog(type, message, data = null) {
  const entry = { type, message, time: new Date().toISOString(), data };
  console.log(`[${type.toUpperCase()}] ${message}`);
  systemLogs.unshift(entry);
  if (systemLogs.length > 500) systemLogs.length = 500;
  broadcast({ type: 'log', payload: entry });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════
//  SHIELD/DHR API — CONEXÃO QUE FUNCIONA
//  Auth: Basic pk:sk em base64
//  Endpoint: GET /transactions?page=X&pageSize=Y
// ═══════════════════════════════════════

function getAuth() {
  return 'Basic ' + Buffer.from(`${CONFIG.DHR_PUBLIC_KEY}:${CONFIG.DHR_SECRET_KEY}`).toString('base64');
}

async function fetchDHR(endpoint, retries = CONFIG.MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${CONFIG.DHR_API_URL}${endpoint}`, {
        headers: { 'Authorization': getAuth(), 'Connection': 'keep-alive' },
        timeout: 30000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === retries) throw e;
      await delay(CONFIG.RETRY_DELAY);
    }
  }
}

// Buscar TODAS as transações (primeira vez)
async function fetchAllTransactions() {
  if (txCache.isLoading) return txCache.data;
  txCache.isLoading = true;
  addLog('info', 'Buscando TODAS as transações da API Shield...');

  try {
    const first = await fetchDHR('/transactions?page=1&pageSize=500');
    let all = first.data || [];
    const pagination = first.pagination || {};
    const totalPages = pagination.totalPages || 1;
    const totalRecords = pagination.totalRecords || 0;

    addLog('info', `Total: ${totalRecords} transações em ${totalPages} páginas`);

    if (totalPages > 1) {
      for (let batch = 2; batch <= totalPages; batch += 10) {
        const pages = [];
        for (let p = batch; p < batch + 10 && p <= totalPages; p++) pages.push(p);
        const results = await Promise.all(pages.map(p => fetchDHR(`/transactions?page=${p}&pageSize=500`)));
        results.forEach(r => { if (r.data) all = all.concat(r.data); });
        addLog('info', `Progresso: ${all.length}/${totalRecords}`);
      }
    }

    all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    txCache.data = all;
    txCache.lastUpdate = Date.now();
    txCache.isLoading = false;

    await saveJSON(FILES.cache, { data: all, lastUpdate: txCache.lastUpdate });
    addLog('success', `✓ ${all.length} transações carregadas`);

    // Auto-enviar leads novos ao CRM
    if (CONFIG.AUTO_SEND_CRM) await autoSendNewLeads();

    return all;
  } catch (e) {
    txCache.isLoading = false;
    addLog('error', `Erro ao buscar: ${e.message}`);
    return txCache.data;
  }
}

// Buscar apenas NOVAS transações (incremental)
async function fetchNewTransactions() {
  if (txCache.isLoading) return;
  if (txCache.data.length === 0) return await fetchAllTransactions();

  txCache.isLoading = true;
  try {
    const data = await fetchDHR('/transactions?page=1&pageSize=100');
    const newTxs = data.data || [];
    const existingIds = new Set(txCache.data.map(t => t.id));
    const brandNew = newTxs.filter(t => !existingIds.has(t.id));

    if (brandNew.length > 0) {
      addLog('success', `🆕 ${brandNew.length} novas transações!`);
      txCache.data = [...brandNew, ...txCache.data];
      txCache.lastUpdate = Date.now();
      await saveJSON(FILES.cache, { data: txCache.data, lastUpdate: txCache.lastUpdate });
      broadcast({ type: 'new_transactions', payload: { count: brandNew.length } });

      // Auto-enviar novos leads pagos
      if (CONFIG.AUTO_SEND_CRM) {
        for (const tx of brandNew) {
          if (tx.status === 'paid' && !leadsSent[tx.id]) {
            await sendLeadToCRM(tx);
          }
        }
      }
    }

    // Checar mudanças de status
    let updated = 0;
    for (const newTx of newTxs) {
      const existing = txCache.data.find(t => t.id === newTx.id);
      if (existing && existing.status !== newTx.status) {
        const oldStatus = existing.status;
        Object.assign(existing, newTx);
        updated++;
        // Se mudou pra paid, envia pro CRM
        if (newTx.status === 'paid' && oldStatus !== 'paid' && !leadsSent[newTx.id]) {
          addLog('info', `Transação ${newTx.id} mudou: ${oldStatus} → paid`);
          if (CONFIG.AUTO_SEND_CRM) await sendLeadToCRM(newTx);
        }
      }
    }
    if (updated > 0) {
      addLog('info', `${updated} transações atualizadas`);
      await saveJSON(FILES.cache, { data: txCache.data, lastUpdate: txCache.lastUpdate });
    }
  } catch (e) {
    addLog('error', `Erro incremental: ${e.message}`);
  }
  txCache.isLoading = false;
}

// ═══════════════════════════════════════
//  CRM DATACRAZY — ENVIO DE LEADS
// ═══════════════════════════════════════

function buildCRMPayload(tx) {
  return {
    event: 'venda_paga',
    timestamp: new Date().toISOString(),
    lead: {
      nome: tx.customer?.name || '',
      email: tx.customer?.email || '',
      telefone: tx.customer?.phone || '',
      documento: tx.customer?.document?.number || '',
    },
    transacao: {
      id: tx.id,
      produto: tx.items?.[0]?.title || '',
      valor: (tx.amount || 0) / 100,
      valor_liquido: (tx.fee?.netAmount || 0) / 100,
      metodo_pagamento: tx.paymentMethod || '',
      parcelas: tx.installments || 1,
      data_pagamento: tx.createdAt,
      status: tx.status,
    },
    metadata: {
      source: 'dhr_shield_integration',
      gateway: 'shield_tecnologia',
    },
  };
}

async function sendLeadToCRM(tx) {
  if (!CONFIG.CRM_WEBHOOK_URL) return false;
  if (leadsSent[tx.id]) {
    addLog('info', `Lead ${tx.id} já enviado anteriormente`);
    return true;
  }

  const customerName = tx.customer?.name || 'Desconhecido';
  const amount = ((tx.amount || 0) / 100).toFixed(2);

  try {
    addLog('info', `CRM ← ${customerName} R$ ${amount}`);
    const res = await fetch(CONFIG.CRM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCRMPayload(tx)),
      timeout: 15000,
    });
    const text = await res.text().catch(() => '');

    if (res.ok) {
      leadsSent[tx.id] = { sentAt: new Date().toISOString(), status: 'sent', crmResponse: text.substring(0, 200) };
      await saveJSON(FILES.leads, leadsSent);
      addLog('success', `✓ CRM: ${customerName} - R$ ${amount}`);
      broadcast({ type: 'lead_sent', payload: { id: tx.id, name: customerName, amount } });
      return true;
    } else {
      leadsSent[tx.id] = { sentAt: new Date().toISOString(), status: 'error', crmResponse: `${res.status}: ${text.substring(0, 200)}` };
      await saveJSON(FILES.leads, leadsSent);
      addLog('error', `CRM erro ${res.status}: ${text.substring(0, 100)}`);
      return false;
    }
  } catch (e) {
    addLog('error', `CRM: ${e.message}`);
    return false;
  }
}

async function autoSendNewLeads() {
  const paid = txCache.data.filter(t => t.status === 'paid' && !leadsSent[t.id]);
  if (paid.length === 0) return;

  addLog('info', `Enviando ${paid.length} leads pendentes ao CRM...`);
  let sent = 0;
  for (const tx of paid) {
    if (await sendLeadToCRM(tx)) sent++;
    await delay(300);
  }
  addLog('success', `✓ ${sent}/${paid.length} leads enviados ao CRM`);
}

// ═══════════════════════════════════════
//  ANÁLISES
// ═══════════════════════════════════════

function getStats(transactions) {
  const paid = transactions.filter(t => t.status === 'paid');
  const pending = transactions.filter(t => ['waiting_payment', 'pending'].includes(t.status));
  const sentCount = paid.filter(t => leadsSent[t.id]).length;

  return {
    total: transactions.length,
    paid: paid.length,
    pending: pending.length,
    revenue: paid.reduce((s, t) => s + (t.amount || 0), 0) / 100,
    netRevenue: paid.reduce((s, t) => s + (t.fee?.netAmount || 0), 0) / 100,
    avgTicket: paid.length ? paid.reduce((s, t) => s + (t.amount || 0), 0) / paid.length / 100 : 0,
    conversion: transactions.length ? (paid.length / transactions.length * 100).toFixed(1) : 0,
    sentToCRM: sentCount,
    pendingCRM: paid.length - sentCount,
    polling: true,
    auto_send: CONFIG.AUTO_SEND_CRM,
    cacheAge: Date.now() - txCache.lastUpdate,
    isLoading: txCache.isLoading,
  };
}

function getLeads(transactions) {
  const map = {};
  transactions.forEach(t => {
    const doc = t.customer?.document?.number;
    if (!doc) return;
    if (!map[doc]) {
      map[doc] = {
        document: doc,
        name: t.customer?.name || '',
        email: t.customer?.email || '',
        phone: t.customer?.phone || '',
        firstPurchase: t.createdAt,
        lastPurchase: t.createdAt,
        totalPurchases: 0,
        paidPurchases: 0,
        totalSpent: 0,
        products: new Set(),
        crmStatus: 'pending',
        lastTxId: null,
      };
    }
    const lead = map[doc];
    lead.totalPurchases++;
    if (t.status === 'paid') {
      lead.paidPurchases++;
      lead.totalSpent += (t.amount || 0) / 100;
      lead.lastTxId = t.id;
      if (leadsSent[t.id]) lead.crmStatus = 'sent';
    }
    if (new Date(t.createdAt) < new Date(lead.firstPurchase)) lead.firstPurchase = t.createdAt;
    if (new Date(t.createdAt) > new Date(lead.lastPurchase)) lead.lastPurchase = t.createdAt;
    if (t.items?.[0]?.title) lead.products.add(t.items[0].title.split(' - ')[0].trim());
  });

  return Object.values(map).map(l => ({
    ...l,
    products: Array.from(l.products).join(', '),
  })).sort((a, b) => new Date(b.lastPurchase) - new Date(a.lastPurchase));
}

function applyFilters(txs, filters) {
  let result = [...txs];
  if (filters.startDate) {
    const start = new Date(filters.startDate + 'T00:00:00-03:00').getTime();
    result = result.filter(t => new Date(t.createdAt).getTime() >= start);
  }
  if (filters.endDate) {
    const end = new Date(filters.endDate + 'T23:59:59-03:00').getTime();
    result = result.filter(t => new Date(t.createdAt).getTime() <= end);
  }
  if (filters.status === 'paid') result = result.filter(t => t.status === 'paid');
  else if (filters.status === 'pending') result = result.filter(t => ['waiting_payment', 'pending'].includes(t.status));
  if (filters.paymentMethod && filters.paymentMethod !== 'all') result = result.filter(t => t.paymentMethod === filters.paymentMethod);
  if (filters.search) {
    const q = filters.search.toLowerCase();
    result = result.filter(t =>
      (t.customer?.name || '').toLowerCase().includes(q) ||
      (t.customer?.email || '').toLowerCase().includes(q) ||
      (t.customer?.document?.number || '').includes(q) ||
      (t.customer?.phone || '').includes(q) ||
      (t.id || '').toLowerCase().includes(q)
    );
  }
  return result;
}

// ═══════════════════════════════════════
//  EXPRESS
// ═══════════════════════════════════════

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Stats ───
app.get('/api/stats', (req, res) => {
  let txs = txCache.data;
  txs = applyFilters(txs, req.query);
  res.json(getStats(txs));
});

// ─── Transações ───
app.get('/api/transactions', (req, res) => {
  let txs = applyFilters(txCache.data, req.query);
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 50;
  const start = (page - 1) * pageSize;
  res.json({
    data: txs.slice(start, start + pageSize).map(t => ({
      ...t,
      crmStatus: leadsSent[t.id] ? 'sent' : (t.status === 'paid' ? 'pending' : 'n/a'),
      crmSentAt: leadsSent[t.id]?.sentAt || null,
    })),
    pagination: { page, pageSize, totalRecords: txs.length, totalPages: Math.ceil(txs.length / pageSize) },
  });
});

// ─── Leads ───
app.get('/api/leads', (req, res) => {
  let txs = applyFilters(txCache.data, req.query);
  res.json(getLeads(txs));
});

// ─── Vendas ───
app.get('/api/sales', (req, res) => {
  let txs = applyFilters(txCache.data, req.query);
  const sales = txs.filter(t => t.status === 'paid').map(t => ({
    id: t.id,
    date: t.createdAt,
    customer: t.customer?.name || 'N/A',
    email: t.customer?.email || 'N/A',
    phone: t.customer?.phone || 'N/A',
    document: t.customer?.document?.number || 'N/A',
    product: t.items?.[0]?.title || 'N/A',
    amount: (t.amount || 0) / 100,
    netAmount: (t.fee?.netAmount || 0) / 100,
    method: t.paymentMethod || 'N/A',
    installments: t.installments || 1,
    crmStatus: leadsSent[t.id] ? 'sent' : 'pending',
    crmSentAt: leadsSent[t.id]?.sentAt || null,
  }));
  res.json(sales);
});

// ─── Produtos ───
app.get('/api/products', (req, res) => {
  const products = new Set();
  txCache.data.forEach(t => {
    if (t.items?.[0]?.title) products.add(t.items[0].title.split(' - ')[0].trim());
  });
  res.json(Array.from(products).sort());
});

// ─── CRM Actions ───
app.post('/api/crm/send/:id', async (req, res) => {
  const tx = txCache.data.find(t => t.id === req.params.id);
  if (!tx) return res.status(404).json({ error: 'Transação não encontrada' });
  const ok = await sendLeadToCRM(tx);
  res.json({ success: ok });
});

app.post('/api/crm/resend/:id', async (req, res) => {
  const tx = txCache.data.find(t => t.id === req.params.id);
  if (!tx) return res.status(404).json({ error: 'Transação não encontrada' });
  delete leadsSent[tx.id]; // Remove pra forçar reenvio
  const ok = await sendLeadToCRM(tx);
  res.json({ success: ok });
});

app.post('/api/crm/send-all', async (req, res) => {
  const paid = txCache.data.filter(t => t.status === 'paid' && !leadsSent[t.id]);
  if (!paid.length) return res.json({ success: true, sent: 0, total: 0 });
  addLog('info', `Enviando ${paid.length} leads em lote...`);
  let sent = 0;
  for (const tx of paid) {
    if (await sendLeadToCRM(tx)) sent++;
    await delay(300);
  }
  res.json({ success: true, sent, total: paid.length });
});

app.post('/api/crm/test', async (req, res) => {
  try {
    const r = await fetch(CONFIG.CRM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'test', lead: { nome: 'Teste' }, transacao: { id: 'test_' + Date.now(), valor: 0 } }),
    });
    res.json({ success: r.ok, status: r.status });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── Polling Controls ───
app.post('/api/refresh', async (req, res) => {
  await fetchNewTransactions();
  res.json({ success: true, transactions: txCache.data.length });
});

app.post('/api/rebuild-cache', async (req, res) => {
  txCache.data = [];
  await fetchAllTransactions();
  res.json({ success: true, transactions: txCache.data.length });
});

app.post('/api/settings/auto-send', (req, res) => {
  CONFIG.AUTO_SEND_CRM = req.body.enabled !== false;
  res.json({ success: true, auto_send: CONFIG.AUTO_SEND_CRM });
});

// ─── Logs ───
app.get('/api/logs', (req, res) => {
  res.json(systemLogs.slice(0, parseInt(req.query.limit) || 100));
});

// ─── Webhook receiver (bonus) ───
app.post('/webhook/dhr', async (req, res) => {
  const ev = req.body;
  addLog('info', `Webhook: ${JSON.stringify(ev).substring(0, 200)}`);
  const raw = ev.data || ev;
  if (raw.customer || raw.amount || raw.status) {
    // Adiciona ao cache
    const existingIds = new Set(txCache.data.map(t => t.id));
    if (!existingIds.has(raw.id)) {
      txCache.data.unshift(raw);
      txCache.lastUpdate = Date.now();
      broadcast({ type: 'new_transactions', payload: { count: 1 } });
      if (raw.status === 'paid' && CONFIG.AUTO_SEND_CRM) await sendLeadToCRM(raw);
    }
  }
  res.json({ received: true });
});

// ─── Health ───
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    transactions: txCache.data.length,
    cacheAge: Date.now() - txCache.lastUpdate,
    isLoading: txCache.isLoading,
    leadsSent: Object.keys(leadsSent).length,
  });
});

// ─── SPA Fallback ───
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══════════════════════════════════════
//  SERVER + WEBSOCKET + INIT
// ═══════════════════════════════════════

const server = http.createServer(app);
wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'init', payload: getStats(txCache.data) }));
  ws.on('close', () => wsClients.delete(ws));
});

let pollInterval = null;

async function init() {
  // Carregar dados persistidos
  const cached = await loadJSON(FILES.cache, null);
  if (cached?.data?.length) {
    txCache.data = cached.data;
    txCache.lastUpdate = cached.lastUpdate || Date.now();
    addLog('info', `Cache carregado: ${txCache.data.length} transações`);
  }

  const savedLeads = await loadJSON(FILES.leads, {});
  leadsSent = savedLeads || {};
  addLog('info', `Leads enviados: ${Object.keys(leadsSent).length}`);

  // Iniciar servidor
  server.listen(CONFIG.PORT, () => {
    console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║   ⚡ DHR Lead Capture → CRM DataCrazy                   ║
  ╠═══════════════════════════════════════════════════════════╣
  ║   Dashboard:  http://localhost:${CONFIG.PORT}
  ║   API:        http://localhost:${CONFIG.PORT}/api/stats
  ║   Webhook:    http://localhost:${CONFIG.PORT}/webhook/dhr
  ║   WebSocket:  ws://localhost:${CONFIG.PORT}/ws
  ╠═══════════════════════════════════════════════════════════╣
  ║   Shield API: ${CONFIG.DHR_API_URL}
  ║   CRM:        ${CONFIG.CRM_WEBHOOK_URL ? '✓ Configurado' : '✗ Não configurado'}
  ║   Auto Send:  ${CONFIG.AUTO_SEND_CRM}
  ║   Cache:      ${txCache.data.length} transações
  ╚═══════════════════════════════════════════════════════════╝
    `);
  });

  // Buscar dados em background
  if (txCache.data.length === 0) {
    fetchAllTransactions().then(() => startPolling()).catch(() => startPolling());
  } else {
    fetchNewTransactions().catch(() => {});
    startPolling();
  }
}

function startPolling() {
  if (pollInterval) return;
  addLog('info', `🟢 Polling iniciado (${CONFIG.POLL_INTERVAL / 1000}s)`);
  pollInterval = setInterval(fetchNewTransactions, CONFIG.POLL_INTERVAL);
}

init();

process.on('SIGINT', () => { clearInterval(pollInterval); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(pollInterval); process.exit(0); });
