const listEl = document.getElementById('tradingvalue-list');
const updatedEl = document.getElementById('tradingvalue-updated');

const DIRECTION_CLASS = { RISING: 'up', FALLING: 'down', EVEN: 'flat' };

function formatWon(value) {
  if (value === null || value === undefined) return '-';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(1)}조원`;
  if (abs >= 1e8) return `${(value / 1e8).toFixed(1)}억원`;
  return `${value.toLocaleString()}원`;
}

function formatChangeRatio(direction, changeRatio) {
  const sign = direction === 'RISING' ? '+' : '';
  const arrow = direction === 'RISING' ? '▲' : direction === 'FALLING' ? '▼' : '-';
  return `${arrow} ${sign}${changeRatio}%`;
}

function formatNetBuy(value) {
  if (value === null || value === undefined) return null;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toLocaleString()}주`;
}

function renderNewsList(news) {
  if (!news || !news.length) {
    return '<p class="valuation-meta">관련 뉴스가 없습니다.</p>';
  }

  const items = news
    .map(
      (n) => `
        <li class="report-item">
          <a class="report-title" href="${n.link}" target="_blank" rel="noopener noreferrer">${n.title}</a>
          <div class="report-meta"><span>${n.office}</span></div>
        </li>
      `
    )
    .join('');

  return `<ul class="report-list">${items}</ul>`;
}

// "20260914" -> "9/14". 장마감 전이거나 휴장일 다음날엔 dealTrend가 어제 날짜일
// 수 있어서, "오늘"이라 단정하지 않고 실제 날짜를 그대로 보여준다.
function formatBizdate(bizdate) {
  if (!bizdate || bizdate.length !== 8) return '';
  const m = Number(bizdate.slice(4, 6));
  const d = Number(bizdate.slice(6, 8));
  return `${m}/${d}`;
}

function renderDetail(item) {
  const deal = item.dealTrend;
  const foreignLabel = deal ? formatNetBuy(deal.foreignerNetBuy) : null;
  const institutionLabel = deal ? formatNetBuy(deal.institutionNetBuy) : null;
  const dateLabel = deal ? formatBizdate(deal.date) : '';

  const dealBlock = `
    <div class="valuation-block">
      <p class="valuation-block-title">${dateLabel ? `${dateLabel} 수급` : '수급'} (외국인·기관 순매수)</p>
      <p class="valuation-meta">
        ${foreignLabel ? `외국인 ${foreignLabel}` : '외국인 데이터 없음'} ·
        ${institutionLabel ? `기관 ${institutionLabel}` : '기관 데이터 없음'}
      </p>
    </div>
  `;

  const newsBlock = `
    <div class="valuation-block">
      <p class="valuation-block-title">관련 뉴스</p>
      ${renderNewsList(item.news)}
    </div>
  `;

  return dealBlock + newsBlock;
}

function renderList(items) {
  listEl.innerHTML = '';

  if (!items.length) {
    listEl.innerHTML = '<li class="calendar-empty">표시할 종목이 없습니다.</li>';
    return;
  }

  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = `screener-item ${DIRECTION_CLASS[item.direction] || 'flat'}`;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'screener-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = `
      <div class="screener-item-top">
        <span class="screener-name">${item.name}</span>
        <span class="screener-market">${item.market}</span>
        <span class="screener-cap">거래대금 ${formatWon(item.tradingValue)}</span>
      </div>
      <div class="screener-item-bottom">
        <span class="screener-price">${item.currentPrice.toLocaleString()}원</span>
        <span class="screener-badge">${formatChangeRatio(item.direction, item.changeRatio)}</span>
      </div>
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

function formatUpdatedAt(iso) {
  if (!iso) return '데이터를 불러오지 못했습니다.';
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `마지막 갱신: ${hh}:${mm}`;
}

async function loadTradingValue() {
  try {
    const res = await fetch('/api/trading-value');
    if (!res.ok) throw new Error('요청 실패');
    const data = await res.json();
    updatedEl.textContent = formatUpdatedAt(data.updatedAt);
    renderList(data.items || []);
  } catch (err) {
    updatedEl.textContent = '데이터를 불러오지 못했습니다.';
    listEl.innerHTML = '<li class="calendar-empty">거래대금상위 데이터를 불러오지 못했습니다.</li>';
  }
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  setTimeout(() => overlay.remove(), 600);
}

const minDisplayTime = new Promise((resolve) => setTimeout(resolve, 1500));
Promise.all([loadTradingValue(), minDisplayTime]).finally(hideLoadingOverlay);
