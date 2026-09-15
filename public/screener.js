const verdictSelectEl = document.getElementById('screener-verdict-select');
const updatedEl = document.getElementById('screener-updated');
const listEl = document.getElementById('screener-list');

let allItems = [];

verdictSelectEl.addEventListener('change', () => {
  renderList(verdictSelectEl.value);
});

function formatJoWon(marketCap) {
  return `${(marketCap / 1e12).toFixed(1)}조원`;
}

function formatGrowth(growth) {
  if (growth === null || growth === undefined) return null;
  const sign = growth > 0 ? '+' : '';
  return `${sign}${growth.toFixed(1)}%`;
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

function renderList(verdict) {
  const items = allItems
    .filter((item) => item.verdict === verdict)
    .sort((a, b) => growthMagnitude(b.growth) - growthMagnitude(a.growth));

  listEl.innerHTML = '';

  if (!items.length) {
    listEl.innerHTML = '<li class="calendar-empty">조건에 맞는 종목이 없습니다.</li>';
    return;
  }

  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = `screener-item ${verdict === 'UP' ? 'up' : 'down'}`;

    const opLabel = operatingProfitLabel(item.growth);
    const revLabel = formatGrowth(item.growth.revenueGrowth);

    li.innerHTML = `
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
    `;
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
    allItems = (data.items || []).filter((item) => item.verdict && item.growth);
    updatedEl.textContent = formatUpdatedAt(data.capturedAt);
    renderList(verdictSelectEl.value);
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
