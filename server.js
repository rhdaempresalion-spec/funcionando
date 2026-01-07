import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodePIX } from './pix-decoder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  DHR_PUBLIC_KEY: 'pk_WNNg2i_r8_iqeG3XrdJFI_q1I8ihd1yLoUa08Ip0LKaqxXxE',
  DHR_SECRET_KEY: 'sk_jz1yyIaa0Dw2OWhMH0r16gUgWZ7N2PCpb6aK1crKPIFq02aD',
  DHR_API_URL: 'https://api.dhrtecnologialtda.com/v1',
  CHECK_INTERVAL: 5000,
  PORT: process.env.PORT || 3005,
  BACKGROUND_REFRESH: 10000, // Buscar novas transações a cada 10 segundos (tempo real)
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000
};

const FILES = {
  notifications: path.join(__dirname, 'notifications.json'),
  processed: path.join(__dirname, 'processed.json'),
  transactionsCache: path.join(__dirname, 'transactions_cache.json') // CACHE PERSISTENTE
};

let notifications = [];
let processedEvents = new Set();

// ===== CACHE PERSISTENTE =====
let transactionsCache = {
  data: [],           // Array de transações
  lastId: null,       // ID da última transação (para busca incremental)
  lastUpdate: 0,      // Timestamp da última atualização
  isLoading: false,
  totalRecords: 0
};

// ===== UTILITÁRIOS =====

async function loadFile(filepath, defaultValue = []) {
  try {
    const data = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return defaultValue;
  }
}

async function saveFile(filepath, data) {
  await fs.writeFile(filepath, JSON.stringify(data, null, 2));
}

// Salvar cache de forma otimizada (sem formatação para ser mais rápido)
async function saveCacheFile() {
  try {
    const cacheData = {
      data: transactionsCache.data,
      lastId: transactionsCache.lastId,
      lastUpdate: transactionsCache.lastUpdate,
      totalRecords: transactionsCache.totalRecords
    };
    await fs.writeFile(FILES.transactionsCache, JSON.stringify(cacheData));
    console.log(`💾 Cache salvo: ${transactionsCache.data.length} transações`);
  } catch (err) {
    console.error('❌ Erro ao salvar cache:', err.message);
  }
}

// Carregar cache do disco
async function loadCacheFile() {
  try {
    const data = await fs.readFile(FILES.transactionsCache, 'utf-8');
    const cache = JSON.parse(data);
    transactionsCache.data = cache.data || [];
    transactionsCache.lastId = cache.lastId || null;
    transactionsCache.lastUpdate = cache.lastUpdate || 0;
    transactionsCache.totalRecords = cache.totalRecords || 0;
    console.log(`📂 Cache carregado do disco: ${transactionsCache.data.length} transações`);
    return true;
  } catch {
    console.log('📂 Nenhum cache encontrado, será criado um novo');
    return false;
  }
}

function getAuth() {
  return 'Basic ' + Buffer.from(`${CONFIG.DHR_PUBLIC_KEY}:${CONFIG.DHR_SECRET_KEY}`).toString('base64');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch com retry automático
async function fetchDHR(endpoint, retries = CONFIG.MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${CONFIG.DHR_API_URL}${endpoint}`, {
        headers: { 
          'Authorization': getAuth(),
          'Connection': 'keep-alive'
        },
        timeout: 30000
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      return await response.json();
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      await delay(CONFIG.RETRY_DELAY);
    }
  }
}

// ===== BUSCA INCREMENTAL =====

// Buscar TODAS as transações (usado apenas na primeira vez ou rebuild)
async function fetchAllTransactionsFull() {
  // Evitar múltiplas buscas simultâneas
  if (transactionsCache.isLoading) {
    console.log('⚠️ Busca já em andamento, ignorando...');
    return transactionsCache.data;
  }
  
  transactionsCache.isLoading = true;
  console.log('🔄 Buscando TODAS as transações da API (primeira vez)...');
  
  let allTransactions = [];
  const pageSize = 500;
  
  try {
    // Primeira requisição para descobrir total
    const firstData = await fetchDHR(`/transactions?page=1&pageSize=${pageSize}`);
    const firstTransactions = firstData.data || [];
    const pagination = firstData.pagination || {};
    const totalPages = pagination.totalPages || 1;
    const totalRecords = pagination.totalRecords || 0;
    
    console.log(`  📊 Total: ${totalRecords} transações em ${totalPages} páginas`);
    
    allTransactions = [...firstTransactions];
    
    if (totalPages > 1) {
      // Buscar demais páginas em paralelo (lotes de 10)
      const remainingPages = [];
      for (let p = 2; p <= totalPages; p++) {
        remainingPages.push(p);
      }
      
      const batchSize = 10; // Aumentado para ser mais rápido
      for (let i = 0; i < remainingPages.length; i += batchSize) {
        const batch = remainingPages.slice(i, i + batchSize);
        const promises = batch.map(p => fetchDHR(`/transactions?page=${p}&pageSize=${pageSize}`));
        
        const results = await Promise.all(promises);
        results.forEach(data => {
          if (data.data) {
            allTransactions = allTransactions.concat(data.data);
          }
        });
        
        const progress = Math.min(100, Math.round((i + batchSize) / remainingPages.length * 100));
        console.log(`  📥 Progresso: ${progress}% (${allTransactions.length} transações)`);
      }
    }
    
    // Ordenar por data (mais recente primeiro)
    allTransactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    // Atualizar cache
    transactionsCache.data = allTransactions;
    transactionsCache.lastId = allTransactions[0]?.id || null;
    transactionsCache.lastUpdate = Date.now();
    transactionsCache.totalRecords = allTransactions.length;
    
    // Salvar em disco
    await saveCacheFile();
    
    console.log(`✅ Cache completo: ${allTransactions.length} transações`);
    transactionsCache.isLoading = false;
    return allTransactions;
    
  } catch (err) {
    console.error('❌ Erro ao buscar transações:', err.message);
    transactionsCache.isLoading = false;
    throw err;
  }
}

// Buscar apenas transações NOVAS (incremental)
async function fetchNewTransactions() {
  if (transactionsCache.isLoading) return;
  if (transactionsCache.data.length === 0) {
    // Primeira vez, precisa buscar tudo
    return await fetchAllTransactionsFull();
  }
  
  transactionsCache.isLoading = true;
  
  try {
    // Buscar primeira página para ver se tem novidades
    const data = await fetchDHR('/transactions?page=1&pageSize=100');
    const newTxs = data.data || [];
    
    if (newTxs.length === 0) {
      transactionsCache.isLoading = false;
      return transactionsCache.data;
    }
    
    // Encontrar transações que ainda não temos
    const existingIds = new Set(transactionsCache.data.map(t => t.id));
    const brandNew = newTxs.filter(t => !existingIds.has(t.id));
    
    if (brandNew.length > 0) {
      console.log(`🆕 ${brandNew.length} novas transações encontradas`);
      
      // Adicionar no início (mais recentes primeiro)
      transactionsCache.data = [...brandNew, ...transactionsCache.data];
      transactionsCache.lastId = transactionsCache.data[0]?.id;
      transactionsCache.lastUpdate = Date.now();
      transactionsCache.totalRecords = transactionsCache.data.length;
      
      // Salvar em disco
      await saveCacheFile();
    }
    
    // Verificar se alguma transação mudou de status (ex: pending -> paid)
    let updated = 0;
    for (const newTx of newTxs) {
      const existing = transactionsCache.data.find(t => t.id === newTx.id);
      if (existing && existing.status !== newTx.status) {
        // Atualizar status
        Object.assign(existing, newTx);
        updated++;
      }
    }
    
    if (updated > 0) {
      console.log(`🔄 ${updated} transações atualizadas`);
      await saveCacheFile();
    }
    
    transactionsCache.isLoading = false;
    return transactionsCache.data;
    
  } catch (err) {
    console.error('❌ Erro ao buscar novas transações:', err.message);
    transactionsCache.isLoading = false;
    return transactionsCache.data;
  }
}

// Retorna dados do cache (instantâneo)
function getTransactionsFromCache() {
  return transactionsCache.data;
}

// ===== FILTROS =====

function applyFilters(transactions, filters) {
  let result = [...transactions];

  if (filters.startDate) {
    const start = new Date(filters.startDate + 'T00:00:00-03:00').getTime();
    result = result.filter(t => new Date(t.createdAt).getTime() >= start);
  }

  if (filters.endDate) {
    const end = new Date(filters.endDate + 'T23:59:59-03:00').getTime();
    result = result.filter(t => new Date(t.createdAt).getTime() <= end);
  }

  if (filters.status === 'paid') {
    result = result.filter(t => t.status === 'paid');
  } else if (filters.status === 'pending') {
    result = result.filter(t => ['waiting_payment', 'pending'].includes(t.status));
  }

  if (filters.paymentMethod && filters.paymentMethod !== 'all') {
    result = result.filter(t => t.paymentMethod === filters.paymentMethod);
  }

  if (filters.products && filters.products.length > 0) {
    const productList = filters.products.split(',');
    result = result.filter(t => {
      if (!t.items || !t.items[0]) return false;
      const productType = t.items[0].title.split(' - ')[0].trim();
      return productList.includes(productType);
    });
  }

  return result;
}

// ===== ANÁLISES =====

function analyzeDashboard(transactions) {
  const uniqueLeads = new Set();
  transactions.forEach(t => {
    if (t.customer && t.customer.document && t.customer.document.number) {
      uniqueLeads.add(t.customer.document.number);
    }
  });
  const totalLeads = uniqueLeads.size;

  const calc = (txs) => {
    const paid = txs.filter(t => t.status === 'paid');
    const pending = txs.filter(t => ['waiting_payment','pending'].includes(t.status));
    const paidAmount = paid.reduce((s,t) => s + (t.amount||0), 0) / 100;
    const netAmount = paid.reduce((s,t) => s + (t.fee?.netAmount||0), 0) / 100;
    const estimatedFee = paidAmount - netAmount;
    const refundedAmount = txs.reduce((s,t) => s + (t.refundedAmount||0), 0) / 100;
    
    return {
      total: txs.length,
      paid: paid.length,
      pending: pending.length,
      paidAmount,
      pendingAmount: pending.reduce((s,t) => s + (t.amount||0), 0) / 100,
      totalAmount: txs.reduce((s,t) => s + (t.amount||0), 0) / 100,
      avgTicket: paid.length ? paid.reduce((s,t) => s + (t.amount||0), 0) / paid.length / 100 : 0,
      conversion: txs.length ? (paid.length / txs.length * 100).toFixed(1) : 0,
      netAmount,
      estimatedFee,
      refundedAmount
    };
  };

  const hourly = Array(24).fill(0).map(() => ({sales:0, amount:0}));
  transactions.filter(t => t.status === 'paid').forEach(t => {
    const date = new Date(t.createdAt);
    const utcHour = date.getUTCHours();
    const spHour = (utcHour - 3 + 24) % 24;
    hourly[spHour].sales++;
    hourly[spHour].amount += (t.amount||0) / 100;
  });

  const bestHour = hourly.reduce((best, curr, idx) => 
    curr.sales > hourly[best].sales ? idx : best, 0);

  const weekdays = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const byWeekday = weekdays.map(d => ({day:d, sales:0, amount:0}));
  transactions.filter(t => t.status === 'paid').forEach(t => {
    const date = new Date(t.createdAt);
    const spDate = new Date(date.getTime() - 3 * 60 * 60 * 1000);
    const d = spDate.getUTCDay();
    byWeekday[d].sales++;
    byWeekday[d].amount += (t.amount||0) / 100;
  });

  const allTxs = transactions;
  const latestDate = allTxs.length > 0 
    ? Math.max(...allTxs.map(t => new Date(t.createdAt).getTime()))
    : Date.now();
  
  const weekAgo = new Date(latestDate - 7*86400000);
  const monthAgo = new Date(latestDate - 30*86400000);
  
  const weekTxs = allTxs.filter(t => new Date(t.createdAt) >= weekAgo);
  const monthTxs = allTxs.filter(t => new Date(t.createdAt) >= monthAgo);

  return {
    period: calc(transactions),
    today: calc(transactions),
    week: calc(weekTxs),
    month: calc(monthTxs),
    hourly,
    bestHour: `${bestHour}:00`,
    weekdayStats: byWeekday,
    totalLeads: totalLeads
  };
}

function analyzeProductsSoldByDate(transactions, startDate = null, endDate = null) {
  let dayStartBrazil, dayEndBrazil;
  
  if (startDate) {
    const [year, month, day] = startDate.split('-').map(Number);
    dayStartBrazil = new Date(Date.UTC(year, month - 1, day, 3, 0, 0, 0));
  } else {
    const now = new Date();
    const nowUTC = now.getTime();
    const brazilNow = new Date(nowUTC - (3 * 60 * 60 * 1000));
    dayStartBrazil = new Date(Date.UTC(
      brazilNow.getUTCFullYear(),
      brazilNow.getUTCMonth(), 
      brazilNow.getUTCDate(),
      3, 0, 0, 0
    ));
  }
  
  if (endDate) {
    const [year, month, day] = endDate.split('-').map(Number);
    dayEndBrazil = new Date(Date.UTC(year, month - 1, day, 3 + 23, 59, 59, 999));
  } else if (startDate) {
    const [year, month, day] = startDate.split('-').map(Number);
    dayEndBrazil = new Date(Date.UTC(year, month - 1, day, 3 + 23, 59, 59, 999));
  } else {
    const now = new Date();
    const nowUTC = now.getTime();
    const brazilNow = new Date(nowUTC - (3 * 60 * 60 * 1000));
    dayEndBrazil = new Date(Date.UTC(
      brazilNow.getUTCFullYear(),
      brazilNow.getUTCMonth(),
      brazilNow.getUTCDate(),
      3 + 23, 59, 59, 999
    ));
  }
  
  const filteredTxs = transactions.filter(t => {
    const txTime = new Date(t.createdAt).getTime();
    return txTime >= dayStartBrazil.getTime() && txTime <= dayEndBrazil.getTime();
  });
  
  const productMap = {};
  
  filteredTxs.forEach(t => {
    if (t.items && t.items[0] && t.items[0].title) {
      let productName = t.items[0].title;
      productName = productName.replace(/\s*-\s*Placa\s+[A-Z0-9]+/i, '');
      
      const quantity = t.items[0].quantity || 1;
      const amount = (t.amount || 0) / 100;
      
      if (!productMap[productName]) {
        productMap[productName] = {
          name: productName,
          totalSales: 0,
          totalQuantity: 0,
          totalAmount: 0,
          paidSales: 0,
          paidAmount: 0,
          paidNetAmount: 0,
          pendingSales: 0,
          pendingAmount: 0
        };
      }
      
      productMap[productName].totalSales++;
      productMap[productName].totalQuantity += quantity;
      productMap[productName].totalAmount += amount;
      
      if (t.status === 'paid') {
        const netAmount = (t.fee?.netAmount || 0) / 100;
        productMap[productName].paidSales++;
        productMap[productName].paidAmount += amount;
        productMap[productName].paidNetAmount += netAmount;
      } else if (['waiting_payment', 'pending'].includes(t.status)) {
        productMap[productName].pendingSales++;
        productMap[productName].pendingAmount += amount;
      }
    }
  });
  
  return Object.values(productMap)
    .map(p => ({
      ...p,
      avgTicket: p.paidSales > 0 ? (p.paidAmount / p.paidSales).toFixed(2) : '0.00',
      avgNetTicket: p.paidSales > 0 ? (p.paidNetAmount / p.paidSales).toFixed(2) : '0.00'
    }))
    .filter(p => p.paidSales > 0)
    .sort((a, b) => b.paidNetAmount - a.paidNetAmount);
}

function analyzePIX(transactions) {
  const pixTxs = transactions.filter(t => t.paymentMethod === 'pix');
  const paid = pixTxs.filter(t => t.status === 'paid');
  const pending = pixTxs.filter(t => ['waiting_payment','pending'].includes(t.status));

  const merchantMap = {};
  pixTxs.forEach(t => {
    const pixInfo = decodePIX(t.pix?.qrcode);
    const name = pixInfo.full;
    
    if (!merchantMap[name]) {
      merchantMap[name] = {
        name,
        merchant: pixInfo.merchant,
        acquirer: pixInfo.acquirer,
        total: 0,
        paid: 0,
        pending: 0,
        amount: 0
      };
    }
    merchantMap[name].total++;
    if (t.status === 'paid') {
      merchantMap[name].paid++;
      merchantMap[name].amount += (t.amount||0) / 100;
    } else if (['waiting_payment','pending'].includes(t.status)) {
      merchantMap[name].pending++;
    }
  });

  const ranking = Object.values(merchantMap).map(m => ({
    ...m,
    conversion: m.total ? (m.paid / m.total * 100).toFixed(1) : 0
  })).sort((a,b) => b.paid - a.paid);

  const amounts = {};
  pixTxs.forEach(t => {
    const amt = ((t.amount||0)/100).toFixed(2);
    amounts[amt] = (amounts[amt]||0) + 1;
  });

  const topAmounts = Object.entries(amounts)
    .map(([amt, cnt]) => ({amount:parseFloat(amt), count:cnt}))
    .sort((a,b) => b.count - a.count)
    .slice(0,10);

  let avgTime = 0;
  if (paid.length) {
    const times = paid.filter(t => t.updatedAt).map(t => 
      new Date(t.updatedAt) - new Date(t.createdAt)
    );
    if (times.length) avgTime = times.reduce((s,t) => s+t, 0) / times.length / 60000;
  }

  return {
    total: pixTxs.length,
    paid: paid.length,
    pending: pending.length,
    uniqueMerchants: Object.keys(merchantMap).length,
    conversionRate: pixTxs.length ? (paid.length / pixTxs.length * 100).toFixed(1) : 0,
    avgPaymentTime: avgTime.toFixed(1) + ' min',
    ranking: ranking,
    topValues: topAmounts.map(a => ({value: a.amount, count: a.count}))
  };
}

// ===== NOTIFICAÇÕES =====

async function checkEvents() {
  try {
    const data = await fetchDHR('/transactions?page=1&pageSize=50');
    const txs = data.data || [];

    for (const tx of txs) {
      const key = `${tx.id}-${tx.status}`;
      if (processedEvents.has(key)) continue;

      if (tx.status === 'paid' || tx.status === 'refunded') {
        await sendNotifs(tx);
        processedEvents.add(key);
      }
    }

    await saveFile(FILES.processed, Array.from(processedEvents));
  } catch (err) {
    console.error('Erro ao verificar eventos:', err.message);
  }
}

async function sendNotifs(tx) {
  const type = tx.status === 'paid' ? 'sale_paid' : 'refund';
  const active = notifications.filter(n => n.enabled && n.eventType === type);

  for (const n of active) {
    try {
      const msg = formatMsg(n, tx);
      await fetch(n.url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(msg)
      });
      console.log(`✅ Notificação enviada: ${n.name}`);
    } catch (err) {
      console.error(`❌ Erro ao enviar notificação: ${err.message}`);
    }
  }
}

function formatMsg(notif, tx) {
  const vars = {
    '{VALOR}': `R$ ${((tx.amount||0)/100).toFixed(2)}`,
    '{CLIENTE}': tx.customer?.name || 'Cliente',
    '{EMAIL}': tx.customer?.email || '',
    '{DOCUMENTO}': tx.customer?.document || '',
    '{METODO}': tx.paymentMethod || '',
    '{ID}': tx.id || '',
    '{DATA}': new Date().toLocaleString('pt-BR'),
    '{PARCELAS}': tx.installments || '1'
  };

  let title = notif.title;
  let text = notif.text;
  Object.entries(vars).forEach(([k,v]) => {
    title = title.replace(new RegExp(k, 'g'), v);
    text = text.replace(new RegExp(k, 'g'), v);
  });

  return {title, text};
}

// ===== API =====

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Endpoint para obter TODAS as transações do cache (INSTANTÂNEO)
app.get('/api/all-transactions', (req, res) => {
  const txs = getTransactionsFromCache();
  res.json({
    data: txs,
    cacheTimestamp: transactionsCache.lastUpdate,
    isLoading: transactionsCache.isLoading,
    totalRecords: txs.length
  });
});

// Status do cache
app.get('/api/cache-status', (req, res) => {
  res.json({
    timestamp: transactionsCache.lastUpdate,
    isLoading: transactionsCache.isLoading,
    totalRecords: transactionsCache.data.length,
    age: Date.now() - transactionsCache.lastUpdate
  });
});

app.get('/api/products', (req, res) => {
  const txs = getTransactionsFromCache();
  const products = new Set();
  
  txs.forEach(t => {
    if (t.items && t.items[0] && t.items[0].title) {
      const productType = t.items[0].title.split(' - ')[0].trim();
      products.add(productType);
    }
  });
  
  res.json(Array.from(products).sort());
});

app.get('/api/dashboard', (req, res) => {
  let txs = getTransactionsFromCache();
  txs = applyFilters(txs, req.query);
  res.json(analyzeDashboard(txs));
});

app.get('/api/pix', (req, res) => {
  let txs = getTransactionsFromCache();
  txs = applyFilters(txs, {...req.query, paymentMethod: 'pix'});
  res.json(analyzePIX(txs));
});

app.get('/api/products-sold-today', (req, res) => {
  const { startDate, endDate } = req.query;
  const txs = getTransactionsFromCache();
  const products = analyzeProductsSoldByDate(txs, startDate || null, endDate || null);
  res.json(products);
});

app.get('/api/transactions', (req, res) => {
  let allTxs = getTransactionsFromCache();
  allTxs = applyFilters(allTxs, req.query);
  
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 50;
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  
  const paginatedTxs = allTxs.slice(start, end);
  
  res.json({
    data: paginatedTxs,
    pagination: {
      page,
      pageSize,
      totalRecords: allTxs.length,
      totalPages: Math.ceil(allTxs.length / pageSize)
    }
  });
});

app.get('/api/sales', (req, res) => {
  let allTxs = getTransactionsFromCache();
  allTxs = applyFilters(allTxs, req.query);
  
  const sales = allTxs
    .filter(t => t.status === 'paid')
    .map(t => ({
      id: t.id,
      date: t.createdAt,
      customer: t.customer?.name || 'N/A',
      email: t.customer?.email || 'N/A',
      document: t.customer?.document?.number || 'N/A',
      product: t.items?.[0]?.title || 'N/A',
      amount: (t.amount || 0) / 100,
      netAmount: (t.fee?.netAmount || 0) / 100,
      fee: ((t.amount || 0) - (t.fee?.netAmount || 0)) / 100,
      method: t.paymentMethod || 'N/A',
      installments: t.installments || 1
    }));
  
  res.json(sales);
});

app.get('/api/leads', (req, res) => {
  let allTxs = getTransactionsFromCache();
  allTxs = applyFilters(allTxs, req.query);
  
  const leadsMap = {};
  
  allTxs.forEach(t => {
    const doc = t.customer?.document?.number;
    if (!doc) return;
    
    if (!leadsMap[doc]) {
      leadsMap[doc] = {
        document: doc,
        name: t.customer?.name || 'N/A',
        email: t.customer?.email || 'N/A',
        phone: t.customer?.phone || 'N/A',
        firstPurchase: t.createdAt,
        lastPurchase: t.createdAt,
        totalPurchases: 0,
        paidPurchases: 0,
        totalSpent: 0,
        products: new Set()
      };
    }
    
    const lead = leadsMap[doc];
    lead.totalPurchases++;
    
    if (t.status === 'paid') {
      lead.paidPurchases++;
      lead.totalSpent += (t.amount || 0) / 100;
    }
    
    if (new Date(t.createdAt) < new Date(lead.firstPurchase)) {
      lead.firstPurchase = t.createdAt;
    }
    if (new Date(t.createdAt) > new Date(lead.lastPurchase)) {
      lead.lastPurchase = t.createdAt;
    }
    
    if (t.items?.[0]?.title) {
      const productType = t.items[0].title.split(' - ')[0].trim();
      lead.products.add(productType);
    }
  });
  
  const leads = Object.values(leadsMap).map(l => ({
    ...l,
    products: Array.from(l.products).join(', ')
  }));
  
  res.json(leads);
});

// Notificações
app.get('/api/notifications', (req, res) => {
  res.json(notifications);
});

app.post('/api/notifications', async (req, res) => {
  const notif = {
    id: Date.now().toString(),
    enabled: true,
    ...req.body
  };
  notifications.push(notif);
  await saveFile(FILES.notifications, notifications);
  res.json(notif);
});

app.put('/api/notifications/:id', async (req, res) => {
  const idx = notifications.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({error: 'Not found'});
  
  notifications[idx] = {...notifications[idx], ...req.body};
  await saveFile(FILES.notifications, notifications);
  res.json(notifications[idx]);
});

app.delete('/api/notifications/:id', async (req, res) => {
  notifications = notifications.filter(n => n.id !== req.params.id);
  await saveFile(FILES.notifications, notifications);
  res.json({success: true});
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    cacheAge: Date.now() - transactionsCache.lastUpdate,
    transactions: transactionsCache.data.length,
    isLoading: transactionsCache.isLoading
  });
});

// Forçar refresh do cache (busca incremental)
app.post('/api/refresh', async (req, res) => {
  console.log('🔄 Atualizando cache...');
  await fetchNewTransactions();
  res.json({ success: true, transactions: transactionsCache.data.length });
});

// Forçar rebuild completo do cache
app.post('/api/rebuild-cache', async (req, res) => {
  console.log('🔄 Reconstruindo cache completo...');
  transactionsCache.data = [];
  await fetchAllTransactionsFull();
  res.json({ success: true, transactions: transactionsCache.data.length });
});

// ===== INICIALIZAÇÃO =====

let backgroundRefreshInterval = null;

async function init() {
  notifications = await loadFile(FILES.notifications);
  const processed = await loadFile(FILES.processed);
  processedEvents = new Set(processed);

  console.log('\n🚀 DHR Analytics PRO - INSTANT LOAD');
  console.log(`📍 http://localhost:${CONFIG.PORT}`);
  console.log(`🔄 Background refresh: ${CONFIG.BACKGROUND_REFRESH / 1000}s\n`);

  // PRIMEIRO: Carregar cache do disco (INSTANTÂNEO)
  const cacheLoaded = await loadCacheFile();
  
  // Iniciar servidor IMEDIATAMENTE (não espera API)
  app.listen(CONFIG.PORT, () => {
    console.log(`✅ Servidor rodando na porta ${CONFIG.PORT}`);
    if (cacheLoaded) {
      console.log(`⚡ Cache disponível: ${transactionsCache.data.length} transações`);
    }
  });
  
  // Se não tinha cache, buscar em background e SÓ DEPOIS iniciar o intervalo
  if (!cacheLoaded) {
    console.log('📥 Buscando transações da API em background...');
    fetchAllTransactionsFull()
      .then(() => {
        // SÓ inicia o intervalo DEPOIS que terminar o primeiro carregamento
        startBackgroundRefresh();
      })
      .catch(err => {
        console.error('⚠️ Erro ao buscar dados iniciais:', err.message);
        // Mesmo com erro, inicia o intervalo para tentar novamente
        startBackgroundRefresh();
      });
  } else {
    // Se tinha cache, buscar apenas novas transações em background
    setTimeout(() => {
      fetchNewTransactions().catch(err => {
        console.error('⚠️ Erro ao buscar novas transações:', err.message);
      });
    }, 2000);
    
    // Já tem cache, pode iniciar o intervalo
    startBackgroundRefresh();
  }
  
  // Iniciar verificação de eventos para notificações
  setInterval(checkEvents, CONFIG.CHECK_INTERVAL);
}

function startBackgroundRefresh() {
  if (backgroundRefreshInterval) return; // Já iniciado
  
  console.log(`🔄 Iniciando atualização em background a cada ${CONFIG.BACKGROUND_REFRESH / 1000}s`);
  backgroundRefreshInterval = setInterval(fetchNewTransactions, CONFIG.BACKGROUND_REFRESH);
}

init();
