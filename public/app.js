const REFRESH_INTERVAL_MS = 30000;

const updatedAtEl = document.getElementById('updated-at');
const refreshBtn = document.getElementById('refresh-btn');
const errorMsgEl = document.getElementById('error-msg');
const cards = Object.fromEntries(
  Array.from(document.querySelectorAll('.index-card')).map((el) => [el.dataset.code, el])
);

const DIRECTION_CLASS = {
  RISING: 'up',
  FALLING: 'down',
  EVEN: 'flat',
};

const MARKET_STATUS_LABEL = {
  OPEN: '장중',
  CLOSE: '장마감',
  PRE_OPEN: '장시작전',
};

function formatTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ECOS periods come back as "202607"; display as "2026-07".
function formatYyyymm(period) {
  return period && period.length === 6 ? `${period.slice(0, 4)}-${period.slice(4)}` : period;
}

function renderIndex(item) {
  const card = cards[item.code];
  if (!card) return;

  const directionClass = DIRECTION_CLASS[item.direction] || 'flat';
  card.classList.remove('up', 'down', 'flat', 'loading');
  card.classList.add(directionClass);

  // Naver already prefixes negative change/ratio values with "-"; only "up" needs a "+" added.
  const sign = directionClass === 'up' ? '+' : '';
  const arrow = directionClass === 'up' ? '▲' : directionClass === 'down' ? '▼' : '-';

  card.querySelector('.index-price').textContent = item.price;
  card.querySelector('.change-value').textContent = `${arrow} ${item.change}`;
  card.querySelector('.change-ratio').textContent = `(${sign}${item.changeRatio}%)`;
  card.querySelector('.market-status').textContent =
    `${MARKET_STATUS_LABEL[item.marketStatus] || item.marketStatus} · 기준시각 ${formatTime(item.tradedAt)}`;
}

async function loadIndices() {
  Object.values(cards).forEach((card) => card.classList.add('loading'));
  errorMsgEl.hidden = true;

  try {
    const res = await fetch('/api/indices');
    if (!res.ok) throw new Error('요청 실패');
    const data = await res.json();

    data.indices.forEach(renderIndex);
    updatedAtEl.textContent = `마지막 업데이트: ${formatTime(data.updatedAt)}`;
  } catch (err) {
    errorMsgEl.textContent = '지수 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.';
    errorMsgEl.hidden = false;
  } finally {
    Object.values(cards).forEach((card) => card.classList.remove('loading'));
  }
}

const usCards = Object.fromEntries(
  Array.from(document.querySelectorAll('#us-index-grid .mini-card, #us-stock-grid .mini-card')).map((el) => [
    el.dataset.code,
    el,
  ])
);
const usdKrwCard = document.getElementById('usd-krw-card');
const yield10yCard = document.getElementById('us-yield10y-card');
const spreadCard = document.getElementById('us-spread-card');
const oecdCard = document.getElementById('oecd-cli-card');
const chinaBciCard = document.getElementById('china-bci-card');
const depositsCard = document.getElementById('deposits-card');
const marginCard = document.getElementById('margin-card');
const commodityCards = Object.fromEntries(
  Array.from(document.querySelectorAll('#commodity-grid .mini-card')).map((el) => [el.dataset.code, el])
);
const vixCard = document.getElementById('vix-card');
const creditSpreadCard = document.getElementById('credit-spread-card');
const kospiForeignCard = document.getElementById('kospi-foreign-card');
const kospiInstitutionCard = document.getElementById('kospi-institution-card');
const kosdaqForeignCard = document.getElementById('kosdaq-foreign-card');
const kosdaqInstitutionCard = document.getElementById('kosdaq-institution-card');
const usFedRateCard = document.getElementById('us-fed-rate-card');
const krBaseRateCard = document.getElementById('kr-base-rate-card');
const usKrSpreadCard = document.getElementById('us-kr-spread-card');
const bsiCard = document.getElementById('bsi-card');
const ccsiCard = document.getElementById('ccsi-card');
const bdiCard = document.getElementById('bdi-card');

const ALL_LEADING_CARDS = [
  ...Object.values(usCards),
  usdKrwCard,
  yield10yCard,
  spreadCard,
  oecdCard,
  chinaBciCard,
  depositsCard,
  marginCard,
  ...Object.values(commodityCards),
  vixCard,
  creditSpreadCard,
  kospiForeignCard,
  kospiInstitutionCard,
  kosdaqForeignCard,
  kosdaqInstitutionCard,
  usFedRateCard,
  krBaseRateCard,
  usKrSpreadCard,
  bsiCard,
  ccsiCard,
  bdiCard,
];

function renderMiniIndex(card, item) {
  card.classList.remove('up', 'down', 'flat', 'loading');

  if (!item.price) {
    card.classList.add('flat');
    card.querySelector('.mini-price').textContent = '데이터 없음';
    card.querySelector('.change-value').textContent = '-';
    const ratioEl = card.querySelector('.change-ratio');
    if (ratioEl) ratioEl.textContent = '';
    return;
  }

  const directionClass = DIRECTION_CLASS[item.direction] || 'flat';
  card.classList.add(directionClass);

  // Naver already prefixes negative change/ratio values with "-"; only "up" needs a "+" added.
  const sign = directionClass === 'up' ? '+' : '';
  const arrow = directionClass === 'up' ? '▲' : directionClass === 'down' ? '▼' : '-';

  card.querySelector('.mini-price').textContent = item.price;
  card.querySelector('.change-value').textContent = `${arrow} ${item.change}`;
  card.querySelector('.change-ratio').textContent = `(${sign}${item.changeRatio}%)`;
  const metaEl = card.querySelector('.mini-meta');
  if (metaEl && item.tradedAt) metaEl.textContent = item.tradedAt;
}

// Generic renderer for single-value metric cards (OECD indicators, US Treasury
// yields, 증시자금동향) that share the .mini-price/.change-value/.mini-meta markup.
function renderMetricCard(card, data, { formatValue, formatChange, meta }) {
  if (!card) return;

  card.classList.remove('up', 'down', 'flat', 'loading');

  if (!data) {
    card.classList.add('flat');
    card.querySelector('.mini-price').textContent = '데이터 없음';
    card.querySelector('.change-value').textContent = '-';
    const metaEl = card.querySelector('.mini-meta');
    if (metaEl) metaEl.textContent = '-';
    return;
  }

  const directionClass = DIRECTION_CLASS[data.direction] || 'flat';
  card.classList.add(directionClass);

  const sign = directionClass === 'up' ? '+' : directionClass === 'down' ? '-' : '';
  const arrow = directionClass === 'up' ? '▲' : directionClass === 'down' ? '▼' : '-';

  card.querySelector('.mini-price').textContent = formatValue(data);
  card.querySelector('.change-value').textContent =
    data.change === null || data.change === undefined ? '-' : `${arrow} ${sign}${formatChange(data)}`;
  const metaEl = card.querySelector('.mini-meta');
  if (metaEl && meta) metaEl.textContent = meta(data);
}

// 외국인/기관 순매수 cards: a single day's flow figure has no "previous value"
// to diff against, so show the signed amount itself plus a 순매수/순매도 label.
function renderFlowCard(card, flow, date) {
  if (!card) return;
  card.classList.remove('up', 'down', 'flat', 'loading');

  if (!flow) {
    card.classList.add('flat');
    card.querySelector('.mini-price').textContent = '데이터 없음';
    card.querySelector('.change-value').textContent = '-';
    return;
  }

  const directionClass = DIRECTION_CLASS[flow.direction] || 'flat';
  card.classList.add(directionClass);
  const arrow = directionClass === 'up' ? '▲' : directionClass === 'down' ? '▼' : '-';
  const label = directionClass === 'up' ? '순매수' : directionClass === 'down' ? '순매도' : '보합';

  card.querySelector('.mini-price').textContent = `${arrow} ${Math.abs(flow.value).toLocaleString('ko-KR')}`;
  card.querySelector('.change-value').textContent = label;
  const metaEl = card.querySelector('.mini-meta');
  if (metaEl && date) metaEl.textContent = `${date} 기준`;
}

function renderUsFedRateCard(card, fed) {
  if (!card) return;
  card.classList.remove('up', 'down', 'flat', 'loading');

  if (!fed) {
    card.classList.add('flat');
    card.querySelector('.mini-price').textContent = '데이터 없음';
    card.querySelector('.change-value').textContent = '-';
    return;
  }

  const directionClass = DIRECTION_CLASS[fed.upper.direction] || 'flat';
  card.classList.add(directionClass);
  card.querySelector('.mini-price').textContent = `${fed.lower.value.toFixed(2)}~${fed.upper.value.toFixed(2)}%`;
  card.querySelector('.change-value').textContent = fed.upper.change === 0 ? '동결' : '변경';
  const metaEl = card.querySelector('.mini-meta');
  if (metaEl) metaEl.textContent = `${fed.upper.date} 기준 · FOMC 목표범위`;
}

function renderUsKrSpreadCard(card, spread) {
  if (!card) return;
  card.classList.remove('up', 'down', 'flat', 'loading');

  if (!spread) {
    card.classList.add('flat');
    card.querySelector('.mini-price').textContent = '데이터 없음';
    card.querySelector('.change-value').textContent = '-';
    return;
  }

  card.classList.add('flat');
  const sign = spread.value > 0 ? '+' : '';
  card.querySelector('.mini-price').textContent = `${sign}${spread.value.toFixed(2)}%p`;
  card.querySelector('.change-value').textContent = spread.value > 0 ? '미국 > 한국' : spread.value < 0 ? '한국 > 미국' : '동일';
}

async function loadLeadingIndicators() {
  ALL_LEADING_CARDS.forEach((card) => card.classList.add('loading'));

  try {
    const res = await fetch('/api/leading-indicators');
    if (!res.ok) throw new Error('요청 실패');
    const data = await res.json();

    [...data.us, ...(data.usStocks || [])].forEach((item) => {
      const card = usCards[item.code];
      if (card) renderMiniIndex(card, item);
    });

    if (data.usdKrw) renderMiniIndex(usdKrwCard, data.usdKrw);

    (data.commodities || []).forEach((item) => {
      const card = commodityCards[item.code];
      if (!card) return;
      const meta = [item.unit, item.date].filter(Boolean).join(' · ');
      renderMiniIndex(card, { ...item, tradedAt: meta });
    });

    renderMetricCard(yield10yCard, data.usTreasury && data.usTreasury.yield10y, {
      formatValue: (d) => `${d.value.toFixed(2)}%`,
      formatChange: (d) => `${Math.abs(d.change).toFixed(2)}%p (전일대비)`,
      meta: (d) => `${d.date} 기준`,
    });

    renderMetricCard(spreadCard, data.usTreasury && data.usTreasury.spread10y2y, {
      formatValue: (d) => `${d.value.toFixed(2)}%p`,
      formatChange: (d) => `${Math.abs(d.change).toFixed(2)}%p (전일대비)`,
      meta: (d) => `${d.date} 기준${d.value < 0 ? ' · 장단기 역전' : ''}`,
    });

    renderMetricCard(oecdCard, data.oecdCli, {
      formatValue: (d) => d.value.toFixed(2),
      formatChange: (d) => `${Math.abs(d.change).toFixed(2)} (전월대비)`,
      meta: (d) => `${d.period} 기준 · 매월 갱신`,
    });

    renderMetricCard(chinaBciCard, data.chinaBci, {
      formatValue: (d) => d.value.toFixed(1),
      formatChange: (d) => `${Math.abs(d.change).toFixed(1)} (전월대비)`,
      meta: (d) => `${d.period} 기준 · PMI 아닌 OECD 기업경기신뢰지수`,
    });

    renderMetricCard(depositsCard, data.fundFlow && data.fundFlow.deposits, {
      formatValue: (d) => d.value,
      formatChange: (d) => `${d.change.replace(/^-/, '')} (전일대비)`,
      meta: () => (data.fundFlow ? `${data.fundFlow.date} 기준` : '-'),
    });

    renderMetricCard(marginCard, data.fundFlow && data.fundFlow.marginBalance, {
      formatValue: (d) => d.value,
      formatChange: (d) => `${d.change.replace(/^-/, '')} (전일대비)`,
      meta: () => (data.fundFlow ? `${data.fundFlow.date} 기준` : '-'),
    });

    if (data.vix) renderMiniIndex(vixCard, data.vix);

    const rates = data.rates || {};
    renderMetricCard(creditSpreadCard, rates.creditSpread, {
      formatValue: (d) => `${d.value.toFixed(2)}%p`,
      formatChange: (d) => `${Math.abs(d.change).toFixed(2)}%p (전일대비)`,
      meta: (d) => `국고채 ${d.govt3y.toFixed(2)}% · 회사채(AA-) ${d.corp3y.toFixed(2)}% · ${d.date} 기준`,
    });

    const flow = data.investorFlow || {};
    renderFlowCard(kospiForeignCard, flow.kospi && flow.kospi.foreign, flow.kospi && flow.kospi.date);
    renderFlowCard(kospiInstitutionCard, flow.kospi && flow.kospi.institution, flow.kospi && flow.kospi.date);
    renderFlowCard(kosdaqForeignCard, flow.kosdaq && flow.kosdaq.foreign, flow.kosdaq && flow.kosdaq.date);
    renderFlowCard(
      kosdaqInstitutionCard,
      flow.kosdaq && flow.kosdaq.institution,
      flow.kosdaq && flow.kosdaq.date
    );

    renderUsFedRateCard(usFedRateCard, rates.usFedRate);

    renderMetricCard(krBaseRateCard, rates.krBaseRate, {
      formatValue: (d) => `${d.value.toFixed(2)}%`,
      formatChange: (d) => `${Math.abs(d.change).toFixed(2)}%p (전월대비)`,
      meta: (d) => `${formatYyyymm(d.period)} 기준 · 한국은행`,
    });

    renderUsKrSpreadCard(usKrSpreadCard, rates.usKrSpread);

    const sentiment = data.sentiment || {};
    renderMetricCard(bsiCard, sentiment.bsi, {
      formatValue: (d) => d.value,
      formatChange: (d) => `${Math.abs(d.change).toFixed(0)} (전월대비)`,
      meta: (d) => `${formatYyyymm(d.period)} 기준 · 한국은행`,
    });

    renderMetricCard(ccsiCard, sentiment.ccsi, {
      formatValue: (d) => d.value,
      formatChange: (d) => `${Math.abs(d.change).toFixed(1)} (전월대비)`,
      meta: (d) => `${formatYyyymm(d.period)} 기준 · 한국은행`,
    });

    if (data.bdi) {
      renderMiniIndex(bdiCard, {
        price: data.bdi.price,
        change: data.bdi.change,
        changeRatio: data.bdi.changeRatio,
        direction: data.bdi.direction,
        tradedAt: data.bdi.date,
      });
    }
  } catch (err) {
    ALL_LEADING_CARDS.forEach((card) => {
      card.querySelector('.mini-price').textContent = '오류';
    });
  } finally {
    ALL_LEADING_CARDS.forEach((card) => card.classList.remove('loading'));
  }
}

function renderNews(listEl, items, emptyText) {
  listEl.innerHTML = '';

  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'news-item news-empty';
    li.textContent = emptyText;
    listEl.appendChild(li);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'news-item';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'news-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = item.title;

    const detail = document.createElement('div');
    detail.className = 'news-detail';
    detail.hidden = true;

    const summary = document.createElement('p');
    summary.className = 'news-summary';
    summary.textContent = item.summary;

    const meta = document.createElement('span');
    meta.className = 'news-meta';
    meta.textContent = [item.press, item.time].filter(Boolean).join(' · ');

    const link = document.createElement('a');
    link.className = 'news-link';
    link.href = item.link;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '원문 보기';

    if (item.summary) detail.appendChild(summary);
    detail.appendChild(meta);
    detail.appendChild(link);

    toggle.addEventListener('click', () => {
      const isOpen = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!isOpen));
      detail.hidden = isOpen;
      li.classList.toggle('open', !isOpen);
    });

    li.appendChild(toggle);
    li.appendChild(detail);
    listEl.appendChild(li);
  });
}

// Wires up one news section: fetch/render function, its section-collapse
// toggle button, and returns the loader so it can be called on refresh/interval.
function setupNewsSection({ apiUrl, listId, toggleId, emptyText, errorText }) {
  const listEl = document.getElementById(listId);
  const toggleEl = document.getElementById(toggleId);

  toggleEl.addEventListener('click', () => {
    const isOpen = toggleEl.getAttribute('aria-expanded') === 'true';
    toggleEl.setAttribute('aria-expanded', String(!isOpen));
    toggleEl.textContent = isOpen ? '펼치기' : '접기';
    listEl.hidden = isOpen;
  });

  return async function load() {
    try {
      const res = await fetch(apiUrl);
      if (!res.ok) throw new Error('요청 실패');
      const data = await res.json();
      renderNews(listEl, data.news, emptyText);
    } catch (err) {
      renderNews(listEl, [], errorText);
    }
  };
}

const loadNyNews = setupNewsSection({
  apiUrl: '/api/ny-news',
  listId: 'ny-news-list',
  toggleId: 'news-section-toggle',
  emptyText: '표시할 뉴욕증시 뉴스가 없습니다.',
  errorText: '뉴욕증시 뉴스를 불러오지 못했습니다.',
});

const loadKrNews = setupNewsSection({
  apiUrl: '/api/kr-news',
  listId: 'kr-news-list',
  toggleId: 'kr-news-section-toggle',
  emptyText: '표시할 국내증시 뉴스가 없습니다.',
  errorText: '국내증시 뉴스를 불러오지 못했습니다.',
});

refreshBtn.addEventListener('click', () => {
  loadIndices();
  loadNyNews();
  loadKrNews();
  loadLeadingIndicators();
});

loadIndices();
loadNyNews();
loadKrNews();
loadLeadingIndicators();
setInterval(loadIndices, REFRESH_INTERVAL_MS);
setInterval(loadNyNews, REFRESH_INTERVAL_MS * 4);
setInterval(loadKrNews, REFRESH_INTERVAL_MS * 4);
setInterval(loadLeadingIndicators, REFRESH_INTERVAL_MS * 2);
