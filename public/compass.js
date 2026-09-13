function directionClass(value) {
  if (value === null || value === undefined) return 'flat';
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'flat';
}

function formatPercent(value) {
  const dir = directionClass(value);
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '-';
  const sign = dir === 'up' ? '+' : '';
  return `${arrow} ${sign}${value.toFixed(2)}%`;
}

function renderCompass(sectors, quarterCumulative) {
  sectors.forEach((sector) => {
    const card = document.querySelector(`.mini-card[data-sector="${sector.id}"]`);
    if (!card) return;

    card.classList.remove('up', 'down', 'flat', 'loading');

    const priceEl = card.querySelector('.mini-price');
    const changeEl = card.querySelector('.change-value');
    const metaEl = card.querySelector('.mini-meta');

    if (sector.changeRate === null) {
      card.classList.add('flat');
      priceEl.textContent = '데이터 없음';
      changeEl.textContent = '-';
      metaEl.textContent = '-';
      return;
    }

    card.classList.add(directionClass(sector.changeRate));
    priceEl.textContent = formatPercent(sector.changeRate);
    changeEl.textContent = `상승 ${sector.riseCount} · 하락 ${sector.fallCount}`;

    if (!quarterCumulative || !quarterCumulative.tradingDays) {
      metaEl.textContent = '분기 누적: 수집 중 (오늘부터 시작)';
      return;
    }

    const q = quarterCumulative.sectors[sector.id];
    metaEl.textContent =
      typeof q === 'number'
        ? `분기 누적(${quarterCumulative.tradingDays}거래일): ${formatPercent(q)}`
        : '분기 누적: 데이터 없음';
  });
}

async function loadCompass() {
  const updatedAtEl = document.getElementById('compass-updated-at');
  try {
    const res = await fetch('/api/industry-compass');
    if (!res.ok) throw new Error('요청 실패');
    const data = await res.json();
    renderCompass(data.sectors, data.quarterCumulative);
    updatedAtEl.textContent = `마지막 업데이트: ${new Date(data.updatedAt).toLocaleTimeString('ko-KR')}`;
  } catch (err) {
    document.querySelectorAll('#compass-grid .mini-card').forEach((card) => {
      card.classList.remove('loading');
      card.querySelector('.mini-price').textContent = '오류';
    });
    updatedAtEl.textContent = '업데이트 실패';
  }
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  setTimeout(() => overlay.remove(), 600);
}

const initialLoad = loadCompass();
const minDisplayTime = new Promise((resolve) => setTimeout(resolve, 1500));
Promise.all([initialLoad, minDisplayTime]).finally(hideLoadingOverlay);

setInterval(loadCompass, 60000);
