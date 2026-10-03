const emptyPortfolio = () => ({ transactions: [], quotes: {}, history: {}, settings: { target: 0 } });
let portfolio = emptyPortfolio();
let portfolios = [];
let activePortfolioId = '';
let pendingImport = null;
let activeRange = 'all';
let toastTimer;

const euro = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const number = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 5 });
const dateFormat = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
const byId = (id) => document.getElementById(id);
const maxCsvBytes = 10 * 1024 * 1024;

async function persist() {
  const response = await fetch(`/api/portfolios/${encodeURIComponent(activePortfolioId)}/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(portfolio)
  });
  if (!response.ok) throw new Error('No se pudieron guardar los datos locales.');
}

async function archiveCsv(file, category) {
  if (file.size > maxCsvBytes) throw new Error('El CSV supera el limite de 10 MB.');
  const response = await fetch(`/api/portfolios/${encodeURIComponent(activePortfolioId)}/imports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, category, content: await file.text() })
  });
  if (!response.ok) throw new Error('No se pudo guardar el CSV en .data/imports.');
  return response.json();
}

function renderPortfolioOptions() {
  const select = byId('portfolio-select');
  select.replaceChildren();
  for (const item of portfolios) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.alias;
    option.selected = item.id === activePortfolioId;
    select.append(option);
  }
}

async function loadPortfolio(portfolioId) {
  const response = await fetch(`/api/portfolios/${encodeURIComponent(portfolioId)}/data`);
  if (!response.ok) throw new Error('No se pudo cargar el portfolio seleccionado.');
  const stored = await response.json();
  activePortfolioId = portfolioId;
  portfolio = { ...emptyPortfolio(), ...stored, settings: { target: 0, ...stored.settings } };
  localStorage.setItem('bradtrack-active-portfolio', portfolioId);
  renderPortfolioOptions();
  render();
}

async function createPortfolio(alias) {
  const response = await fetch('/api/portfolios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alias })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail.includes('already exists') ? 'Ya existe un portfolio con ese alias.' : 'No se pudo crear el portfolio.');
  }
  const created = await response.json();
  portfolios.push(created);
  await loadPortfolio(created.id);
  return created.id;
}

async function activatePortfolio(portfolioId) {
  if (!portfolios.some((item) => item.id === portfolioId)) throw new Error('Portfolio desconocido.');
  await loadPortfolio(portfolioId);
}

async function initializePortfolios() {
  const response = await fetch('/api/portfolios');
  if (!response.ok) throw new Error('No se pudo cargar la lista de portfolios.');
  const data = await response.json();
  portfolios = data.portfolios || [];
  if (!portfolios.length) throw new Error('No hay portfolios configurados.');
  const savedId = localStorage.getItem('bradtrack-active-portfolio');
  const selected = portfolios.find((item) => item.id === savedId) || portfolios[0];
  await loadPortfolio(selected.id);
}

function readNumber(value) {
  const parsed = Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCsv(text) {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] || '';
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"' && quoted && source[index + 1] === '"') { field += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === delimiter && !quoted) { row.push(field); field = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += character;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const headers = (rows.shift() || []).map((header) => header.trim().toLowerCase());
  return rows.filter((values) => values.some((value) => value.trim())).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, (values[index] || '').trim()]))
  );
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function getPositions() {
  const positions = {};
  for (const transaction of portfolio.transactions) {
    const position = positions[transaction.symbol] || { symbol: transaction.symbol, quantity: 0, netInvested: 0 };
    const direction = transaction.type === 'SELL' ? -1 : 1;
    position.quantity += direction * transaction.quantity;
    position.netInvested += capitalImpact(transaction);
    positions[transaction.symbol] = position;
  }
  return Object.values(positions).filter((position) => position.quantity > 0.00000001).map((position) => {
    const price = readNumber(portfolio.quotes[position.symbol]);
    return { ...position, price, value: position.quantity * price, result: position.quantity * price - position.netInvested };
  }).sort((first, second) => second.value - first.value);
}

function getNetContributions() {
  return portfolio.transactions.reduce((total, transaction) => total + capitalImpact(transaction), 0);
}

function capitalImpact(transaction) {
  const gross = transaction.price * transaction.quantity;
  return transaction.type === 'SELL' ? -gross + transaction.commission : gross + transaction.commission;
}

function formatDate(date) {
  return date ? dateFormat.format(new Date(`${date}T12:00:00`)) : 'Sin fecha';
}

function renderMetrics(positions) {
  const total = positions.reduce((sum, position) => sum + position.value, 0);
  const invested = getNetContributions();
  const result = total - invested;
  const percent = invested ? result / invested * 100 : 0;
  byId('total-value').textContent = euro.format(total);
  byId('invested-value').textContent = euro.format(invested);
  byId('gain-value').textContent = `${result >= 0 ? '+' : ''}${euro.format(result)}`;
  byId('gain-percent').textContent = `${percent >= 0 ? '+' : ''}${number.format(percent)} %`;
  byId('unrealized-value').textContent = euro.format(result);
  byId('gain-value').className = result >= 0 ? 'positive' : 'negative';
  byId('gain-percent').className = result >= 0 ? 'positive' : 'negative';
  byId('unrealized-value').className = result >= 0 ? 'positive' : 'negative';
  byId('position-count').textContent = String(positions.length);
  byId('positions-badge').textContent = `${positions.length} ${positions.length === 1 ? 'activo' : 'activos'}`;
  byId('transaction-count').textContent = `${portfolio.transactions.length} ${portfolio.transactions.length === 1 ? 'operacion' : 'operaciones'}`;
  const dates = portfolio.transactions.map((transaction) => transaction.date).filter(Boolean).sort();
  byId('as-of').textContent = dates.length ? `Desde ${formatDate(dates[0])} · ${portfolio.transactions.length} operaciones registradas` : 'Sin operaciones registradas';
  const latestDate = Object.values(portfolio.history).flatMap((entries) => Object.keys(entries)).sort().at(-1);
  byId('last-update').textContent = latestDate ? formatDate(latestDate) : (Object.keys(portfolio.quotes).length ? 'Cotizaciones' : 'Sin datos');
  const target = readNumber(portfolio.settings.target);
  const progress = target > 0 ? Math.min(100, total / target * 100) : 0;
  byId('target-progress').style.width = `${progress}%`;
  byId('target-percent').textContent = target ? `${number.format(progress)} % del objetivo` : 'Define un objetivo';
  byId('target-remaining').textContent = target ? (total < target ? `Faltan ${euro.format(target - total)}` : 'Objetivo alcanzado') : '';
}

function renderPositions(positions) {
  const body = byId('positions-body');
  body.replaceChildren();
  for (const position of positions) {
    const row = document.createElement('tr');
    row.innerHTML = `<td><div class="asset-cell"><span class="asset-mark">${escapeHtml(position.symbol.slice(0, 2))}</span><span class="asset-symbol">${escapeHtml(position.symbol)}</span></div></td><td>${number.format(position.quantity)}</td><td>${euro.format(position.price)} <button class="small-action" data-quote="${escapeHtml(position.symbol)}" type="button" aria-label="Actualizar precio de ${escapeHtml(position.symbol)}">Editar</button></td><td>${euro.format(position.value)}</td><td class="${position.result >= 0 ? 'positive' : 'negative'}">${euro.format(position.result)}</td><td><button class="small-action" data-delete="${escapeHtml(position.symbol)}" type="button" aria-label="Eliminar operaciones de ${escapeHtml(position.symbol)}">Quitar</button></td>`;
    body.append(row);
  }
  byId('positions-empty').hidden = positions.length > 0;
  body.querySelectorAll('[data-quote]').forEach((button) => button.addEventListener('click', () => openQuote(button.dataset.quote)));
  body.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => removePosition(button.dataset.delete)));
}

function renderTransactions() {
  const list = byId('transaction-list');
  list.replaceChildren();
  const entries = [...portfolio.transactions].sort((first, second) => second.date.localeCompare(first.date)).slice(0, 5);
  for (const transaction of entries) {
    const row = document.createElement('div');
    row.className = 'transaction-row';
    const sell = transaction.type === 'SELL';
    row.innerHTML = `<div class="transaction-info"><span class="transaction-type ${sell ? 'sell' : ''}">${sell ? '−' : '+'}</span><div class="transaction-meta"><strong>${escapeHtml(transaction.symbol)} · ${sell ? 'Venta' : 'Compra'}</strong><span>${formatDate(transaction.date)} · ${number.format(transaction.quantity)} ud.</span></div></div><div class="transaction-amount">${euro.format(transaction.price * transaction.quantity)}<span>${euro.format(transaction.price)} / ud.</span></div>`;
    list.append(row);
  }
  byId('transactions-empty').hidden = entries.length > 0;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function historySeries() {
  const dates = [...new Set(Object.values(portfolio.history).flatMap((entries) => Object.keys(entries)))].sort();
  if (!dates.length) return { dates: [...new Set(portfolio.transactions.map((item) => item.date).filter(Boolean))].sort(), values: null };
  const positions = {};
  const historySymbols = Object.keys(portfolio.history);
  let transactionIndex = 0;
  const transactions = [...portfolio.transactions].sort((first, second) => first.date.localeCompare(second.date));
  const values = [];
  for (const date of dates) {
    while (transactionIndex < transactions.length && transactions[transactionIndex].date <= date) {
      const transaction = transactions[transactionIndex];
      positions[transaction.symbol] = (positions[transaction.symbol] || 0) + (transaction.type === 'SELL' ? -transaction.quantity : transaction.quantity);
      transactionIndex += 1;
    }
    let total = 0;
    let hasHistoryPrice = false;
    for (const symbol of historySymbols) {
      const quantity = positions[symbol] || 0;
      const quoteDates = Object.keys(portfolio.history[symbol]).filter((quoteDate) => quoteDate <= date).sort();
      if (quantity > 0 && quoteDates.length) {
        total += quantity * readNumber(portfolio.history[symbol][quoteDates.at(-1)]);
        hasHistoryPrice = true;
      }
    }
    values.push(hasHistoryPrice ? total : null);
  }
  return { dates, values };
}

function renderChart() {
  const svg = byId('portfolio-chart');
  const { dates, values } = historySeries();
  const hasHistory = values !== null;
  byId('chart-title').textContent = hasHistory ? 'Valoracion historica de la cartera' : 'Capital neto a lo largo del tiempo';
  byId('chart-note').textContent = hasHistory
    ? 'Valor estimado con las operaciones registradas y los cierres diarios importados. Solo incluye activos con historico disponible.'
    : 'Importa historicos de precios Yahoo para ver valoracion diaria. Mientras tanto, mostramos el capital neto aportado.';
  byId('legend-label').textContent = hasHistory ? 'Valoracion historica' : 'Capital neto aportado';
  const filtered = dates.map((date, index) => ({ date, value: hasHistory ? values[index] : null })).filter((point) => {
    if (activeRange === 'all' || !point.date) return true;
    const date = new Date(`${point.date}T00:00:00`);
    const threshold = new Date();
    threshold.setMonth(threshold.getMonth() - (activeRange === 'year' ? 12 : 1));
    return date >= threshold;
  });
  const points = hasHistory
    ? filtered.filter((point) => point.value !== null)
    : filtered.map((point) => ({ ...point, value: portfolio.transactions.filter((item) => item.date <= point.date).reduce((sum, item) => sum + capitalImpact(item), 0) }));
  svg.replaceChildren();
  byId('chart-empty').classList.toggle('hidden', points.length > 0);
  if (!points.length) return;
  const namespace = 'http://www.w3.org/2000/svg';
  const create = (tag, attributes) => {
    const element = document.createElementNS(namespace, tag);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    return element;
  };
  const width = 1000;
  const height = 280;
  const left = 62;
  const right = 12;
  const top = 15;
  const bottom = 33;
  const minValue = Math.min(0, ...points.map((point) => point.value));
  const maxValue = Math.max(1, ...points.map((point) => point.value));
  const spread = Math.max(1, maxValue - minValue);
  const x = (index) => left + (points.length === 1 ? (width - left - right) / 2 : index / (points.length - 1) * (width - left - right));
  const y = (value) => top + (maxValue - value) / spread * (height - top - bottom);
  for (let grid = 0; grid < 4; grid += 1) {
    const value = maxValue - spread * grid / 3;
    const yPosition = y(value);
    svg.append(create('line', { x1: left, x2: width - right, y1: yPosition, y2: yPosition, class: 'chart-grid-line' }));
    const label = create('text', { x: left - 9, y: yPosition + 4, 'text-anchor': 'end', class: 'chart-axis-label' });
    label.textContent = euro.format(value);
    svg.append(label);
  }
  const coordinates = points.map((point, index) => `${x(index)},${y(point.value)}`);
  const linePath = `M ${coordinates.join(' L ')}`;
  const areaPath = `${linePath} L ${x(points.length - 1)},${height - bottom} L ${x(0)},${height - bottom} Z`;
  const defs = create('defs', {});
  const gradient = create('linearGradient', { id: 'chartFill', x1: '0', x2: '0', y1: '0', y2: '1' });
  gradient.append(create('stop', { offset: '0%', 'stop-color': 'var(--accent)', 'stop-opacity': '.2' }));
  gradient.append(create('stop', { offset: '100%', 'stop-color': 'var(--accent)', 'stop-opacity': '0' }));
  defs.append(gradient);
  svg.append(defs, create('path', { d: areaPath, class: 'chart-area' }), create('path', { d: linePath, class: 'chart-line' }));
  const first = create('text', { x: left, y: height - 7, class: 'chart-axis-label' });
  first.textContent = formatDate(points[0].date);
  const last = create('text', { x: width - right, y: height - 7, 'text-anchor': 'end', class: 'chart-axis-label' });
  last.textContent = formatDate(points.at(-1).date);
  svg.append(first, last);
  const lastPoint = points.at(-1);
  svg.append(create('circle', { cx: x(points.length - 1), cy: y(lastPoint.value), r: 5, class: 'chart-dot' }));
}

function render() {
  const positions = getPositions();
  renderMetrics(positions);
  renderPositions(positions);
  renderTransactions();
  renderChart();
}

function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2800);
}

function openQuote(symbol) {
  const form = byId('quote-form');
  form.elements.symbol.value = symbol;
  form.elements.price.value = portfolio.quotes[symbol] || '';
  byId('quote-dialog').showModal();
}

async function removePosition(symbol) {
  if (!confirm(`Se eliminaran todas las operaciones de ${symbol}. Esta accion no se puede deshacer.`)) return;
  const previous = portfolio;
  portfolio = { ...portfolio, transactions: portfolio.transactions.filter((item) => item.symbol !== symbol), quotes: { ...portfolio.quotes }, history: { ...portfolio.history } };
  delete portfolio.quotes[symbol];
  delete portfolio.history[symbol];
  try { await persist(); render(); showToast('Posicion eliminada.'); }
  catch (error) { portfolio = previous; showToast(error.message); }
}

byId('theme-toggle').addEventListener('click', () => {
  document.body.classList.toggle('dark');
  const dark = document.body.classList.contains('dark');
  localStorage.setItem('bradtrack-theme', dark ? 'dark' : 'light');
  byId('theme-toggle').setAttribute('aria-label', dark ? 'Activar modo claro' : 'Activar modo oscuro');
});
if (localStorage.getItem('bradtrack-theme') === 'dark') document.body.classList.add('dark');
byId('theme-toggle').setAttribute('aria-label', document.body.classList.contains('dark') ? 'Activar modo claro' : 'Activar modo oscuro');
byId('add-transaction').addEventListener('click', () => {
  const form = byId('transaction-form');
  form.reset();
  form.elements.date.value = new Date().toISOString().slice(0, 10);
  byId('form-error').textContent = '';
  byId('transaction-dialog').showModal();
});
byId('cancel-transaction').addEventListener('click', () => byId('transaction-dialog').close());
document.querySelector('.dialog-close').addEventListener('click', () => byId('transaction-dialog').close());
document.querySelectorAll('.quote-close').forEach((button) => button.addEventListener('click', () => byId('quote-dialog').close()));
document.querySelectorAll('.target-close').forEach((button) => button.addEventListener('click', () => byId('target-dialog').close()));

byId('transaction-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const transaction = {
    symbol: form.elements.symbol.value.trim().toUpperCase(),
    type: form.elements.type.value,
    date: normalizeDate(form.elements.date.value),
    quantity: readNumber(form.elements.quantity.value),
    price: readNumber(form.elements.price.value),
    commission: readNumber(form.elements.commission.value)
  };
  const held = portfolio.transactions.reduce((total, item) => total + (item.symbol === transaction.symbol ? (item.type === 'SELL' ? -item.quantity : item.quantity) : 0), 0);
  if (!transaction.date || !transaction.symbol || transaction.quantity <= 0 || transaction.price < 0 || transaction.commission < 0) {
    byId('form-error').textContent = 'Revisa los campos: unidades, precio y comision deben ser validos.';
    return;
  }
  if (transaction.type === 'SELL' && transaction.quantity > held + 0.00000001) {
    byId('form-error').textContent = `No puedes vender ${number.format(transaction.quantity)} unidades; solo tienes ${number.format(held)}.`;
    return;
  }
  const previousQuote = portfolio.quotes[transaction.symbol];
  portfolio.transactions.push(transaction);
  const enteredQuote = readNumber(form.elements.currentPrice.value);
  portfolio.quotes[transaction.symbol] = enteredQuote > 0 ? enteredQuote : (previousQuote || transaction.price);
  try { await persist(); byId('transaction-dialog').close(); render(); showToast('Operacion guardada en este dispositivo.'); }
  catch (error) { portfolio.transactions.pop(); if (previousQuote === undefined) delete portfolio.quotes[transaction.symbol]; else portfolio.quotes[transaction.symbol] = previousQuote; byId('form-error').textContent = error.message; }
});

byId('quote-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const symbol = form.elements.symbol.value;
  const oldQuote = portfolio.quotes[symbol];
  portfolio.quotes[symbol] = readNumber(form.elements.price.value);
  try { await persist(); byId('quote-dialog').close(); render(); showToast(`Precio de ${symbol} actualizado.`); }
  catch (error) { portfolio.quotes[symbol] = oldQuote; showToast(error.message); }
});

byId('target-edit').addEventListener('click', () => {
  const form = byId('target-form');
  form.elements.target.value = portfolio.settings.target || '';
  byId('target-dialog').showModal();
});
byId('target-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const previousTarget = portfolio.settings.target;
  portfolio.settings.target = readNumber(event.currentTarget.elements.target.value);
  try { await persist(); byId('target-dialog').close(); render(); }
  catch (error) { portfolio.settings.target = previousTarget; showToast(error.message); }
});

function openImportDialog(kind, files) {
  if (!files.length) return;
  pendingImport = { kind, files };
  const select = byId('import-portfolio-target');
  select.replaceChildren();
  for (const item of portfolios) select.add(new Option(item.alias, item.id));
  select.add(new Option('Crear nuevo portfolio...', '__new__'));
  select.value = activePortfolioId;
  byId('import-title').textContent = kind === 'transactions' ? 'Importar operaciones' : 'Importar historicos';
  byId('import-file-name').textContent = files.map((file) => file.name).join(', ');
  byId('import-portfolio-alias').value = '';
  byId('import-alias-field').hidden = true;
  byId('import-portfolio-alias').required = false;
  byId('import-error').textContent = '';
  byId('import-dialog').showModal();
}

byId('import-transactions').addEventListener('click', () => byId('transaction-file').click());
byId('transaction-file').addEventListener('change', (event) => {
  openImportDialog('transactions', [...event.target.files]);
  event.target.value = '';
});

async function importTransactionsFile(file) {
  const previous = portfolio;
  portfolio = { ...portfolio, transactions: [...portfolio.transactions], quotes: { ...portfolio.quotes } };
  try {
    const rows = parseCsv(await file.text());
    const imported = rows.map((row) => {
      const symbol = row.symbol || row.ticker || '';
      const type = (row['transaction type'] || row.type || '').toUpperCase();
      const date = normalizeDate(row['trade date'] || row.date);
      const transaction = { symbol: symbol.trim().toUpperCase(), type, date, price: readNumber(row['purchase price'] || row.price), quantity: readNumber(row.quantity || row.shares), commission: readNumber(row.commission || row.fee) };
      const quote = readNumber(row['current price'] || row.close);
      return { transaction, quote };
    }).filter(({ transaction }) => transaction.symbol && ['BUY', 'SELL'].includes(transaction.type) && transaction.date && transaction.price > 0 && transaction.quantity > 0);
    if (!imported.length) throw new Error('No se encontraron operaciones. Se esperan columnas Symbol, Trade Date, Purchase Price, Quantity y Transaction Type.');
    for (const { transaction, quote } of imported) {
      const exists = portfolio.transactions.some((saved) => saved.symbol === transaction.symbol && saved.type === transaction.type && saved.date === transaction.date && saved.price === transaction.price && saved.quantity === transaction.quantity && saved.commission === transaction.commission);
      if (!exists) portfolio.transactions.push(transaction);
      if (quote > 0) portfolio.quotes[transaction.symbol] = quote;
    }
    await archiveCsv(file, 'transactions');
    await persist();
    render();
    showToast(`${imported.length} operaciones procesadas; CSV guardado en .data/imports.`);
  } catch (error) { portfolio = previous; showToast(error.message); }
}

byId('import-history').addEventListener('click', () => byId('history-files').click());
byId('history-files').addEventListener('change', (event) => {
  openImportDialog('history', [...event.target.files]);
  event.target.value = '';
});

async function importHistoryFiles(files) {
  const previous = portfolio;
  portfolio = { ...portfolio, quotes: { ...portfolio.quotes }, history: Object.fromEntries(Object.entries(portfolio.history).map(([symbol, entries]) => [symbol, { ...entries }])) };
  let importedRows = 0;
  const validFiles = [];
  try {
    for (const file of files) {
      const symbol = file.name.replace(/\.csv$/i, '').replace(/[-_ ]+(history|historical|prices|data)$/i, '').trim().toUpperCase();
      if (!symbol) continue;
      const rows = parseCsv(await file.text());
      const quotes = rows.map((row) => ({ date: normalizeDate(row.date), close: readNumber(row.close || row['adj close'] || row['adjusted close']) })).filter((row) => row.date && row.close > 0);
      if (!quotes.length) continue;
      portfolio.history[symbol] = { ...(portfolio.history[symbol] || {}) };
      for (const quote of quotes) portfolio.history[symbol][quote.date] = quote.close;
      const latest = quotes.sort((first, second) => first.date.localeCompare(second.date)).at(-1);
      portfolio.quotes[symbol] = latest.close;
      importedRows += quotes.length;
      validFiles.push(file);
    }
    if (!importedRows) throw new Error('No se encontraron fechas y cierres. Usa el CSV historico de Yahoo con nombre como MSFT.csv.');
    for (const file of validFiles) await archiveCsv(file, 'history');
    await persist();
    render();
    showToast(`${importedRows} cierres importados; CSV guardado en .data/imports.`);
  } catch (error) { portfolio = previous; showToast(error.message); }
}

byId('import-portfolio-target').addEventListener('change', (event) => {
  const creating = event.target.value === '__new__';
  byId('import-alias-field').hidden = !creating;
  byId('import-portfolio-alias').required = creating;
});
byId('import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!pendingImport) return;
  const target = byId('import-portfolio-target').value;
  try {
    const portfolioId = target === '__new__'
      ? await createPortfolio(byId('import-portfolio-alias').value.trim())
      : target;
    if (target !== '__new__') await activatePortfolio(portfolioId);
    const pending = pendingImport;
    pendingImport = null;
    byId('import-dialog').close();
    if (pending.kind === 'transactions') await importTransactionsFile(pending.files[0]);
    else await importHistoryFiles(pending.files);
  } catch (error) {
    byId('import-error').textContent = error.message;
  }
});
document.querySelectorAll('.import-close').forEach((button) => button.addEventListener('click', () => {
  pendingImport = null;
  byId('import-dialog').close();
}));

byId('portfolio-select').addEventListener('change', (event) => {
  activatePortfolio(event.target.value).catch((error) => showToast(error.message));
});
byId('create-portfolio').addEventListener('click', () => {
  byId('portfolio-error').textContent = '';
  byId('portfolio-form').reset();
  byId('portfolio-dialog').showModal();
});
document.querySelectorAll('.portfolio-close').forEach((button) => button.addEventListener('click', () => byId('portfolio-dialog').close()));
byId('portfolio-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await createPortfolio(event.currentTarget.elements.alias.value.trim());
    byId('portfolio-dialog').close();
  } catch (error) { byId('portfolio-error').textContent = error.message; }
});

byId('show-all-transactions').addEventListener('click', () => byId('transaction-dialog').showModal());
document.querySelectorAll('.range-button').forEach((button) => button.addEventListener('click', () => {
  activeRange = button.dataset.range;
  document.querySelectorAll('.range-button').forEach((other) => other.classList.toggle('active', other === button));
  renderChart();
}));

initializePortfolios().catch((error) => showToast(error.message));