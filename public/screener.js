const termSelectEl = document.getElementById('screener-term-select');
const verdictSelectEl = document.getElementById('screener-verdict-select');
const updatedEl = document.getElementById('screener-updated');
const listEl = document.getElementById('screener-list');

let allItems = [];

const TERM_KEY = { short: 'shortTerm', long: 'longTerm' };

termSelectEl.addEventListener('change', () => {
  renderList();
});

verdictSelectEl.addEventListener('change', () => {
  renderList();
});

function formatJoWon(marketCap) {
  return `${(marketCap / 1e12).toFixed(1)}조원`;
}

// 매출액/영업이익은 API가 억원 단위로 주므로, 1조 이상이면 조원으로 줄여 표시.
function formatEokWon(value) {
  if (value === null || value === undefined) return '-';
  return Math.abs(value) >= 10000 ? `${(value / 10000).toFixed(1)}조원` : `${value.toLocaleString()}억원`;
}

function formatGrowth(growth) {
  if (growth === null || growth === undefined) return null;
  const sign = growth > 0 ? '+' : '';
  return `${sign}${growth.toFixed(1)}%`;
}

const FAIR_VERDICT_LABEL = { UNDERVALUED: '저평가', OVERVALUED: '고평가', FAIR: '적정' };
const FAIR_VERDICT_CLASS = { UNDERVALUED: 'up', OVERVALUED: 'down', FAIR: 'flat' };

function renderFairValueBadge(item) {
  if (!item.fairValue || item.fairValue.fairValue === null || !item.currentPrice) return '';

  const gapRatio = ((item.fairValue.fairValue - item.currentPrice) / item.currentPrice) * 100;
  const verdict = gapRatio > 0 ? 'UNDERVALUED' : gapRatio < 0 ? 'OVERVALUED' : 'FAIR';
  const sign = gapRatio > 0 ? '+' : '';

  return `
    <span class="screener-sub">적정주가 ${item.fairValue.fairValue.toLocaleString()}원</span>
    <span class="valuation-badge ${FAIR_VERDICT_CLASS[verdict]}">${FAIR_VERDICT_LABEL[verdict]} (${sign}${gapRatio.toFixed(1)}%)</span>
  `;
}

function renderDetail(item) {
  if (!item.fairValue || !item.fairValue.quarters) {
    return '<p class="valuation-meta">상세 실적 데이터가 없습니다.</p>';
  }

  const rows = item.fairValue.quarters.map(
    (q) =>
      `<tr><td>${q.period}</td><td>매출액 ${formatEokWon(q.revenue)} · 영업이익 ${formatEokWon(q.operatingProfit)} · EPS ${q.eps.toLocaleString()}원</td></tr>`
  );

  if (item.lastYear) {
    const y = item.lastYear;
    const label = `${y.period.replace(/\.$/, '')} (작년)`;
    rows.push(
      `<tr><td>${label}</td><td>매출액 ${formatEokWon(y.revenue)} · 영업이익 ${formatEokWon(y.operatingProfit)} · EPS ${
        y.eps !== null ? y.eps.toLocaleString() + '원' : '-'
      }</td></tr>`
    );
  }

  const noFairValueNote =
    item.fairValue.fairValue === null
      ? '<p class="valuation-meta">최근 4분기 합산 실적이 적자라 적정주가는 계산하지 않았습니다.</p>'
      : '';

  return `
    <div class="valuation-block">
      <p class="valuation-block-title">최근 4분기 + 작년 실적</p>
      <table class="valuation-quarters"><tbody>${rows.join('')}</tbody></table>
      ${noFairValueNote}
    </div>
  `;
}

function operatingProfitLabel(growth) {
  if (growth.operatingProfitTurnaround === 'PROFIT') return '흑자전환';
  if (growth.operatingProfitTurnaround === 'LOSS') return '적자전환';
  return formatGrowth(growth.operatingProfitGrowth);
}

// 흑자/적자전환을 %보다 더 강한 변화로 취급해, 정렬 시 맨 위로 오게 한다.
function growthMagnitude(growth) {
  if (growth.operatingProfitTurnaround) return Infinity;
  return growth.operatingProfitGrowth === null ? 0 : Math.abs(growth.operatingProfitGrowth);
}

function renderList() {
  const termKey = TERM_KEY[termSelectEl.value];
  const verdict = verdictSelectEl.value;

  const items = allItems
    .filter((item) => item[termKey].verdict === verdict)
    .sort((a, b) => growthMagnitude(b[termKey].growth) - growthMagnitude(a[termKey].growth));

  listEl.innerHTML = '';

  if (!items.length) {
    listEl.innerHTML = '<li class="calendar-empty">조건에 맞는 종목이 없습니다.</li>';
    return;
  }

  items.forEach((item) => {
    const growth = item[termKey].growth;
    const li = document.createElement('li');
    li.className = `screener-item ${verdict === 'UP' ? 'up' : 'down'}`;

    const opLabel = operatingProfitLabel(growth);
    const revLabel = formatGrowth(growth.revenueGrowth);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'screener-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = `
      <div class="screener-item-top">
        <span class="screener-name">${item.name}</span>
        <span class="screener-market">${item.market}</span>
        <span class="screener-cap">${formatJoWon(item.marketCap)}</span>
      </div>
      <div class="screener-item-bottom">
        <span class="screener-price">${item.currentPrice.toLocaleString()}원</span>
        <span class="screener-badge">영업이익 ${opLabel}</span>
        ${revLabel ? `<span class="screener-sub">매출액 ${revLabel}</span>` : ''}
      </div>
      ${item.fairValue ? `<div class="screener-item-bottom">${renderFairValueBadge(item)}</div>` : ''}
    `;

    const detail = document.createElement('div');
    detail.className = 'valuation-detail';
    detail.hidden = true;
    detail.innerHTML = renderDetail(item);

    toggle.addEventListener('click', () => {
      const isOpen = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!isOpen));
      detail.hidden = isOpen;
    });

    li.appendChild(toggle);
    li.appendChild(detail);
    listEl.appendChild(li);
  });
}

function formatUpdatedAt(capturedAt) {
  if (!capturedAt) return '아직 데이터가 없습니다.';
  const date = new Date(capturedAt);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `마지막 갱신: ${y}-${m}-${d} 자정 기준`;
}

async function loadScreener() {
  try {
    const res = await fetch('/api/screener');
    if (!res.ok) throw new Error('요청 실패');
    const data = await res.json();
    allItems = data.items || [];
    updatedEl.textContent = formatUpdatedAt(data.capturedAt);
    renderList();
  } catch (err) {
    updatedEl.textContent = '데이터를 불러오지 못했습니다.';
    listEl.innerHTML = '<li class="calendar-empty">실적주 데이터를 불러오지 못했습니다.</li>';
  }
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  setTimeout(() => overlay.remove(), 600);
}

const minDisplayTime = new Promise((resolve) => setTimeout(resolve, 1500));
Promise.all([loadScreener(), minDisplayTime]).finally(hideLoadingOverlay);
