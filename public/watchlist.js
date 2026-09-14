import { watchAuthState, loginWithGoogle, logout, getIdToken } from './firebase-init.js';
import { getActiveGroup, renderGroupTabs } from './group-tabs.js';

const authStatusEl = document.getElementById('auth-status');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const contentEl = document.getElementById('watchlist-content');
const loginRequiredEl = document.getElementById('watchlist-login-required');
const searchInput = document.getElementById('stock-search-input');
const searchResultsEl = document.getElementById('search-results');
const listEl = document.getElementById('watchlist-list');
const groupTabsEl = document.getElementById('group-tabs');

const DIRECTION_CLASS = { RISING: 'up', FALLING: 'down', EVEN: 'flat' };

let allItems = [];

loginBtn.addEventListener('click', () => {
  loginWithGoogle().catch((err) => alert('로그인에 실패했습니다: ' + err.message));
});

logoutBtn.addEventListener('click', () => {
  logout();
});

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  setTimeout(() => overlay.remove(), 600);
}

const initialAuth = new Promise((resolveInitialAuth) => {
  watchAuthState((user) => {
    if (user) {
      authStatusEl.textContent = `${user.displayName || user.email}님으로 로그인됨`;
      loginBtn.hidden = true;
      logoutBtn.hidden = false;
      contentEl.hidden = false;
      loginRequiredEl.hidden = true;
      loadWatchlist();
    } else {
      authStatusEl.textContent = '로그인이 필요합니다.';
      loginBtn.hidden = false;
      logoutBtn.hidden = true;
      contentEl.hidden = true;
      loginRequiredEl.hidden = false;
    }
    resolveInitialAuth();
  });
});

let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (!query) {
    searchResultsEl.hidden = true;
    searchResultsEl.innerHTML = '';
    return;
  }
  searchTimer = setTimeout(() => runSearch(query), 300);
});

async function runSearch(query) {
  try {
    const res = await fetch(`/api/stock-search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    renderSearchResults(data.results || []);
  } catch (err) {
    searchResultsEl.hidden = true;
  }
}

function renderSearchResults(results) {
  searchResultsEl.innerHTML = '';
  if (!results.length) {
    searchResultsEl.hidden = true;
    return;
  }
  results.slice(0, 8).forEach((item) => {
    const li = document.createElement('li');
    li.textContent = `${item.name} (${item.market})`;
    li.addEventListener('click', () => addStock(item.code, item.name));
    searchResultsEl.appendChild(li);
  });
  searchResultsEl.hidden = false;
}

async function addStock(code, name) {
  const token = await getIdToken();
  await fetch('/api/watchlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ code, name, group: getActiveGroup() }),
  });
  searchInput.value = '';
  searchResultsEl.hidden = true;
  searchResultsEl.innerHTML = '';
  loadWatchlist();
}

async function removeStock(code) {
  const token = await getIdToken();
  await fetch(`/api/watchlist/${code}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  loadWatchlist();
}

async function loadWatchlist() {
  const token = await getIdToken();
  try {
    const res = await fetch('/api/watchlist', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('요청 실패');
    const data = await res.json();
    allItems = data.items || [];
    renderGroupTabs(groupTabsEl, (group) => {
      renderWatchlist(allItems.filter((item) => (item.group || 1) === group));
    });
  } catch (err) {
    listEl.innerHTML = '<li class="calendar-empty">관심종목을 불러오지 못했습니다.</li>';
  }
}

function renderWatchlist(items) {
  listEl.innerHTML = '';
  if (!items.length) {
    listEl.innerHTML = '<li class="calendar-empty">이 그룹에 추가된 종목이 없습니다. 위에서 검색해 추가해보세요.</li>';
    return;
  }

  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = `watchlist-item ${DIRECTION_CLASS[item.direction] || 'flat'}`;

    const name = document.createElement('span');
    name.className = 'watchlist-name';
    name.textContent = item.name || item.code;

    const price = document.createElement('span');
    price.className = 'watchlist-price';
    if (item.error || item.currentPrice === null || item.currentPrice === undefined) {
      price.textContent = '데이터 없음';
    } else {
      const arrow = item.direction === 'RISING' ? '▲' : item.direction === 'FALLING' ? '▼' : '-';
      price.textContent = `${item.currentPrice.toLocaleString()} ${arrow} ${item.changeRatio}%`;
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'watchlist-remove';
    removeBtn.textContent = '삭제';
    removeBtn.addEventListener('click', () => removeStock(item.code));

    li.appendChild(name);
    li.appendChild(price);
    li.appendChild(removeBtn);
    listEl.appendChild(li);
  });
}

const minDisplayTime = new Promise((resolve) => setTimeout(resolve, 1500));
Promise.all([initialAuth, minDisplayTime]).finally(hideLoadingOverlay);
