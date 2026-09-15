import { watchAuthState, loginWithGoogle, logout, getIdToken } from './firebase-init.js';

const listEl = document.getElementById('tradingvalue-list');
const updatedEl = document.getElementById('tradingvalue-updated');
const sortBtnEls = document.querySelectorAll('.sort-btn');
const authStatusEl = document.getElementById('auth-status');
const loginBtnEl = document.getElementById('login-btn');
const logoutBtnEl = document.getElementById('logout-btn');

let currentUser = null;
let watchlistCodes = new Set();

loginBtnEl.addEventListener('click', () => {
  loginWithGoogle().catch((err) => alert('로그인에 실패했습니다: ' + err.message));
});

logoutBtnEl.addEventListener('click', () => {
  logout();
});

async function loadWatchlistCodes() {
  try {
    const token = await getIdToken();
    const res = await fetch('/api/watchlist/codes', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('요청 실패');
    const data = await res.json();
    watchlistCodes = new Set(data.codes || []);
  } catch (err) {
    watchlistCodes = new Set();
  }
}

async function addToWatchlist(item, button) {
  if (!currentUser) {
    if (confirm('관심종목에 추가하려면 로그인이 필요합니다. 로그인할까요?')) {
      loginWithGoogle().catch((err) => alert('로그인에 실패했습니다: ' + err.message));
    }
    return;
  }

  if (watchlistCodes.has(item.code)) {
    alert('이미 관심종목에 있는 종목입니다.');
    return;
  }

  button.disabled = true;
  try {
    const token = await getIdToken();
    await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: item.code, name: item.name, group: 1 }),
    });
    watchlistCodes.add(item.code);
    button.textContent = '추가됨';
  } catch (err) {
    button.disabled = false;
    alert('관심종목 추가에 실패했습니다.');
  }
}

const initialAuth = new Promise((resolveInitialAuth) => {
  watchAuthState(async (user) => {
    currentUser = user;
    if (user) {
      authStatusEl.textContent = `${user.displayName || user.email}님으로 로그인됨`;
      loginBtnEl.hidden = true;
      logoutBtnEl.hidden = false;
      await loadWatchlistCodes();
    } else {
      authStatusEl.textContent = '로그인하면 관심종목에 바로 추가할 수 있습니다.';
      loginBtnEl.hidden = false;
      logoutBtnEl.hidden = true;
      watchlistCodes = new Set();
    }
    if (allItems.length) applySort();
    resolveInitialAuth();
  });
});

// 네이버 API는 상한가/하한가를 RISING/FALLING이 아니라 별도 코드
// (UPPER_LIMIT/LOWER_LIMIT)로 내려주므로 같이 up/down 취급해야 한다.
const DIRECTION_CLASS = { RISING: 'up', UPPER_LIMIT: 'up', FALLING: 'down', LOWER_LIMIT: 'down', EVEN: 'flat' };
const UP_DIRECTIONS = new Set(['RISING', 'UPPER_LIMIT']);
const DOWN_DIRECTIONS = new Set(['FALLING', 'LOWER_LIMIT']);

let allItems = [];
let sortField = 'tradingValue';
let sortDirection = 'desc';

// FALLING의 fluctuationsRatio 문자열엔 "-"가 붙어있지만, 하한가(LOWER_LIMIT)는
// RISING과 마찬가지로 부호 없이 절대값만 내려주므로 direction 기준으로 부호를
// 다시 매긴다 (안 그러면 하한가 종목이 등락률 정렬에서 급등주로 취급됨).
function signedChangeRatio(item) {
  const magnitude = Math.abs(Number(item.changeRatio));
  if (DOWN_DIRECTIONS.has(item.direction)) return -magnitude;
  if (UP_DIRECTIONS.has(item.direction)) return magnitude;
  return 0;
}

function sortValue(item, field) {
  if (field === 'changeRatio') return signedChangeRatio(item);
  if (field === 'sector') return item.sector ? item.sector.changeRate : 0;
  return item.tradingValue;
}

function applySort() {
  const sorted = [...allItems].sort((a, b) => {
    const diff = sortValue(b, sortField) - sortValue(a, sortField);
    return sortDirection === 'desc' ? diff : -diff;
  });

  sortBtnEls.forEach((btn) => {
    const isActive = btn.dataset.sort === sortField;
    btn.classList.toggle('active', isActive);
    btn.querySelector('.sort-icon').textContent = isActive ? (sortDirection === 'desc' ? '▼' : '▲') : '▼';
  });

  renderList(sorted);
}

sortBtnEls.forEach((btn) => {
  btn.addEventListener('click', () => {
    const field = btn.dataset.sort;
    if (field === sortField) {
      sortDirection = sortDirection === 'desc' ? 'asc' : 'desc';
    } else {
      sortField = field;
      sortDirection = 'desc';
    }
    applySort();
  });
});

function formatWon(value) {
  if (value === null || value === undefined) return '-';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(1)}조원`;
  if (abs >= 1e8) return `${(value / 1e8).toFixed(1)}억원`;
  return `${value.toLocaleString()}원`;
}

function formatChangeRatio(direction, changeRatio) {
  const isUp = UP_DIRECTIONS.has(direction);
  const isDown = DOWN_DIRECTIONS.has(direction);
  const sign = isUp ? '+' : '';
  const arrow = isUp ? '▲' : isDown ? '▼' : '-';
  return `${arrow} ${sign}${changeRatio}%`;
}

function formatSector(sector) {
  if (!sector) return '';
  const sign = sector.changeRate > 0 ? '+' : '';
  const cls = sector.changeRate > 0 ? 'up' : sector.changeRate < 0 ? 'down' : 'flat';
  return `${sector.name} <span class="screener-sector-rate ${cls}">${sign}${sector.changeRate.toFixed(1)}%</span>`;
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
        ${item.sector ? `<span class="screener-sub">${formatSector(item.sector)}</span>` : ''}
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

    const actions = document.createElement('div');
    actions.className = 'screener-actions';

    const watchBtn = document.createElement('button');
    watchBtn.type = 'button';
    watchBtn.className = 'screener-watch-btn';
    watchBtn.textContent = '+ 관심종목';
    watchBtn.addEventListener('click', () => addToWatchlist(item, watchBtn));
    actions.appendChild(watchBtn);

    li.appendChild(toggle);
    li.appendChild(actions);
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
    allItems = data.items || [];
    applySort();
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
Promise.all([loadTradingValue(), initialAuth, minDisplayTime]).finally(hideLoadingOverlay);
