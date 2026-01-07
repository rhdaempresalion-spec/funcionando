// ===== DHR ANALYTICS PRO - ULTRA FAST =====
// Versão otimizada com cache local e filtros instantâneos

// ===== ESTADO GLOBAL =====
let currentFilters = {
  startDate: '',
  endDate: '',
  status: 'all',
  paymentMethod: 'all',
  products: []
};

let analysisData = {
  adSpend: 0,
  leads: 0,
  chargeback: 0
};

let dashboardData = null;
let editingNotificationId = null;

let charts = {
  hourly: null,
  weekday: null,
  amounts: null
};

// ===== CACHE LOCAL DE TRANSAÇÕES =====
let localCache = {
  transactions: [],
  timestamp: 0,
  isLoading: false,
  products: []
};

// ===== INICIALIZAÇÃO =====
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupFilters();
  
  // Carregar dados iniciais
  initializeData();
  
  // Atualizar cache em background a cada 10 segundos (tempo real)
  setInterval(refreshCacheBackground, 10000);
  
  // Mostrar indicador de última atualização
  updateCacheIndicator();
  setInterval(updateCacheIndicator, 5000);
});

async function initializeData() {
  await loadAllTransactions();
  
  // Se não carregou dados, tentar novamente em 2 segundos
  if (localCache.transactions.length === 0) {
    showToast('⏳ Servidor carregando dados, aguarde...');
    setTimeout(async () => {
      await loadAllTransactions();
      if (localCache.transactions.length === 0) {
        // Tentar mais uma vez
        setTimeout(initializeData, 3000);
      } else {
        finishInitialization();
      }
    }, 2000);
  } else {
    finishInitialization();
  }
}

function finishInitialization() {
  loadProducts();
  applyFiltersInstant();
  loadNotifications();
  loadAnalysisData();
}

// ===== CACHE LOCAL =====
async function loadAllTransactions() {
  if (localCache.isLoading) return;
  
  localCache.isLoading = true;
  showLoadingIndicator(true);
  
  try {
    const startTime = Date.now();
    const response = await fetch('/api/all-transactions');
    const data = await response.json();
    const loadTime = Date.now() - startTime;
    
    localCache.transactions = data.data || [];
    localCache.timestamp = data.cacheTimestamp || Date.now();
    
    // Extrair produtos únicos
    const products = new Set();
    localCache.transactions.forEach(t => {
      if (t.items && t.items[0] && t.items[0].title) {
        const productType = t.items[0].title.split(' - ')[0].trim();
        products.add(productType);
      }
    });
    localCache.products = Array.from(products).sort();
    
    console.log(`✅ Cache local: ${localCache.transactions.length} transações em ${loadTime}ms`);
    
    if (localCache.transactions.length > 0) {
      showToast(`⚡ ${localCache.transactions.length.toLocaleString()} transações em ${loadTime}ms`);
    } else {
      showToast('⏳ Aguardando dados do servidor...');
    }
    
  } catch (error) {
    console.error('Erro ao carregar transações:', error);
    showToast('❌ Erro ao carregar dados');
  } finally {
    localCache.isLoading = false;
    showLoadingIndicator(false);
  }
}

async function refreshCacheBackground() {
  if (localCache.isLoading) return;
  
  try {
    const response = await fetch('/api/all-transactions');
    const data = await response.json();
    
    const newCount = (data.data || []).length;
    const oldCount = localCache.transactions.length;
    
    localCache.transactions = data.data || [];
    localCache.timestamp = data.cacheTimestamp || Date.now();
    
    // Atualizar produtos
    const products = new Set();
    localCache.transactions.forEach(t => {
      if (t.items && t.items[0] && t.items[0].title) {
        const productType = t.items[0].title.split(' - ')[0].trim();
        products.add(productType);
      }
    });
    localCache.products = Array.from(products).sort();
    
    // Se houve mudança, atualizar dashboard
    if (newCount !== oldCount) {
      console.log(`🔄 Cache atualizado: ${oldCount} → ${newCount} transações`);
      applyFiltersInstant();
    }
    
    updateCacheIndicator();
    
  } catch (error) {
    console.error('Erro ao atualizar cache:', error);
  }
}

function updateCacheIndicator() {
  const indicator = document.getElementById('cache-indicator');
  if (!indicator) return;
  
  const age = Date.now() - localCache.timestamp;
  const seconds = Math.floor(age / 1000);
  
  if (seconds < 60) {
    indicator.textContent = `Atualizado há ${seconds}s`;
  } else {
    const minutes = Math.floor(seconds / 60);
    indicator.textContent = `Atualizado há ${minutes}min`;
  }
}

function showLoadingIndicator(show) {
  const indicator = document.getElementById('loading-indicator');
  if (indicator) {
    indicator.style.display = show ? 'block' : 'none';
  }
}

// ===== FILTROS LOCAIS (INSTANTÂNEOS) =====
function applyFiltersLocal(transactions) {
  let result = [...transactions];

  if (currentFilters.startDate) {
    const start = new Date(currentFilters.startDate + 'T00:00:00-03:00').getTime();
    result = result.filter(t => new Date(t.createdAt).getTime() >= start);
  }

  if (currentFilters.endDate) {
    const end = new Date(currentFilters.endDate + 'T23:59:59-03:00').getTime();
    result = result.filter(t => new Date(t.createdAt).getTime() <= end);
  }

  if (currentFilters.status === 'paid') {
    result = result.filter(t => t.status === 'paid');
  } else if (currentFilters.status === 'pending') {
    result = result.filter(t => ['waiting_payment', 'pending'].includes(t.status));
  }

  if (currentFilters.paymentMethod && currentFilters.paymentMethod !== 'all') {
    result = result.filter(t => t.paymentMethod === currentFilters.paymentMethod);
  }

  if (currentFilters.products && currentFilters.products.length > 0) {
    result = result.filter(t => {
      if (!t.items || !t.items[0]) return false;
      const productType = t.items[0].title.split(' - ')[0].trim();
      return currentFilters.products.includes(productType);
    });
  }

  return result;
}

// ===== ANÁLISES LOCAIS =====
function analyzeDashboardLocal(transactions) {
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
    today: calc(transactions), // Compatibilidade
    week: calc(weekTxs),
    month: calc(monthTxs),
    hourly,
    bestHour: `${bestHour}:00`,
    weekdayStats: byWeekday,
    totalLeads: totalLeads
  };
}

function analyzeProductsSoldLocal(transactions, startDate = null, endDate = null) {
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

function analyzePIXLocal(transactions) {
  const pixTxs = transactions.filter(t => t.paymentMethod === 'pix');
  const paid = pixTxs.filter(t => t.status === 'paid');
  const pending = pixTxs.filter(t => ['waiting_payment','pending'].includes(t.status));

  const merchantMap = {};
  pixTxs.forEach(t => {
    // Simplificado - usar nome do cliente como merchant
    const name = t.customer?.name || 'Desconhecido';
    
    if (!merchantMap[name]) {
      merchantMap[name] = {
        name,
        merchant: name,
        acquirer: 'PIX',
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

// ===== TABS =====
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      document.getElementById(`tab-${tabName}`).classList.remove('hidden');
      
      // Carregar dados instantaneamente do cache local
      if (tabName === 'dashboard') applyFiltersInstant();
      if (tabName === 'pix') loadPIXInstant();
      if (tabName === 'analysis') {
        updateAnalysis();
        setTimeout(() => calculateAnalysis(), 100);
      }
      if (tabName === 'notifications') loadNotifications();
    });
  });
}

// ===== PRODUTOS =====
function loadProducts() {
  const select = document.getElementById('filter-products');
  if (!select) return;
  
  select.innerHTML = '<option value="all">Todos</option>';
  
  localCache.products.forEach(p => {
    const option = document.createElement('option');
    option.value = p;
    option.textContent = p;
    select.appendChild(option);
  });
}

// ===== FILTROS =====
function setupFilters() {
  // Filtros já configurados no HTML
}

function applyFilters() {
  const startDate = document.getElementById('filter-start-date').value;
  const endDate = document.getElementById('filter-end-date').value;
  const status = document.getElementById('filter-status').value;
  const method = document.getElementById('filter-method').value;
  
  const productsSelect = document.getElementById('filter-products');
  const selectedProducts = productsSelect ? Array.from(productsSelect.selectedOptions).map(opt => opt.value) : [];
  
  currentFilters = {
    startDate,
    endDate,
    status,
    paymentMethod: method,
    products: selectedProducts.includes('all') ? [] : selectedProducts
  };
  
  // INSTANTÂNEO - sem requisição ao servidor!
  applyFiltersInstant();
  showToast('✅ Filtros aplicados');
}

function applyFiltersInstant() {
  // Filtrar localmente - INSTANTÂNEO!
  const filtered = applyFiltersLocal(localCache.transactions);
  
  // Analisar localmente
  dashboardData = analyzeDashboardLocal(filtered);
  
  // Atualizar UI
  updateDashboardCards(dashboardData);
  updateCharts(dashboardData);
  loadProductsSoldInstant();
}

function clearFilters() {
  document.getElementById('filter-start-date').value = '';
  document.getElementById('filter-end-date').value = '';
  document.getElementById('filter-status').value = 'all';
  document.getElementById('filter-method').value = 'all';
  
  const productsSelect = document.getElementById('filter-products');
  if (productsSelect) {
    Array.from(productsSelect.options).forEach(opt => {
      opt.selected = opt.value === 'all';
    });
  }
  
  currentFilters = {
    startDate: '',
    endDate: '',
    status: 'all',
    paymentMethod: 'all',
    products: []
  };
  
  applyFiltersInstant();
  showToast('🔄 Filtros limpos');
}

function buildQueryString() {
  const params = new URLSearchParams();
  if (currentFilters.startDate) params.append('startDate', currentFilters.startDate);
  if (currentFilters.endDate) params.append('endDate', currentFilters.endDate);
  if (currentFilters.status !== 'all') params.append('status', currentFilters.status);
  if (currentFilters.paymentMethod !== 'all') params.append('paymentMethod', currentFilters.paymentMethod);
  if (currentFilters.products && currentFilters.products.length > 0) {
    params.append('products', currentFilters.products.join(','));
  }
  return params.toString();
}

// ===== DASHBOARD =====
async function loadDashboard() {
  // Usar cache local
  applyFiltersInstant();
}

function loadProductsSoldInstant() {
  const startDate = currentFilters.startDate || new Date().toISOString().split('T')[0];
  const endDate = currentFilters.endDate || startDate;
  
  const label = document.getElementById('products-date-label');
  if (label) {
    if (startDate === endDate) {
      const today = new Date().toISOString().split('T')[0];
      if (startDate === today) {
        label.textContent = 'Mostrando vendas de hoje';
      } else {
        const dateObj = new Date(startDate + 'T12:00:00');
        const formatted = dateObj.toLocaleDateString('pt-BR');
        label.textContent = 'Mostrando vendas de ' + formatted;
      }
    } else {
      const startObj = new Date(startDate + 'T12:00:00');
      const endObj = new Date(endDate + 'T12:00:00');
      label.textContent = 'Mostrando vendas de ' + startObj.toLocaleDateString('pt-BR') + ' ate ' + endObj.toLocaleDateString('pt-BR');
    }
  }
  
  // Analisar localmente
  const products = analyzeProductsSoldLocal(localCache.transactions, startDate, endDate);
  
  const container = document.getElementById('products-sold-container');
  if (!container) return;
  
  if (products.length === 0) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">Nenhum produto vendido no período selecionado</div>';
    return;
  }
  
  let html = '<div class="table-container"><table>';
  html += '<thead><tr>';
  html += '<th>Produto</th>';
  html += '<th style="text-align: center;">Vendas Pagas</th>';
  html += '<th style="text-align: center;">Quantidade</th>';
  html += '<th style="text-align: right;">Valor Líquido Recebido</th>';
  html += '<th style="text-align: right;">Ticket Médio Líquido</th>';
  html += '</tr></thead><tbody>';
  
  products.forEach(product => {
    html += '<tr>';
    html += `<td><strong>${product.name}</strong></td>`;
    html += `<td style="text-align: center;">`;
    html += `<span class="badge badge-success">${product.paidSales}</span>`;
    html += `</td>`;
    html += `<td style="text-align: center;">${product.paidSales}x</td>`;
    html += `<td style="text-align: right;"><strong>${formatMoney(product.paidNetAmount)}</strong></td>`;
    html += `<td style="text-align: right;">${formatMoney(parseFloat(product.avgNetTicket))}</td>`;
    html += '</tr>';
  });
  
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function updateDashboardCards(data) {
  const periodData = data.period || data.today;
  
  const netAmountEl = document.getElementById('net-amount');
  if (netAmountEl) netAmountEl.textContent = formatMoney(periodData.netAmount);
  
  const netSubtitleEl = document.getElementById('net-subtitle');
  if (netSubtitleEl) netSubtitleEl.textContent = `Taxa: ${formatMoney(periodData.estimatedFee || 0)}`;
  
  const todayPaidAmountEl = document.getElementById('today-paid-amount');
  if (todayPaidAmountEl) todayPaidAmountEl.textContent = formatMoney(periodData.paidAmount);
  
  const todayPaidCountEl = document.getElementById('today-paid-count');
  if (todayPaidCountEl) todayPaidCountEl.textContent = `${periodData.paid} transações`;
  
  const todayPendingAmountEl = document.getElementById('today-pending-amount');
  if (todayPendingAmountEl) todayPendingAmountEl.textContent = formatMoney(periodData.pendingAmount);
  
  const todayPendingCountEl = document.getElementById('today-pending-count');
  if (todayPendingCountEl) todayPendingCountEl.textContent = `${periodData.pending} transações`;
  
  const avgTicketEl = document.getElementById('avg-ticket');
  if (avgTicketEl) avgTicketEl.textContent = formatMoney(periodData.avgTicket);
  
  const weekPaidAmountEl = document.getElementById('week-paid-amount');
  if (weekPaidAmountEl) weekPaidAmountEl.textContent = formatMoney(data.week.paidAmount);
  
  const weekPaidCountEl = document.getElementById('week-paid-count');
  if (weekPaidCountEl) weekPaidCountEl.textContent = `${data.week.paid} transações`;
  
  const monthPaidAmountEl = document.getElementById('month-paid-amount');
  if (monthPaidAmountEl) monthPaidAmountEl.textContent = formatMoney(data.month.paidAmount);
  
  const monthPaidCountEl = document.getElementById('month-paid-count');
  if (monthPaidCountEl) monthPaidCountEl.textContent = `${data.month.paid} transações`;
  
  const conversionRateEl = document.getElementById('conversion-rate');
  if (conversionRateEl) conversionRateEl.textContent = periodData.conversion + '%';
  
  const bestHourEl = document.getElementById('best-hour');
  if (bestHourEl) bestHourEl.textContent = data.bestHour;
}

function updateCharts(data) {
  const hourlyCtx = document.getElementById('chart-hourly')?.getContext('2d');
  if (hourlyCtx) {
    if (charts.hourly) charts.hourly.destroy();
    
    charts.hourly = new Chart(hourlyCtx, {
      type: 'bar',
      data: {
        labels: data.hourly.map((_, i) => `${i}:00`),
        datasets: [{
          label: 'Vendas',
          data: data.hourly.map(h => h.sales),
          backgroundColor: '#3b82f6'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });
  }
  
  const weekdayCtx = document.getElementById('chart-weekday')?.getContext('2d');
  if (weekdayCtx) {
    if (charts.weekday) charts.weekday.destroy();
    
    charts.weekday = new Chart(weekdayCtx, {
      type: 'bar',
      data: {
        labels: data.weekdayStats.map(w => w.day),
        datasets: [{
          label: 'Vendas',
          data: data.weekdayStats.map(w => w.sales),
          backgroundColor: '#10b981'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });
  }
}

// ===== ANÁLISE DO DIA =====
function loadAnalysisData() {
  const saved = localStorage.getItem('analysisData');
  if (saved) {
    analysisData = JSON.parse(saved);
    const adSpendInput = document.getElementById('input-ad-spend');
    const leadsInput = document.getElementById('input-leads');
    const chargebackInput = document.getElementById('input-chargeback');
    
    if (adSpendInput) adSpendInput.value = analysisData.adSpend || '';
    if (leadsInput) leadsInput.value = analysisData.leads || '';
    if (chargebackInput) chargebackInput.value = analysisData.chargeback || '';
  }
}

function saveAnalysisData() {
  localStorage.setItem('analysisData', JSON.stringify(analysisData));
}

async function updateAnalysis() {
  if (!dashboardData) {
    applyFiltersInstant();
  }
  calculateAnalysis();
}

function calculateAnalysis() {
  const adSpendInput = document.getElementById('input-ad-spend');
  const leadsInput = document.getElementById('input-leads');
  const chargebackInput = document.getElementById('input-chargeback');
  
  if (!adSpendInput) return;
  
  analysisData.adSpend = parseFloat(adSpendInput.value) || 0;
  const leadsFromAPI = dashboardData?.totalLeads || 0;
  analysisData.leads = leadsFromAPI;
  const periodData = dashboardData?.period || dashboardData?.today || {};
  const chargebackFromAPI = periodData.refundedAmount || 0;
  analysisData.chargeback = chargebackFromAPI;
  
  if (leadsInput) {
    leadsInput.value = leadsFromAPI;
    leadsInput.disabled = true;
    leadsInput.style.backgroundColor = '#f0f0f0';
    leadsInput.style.cursor = 'not-allowed';
  }
  
  if (chargebackInput) {
    chargebackInput.value = chargebackFromAPI.toFixed(2);
    chargebackInput.disabled = true;
    chargebackInput.style.backgroundColor = '#f0f0f0';
    chargebackInput.style.cursor = 'not-allowed';
  }
  
  saveAnalysisData();
  
  if (!dashboardData) return;
  
  const revenue = periodData.paidAmount || 0;
  const profit = periodData.netAmount || 0;
  const fees = periodData.estimatedFee || 0;
  const sales = periodData.paid || 0;
  
  const revenueEl = document.getElementById('analysis-revenue');
  const profitEl = document.getElementById('analysis-profit');
  const feesEl = document.getElementById('analysis-fees');
  
  if (revenueEl) revenueEl.textContent = formatMoney(revenue);
  if (profitEl) profitEl.textContent = formatMoney(profit);
  if (feesEl) feesEl.textContent = formatMoney(fees);
  
  const adSpend = analysisData.adSpend;
  const leads = analysisData.leads;
  const chargeback = analysisData.chargeback;
  
  const roi = adSpend > 0 ? ((profit - adSpend) / adSpend * 100) : 0;
  const roiEl = document.getElementById('metric-roi');
  if (roiEl) {
    roiEl.textContent = roi.toFixed(1) + '%';
    roiEl.style.color = roi >= 0 ? '#10b981' : '#ef4444';
  }
  
  const roas = adSpend > 0 ? (revenue / adSpend) : 0;
  const roasEl = document.getElementById('metric-roas');
  if (roasEl) roasEl.textContent = roas.toFixed(2) + 'x';
  
  const margin = revenue > 0 ? ((profit - adSpend - chargeback) / revenue * 100) : 0;
  const marginEl = document.getElementById('metric-margin');
  if (marginEl) {
    marginEl.textContent = margin.toFixed(1) + '%';
    marginEl.style.color = margin >= 0 ? '#10b981' : '#ef4444';
  }
  
  const cpl = leads > 0 ? (adSpend / leads) : 0;
  const cplEl = document.getElementById('metric-cpl');
  if (cplEl) cplEl.textContent = formatMoney(cpl);
  
  const cpa = sales > 0 ? (adSpend / sales) : 0;
  const cpaEl = document.getElementById('metric-cpa');
  if (cpaEl) cpaEl.textContent = formatMoney(cpa);
  
  const refunded = dashboardData?.today?.refundedAmount || 0;
  const lossesEl = document.getElementById('metric-losses');
  if (lossesEl) lossesEl.textContent = formatMoney(refunded);
}

// ===== PIX =====
function loadPIXInstant() {
  const filtered = applyFiltersLocal(localCache.transactions);
  const data = analyzePIXLocal(filtered);
  
  const pixTotalEl = document.getElementById('pix-total');
  if (pixTotalEl) pixTotalEl.textContent = data.total;
  
  const pixPaidEl = document.getElementById('pix-paid');
  if (pixPaidEl) pixPaidEl.textContent = data.paid;
  
  const pixPendingEl = document.getElementById('pix-pending');
  if (pixPendingEl) pixPendingEl.textContent = data.pending;
  
  const pixMerchantsEl = document.getElementById('pix-merchants');
  if (pixMerchantsEl) pixMerchantsEl.textContent = data.uniqueMerchants;
  
  const pixConversionEl = document.getElementById('pix-conversion');
  if (pixConversionEl) pixConversionEl.textContent = data.conversionRate + '%';
  
  const pixAvgTimeEl = document.getElementById('pix-avg-time');
  if (pixAvgTimeEl) pixAvgTimeEl.textContent = data.avgPaymentTime;
  
  const rankingContainer = document.getElementById('merchant-ranking');
  if (rankingContainer) {
    rankingContainer.innerHTML = data.ranking.slice(0, 10).map((m, idx) => `
      <div class="ranking-item">
        <div class="ranking-position">#${idx + 1}</div>
        <div class="ranking-info">
          <div class="ranking-name">${m.merchant}</div>
          <div class="ranking-acquirer">${m.acquirer}</div>
        </div>
        <div class="ranking-stats">
          <div>${m.total} PIX</div>
          <div style="color: var(--success)">${m.paid} pagos</div>
          <div>${m.conversion}% conversão</div>
        </div>
      </div>
    `).join('');
  }
  
  const valuesContainer = document.getElementById('top-values');
  if (valuesContainer) {
    valuesContainer.innerHTML = data.topValues.slice(0, 10).map((v, idx) => `
      <div class="value-item">
        <span>#${idx + 1}</span>
        <span>${formatMoney(v.value)}</span>
        <span>${v.count}x</span>
      </div>
    `).join('');
  }
}

async function loadPIX() {
  loadPIXInstant();
}

// ===== NOTIFICAÇÕES =====
async function loadNotifications() {
  try {
    const response = await fetch('/api/notifications');
    const notifications = await response.json();
    
    const container = document.getElementById('notifications-list');
    
    if (notifications.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
          <p style="font-size: 16px; margin-bottom: 8px;">Nenhuma notificação configurada</p>
          <p style="font-size: 14px;">Clique em "Nova Notificação" para começar</p>
        </div>
      `;
      return;
    }
    
    container.innerHTML = notifications.map(n => `
      <div class="notif-item">
        <div class="notif-info">
          <h4>${n.name}</h4>
          <p>${n.eventType === 'sale_paid' ? '💰 Venda Paga' : '🔄 Reembolso'} • ${n.enabled ? '<span style="color: var(--success)">Ativo</span>' : '<span style="color: var(--text-muted)">Inativo</span>'}</p>
        </div>
        <div class="notif-actions">
          <div class="toggle ${n.enabled ? 'active' : ''}" onclick="toggleNotification('${n.id}')"></div>
          <button class="btn btn-sm btn-secondary" onclick="editNotification('${n.id}')">✏️ Editar</button>
          <button class="btn btn-sm btn-secondary" onclick="testNotification('${n.id}')">🧪 Testar</button>
          <button class="btn btn-sm btn-secondary" onclick="deleteNotification('${n.id}')">🗑️</button>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Erro ao carregar notificações:', error);
  }
}

function openNotificationModal() {
  editingNotificationId = null;
  document.querySelector('#notification-modal .modal-header h3').textContent = 'Nova Notificação';
  document.getElementById('notification-modal').classList.remove('hidden');
}

function closeNotificationModal() {
  editingNotificationId = null;
  document.getElementById('notification-modal').classList.add('hidden');
  document.getElementById('notification-form').reset();
}

async function editNotification(id) {
  try {
    const response = await fetch('/api/notifications');
    const notifications = await response.json();
    const notif = notifications.find(n => n.id === id);
    
    if (!notif) {
      showToast('❌ Notificação não encontrada');
      return;
    }
    
    editingNotificationId = id;
    
    document.getElementById('notif-name').value = notif.name;
    document.getElementById('notif-url').value = notif.url;
    document.getElementById('notif-event').value = notif.eventType;
    document.getElementById('notif-title').value = notif.title;
    document.getElementById('notif-text').value = notif.text;
    
    document.querySelector('#notification-modal .modal-header h3').textContent = 'Editar Notificação';
    document.getElementById('notification-modal').classList.remove('hidden');
  } catch (error) {
    console.error('Erro ao editar notificação:', error);
    showToast('❌ Erro ao carregar notificação');
  }
}

document.getElementById('notification-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const data = {
    name: document.getElementById('notif-name').value,
    url: document.getElementById('notif-url').value,
    eventType: document.getElementById('notif-event').value,
    title: document.getElementById('notif-title').value,
    text: document.getElementById('notif-text').value,
    enabled: true
  };
  
  try {
    if (editingNotificationId) {
      await fetch(`/api/notifications/${editingNotificationId}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(data)
      });
      showToast('✅ Notificação atualizada');
    } else {
      await fetch('/api/notifications', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(data)
      });
      showToast('✅ Notificação salva');
    }
    
    editingNotificationId = null;
    document.querySelector('#notification-modal .modal-header h3').textContent = 'Nova Notificação';
    closeNotificationModal();
    loadNotifications();
  } catch (error) {
    showToast('❌ Erro ao salvar');
  }
});

async function toggleNotification(id) {
  try {
    const response = await fetch(`/api/notifications/${id}/toggle`, {method: 'POST'});
    if (response.ok) {
      loadNotifications();
      showToast('✅ Status atualizado');
    }
  } catch (error) {
    showToast('❌ Erro ao atualizar');
  }
}

async function testNotification(id) {
  try {
    const response = await fetch(`/api/notifications/${id}/test`, {method: 'POST'});
    if (response.ok) {
      showToast('✅ Notificação de teste enviada!');
    } else {
      showToast('❌ Erro ao enviar teste');
    }
  } catch (error) {
    showToast('❌ Erro ao enviar teste');
  }
}

async function deleteNotification(id) {
  if (!confirm('Tem certeza que deseja excluir esta notificação?')) return;
  
  try {
    await fetch(`/api/notifications/${id}`, {method: 'DELETE'});
    loadNotifications();
    showToast('✅ Notificação excluída');
  } catch (error) {
    showToast('❌ Erro ao excluir');
  }
}

// ===== EXPORTAÇÃO =====
function exportCSV() {
  const query = buildQueryString();
  window.open(`/api/export/csv?${query}`, '_blank');
}

function exportExcel() {
  const query = buildQueryString();
  window.open(`/api/export/excel?${query}`, '_blank');
}

function exportTXT() {
  const query = buildQueryString();
  window.open(`/api/export/txt?${query}`, '_blank');
}

// ===== UTILS =====
function formatMoney(value) {
  return 'R$ ' + (value || 0).toFixed(2).replace('.', ',');
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: var(--bg-card);
    color: var(--text-primary);
    padding: 12px 20px;
    border-radius: 8px;
    border: 1px solid var(--border);
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    z-index: 10000;
    animation: slideIn 0.3s ease;
  `;
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ===== FORÇAR ATUALIZAÇÃO =====
async function forceRefresh() {
  showToast('🔄 Atualizando dados...');
  await loadAllTransactions();
  applyFiltersInstant();
}
