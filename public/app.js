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
  CACHE_TTL: 60000, // Cache de 1 minuto
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000 // 2 segundos entre retries
};

const FILES = {
  notifications: path.join(__dirname, 'notifications.json'),
  processed: path.join(__dirname, 'processed.json')
};

let notifications = [];
let processedEvents = new Set();

// ===== CACHE =====
let transactionsCache = {
  data: null,
  timestamp: 0
};

function isCacheValid() {
  return transactionsCache.data && (Date.now() - transactionsCache.timestamp < CONFIG.CACHE_TTL);
}

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

function getAuth() {
  return 'Basic ' + Buffer.from(`${CONFIG.DHR_PUBLIC_KEY}:${CONFIG.DHR_SECRET_KEY}`).toString('base64');
}

// Função de delay para retry
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
        timeout: 30000 // 30 segundos de timeout
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      return await response.json();
    } catch (error) {
      if (attempt === retries) {
        console.error(`  ❌ Falha após ${retries} tentativas: ${error.message}`);
        throw error;
      }
      console.log(`  ⚠️  Tentativa ${attempt}/${retries} falhou, tentando novamente em ${CONFIG.RETRY_DELAY}ms...`);
      await delay(CONFIG.RETRY_DELAY);
    }
  }
}

// Buscar TODAS as transações com paginação automática e cache
async function fetchAllTransactions(forceRefresh = false) {
  // Verificar cache primeiro
  if (!forceRefresh && isCacheValid()) {
    console.log('📦 Usando dados do cache');
    return transactionsCache.data;
  }

  let allTransactions = [];
  let page = 1;
  const pageSize = 200;
  let totalPages = null;
  
  console.log('🔄 Buscando todas as transações da API...');
  
  while (true) {
    try {
      const data = await fetchDHR(`/transactions?page=${page}&pageSize=${pageSize}`);
      const transactions = data.data || [];
      const pagination = data.pagination || {};
      
      // Primeira requisição: descobrir total de páginas
      if (totalPages === null && pagination.totalPages) {
        totalPages = pagination.totalPages;
        console.log(`  📊 Total de registros: ${pagination.totalRecords} (${totalPages} páginas)`);
      }
      
      if (transactions.length === 0) {
        break;
      }
      
      allTransactions = allTransactions.concat(transactions);
      console.log(`  📄 Página ${page}/${totalPages || '?'}: ${transactions.length} transações (total: ${allTransactions.length})`);
      
      // Parar se chegou na última página
      if (totalPages && page >= totalPages) {
        break;
      }
      
      // Limite de segurança: máximo 1000 páginas (200.000 transações)
      if (page >= 1000) {
        console.log('  ⚠️  Limite de segurança atingido (1000 páginas)');
        break;
      }
      
      page++;
      
      // Pequeno delay entre páginas para não sobrecarregar a API
      if (page % 5 === 0) {
        await delay(500);
      }
    } catch (error) {
      console.error(`  ❌ Erro na página ${page}:`, error.message);
      break;
    }
  }
  
  console.log(`✅ Total de transações buscadas: ${allTransactions.length}`);
  
  // Atualizar cache
  transactionsCache = {
    data: allTransactions,
    timestamp: Date.now()
  };
  
  return allTransactions;
}

// ===== FILTROS =====

function applyFilters(transactions, filters) {
  let result = [...transactions];

  if (filters.startDate) {
    // Ajustar para GMT-3 (São Paulo)
    const start = new Date(filters.startDate + 'T00:00:00-03:00').getTime();
    result = result.filter(t => new Date(t.createdAt).getTime() >= start);
  }

  if (filters.endDate) {
    // Ajustar para GMT-3 (São Paulo)
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
  // transactions já vem filtrado pelo período selecionado
  
  // Calcular leads únicos (CPFs únicos) do período
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

  // Calcular vendas por hora (baseado no período filtrado)
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

  // Calcular vendas por dia da semana (baseado no período filtrado)
  const weekdays = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const byWeekday = weekdays.map(d => ({day:d, sales:0, amount:0}));
  transactions.filter(t => t.status === 'paid').forEach(t => {
    const date = new Date(t.createdAt);
    const spDate = new Date(date.getTime() - 3 * 60 * 60 * 1000);
    const d = spDate.getUTCDay();
    byWeekday[d].sales++;
    byWeekday[d].amount += (t.amount||0) / 100;
  });

  // Calcular últimos 7 e 30 dias baseado na data final do período
  const allTxs = transactions;
  const latestDate = allTxs.length > 0 
    ? Math.max(...allTxs.map(t => new Date(t.createdAt).getTime()))
    : Date.now();
  
  const weekAgo = new Date(latestDate - 7*86400000);
  const monthAgo = new Date(latestDate - 30*86400000);
  
  const weekTxs = allTxs.filter(t => new Date(t.createdAt) >= weekAgo);
  const monthTxs = allTxs.filter(t => new Date(t.createdAt) >= monthAgo);

  return {
    period: calc(transactions),  // Renomear de "today" para "period"
    week: calc(weekTxs),
    month: calc(monthTxs),
    hourly,
    bestHour: `${bestHour}:00`,
    weekdayStats: byWeekday,
    totalLeads: totalLeads
  };
}

function analyzeProductsSoldByDate(transactions, startDate = null, endDate = null) {
  // Se não passar datas, usa hoje
  let dayStartBrazil, dayEndBrazil;
  
  if (startDate) {
    // Usar data inicial fornecida (formato: YYYY-MM-DD)
    const [year, month, day] = startDate.split('-').map(Number);
    dayStartBrazil = new Date(Date.UTC(year, month - 1, day, 3, 0, 0, 0)); // 00:00 Brasil = 03:00 UTC
  } else {
    // Usar hoje
    const now = new Date();
    const nowUTC = now.getTime();
    const brazilNow = new Date(nowUTC - (3 * 60 * 60 * 1000)); // UTC-3
    dayStartBrazil = new Date(Date.UTC(
      brazilNow.getUTCFullYear(),
      brazilNow.getUTCMonth(), 
      brazilNow.getUTCDate(),
      3, 0, 0, 0
    ));
  }
  
  if (endDate) {
    // Usar data final fornecida (formato: YYYY-MM-DD)
    const [year, month, day] = endDate.split('-').map(Number);
    dayEndBrazil = new Date(Date.UTC(year, month - 1, day, 3 + 23, 59, 59, 999)); // 23:59 Brasil
  } else if (startDate) {
    // Se só passou startDate, usar o mesmo dia como fim
    const [year, month, day] = startDate.split('-').map(Number);
    dayEndBrazil = new Date(Date.UTC(year, month - 1, day, 3 + 23, 59, 59, 999));
  } else {
    // Usar hoje
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
  
  const dateLabel = startDate ? (endDate && endDate !== startDate ? `${startDate} a ${endDate}` : startDate) : 'hoje';
  console.log(`📅 Filtrando vendas de ${dateLabel} (Brasil):`);
  console.log(`  Início: ${dayStartBrazil.toISOString()} (UTC)`);
  console.log(`  Fim: ${dayEndBrazil.toISOString()} (UTC)`);
  
  // Filtrar transações pelo período
  const filteredTxs = transactions.filter(t => {
    const txTime = new Date(t.createdAt).getTime();
    return txTime >= dayStartBrazil.getTime() && txTime <= dayEndBrazil.getTime();
  });
  
  console.log(`  ✅ ${filteredTxs.length} transações encontradas`);
  
  const productMap = {};
  
  filteredTxs.forEach(t => {
    if (t.items && t.items[0] && t.items[0].title) {
      // Extrair apenas o código da passarela, removendo " - Placa XXX"
      let productName = t.items[0].title;
      // Remove a parte da placa (ex: " - Placa FKO2094")
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
  
  // Converter para array e ordenar por valor líquido (maior para menor)
  const products = Object.values(productMap)
    .map(p => ({
      ...p,
      avgTicket: p.paidSales > 0 ? (p.paidAmount / p.paidSales).toFixed(2) : '0.00',
      avgNetTicket: p.paidSales > 0 ? (p.paidNetAmount / p.paidSales).toFixed(2) : '0.00'
    }))
    .filter(p => p.paidSales > 0) // Mostrar apenas produtos com vendas pagas
    .sort((a, b) => b.paidNetAmount - a.paidNetAmount);
  
  return products;
}

// Manter compatibilidade com a função antiga
function analyzeProductsSoldToday(transactions) {
  return analyzeProductsSoldByDate(transactions, null, null);
}

function analyzePIX(transactions) {
  const pixTxs = transactions.filter(t => t.paymentMethod === 'pix');
  const paid = pixTxs.filter(t => t.status === 'paid');
  const pending = pixTxs.filter(t => ['waiting_payment','pending'].includes(t.status));

  const merchantMap = {};
  pixTxs.forEach(t => {
    // Decodificar código PIX para extrair MERCHANT/ADQUIRENTE
    const pixInfo = decodePIX(t.pix?.qrcode);
    const name = pixInfo.full; // Ex: VIXONSISTEMALTDA/pagsm.com.br
    
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

app.get('/api/products', async (req, res) => {
  try {
    const txs = await fetchAllTransactions();
    const products = new Set();
    
    txs.forEach(t => {
      if (t.items && t.items[0] && t.items[0].title) {
        const productType = t.items[0].title.split(' - ')[0].trim();
        products.add(productType);
      }
    });
    
    res.json(Array.from(products).sort());
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    let txs = await fetchAllTransactions();
    txs = applyFilters(txs, req.query);
    res.json(analyzeDashboard(txs));
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

app.get('/api/pix', async (req, res) => {
  try {
    let txs = await fetchAllTransactions();
    txs = applyFilters(txs, {...req.query, paymentMethod: 'pix'});
    res.json(analyzePIX(txs));
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

app.get('/api/products-sold-today', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const txs = await fetchAllTransactions();
    const products = analyzeProductsSoldByDate(txs, startDate || null, endDate || null);
    res.json(products);
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

app.get('/api/transactions', async (req, res) => {
  try {
    let allTxs = await fetchAllTransactions();
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
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

app.get('/api/sales', async (req, res) => {
  try {
    let allTxs = await fetchAllTransactions();
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
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

app.get('/api/leads', async (req, res) => {
  try {
    let allTxs = await fetchAllTransactions();
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
  } catch (err) {
    res.status(500).json({error: err.message});
  }
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
    cache: isCacheValid() ? 'valid' : 'expired',
    transactions: transactionsCache.data?.length || 0
  });
});

// Endpoint para forçar refresh do cache
app.post('/api/refresh', async (req, res) => {
  try {
    console.log('🔄 Forçando atualização do cache...');
    const txs = await fetchAllTransactions(true);
    res.json({ success: true, transactions: txs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== INICIALIZAÇÃO =====

async function init() {
  notifications = await loadFile(FILES.notifications);
  const processed = await loadFile(FILES.processed);
  processedEvents = new Set(processed);

  console.log('\n🚀 DHR Analytics PRO');
  console.log(`📍 http://localhost:${CONFIG.PORT}`);
  console.log(`💾 Cache TTL: ${CONFIG.CACHE_TTL / 1000}s`);
  console.log(`🔄 Retry: ${CONFIG.MAX_RETRIES} tentativas\n`);

  app.listen(CONFIG.PORT, () => {
    console.log(`✅ Servidor rodando na porta ${CONFIG.PORT}`);
  });
  
  // Buscar dados iniciais
  try {
    await fetchAllTransactions();
  } catch (err) {
    console.error('⚠️  Erro ao buscar dados iniciais:', err.message);
  }
  
  // Iniciar verificação de eventos
  setInterval(checkEvents, CONFIG.CHECK_INTERVAL);
}

init();
