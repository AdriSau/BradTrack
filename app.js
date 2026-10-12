const DEFAULT_TARGET = 100000;
const emptyPortfolio = () => ({ transactions: [], quotes: {}, history: {}, settings: { target: 0 } });
let portfolio = emptyPortfolio();
let portfolios = [];
let portfolioSnapshots = {};
let activePortfolioId = '';
let dashboardFilterId = 'all';
let pendingImport = null;
let activeRange = 'all';
let toastTimer;
let csrfToken = '';
let assetMetadata = { fields: [], assets: {} };
let assetDraft = null;
let assetSymbols = [];
let savingAssets = false;

const euro = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const number = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 5 });
const dateFormat = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
const byId = (id) => document.getElementById(id);
const maxCsvBytes = 10 * 1024 * 1024;

async function writeJson(path, data) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!csrfToken) {
      const sessionResponse = await fetch('/api/session', { cache: 'no-store' });
      if (!sessionResponse.ok) throw new Error('No se pudo conectar con la sesion local.');
      const session = await sessionResponse.json();
      if (typeof session.csrfToken !== 'string' || !session.csrfToken) throw new Error('Sesion local invalida.');
      csrfToken = session.csrfToken;
    }
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BradTrack-CSRF': csrfToken },
      body: JSON.stringify(data)
    });
    if (response.status !== 403 || attempt === 1) return response;
    // Refresh the in-memory token if the local server was restarted.
    csrfToken = '';
  }
}

async function persist() {
  const response = await writeJson(`/api/portfolios/${encodeURIComponent(activePortfolioId)}/data`, portfolio);
  if (!response.ok) throw new Error('No se pudieron guardar los datos locales.');
}

async function archiveCsv(file, category) {
  if (file.size > maxCsvBytes) throw new Error('El CSV supera el limite de 10 MB.');
  const response = await writeJson(`/api/portfolios/${encodeURIComponent(activePortfolioId)}/imports`,
    { name: file.name, category, content: await file.text() });
  if (!response.ok) throw new Error('No se pudo guardar el CSV en .data/imports.');
  return response.json();
}

function populatePortfolioSelect(selectId, selectedId = activePortfolioId) {
  const select = byId(selectId);
  select.replaceChildren();
  for (const item of portfolios) select.add(new Option(item.alias, item.id));
  if (portfolios.some((item) => item.id === selectedId)) select.value = selectedId;
}

function renderDashboardFilterOptions() {
  const select = byId('dashboard-filter');
  select.replaceChildren(new Option('Todos los portfolios', 'all'));
  for (const item of portfolios) select.add(new Option(item.alias, item.id));
  if (!portfolios.some((item) => item.id === dashboardFilterId) && dashboardFilterId !== 'all') dashboardFilterId = 'all';
  select.value = dashboardFilterId;
}

function getDashboardRecords() {
  return portfolios.filter((item) => dashboardFilterId === 'all' || item.id === dashboardFilterId).map((item) => ({
    ...item,
    data: portfolioSnapshots[item.id] || (item.id === activePortfolioId ? portfolio : emptyPortfolio())
  }));
}

async function loadPortfolio(portfolioId) {
  const response = await fetch(`/api/portfolios/${encodeURIComponent(portfolioId)}/data`);
  if (!response.ok) throw new Error('No se pudo cargar el portfolio seleccionado.');
  const stored = await response.json();
  activePortfolioId = portfolioId;
  portfolio = { ...emptyPortfolio(), ...stored, settings: { target: 0, ...stored.settings } };
  portfolioSnapshots[portfolioId] = portfolio;
  localStorage.setItem('bradtrack-active-portfolio', portfolioId);
  populatePortfolioSelect('transaction-portfolio', dashboardFilterId === 'all' ? activePortfolioId : dashboardFilterId);
  populatePortfolioSelect('target-portfolio', dashboardFilterId === 'all' ? activePortfolioId : dashboardFilterId);
  renderDashboardFilterOptions();
  render();
}

async function createPortfolio(alias) {
  const response = await writeJson('/api/portfolios', { alias });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail.includes('already exists') ? 'Ya existe un portfolio con ese alias.' : 'No se pudo crear el portfolio.');
  }
  const created = await response.json();
  portfolios.push(created);
  await loadPortfolio(created.id);
  if (!readNumber(portfolio.settings.target)) {
    portfolio.settings.target = DEFAULT_TARGET;
    await persist();
    render();
  }
  return created.id;
}

async function activatePortfolio(portfolioId) {
  if (!portfolios.some((item) => item.id === portfolioId)) throw new Error('Portfolio desconocido.');
  await loadPortfolio(portfolioId);
}

async function initializePortfolios() {
  assetMetadata = await loadAssetMetadata();
  const response = await fetch('/api/portfolios');
  if (!response.ok) throw new Error('No se pudo cargar la lista de portfolios.');
  const data = await response.json();
  portfolios = data.portfolios || [];
  if (!portfolios.length) throw new Error('No hay portfolios configurados.');
  dashboardFilterId = 'all';
  renderDashboardFilterOptions();
  const savedId = localStorage.getItem('bradtrack-active-portfolio');
  const selected = portfolios.find((item) => item.id === savedId) || portfolios[0];
  await loadPortfolio(selected.id);
  byId('manage-assets').disabled = false;
}

async function loadAssetMetadata() {
  const response = await fetch('/api/assets', { cache: 'no-store' });
  if (!response.ok) throw new Error('No se pudo cargar el catálogo de activos. Reinicia el servidor si acabas de actualizar la aplicación.');
  return response.json();
}

function assetName(symbol) {
  return assetMetadata.assets[symbol.toUpperCase()]?.alias?.trim() || symbol;
}

function collectAssetSymbols(records) {
  const symbols = new Set();
  for (const { data } of records) {
    for (const transaction of data.transactions) symbols.add(transaction.symbol.toUpperCase());
    for (const symbol of [...Object.keys(data.quotes), ...Object.keys(data.history)]) symbols.add(symbol.toUpperCase());
  }
  return [...symbols].sort((first, second) => first.localeCompare(second));
}

function renderAssetTable() {
  const heading = document.createElement('tr');
  for (const name of ['Ticker', 'Alias / acrónimo', 'Tipo de activo', ...assetDraft.fields]) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = name;
    if (assetDraft.fields.includes(name)) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'small-action';
      remove.textContent = 'Quitar';
      remove.setAttribute('aria-label', `Quitar campo ${name}`);
      remove.addEventListener('click', () => {
        assetDraft.fields = assetDraft.fields.filter((field) => field !== name);
        for (const asset of Object.values(assetDraft.assets)) delete asset.values[name];
        renderAssetTable();
      });
      cell.append(remove);
    }
    heading.append(cell);
  }
  byId('assets-head').replaceChildren(heading);
  const body = byId('assets-body');
  body.replaceChildren();
  for (const symbol of assetSymbols) {
    const asset = assetDraft.assets[symbol] ||= { alias: '', type: '', values: {} };
    const row = document.createElement('tr');
    row.dataset.symbol = symbol;
    const ticker = document.createElement('td');
    ticker.textContent = symbol;
    row.append(ticker);
    const columns = [
      { name: 'Alias / acrónimo', key: 'alias', limit: 80 },
      { name: 'Tipo de activo', key: 'type', limit: 48 },
      ...assetDraft.fields.map((name) => ({ name, key: name, limit: 500, custom: true }))
    ];
    for (const column of columns) {
      const cell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = column.limit;
      input.value = (column.custom ? asset.values[column.key] : asset[column.key]) || '';
      input.setAttribute('aria-label', `${column.name} de ${symbol}`);
      if (column.key === 'type' && !column.custom) {
        input.setAttribute('list', 'asset-types');
        input.placeholder = 'Selecciona o escribe';
      } else if (!column.custom) input.placeholder = symbol;
      input.addEventListener('input', () => {
        if (column.custom) asset.values[column.key] = input.value;
        else asset[column.key] = input.value;
      });
      cell.append(input);
      row.append(cell);
    }
    body.append(row);
  }
  byId('assets-count').textContent = `${assetSymbols.length} ${assetSymbols.length === 1 ? 'activo' : 'activos'}`;
  byId('assets-empty').hidden = assetSymbols.length > 0;
}

byId('manage-assets').addEventListener('click', async () => {
  const button = byId('manage-assets');
  button.disabled = true;
  try {
    const [metadata, records] = await Promise.all([
      loadAssetMetadata(),
      Promise.all(portfolios.map(async (item) => {
        const response = await fetch(`/api/portfolios/${encodeURIComponent(item.id)}/data`);
        if (!response.ok) throw new Error('No se pudieron cargar todos los activos.');
        return { data: await response.json() };
      }))
    ]);
    assetMetadata = metadata;
    assetDraft = structuredClone(metadata);
    assetSymbols = collectAssetSymbols(records);
    byId('asset-field-name').value = '';
    byId('assets-error').textContent = '';
    renderAssetTable();
    renderDashboard();
    byId('assets-dialog').showModal();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

function addAssetField() {
  const input = byId('asset-field-name');
  const name = input.value.trim();
  const reserved = ['ticker', 'alias', 'acronimo', 'acrónimo', 'alias / acrónimo', 'tipo', 'tipo de activo', '__proto__', 'constructor', 'prototype'];
  if (!name || name.length > 48 || /[\x00-\x1f\x7f]/.test(name) || reserved.includes(name.toLocaleLowerCase('es')) ||
      assetDraft.fields.some((field) => field.toLocaleLowerCase('es') === name.toLocaleLowerCase('es'))) {
    byId('assets-error').textContent = 'Escribe un nombre de campo único, de hasta 48 caracteres.';
    return;
  }
  if (assetDraft.fields.length >= 20) {
    byId('assets-error').textContent = 'Puedes añadir hasta 20 campos personalizados.';
    return;
  }
  assetDraft.fields.push(name);
  input.value = '';
  byId('assets-error').textContent = '';
  renderAssetTable();
  input.focus();
}

byId('add-asset-field').addEventListener('click', addAssetField);
byId('asset-field-name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); addAssetField(); }
});
document.querySelectorAll('.assets-close').forEach((button) => button.addEventListener('click', () => {
  if (!savingAssets) byId('assets-dialog').close();
}));
byId('assets-dialog').addEventListener('cancel', (event) => { if (savingAssets) event.preventDefault(); });
byId('assets-dialog').addEventListener('close', () => {
  if (!byId('assets-dialog').open) assetDraft = null;
});
byId('assets-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (savingAssets || !assetDraft) return;
  const saved = structuredClone(assetDraft);
  for (const asset of Object.values(saved.assets)) {
    asset.alias = asset.alias.trim();
    asset.type = asset.type.trim();
  }
  savingAssets = true;
  const controls = [...byId('assets-form').querySelectorAll('input, button')];
  controls.forEach((control) => { control.disabled = true; });
  byId('assets-error').textContent = '';
  try {
    const response = await writeJson('/api/assets', saved);
    if (!response.ok) throw new Error('No se pudieron guardar los datos de activos. Revisa los campos e inténtalo de nuevo.');
    assetMetadata = saved;
    byId('assets-dialog').close();
    renderDashboard();
    showToast('Datos de activos guardados.');
  } catch (error) { byId('assets-error').textContent = error.message; }
  finally {
    savingAssets = false;
    controls.forEach((control) => { control.disabled = false; });
  }
});

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

function getPositions(data = portfolio) {
  const positions = {};
  for (const transaction of data.transactions) {
    const position = positions[transaction.symbol] || { symbol: transaction.symbol, quantity: 0, netInvested: 0 };
    const direction = transaction.type === 'SELL' ? -1 : 1;
    position.quantity += direction * transaction.quantity;
    position.netInvested += capitalImpact(transaction);
    positions[transaction.symbol] = position;
  }
  return Object.values(positions).filter((position) => position.quantity > 0.00000001).map((position) => {
    const price = readNumber(data.quotes[position.symbol]);
    return { ...position, price, value: position.quantity * price, result: position.quantity * price - position.netInvested };
  }).sort((first, second) => second.value - first.value);
}

function getNetContributions(records = [{ data: portfolio }]) {
  return records.reduce((total, record) => total + record.data.transactions.reduce((subtotal, transaction) => subtotal + capitalImpact(transaction), 0), 0);
}

function capitalImpact(transaction) {
  const gross = transaction.price * transaction.quantity;
  return transaction.type === 'SELL' ? -gross + transaction.commission : gross + transaction.commission;
}

function formatDate(date) {
  return date ? dateFormat.format(new Date(`${date}T12:00:00`)) : 'Sin fecha';
}

function aggregatePositions(records) {
  const positions = new Map();
  for (const record of records) {
    for (const position of getPositions(record.data)) {
      const combined = positions.get(position.symbol) || { symbol: position.symbol, quantity: 0, netInvested: 0, value: 0 };
      combined.quantity += position.quantity;
      combined.netInvested += position.netInvested;
      combined.value += position.value;
      positions.set(position.symbol, combined);
    }
  }
  return [...positions.values()].map((position) => ({
    ...position,
    price: position.quantity ? position.value / position.quantity : 0,
    result: position.value - position.netInvested
  })).sort((first, second) => second.value - first.value);
}

function renderMetrics(positions, records) {
  const total = positions.reduce((sum, position) => sum + position.value, 0);
  const invested = getNetContributions(records);
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
  const transactionCount = records.reduce((sum, record) => sum + record.data.transactions.length, 0);
  byId('transaction-count').textContent = `${transactionCount} ${transactionCount === 1 ? 'operacion' : 'operaciones'}`;
  const dates = records.flatMap((record) => record.data.transactions.map((transaction) => transaction.date)).filter(Boolean).sort();
  const portfolioDescription = dashboardFilterId === 'all' ? 'todos los portfolios' : records[0]?.alias || 'portfolio';
  byId('as-of').textContent = dates.length ? `Desde ${formatDate(dates[0])} · ${transactionCount} operaciones · ${portfolioDescription}` : `Sin operaciones · ${portfolioDescription}`;
  const latestDate = records.flatMap((record) => Object.values(record.data.history).flatMap((entries) => Object.keys(entries))).sort().at(-1);
  const hasQuotes = records.some((record) => Object.keys(record.data.quotes).length > 0);
  byId('last-update').textContent = latestDate ? formatDate(latestDate) : (hasQuotes ? 'Cotizaciones' : 'Sin datos');
  const target = records.reduce((sum, record) => sum + readNumber(record.data.settings?.target), 0);
  const progress = target > 0 ? Math.min(100, total / target * 100) : 0;
  byId('target-progress').style.width = `${progress}%`;
  byId('target-percent').textContent = target ? `${number.format(progress)} % del objetivo` : 'Define un objetivo';
  byId('target-remaining').textContent = target ? (total < target ? `Faltan ${euro.format(target - total)}` : 'Objetivo alcanzado') : '';
}

function renderPositions(positions, allowActions) {
  const body = byId('positions-body');
  body.replaceChildren();
  for (const position of positions) {
    const row = document.createElement('tr');
    const name = assetName(position.symbol);
    const priceAction = allowActions ? ` <button class="small-action" data-quote="${escapeHtml(position.symbol)}" type="button" aria-label="Actualizar precio de ${escapeHtml(name)}">Editar</button>` : '';
    const deleteAction = allowActions ? `<button class="small-action" data-delete="${escapeHtml(position.symbol)}" type="button" aria-label="Eliminar operaciones de ${escapeHtml(name)}">Quitar</button>` : '';
    row.innerHTML = `<td><div class="asset-cell"><span class="asset-mark">${escapeHtml(name.slice(0, 2))}</span><span class="asset-symbol">${escapeHtml(name)}</span></div></td><td>${number.format(position.quantity)}</td><td>${euro.format(position.price)}${priceAction}</td><td>${euro.format(position.value)}</td><td class="${position.result >= 0 ? 'positive' : 'negative'}">${euro.format(position.result)}</td><td>${deleteAction}</td>`;
    body.append(row);
  }
  byId('positions-empty').hidden = positions.length > 0;
  body.querySelectorAll('[data-quote]').forEach((button) => button.addEventListener('click', () => openQuote(button.dataset.quote)));
  body.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => removePosition(button.dataset.delete)));
}

function renderTransactions(records) {
  const list = byId('transaction-list');
  list.replaceChildren();
  const entries = records.flatMap((record) => record.data.transactions.map((transaction) => ({ ...transaction, portfolioAlias: record.alias })))
    .sort((first, second) => second.date.localeCompare(first.date)).slice(0, 5);
  for (const transaction of entries) {
    const row = document.createElement('div');
    row.className = 'transaction-row';
    const sell = transaction.type === 'SELL';
    row.innerHTML = `<div class="transaction-info"><span class="transaction-type ${sell ? 'sell' : ''}">${sell ? '−' : '+'}</span><div class="transaction-meta"><strong>${escapeHtml(assetName(transaction.symbol))} · ${sell ? 'Venta' : 'Compra'}</strong><span>${escapeHtml(transaction.portfolioAlias)} · ${formatDate(transaction.date)} · ${number.format(transaction.quantity)} ud.</span></div></div><div class="transaction-amount">${euro.format(transaction.price * transaction.quantity)}<span>${euro.format(transaction.price)} / ud.</span></div>`;
    list.append(row);
  }
  byId('transactions-empty').hidden = entries.length > 0;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function getPortfolioSeries(data) {
  const history = data.history || {};
  const historyDates = [...new Set(Object.values(history).flatMap((entries) => Object.keys(entries)))].sort();
  if (historyDates.length) {
    const positions = {};
    let transactionIndex = 0;
    const transactions = [...(data.transactions || [])].sort((first, second) => first.date.localeCompare(second.date));
    const points = [];
    for (const date of historyDates) {
      while (transactionIndex < transactions.length && transactions[transactionIndex].date <= date) {
        const transaction = transactions[transactionIndex];
        positions[transaction.symbol] = (positions[transaction.symbol] || 0) + (transaction.type === 'SELL' ? -transaction.quantity : transaction.quantity);
        transactionIndex += 1;
      }
      let total = 0;
      let hasHistoryPrice = false;
      for (const [symbol, entries] of Object.entries(history)) {
        const quantity = positions[symbol] || 0;
        const quoteDates = Object.keys(entries).filter((quoteDate) => quoteDate <= date).sort();
        if (quantity > 0 && quoteDates.length) {
          total += quantity * readNumber(entries[quoteDates.at(-1)]);
          hasHistoryPrice = true;
        }
      }
      if (hasHistoryPrice) points.push({ date, value: total });
    }
    return { points, metric: 'valoracion' };
  }

  let invested = 0;
  const points = [];
  for (const transaction of [...(data.transactions || [])].sort((first, second) => first.date.localeCompare(second.date))) {
    invested += capitalImpact(transaction);
    const lastPoint = points.at(-1);
    if (lastPoint?.date === transaction.date) lastPoint.value = invested;
    else points.push({ date: transaction.date, value: invested });
  }
  return { points, metric: points.length ? 'aportado' : 'sin datos' };
}

function portfolioColor(id, index) {
  const palette = ['#78AFA4', '#D99AA5', '#D4AF70', '#8FA8CF', '#A99AC7', '#87B58D', '#D79678', '#78AFC2'];
  if (index < palette.length) return palette[index];
  return `hsl(${(index * 137.508) % 360} 38% 68%)`;
}

function renderChart() {
  const svg = byId('portfolio-chart');
  const { width, height } = byId('chart-wrap').getBoundingClientRect();
  if (!width || !height) return;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const series = portfolios.map((item, index) => {
    const data = portfolioSnapshots[item.id] || (item.id === activePortfolioId ? portfolio : emptyPortfolio());
    const result = getPortfolioSeries(data);
    const points = result.points.filter((point) => {
      if (activeRange === 'all' || !point.date) return true;
      const date = new Date(`${point.date}T00:00:00`);
      const threshold = new Date();
      threshold.setMonth(threshold.getMonth() - (activeRange === 'year' ? 12 : 1));
      return date >= threshold;
    });
    return { ...item, points, color: portfolioColor(item.id, index), metric: result.metric };
  });
  const dates = [...new Set(series.flatMap((item) => item.points.map((point) => point.date)))].sort();
  const plottedSeries = series.map((item) => {
    let latest = null;
    let pointIndex = 0;
    const points = [];
    for (const date of dates) {
      while (pointIndex < item.points.length && item.points[pointIndex].date <= date) {
        latest = item.points[pointIndex];
        pointIndex += 1;
      }
      if (latest) points.push({ date, value: latest.value });
    }
    return { ...item, points };
  });

  const legend = byId('chart-legend');
  legend.replaceChildren();
  for (const item of plottedSeries) {
    const entry = document.createElement('span');
    entry.className = 'legend-item';
    const mark = document.createElement('span');
    mark.className = 'legend-mark';
    mark.style.color = item.color;
    mark.style.backgroundColor = item.color;
    const label = document.createElement('span');
    label.textContent = `${item.alias} · ${item.metric}`;
    entry.append(mark, label);
    legend.append(entry);
  }
  byId('chart-title').textContent = 'Evolucion de portfolios';
  byId('chart-note').textContent = 'Valoracion con historicos importados; si faltan, se muestra el capital neto aportado. Cada linea conserva su propia metrica.';
  svg.replaceChildren();
  const activeSeries = plottedSeries.filter((item) => item.points.length);
  byId('chart-empty').classList.toggle('hidden', activeSeries.length > 0);
  if (!activeSeries.length) return;

  const points = activeSeries.flatMap((item) => item.points);
  const minValue = Math.min(0, ...points.map((point) => point.value));
  const maxValue = Math.max(1, ...points.map((point) => point.value));
  const right = 12;
  const top = 15;
  const bottom = 33;
  const spread = Math.max(1, maxValue - minValue);
  const y = (value) => top + (maxValue - value) / spread * (height - top - bottom);
  const namespace = 'http://www.w3.org/2000/svg';
  const create = (tag, attributes) => {
    const element = document.createElementNS(namespace, tag);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    return element;
  };

  const axisLabels = [];
  for (let grid = 0; grid < 4; grid += 1) {
    const value = maxValue - spread * grid / 3;
    const yPosition = y(value);
    const label = create('text', { y: yPosition + 4, 'text-anchor': 'end', class: 'chart-axis-label' });
    label.textContent = euro.format(value);
    svg.append(label);
    axisLabels.push(label);
  }
  // Reserve the actual label width so amounts stay inside the panel at any size.
  const left = Math.ceil(Math.max(...axisLabels.map((label) => label.getComputedTextLength()))) + 17;
  const x = (index) => left + (dates.length === 1 ? (width - left - right) / 2 : index / (dates.length - 1) * (width - left - right));
  for (const label of axisLabels) {
    label.setAttribute('x', left - 9);
    const yPosition = Number(label.getAttribute('y')) - 4;
    svg.append(create('line', { x1: left, x2: width - right, y1: yPosition, y2: yPosition, class: 'chart-grid-line' }));
  }
  for (const item of activeSeries) {
    const coordinates = item.points.map((point) => `${x(dates.indexOf(point.date))},${y(point.value)}`);
    svg.append(create('path', { d: `M ${coordinates.join(' L ')}`, class: 'chart-line', stroke: item.color }));
    const lastPoint = item.points.at(-1);
    svg.append(create('circle', { cx: x(dates.indexOf(lastPoint.date)), cy: y(lastPoint.value), r: 4, class: 'chart-dot', stroke: item.color }));
  }
  const first = create('text', { x: dates.length === 1 ? x(0) : left, y: height - 7, 'text-anchor': dates.length === 1 ? 'middle' : 'start', class: 'chart-axis-label' });
  first.textContent = formatDate(dates[0]);
  svg.append(first);
  if (dates.length === 1) return;
  const last = create('text', { x: width - right, y: height - 7, 'text-anchor': 'end', class: 'chart-axis-label' });
  last.textContent = formatDate(dates.at(-1));
  svg.append(last);
}

function render() {
  portfolioSnapshots[activePortfolioId] = portfolio;
  renderDashboard();
  refreshPortfolioSnapshots();
}

function renderDashboard() {
  const records = getDashboardRecords();
  const positions = aggregatePositions(records);
  renderMetrics(positions, records);
  renderPositions(positions, dashboardFilterId !== 'all');
  renderTransactions(records);
  renderChart();
}

async function refreshPortfolioSnapshots() {
  const responses = await Promise.all(portfolios.map(async (item) => {
    try {
      const response = await fetch(`/api/portfolios/${encodeURIComponent(item.id)}/data`);
      if (!response.ok) return null;
      return [item.id, await response.json()];
    } catch {
      return null;
    }
  }));
  for (const result of responses) {
    if (result && result[0] !== activePortfolioId) portfolioSnapshots[result[0]] = result[1];
  }
  renderDashboard();
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
  byId('quote-asset-name').textContent = assetName(symbol);
  form.elements.price.value = portfolio.quotes[symbol] || '';
  byId('quote-dialog').showModal();
}

async function removePosition(symbol) {
  if (!confirm(`Se eliminaran todas las operaciones de ${assetName(symbol)}. Esta accion no se puede deshacer.`)) return;
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
  populatePortfolioSelect('transaction-portfolio', dashboardFilterId === 'all' ? activePortfolioId : dashboardFilterId);
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
  const targetPortfolioId = form.elements.portfolioId.value;
  if (targetPortfolioId !== activePortfolioId) {
    try { await loadPortfolio(targetPortfolioId); }
    catch (error) { byId('form-error').textContent = error.message; return; }
  }
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
  try { await persist(); byId('quote-dialog').close(); render(); showToast(`Precio de ${assetName(symbol)} actualizado.`); }
  catch (error) { portfolio.quotes[symbol] = oldQuote; showToast(error.message); }
});

byId('target-edit').addEventListener('click', () => {
  const form = byId('target-form');
  populatePortfolioSelect('target-portfolio', dashboardFilterId === 'all' ? activePortfolioId : dashboardFilterId);
  const targetPortfolioId = form.elements.portfolioId.value;
  const targetData = portfolioSnapshots[targetPortfolioId] || portfolio;
  form.elements.target.value = targetData.settings?.target || DEFAULT_TARGET;
  byId('target-dialog').showModal();
});
byId('target-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const targetPortfolioId = event.currentTarget.elements.portfolioId.value;
  if (targetPortfolioId !== activePortfolioId) {
    try { await loadPortfolio(targetPortfolioId); }
    catch (error) { showToast(error.message); return; }
  }
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

byId('dashboard-filter').addEventListener('change', (event) => {
  dashboardFilterId = event.target.value;
  if (dashboardFilterId !== 'all') {
    activatePortfolio(dashboardFilterId).catch((error) => showToast(error.message));
  } else {
    renderDashboard();
  }
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

byId('show-all-transactions').addEventListener('click', () => {
  populatePortfolioSelect('transaction-portfolio', dashboardFilterId === 'all' ? activePortfolioId : dashboardFilterId);
  byId('transaction-dialog').showModal();
});
document.querySelectorAll('.range-button').forEach((button) => button.addEventListener('click', () => {
  activeRange = button.dataset.range;
  document.querySelectorAll('.range-button').forEach((other) => other.classList.toggle('active', other === button));
  renderChart();
}));

const mortgageTaxRates = {
  'Andalucía': { itp: 0.07, ajd: 0.012, newTax: 0.10 },
  'Aragón': { itp: 0.08, ajd: 0.015, newTax: 0.10 },
  'Asturias': { itp: 0.08, ajd: 0.012, newTax: 0.10 },
  'Illes Balears': { itp: 0.08, ajd: 0.015, newTax: 0.10 },
  'Canarias': { itp: 0.065, ajd: 0.0075, newTax: 0.07 },
  'Cantabria': { itp: 0.09, ajd: 0.015, newTax: 0.10 },
  'Castilla-La Mancha': { itp: 0.09, ajd: 0.015, newTax: 0.10 },
  'Castilla y León': { itp: 0.08, ajd: 0.015, newTax: 0.10 },
  'Cataluña': { itp: 0.10, ajd: 0.015, newTax: 0.10 },
  'Comunidad Valenciana': { itp: 0.10, ajd: 0.015, newTax: 0.10 },
  'Extremadura': { itp: 0.08, ajd: 0.015, newTax: 0.10 },
  'Galicia': { itp: 0.08, ajd: 0.015, newTax: 0.10 },
  'La Rioja': { itp: 0.07, ajd: 0.01, newTax: 0.10 },
  'Comunidad de Madrid': { itp: 0.06, ajd: 0.0075, newTax: 0.10 },
  'Región de Murcia': { itp: 0.08, ajd: 0.015, newTax: 0.10 },
  'Navarra': { itp: 0.06, ajd: 0.005, newTax: 0.10 },
  'País Vasco': { itp: 0.04, ajd: 0.005, newTax: 0.10 },
  'Ceuta': { itp: 0.06, ajd: 0.005, newTax: 0.04 },
  'Melilla': { itp: 0.06, ajd: 0.005, newTax: 0.04 }
};
const mortgageOtherPurchaseCostRate = 0.015;
let downPaymentMode = 'percent';
const mortgageNumberFormat = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });

function readMortgageNumber(value) {
  let normalized = String(value ?? '').trim().replace(/[€%\s]/g, '');
  if (!normalized) return 0;
  if (normalized.includes(',')) normalized = normalized.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(normalized)) normalized = normalized.replace(/\./g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMortgageInput(value, decimals = 2, grouping = true) {
  return new Intl.NumberFormat('es-ES', { useGrouping: grouping, maximumFractionDigits: decimals }).format(value);
}

function setMortgageCriterion(id, state, detail) {
  const item = byId(id);
  item.dataset.state = state;
  item.querySelector('.criterion-detail').textContent = detail;
}

function resetMortgageResults() {
  byId('mortgage-monthly').textContent = '—';
  byId('mortgage-principal').textContent = '—';
  byId('mortgage-term-summary').textContent = '—';
  byId('mortgage-total-interest').textContent = '—';
  byId('mortgage-total-paid').textContent = '—';
  byId('mortgage-purchase-costs').textContent = '—';
  byId('mortgage-cash-needed').textContent = '—';
  renderAmortizationChart([]);
  setMortgageCriterion('criterion-ltv', 'pending', 'Introduce el precio del inmueble y la entrada.');
  setMortgageCriterion('criterion-effort', 'pending', 'Introduce precio, plazo e ingresos netos mensuales.');
  setMortgageCriterion('criterion-savings', 'pending', 'Introduce el precio, la entrada y tu ahorro disponible.');
}

function buildAmortization(principal, annualRate, years) {
  const months = years * 12;
  const monthlyRate = annualRate / 1200;
  const payment = monthlyRate === 0
    ? principal / months
    : principal * monthlyRate / (1 - Math.pow(1 + monthlyRate, -months));
  let balance = principal;
  let totalInterest = 0;
  let totalPaid = 0;
  const annualRows = [];
  let yearPaid = 0;
  let yearPrincipal = 0;
  let yearInterest = 0;

  for (let month = 1; month <= months; month += 1) {
    const interest = balance * monthlyRate;
    const paid = month === months ? balance + interest : payment;
    const principalPaid = Math.min(balance, paid - interest);
    balance = Math.max(0, balance - principalPaid);
    yearPaid += paid;
    yearPrincipal += principalPaid;
    yearInterest += interest;
    totalPaid += paid;
    totalInterest += interest;

    if (month % 12 === 0 || month === months) {
      annualRows.push({ year: Math.ceil(month / 12), paid: yearPaid, principal: yearPrincipal, interest: yearInterest, balance });
      yearPaid = 0;
      yearPrincipal = 0;
      yearInterest = 0;
    }
  }

  return { payment, totalInterest, totalPaid, annualRows };
}

function renderAmortizationChart(rows, principal = 0, emptyMessage = 'Introduce el precio del inmueble para generar el gráfico.') {
  const svg = byId('amortization-chart');
  const empty = byId('mortgage-chart-empty');
  svg.replaceChildren();
  empty.textContent = emptyMessage;
  empty.hidden = rows.length > 0;
  if (!rows.length) return;

  const namespace = 'http://www.w3.org/2000/svg';
  const create = (tag, attributes) => {
    const element = document.createElementNS(namespace, tag);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    return element;
  };
  const addText = (text, x, y, className, anchor = 'start') => {
    const element = create('text', { x, y, class: className, 'text-anchor': anchor });
    element.textContent = text;
    svg.append(element);
  };
  const width = 1000;
  const left = 88;
  const right = 982;
  const plotWidth = right - left;
  const topPlot = { top: 30, bottom: 178 };
  const paymentPlot = { top: 254, bottom: 404 };
  const maxBalance = Math.max(1, principal);
  const maxYearlyPaid = Math.max(1, ...rows.map((row) => row.paid));
  const xAtYear = (year) => left + year / rows.length * plotWidth;
  const balanceY = (balance) => topPlot.bottom - balance / maxBalance * (topPlot.bottom - topPlot.top);
  const paymentY = (amount) => paymentPlot.bottom - amount / maxYearlyPaid * (paymentPlot.bottom - paymentPlot.top);

  addText('Capital pendiente', left, 18, 'mortgage-chart-title');
  addText('Cuotas anuales: capital e intereses', left, 239, 'mortgage-chart-title');

  for (let grid = 0; grid <= 3; grid += 1) {
    const fraction = grid / 3;
    const balance = maxBalance * (1 - fraction);
    const topY = topPlot.top + fraction * (topPlot.bottom - topPlot.top);
    svg.append(create('line', { x1: left, x2: right, y1: topY, y2: topY, class: 'mortgage-chart-grid' }));
    addText(euro.format(balance), left - 10, topY + 4, 'mortgage-chart-axis', 'end');

    const paid = maxYearlyPaid * (1 - fraction);
    const bottomY = paymentPlot.top + fraction * (paymentPlot.bottom - paymentPlot.top);
    svg.append(create('line', { x1: left, x2: right, y1: bottomY, y2: bottomY, class: 'mortgage-chart-grid' }));
    addText(euro.format(paid), left - 10, bottomY + 4, 'mortgage-chart-axis', 'end');
  }

  const balances = [{ year: 0, balance: principal }, ...rows.map((row) => ({ year: row.year, balance: row.balance }))];
  const balancePath = balances.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xAtYear(point.year)} ${balanceY(point.balance)}`).join(' ');
  svg.append(create('path', { d: balancePath, class: 'mortgage-balance-line' }));
  const lastBalance = balances.at(-1);
  svg.append(create('circle', { cx: xAtYear(lastBalance.year), cy: balanceY(lastBalance.balance), r: 4, class: 'mortgage-balance-point' }));
  addText('0', xAtYear(0), topPlot.bottom + 18, 'mortgage-chart-axis', 'middle');

  const barWidth = Math.max(5, Math.min(24, plotWidth / rows.length * 0.56));
  const yearLabelStep = Math.max(1, Math.ceil(rows.length / 10));
  for (const row of rows) {
    const center = xAtYear(row.year - 0.5);
    const principalTop = paymentY(row.principal);
    const totalTop = paymentY(row.paid);
    svg.append(create('rect', { x: center - barWidth / 2, y: principalTop, width: barWidth, height: paymentPlot.bottom - principalTop, rx: 2, class: 'mortgage-principal-bar' }));
    svg.append(create('rect', { x: center - barWidth / 2, y: totalTop, width: barWidth, height: principalTop - totalTop, rx: 2, class: 'mortgage-interest-bar' }));
    if (row.year % yearLabelStep === 0 || row.year === rows.length) {
      addText(String(row.year), center, paymentPlot.bottom + 18, 'mortgage-chart-axis', 'middle');
    }
  }
}

function bindMortgageNumberFormatting() {
  const fields = [
    ['mortgage-price', 2, true],
    ['mortgage-rate', 2, false],
    ['mortgage-years', 0, false],
    ['mortgage-down-eur', 2, true],
    ['mortgage-down-percent', 2, false],
    ['mortgage-income', 2, true],
    ['mortgage-debts', 2, true],
    ['mortgage-savings', 2, true]
  ];
  for (const [id, decimals, grouping] of fields) {
    const input = byId(id);
    input.addEventListener('focus', () => {
      if (input.value.trim()) input.value = formatMortgageInput(readMortgageNumber(input.value), decimals, false);
    });
    input.addEventListener('blur', () => {
      if (input.value.trim()) input.value = formatMortgageInput(readMortgageNumber(input.value), decimals, grouping);
    });
  }
}

function calculateMortgage() {
  const price = readMortgageNumber(byId('mortgage-price').value);
  const annualRate = readMortgageNumber(byId('mortgage-rate').value);
  const years = Math.floor(readMortgageNumber(byId('mortgage-years').value));
  const downPercent = readMortgageNumber(byId('mortgage-down-percent').value);
  const downAmount = readMortgageNumber(byId('mortgage-down-eur').value);
  const income = readMortgageNumber(byId('mortgage-income').value);
  const otherDebts = readMortgageNumber(byId('mortgage-debts').value);
  const savingsText = byId('mortgage-savings').value.trim();
  const availableSavings = readMortgageNumber(savingsText);
  const region = mortgageTaxRates[byId('mortgage-region').value] || mortgageTaxRates['Comunidad de Madrid'];
  const propertyType = byId('mortgage-property-type').value;

  byId('mortgage-assumption').textContent = byId('mortgage-type').value === 'fixed'
    ? 'La simulación usa el tipo fijo introducido y el sistema francés de amortización. No incluye seguros ni comisiones.'
    : 'Para hipotecas variables y mixtas, el tipo indicado se mantiene constante durante todo el plazo de esta simulación; las revisiones reales pueden cambiar la cuota.';

  if (price <= 0 || years <= 0 || years > 50 || annualRate < 0 || annualRate > 25 || downAmount < 0 || income < 0 || otherDebts < 0 || availableSavings < 0 || (downPaymentMode === 'percent' && (downPercent < 0 || downPercent > 100))) {
    resetMortgageResults();
    return;
  }

  const entry = downPaymentMode === 'amount' ? downAmount : price * downPercent / 100;
  const percentage = price ? entry / price * 100 : 0;
  const principal = price - entry;
  byId('mortgage-down-eur').value = formatMortgageInput(entry, 2, true);
  byId('mortgage-down-percent').value = formatMortgageInput(percentage, 2, false);
  byId('mortgage-principal').textContent = euro.format(Math.max(0, principal));
  byId('mortgage-term-summary').textContent = `${years} años · ${years * 12} cuotas`;

  if (principal < 0) {
    byId('mortgage-monthly').textContent = '—';
    byId('mortgage-principal').textContent = '—';
    byId('mortgage-total-interest').textContent = '—';
    byId('mortgage-total-paid').textContent = '—';
    byId('mortgage-purchase-costs').textContent = '—';
    byId('mortgage-cash-needed').textContent = '—';
    renderAmortizationChart([], 0, 'La entrada supera el precio del inmueble; revisa los importes.');
    setMortgageCriterion('criterion-ltv', 'fail', 'La entrada supera el precio del inmueble; revisa los importes.');
    setMortgageCriterion('criterion-effort', 'pending', 'Revisa el precio y la entrada.');
    setMortgageCriterion('criterion-savings', 'pending', 'Revisa el precio y la entrada.');
    return;
  }

  const schedule = principal > 0 ? buildAmortization(principal, annualRate, years) : { payment: 0, totalInterest: 0, totalPaid: 0, annualRows: [] };
  byId('mortgage-monthly').textContent = euro.format(schedule.payment);
  byId('mortgage-total-interest').textContent = euro.format(schedule.totalInterest);
  byId('mortgage-total-paid').textContent = euro.format(schedule.totalPaid);
  renderAmortizationChart(schedule.annualRows, Math.max(0, principal));

  const ltv = price ? principal / price : 0;
  if (ltv <= 0.8) {
    setMortgageCriterion('criterion-ltv', 'pass', `LTV ${number.format(ltv * 100)}%; dentro de la referencia del 80%.`);
  } else {
    const minimumEntry = price * 0.2;
    setMortgageCriterion('criterion-ltv', 'fail', `Para llegar al 80%, la entrada sería ${euro.format(minimumEntry)}; faltan ${euro.format(Math.max(0, minimumEntry - entry))}.`);
  }

  if (income <= 0) {
    setMortgageCriterion('criterion-effort', 'pending', 'Introduce los ingresos netos mensuales del hogar.');
  } else {
    const monthlyCommitments = schedule.payment + otherDebts;
    const effort = monthlyCommitments / income;
    if (effort <= 0.35) {
      setMortgageCriterion('criterion-effort', 'pass', `Esfuerzo total ${number.format(effort * 100)}% de los ingresos netos.`);
    } else {
      const minimumIncome = monthlyCommitments / 0.35;
      setMortgageCriterion('criterion-effort', 'fail', `Ingresos netos necesarios: ${euro.format(minimumIncome)} al mes; faltan ${euro.format(Math.max(0, minimumIncome - income))}.`);
    }
  }

  const taxRate = propertyType === 'new' ? region.newTax + region.ajd : region.itp;
  const purchaseCosts = price * (taxRate + mortgageOtherPurchaseCostRate);
  const cashNeeded = entry + purchaseCosts;
  byId('mortgage-purchase-costs').textContent = euro.format(purchaseCosts);
  byId('mortgage-cash-needed').textContent = euro.format(cashNeeded);
  if (!savingsText) {
    setMortgageCriterion('criterion-savings', 'pending', `Ahorro estimado necesario: ${euro.format(cashNeeded)} (entrada e impuestos/gastos).`);
  } else if (availableSavings >= cashNeeded) {
    setMortgageCriterion('criterion-savings', 'pass', `Ahorro suficiente; quedarían ${euro.format(availableSavings - cashNeeded)} tras entrada e impuestos/gastos.`);
  } else {
    setMortgageCriterion('criterion-savings', 'fail', `Ahorro necesario: ${euro.format(cashNeeded)}; te faltan ${euro.format(cashNeeded - availableSavings)}.`);
  }
}

function updateDownPaymentFromPercent() {
  downPaymentMode = 'percent';
  const price = readMortgageNumber(byId('mortgage-price').value);
  const percent = readMortgageNumber(byId('mortgage-down-percent').value);
  byId('mortgage-down-eur').value = price > 0 ? formatMortgageInput(price * percent / 100, 2, true) : '';
  calculateMortgage();
}

function updateDownPaymentFromAmount() {
  downPaymentMode = 'amount';
  const price = readMortgageNumber(byId('mortgage-price').value);
  const amount = readMortgageNumber(byId('mortgage-down-eur').value);
  byId('mortgage-down-percent').value = price > 0 ? formatMortgageInput(amount / price * 100, 2, false) : '';
  calculateMortgage();
}

// Payroll estimate: AEAT retention algorithm 2026 (10 September), ordinary
// employees under 65; Order PJC/297/2026, articles 1-4, 16-17 and 31.
const salaryRules = {
  maxMonthlyBase: 5101.20,
  minimumBases: { 1: 1989.30, 2: 1649.70, 3: 1435.20, 4: 1424.40 },
  commonRate: 0.047, trainingRate: 0.001, meiRate: 0.0015,
  brackets: [
    { from: 0, to: 12450, rate: 0.19 },
    { from: 12450, to: 20200, rate: 0.24 },
    { from: 20200, to: 35200, rate: 0.30 },
    { from: 35200, to: 60000, rate: 0.37 },
    { from: 60000, to: 300000, rate: 0.45 },
    { from: 300000, to: Infinity, rate: 0.47 }
  ]
};
const salaryMonths = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
let salaryExtraMonths = [6, 12];
const salaryPercent = (rate) => `${formatMortgageInput(rate * 100, 2, false)} %`;
const salaryRound = (value) => Math.round((value + 1e-9) * 100) / 100;

function readSalaryNumber(value) {
  const text = String(value).trim().replace(/[€%\s\u00a0]/g, '');
  if (!text) return null;
  // Accept Spanish grouping/decimal notation and ungrouped decimal points.
  if (!/^(?:\d+(?:[.,]\d{1,2})?|\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?)$/.test(text)) return NaN;
  return readMortgageNumber(text);
}

function salaryScale(base) {
  return salaryRules.brackets.reduce((total, bracket) => total + Math.max(0, Math.min(base, bracket.to) - bracket.from) * bracket.rate, 0);
}

function calculateSalaryScenario(options) {
  const { gross, bonus = 0, payments = 12, extraMonths = [6, 12], contract = 'permanent', children = 0, youngChildren = 0, childShare = 0.5, family = '3', group = '4', manualRate = null } = options;
  if (bonus > 0) {
    const fixedSalary = calculateSalaryScenario({ ...options, bonus: 0 });
    const annualProjection = calculateSalaryScenario({ ...options, gross: salaryRound(gross + bonus), bonus: 0 });
    const bonusTax = salaryRound(annualProjection.tax - fixedSalary.tax);
    const bonusSocialSecurity = salaryRound(annualProjection.socialSecurity - fixedSalary.socialSecurity);
    // Separate-bonus simulation: keep all fixed payroll payments unchanged and
    // charge the incremental annual deductions to the bonus when it is paid.
    return {
      ...fixedSalary, bonus, fixedSalary,
      totalGross: annualProjection.totalGross,
      contributions: annualProjection.contributions,
      socialSecurity: annualProjection.socialSecurity,
      tax: annualProjection.tax,
      annualNet: annualProjection.annualNet,
      bonusTax, bonusSocialSecurity,
      bonusNet: salaryRound(bonus - bonusTax - bonusSocialSecurity),
      bonusRate: bonusTax / bonus
    };
  }
  const totalGross = salaryRound(gross + bonus);
  const monthlyGross = salaryRound(totalGross / 12);
  const monthlyBase = Math.min(salaryRules.maxMonthlyBase, Math.max(salaryRules.minimumBases[group], monthlyGross));
  const unemploymentRate = contract === 'permanent' ? 0.0155 : 0.016;
  const excess = Math.max(0, monthlyGross - salaryRules.maxMonthlyBase);
  const solidarityMonthly = Math.min(excess, salaryRules.maxMonthlyBase * 0.1) * 0.0019
    + Math.min(Math.max(0, excess - salaryRules.maxMonthlyBase * 0.1), salaryRules.maxMonthlyBase * 0.4) * 0.0021
    + Math.max(0, excess - salaryRules.maxMonthlyBase * 0.5) * 0.0024;
  // Each contribution is rounded on the monthly payroll, then summed annually.
  const contributions = [
    { label: 'Contingencias comunes', rate: salaryRules.commonRate, monthly: salaryRound(monthlyBase * salaryRules.commonRate) },
    { label: 'Desempleo', rate: unemploymentRate, monthly: salaryRound(monthlyBase * unemploymentRate) },
    { label: 'Formación profesional', rate: salaryRules.trainingRate, monthly: salaryRound(monthlyBase * salaryRules.trainingRate) },
    { label: 'Mecanismo de equidad intergeneracional (MEI)', rate: salaryRules.meiRate, monthly: salaryRound(monthlyBase * salaryRules.meiRate) },
    { label: 'Cotización adicional de solidaridad', rate: null, monthly: salaryRound(solidarityMonthly) }
  ].map((item) => ({ ...item, annual: salaryRound(item.monthly * 12) }));
  const socialSecurity = salaryRound(contributions.reduce((sum, item) => sum + item.annual, 0));
  const netWork = Math.max(0, totalGross - socialSecurity);
  let reduction = 0;
  if (netWork <= 14852) reduction = 7302;
  else if (netWork <= 17673.52) reduction = 7302 - 1.75 * (netWork - 14852);
  else if (netWork < 19747.50) reduction = 2364.34 - 1.14 * (netWork - 17673.52);
  reduction = salaryRound(Math.max(0, reduction));
  const base = salaryRound(Math.max(0, netWork - Math.min(2000, netWork) - reduction - (children > 2 ? 600 : 0)));
  let familyMinimum = 5550;
  const share = family === '1' ? 1 : childShare;
  for (let child = 0; child < children; child += 1) familyMinimum += ([2400, 2700, 4000][child] ?? 4500) * share;
  familyMinimum += youngChildren * 2800 * share;
  const exemptLimits = { '1': [0, 17644, 18694], '2': [17197, 18130, 19262], '3': [15876, 16342, 16867] };
  const exemptLimit = exemptLimits[family][Math.min(children, 2)];
  let quota = totalGross <= exemptLimit ? 0 : Math.max(0, salaryScale(base) - salaryScale(familyMinimum));
  if (totalGross <= 35200) quota = Math.min(quota, Math.max(0, (totalGross - exemptLimit) * 0.43));
  let rate = Math.floor((quota / totalGross * 100 + 1e-9) * 100) / 10000;
  if (contract === 'short') rate = Math.max(0.02, rate);
  if (manualRate !== null) rate = manualRate / 100;
  const tax = salaryRound(totalGross * rate);
  const annualNet = salaryRound(totalGross - socialSecurity - tax);
  const marginalIndex = salaryRules.brackets.findIndex((bracket) => base <= bracket.to);

  // Work in cents so that every monthly total reconciles with the annual result.
  const fixedCents = Math.round(gross * 100);
  const fixedParts = Array.from({ length: payments }, (_, index) => (Math.floor(fixedCents / payments) + (index < fixedCents % payments ? 1 : 0)) / 100);
  const extraPaymentMonths = payments === 14 ? [...extraMonths].sort((a, b) => a - b) : [];
  const months = salaryMonths.map((name, index) => {
    const extraIndex = extraPaymentMonths.indexOf(index + 1);
    return { name, month: index + 1, ordinary: fixedParts[index], extra: extraIndex >= 0 ? fixedParts[12 + extraIndex] : 0, bonus: 0 };
  });
  return { gross, bonus, totalGross, monthlyBase, contributions, socialSecurity, reduction, base, familyMinimum, rate, tax, annualNet, marginalIndex, months, bonusTax: 0, bonusSocialSecurity: 0, bonusNet: 0, bonusRate: 0 };
}

function buildSalaryCalendar(result, bonusMonth) {
  const fixedSalary = result.fixedSalary || result;
  const months = fixedSalary.months.map((month) => ({ ...month, bonus: month.month === bonusMonth ? result.bonusNet : 0 }));
  let assignedTaxCents = 0;
  const targetTaxCents = Math.round(fixedSalary.tax * 100);
  const events = months.flatMap((month) => ['ordinary', 'extra'].filter((kind) => month[kind] > 0).map((kind) => ({ month, kind, gross: month[kind] })));
  events.forEach((event, index) => {
    const taxCents = index === events.length - 1 ? targetTaxCents - assignedTaxCents : Math.round(event.gross * fixedSalary.rate * 100);
    assignedTaxCents += taxCents;
    event.month[event.kind] = salaryRound(event.gross - taxCents / 100);
  });
  const monthlySocial = salaryRound(fixedSalary.socialSecurity / 12);
  months.forEach((month) => {
    month.ordinary = salaryRound(month.ordinary - monthlySocial);
    month.total = salaryRound(month.ordinary + month.extra + month.bonus);
  });
  return months;
}

function salaryTableRow(cells, className = '') {
  const row = document.createElement('tr');
  if (className) row.className = className;
  cells.forEach((value) => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); });
  return row;
}

function renderSalaryExtraMonths() {
  const enabled = byId('salary-payments').value === '14';
  byId('salary-extra-months').querySelectorAll('button').forEach((button) => {
    const selected = salaryExtraMonths.includes(Number(button.dataset.month));
    button.disabled = !enabled;
    button.setAttribute('aria-pressed', String(enabled && selected));
  });
  byId('salary-extra-months-note').textContent = enabled
    ? `${salaryExtraMonths.length} de 2 meses elegidos. Pulsa un mes marcado para cambiarlo.`
    : 'Activa 14 pagas para elegir los dos meses de las extras.';
}

function bindSalaryMonthButtons(containerId, label, onSelect) {
  const container = byId(containerId);
  salaryMonths.forEach((name, index) => {
    const month = index + 1;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'salary-month-button';
    button.dataset.month = String(month);
    button.textContent = name.slice(0, 3);
    button.setAttribute('aria-label', `${name}: ${label}`);
    button.title = name;
    button.addEventListener('click', () => onSelect(month));
    container.append(button);
  });
}

function bindSalaryExtraMonths() {
  bindSalaryMonthButtons('salary-extra-months', 'paga extra', (month) => {
    if (salaryExtraMonths.includes(month)) salaryExtraMonths = salaryExtraMonths.filter((value) => value !== month);
    else if (salaryExtraMonths.length < 2) salaryExtraMonths = [...salaryExtraMonths, month].sort((a, b) => a - b);
    else {
      byId('salary-extra-months-note').textContent = 'Ya has elegido 2 meses. Desmarca uno para elegir otro.';
      return;
    }
    renderSalary();
  });
}

function renderSalaryBonusMonths() {
  const enabled = byId('salary-bonus-enabled').checked;
  const month = Number(byId('salary-bonus-month').value);
  byId('salary-bonus').disabled = !enabled;
  byId('salary-bonus-assumption').hidden = !enabled;
  byId('salary-bonus-months').querySelectorAll('button').forEach((button) => {
    button.disabled = !enabled;
    button.setAttribute('aria-pressed', String(enabled && Number(button.dataset.month) === month));
  });
  byId('salary-bonus-months-note').textContent = enabled
    ? `Cobro en ${salaryMonths[month - 1].toLowerCase()}. Elige un único mes.`
    : 'Activa «Incluir bonus» para elegir el mes de cobro.';
}

function renderSalary() {
  renderSalaryExtraMonths();
  renderSalaryBonusMonths();
  const gross = readSalaryNumber(byId('salary-gross').value);
  const bonusEnabled = byId('salary-bonus-enabled').checked;
  const bonus = bonusEnabled ? (readSalaryNumber(byId('salary-bonus').value) ?? 0) : 0;
  const manualRate = readSalaryNumber(byId('salary-irpf-override').value);
  const children = Number(byId('salary-children').value);
  const youngChildren = Number(byId('salary-young-children').value);
  const family = byId('salary-family').value;
  const foral = byId('salary-territory').value !== 'common';
  byId('salary-child-share').disabled = family === '1';
  if (family === '1') byId('salary-child-share').value = '1';
  byId('salary-error').textContent = '';
  byId('salary-results').hidden = true;
  byId('salary-empty').hidden = gross !== null;
  if (gross === null) return;
  const fail = (message) => { byId('salary-error').textContent = message; };
  if (byId('salary-payments').value === '14' && salaryExtraMonths.length !== 2) return fail('Elige dos meses para las pagas extra.');
  if (!Number.isFinite(gross) || gross <= 0 || gross > 10000000) return fail('Introduce un bruto anual válido, mayor que cero y de hasta 10.000.000 €.');
  if (!Number.isFinite(bonus) || bonus < 0 || bonus > 10000000) return fail('Introduce un bonus válido entre 0 y 10.000.000 €.');
  if (manualRate !== null && (!Number.isFinite(manualRate) || manualRate < 0 || manualRate > 100)) return fail('El IRPF manual debe estar entre 0 y 100 %.');
  if (!Number.isInteger(children) || children < 0 || children > 16 || !Number.isInteger(youngChildren) || youngChildren < 0 || youngChildren > children) return fail('Revisa los hijos: de 0 a 16; los menores de 3 años no pueden superar el total.');
  if (family === '1' && children === 0) return fail('La situación familiar con hijos solo a tu cargo requiere al menos un hijo menor.');
  if (foral && manualRate === null) return fail('Para fiscalidad foral o especial, introduce el IRPF de tu nómina en los ajustes.');
  const options = { gross, bonus, payments: Number(byId('salary-payments').value), extraMonths: salaryExtraMonths, contract: byId('salary-contract').value, children, youngChildren, childShare: Number(byId('salary-child-share').value), family, group: byId('salary-group').value, manualRate };
  const result = calculateSalaryScenario(options);
  const withoutBonus = result.fixedSalary || result;
  const bonusMonth = Number(byId('salary-bonus-month').value);
  const calendar = buildSalaryCalendar(result, bonusMonth);
  const ordinaryMonth = calendar[0];
  byId('salary-results').hidden = false;
  byId('salary-monthly').textContent = euro.format(ordinaryMonth.ordinary);
  byId('salary-pay-summary').textContent = options.payments === 14 ? '12 nóminas + 2 extras' : '12 nóminas iguales';
  byId('salary-rate').textContent = `${salaryPercent(result.rate)}${manualRate !== null ? ' · manual' : ' · estimado'}`;
  byId('salary-annual').textContent = euro.format(result.annualNet);
  byId('salary-total-gross').textContent = euro.format(result.totalGross);
  byId('salary-without-bonus').textContent = euro.format(withoutBonus.annualNet);
  byId('salary-average').textContent = euro.format(result.annualNet / 12);
  byId('salary-extra-row').hidden = options.payments !== 14;
  byId('salary-extra').textContent = euro.format(calendar.find((month) => month.extra !== 0)?.extra || 0);

  const brackets = byId('salary-brackets');
  brackets.replaceChildren();
  brackets.hidden = foral;
  const marginal = salaryRules.brackets[result.marginalIndex];
  if (!foral) {
    salaryRules.brackets.forEach((bracket, index) => {
      const segment = document.createElement('div');
      segment.className = `salary-bracket${index === result.marginalIndex ? ' current' : ''}`;
      const rate = document.createElement('strong'); rate.textContent = salaryPercent(bracket.rate);
      const range = document.createElement('span'); range.textContent = Number.isFinite(bracket.to) ? `Hasta ${euro.format(bracket.to)}` : 'Más de 300.000 €';
      const marker = document.createElement('span'); marker.className = 'salary-bracket-marker'; marker.textContent = index === result.marginalIndex ? 'Tu tramo' : '\u00a0';
      segment.append(rate, range, marker); brackets.append(segment);
    });
    brackets.setAttribute('aria-label', `Base de retención ${euro.format(result.base)}; tramo marginal ${salaryPercent(marginal.rate)}.`);
  }
  byId('salary-marginal').textContent = foral ? 'IRPF manual' : `${salaryPercent(marginal.rate)} marginal`;
  byId('salary-bracket-caption').textContent = foral ? 'La escala común no corresponde a tu régimen. Se utiliza únicamente el porcentaje manual; consulta los tramos de tu administración tributaria.' : `Base estimada de retención del sueldo fijo: ${euro.format(result.base)}. Retención sobre el bruto fijo: ${salaryPercent(result.rate)}.${manualRate !== null ? ' El tramo se muestra como referencia de la escala común; has fijado la retención manualmente.' : ''}`;

  const body = byId('salary-breakdown-body'); body.replaceChildren();
  body.append(salaryTableRow(['Bruto anual total', 'Sueldo fijo + bonus', euro.format(result.totalGross)]));
  result.contributions.forEach((item) => body.append(salaryTableRow([item.label, item.rate === null ? '0,19 / 0,21 / 0,24 % del exceso' : `${salaryPercent(item.rate)} de la base`, `−${euro.format(item.annual)}`])));
  body.append(salaryTableRow(['Total Seguridad Social', 'Cotizaciones del trabajador', `−${euro.format(result.socialSecurity)}`], 'salary-subtotal'));
  body.append(salaryTableRow(['IRPF del sueldo fijo', `${salaryPercent(result.rate)} del bruto fijo`, `−${euro.format(withoutBonus.tax)}`]));
  if (bonus > 0) body.append(salaryTableRow(['IRPF del bonus', `${salaryPercent(result.bonusRate)} del bonus`, `−${euro.format(result.bonusTax)}`]));
  body.append(salaryTableRow(['Neto anual', 'Lo que recibes', euro.format(result.annualNet)], 'salary-net-row'));
  byId('salary-base-note').textContent = `Base mensual de cotización del sueldo fijo: ${euro.format(result.monthlyBase)}. Incluye la prorrata de extras; máximo ${euro.format(salaryRules.maxMonthlyBase)}.${bonus > 0 ? ` El desglose anual incluye ${euro.format(result.bonusSocialSecurity)} de cotización adicional, descontada del bonus en esta simulación.` : ''}${gross / 12 < salaryRules.minimumBases[options.group] ? ' Se aplica la base mínima del grupo; para jornadas parciales o periodos inferiores al año, esta estimación puede no corresponder a tu nómina.' : ''}`;
  const distribution = byId('salary-distribution'); distribution.replaceChildren();
  const parts = [{ label: 'Neto', amount: result.annualNet, kind: 'net' }, { label: 'Seguridad Social', amount: result.socialSecurity, kind: 'social' }, { label: 'IRPF', amount: result.tax, kind: 'tax' }];
  parts.forEach((part) => {
    const segment = document.createElement('span'); segment.className = `salary-part salary-part-${part.kind}`;
    segment.style.width = `${Math.max(0, part.amount / result.totalGross * 100)}%`;
    segment.title = `${part.label}: ${euro.format(part.amount)}`; distribution.append(segment);
  });
  distribution.hidden = result.annualNet < 0;
  distribution.setAttribute('aria-label', parts.map((part) => `${part.label}: ${euro.format(part.amount)}`).join('; '));

  byId('salary-bonus-results').hidden = !bonusEnabled || bonus <= 0;
  const bonusPayroll = calendar[bonusMonth - 1];
  byId('salary-bonus-gain').textContent = euro.format(result.annualNet - withoutBonus.annualNet);
  byId('salary-bonus-tax').textContent = `${euro.format(result.bonusTax)} · ${salaryPercent(result.bonusRate)}`;
  byId('salary-bonus-month-net').textContent = `${euro.format(bonusPayroll.total)} · ${bonusPayroll.name}`;
  byId('salary-bonus-impact').textContent = `Bonus bruto: ${euro.format(bonus)}. Se descuentan ${euro.format(result.bonusTax)} de IRPF y ${euro.format(result.bonusSocialSecurity)} de cotizaciones al cobrarlo en ${bonusPayroll.name.toLowerCase()}. Las deducciones del bonus se estiman como la diferencia entre el cálculo anual con bonus y el cálculo del sueldo fijo. La nómina habitual y las extras mantienen sus importes.`;
  const calendarBody = byId('salary-calendar-body'); calendarBody.replaceChildren();
  calendar.forEach((month) => calendarBody.append(salaryTableRow([month.name, euro.format(month.ordinary), month.extra ? euro.format(month.extra) : '—', month.bonus ? euro.format(month.bonus) : '—', euro.format(month.total)], month.bonus ? 'salary-bonus-month' : '')));
  byId('salary-calendar-total').textContent = euro.format(result.annualNet);
}

function activateMainTab(tabName) {
  [['portfolio', 'portfolio-view', 'tab-patrimonio'], ['mortgage', 'mortgage-view', 'tab-hipotecas'], ['salary', 'salary-view', 'tab-sueldo']].forEach(([name, panelId, tabId]) => {
    const active = tabName === name;
    byId(panelId).hidden = !active;
    byId(tabId).classList.toggle('active', active);
    byId(tabId).setAttribute('aria-selected', String(active));
  });
}

byId('tab-patrimonio').addEventListener('click', () => activateMainTab('portfolio'));
byId('tab-hipotecas').addEventListener('click', () => activateMainTab('mortgage'));
byId('tab-sueldo').addEventListener('click', () => activateMainTab('salary'));
document.querySelectorAll('[data-salary-input]').forEach((input) => input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', renderSalary));
byId('salary-bonus-enabled').addEventListener('change', renderSalary);
['salary-gross', 'salary-bonus', 'salary-irpf-override'].forEach((id) => {
  const input = byId(id);
  input.addEventListener('focus', () => {
    const value = readSalaryNumber(input.value);
    if (value !== null && Number.isFinite(value)) input.value = formatMortgageInput(value, 2, false);
  });
  input.addEventListener('blur', () => {
    const value = readSalaryNumber(input.value);
    if (value !== null && Number.isFinite(value)) input.value = formatMortgageInput(value, 2, id !== 'salary-irpf-override');
  });
});
bindSalaryExtraMonths();
bindSalaryMonthButtons('salary-bonus-months', 'cobro del bonus', (month) => {
  byId('salary-bonus-month').value = String(month);
  renderSalary();
});
renderSalary();
byId('mortgage-price').addEventListener('input', () => {
  if (downPaymentMode === 'percent') updateDownPaymentFromPercent();
  else updateDownPaymentFromAmount();
});
byId('mortgage-down-percent').addEventListener('input', updateDownPaymentFromPercent);
byId('mortgage-down-eur').addEventListener('input', updateDownPaymentFromAmount);
document.querySelectorAll('[data-mortgage-input]').forEach((input) => input.addEventListener('input', calculateMortgage));
bindMortgageNumberFormatting();
byId('mortgage-type').addEventListener('change', calculateMortgage);
byId('mortgage-region').addEventListener('change', calculateMortgage);
byId('mortgage-property-type').addEventListener('change', calculateMortgage);

calculateMortgage();
const chartResizeObserver = new ResizeObserver(() => renderChart());
chartResizeObserver.observe(byId('chart-wrap'));
initializePortfolios().catch((error) => showToast(error.message));
