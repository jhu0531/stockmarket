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
const editToggleBtn = document.getElementById('watchlist-edit-toggle');
const editBarEl = document.getElementById('watchlist-edit-bar');
const selectAllEl = document.getElementById('watchlist-select-all');
const selectedCountEl = document.getElementById('watchlist-selected-count');
const bulkMoveSelect = document.getElementById('watchlist-bulk-move');
const bulkRemoveBtn = document.getElementById('watchlist-bulk-remove');

const DIRECTION_CLASS = { RISING: 'up', FALLING: 'down', EVEN: 'flat' };

let allItems = [];
let visibleItems = [];
let editMode = false;
const selectedCodes = new Set();

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

// ▲▼를 연달아 눌러도 요청은 마지막 순서로 한 번만 보내도록 잠시 모았다가 저장한다.
const ORDER_SAVE_DELAY = 800;
let orderSaveTimer = null;
let pendingOrderCodes = null;

function scheduleOrderSave(codes) {
  pendingOrderCodes = codes;
  clearTimeout(orderSaveTimer);
  orderSaveTimer = setTimeout(flushOrderSave, ORDER_SAVE_DELAY);
}

async function flushOrderSave() {
  clearTimeout(orderSaveTimer);
  if (!pendingOrderCodes) return;
  const codes = pendingOrderCodes;
  pendingOrderCodes = null;
  try {
    const token = await getIdToken();
    const res = await fetch('/api/watchlist/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ codes }),
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch (err) {
    alert('순서를 저장하지 못했습니다. 잠시 후 다시 시도해주세요.');
    loadWatchlist();
  }
}

// 페이지를 떠나기 직전에 아직 안 보낸 순서가 있으면 마저 보낸다.
window.addEventListener('pagehide', () => {
  if (pendingOrderCodes) flushOrderSave();
});

function moveItem(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= visibleItems.length) return;
  const reordered = [...visibleItems];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  visibleItems = reordered;
  // 그룹 탭을 오가도 바뀐 순서가 유지되도록 allItems에도 반영한다.
  const inGroup = new Set(visibleItems.map((item) => item.code));
  allItems = allItems.filter((item) => !inGroup.has(item.code)).concat(visibleItems);
  scheduleOrderSave(visibleItems.map((item) => item.code));
  renderWatchlist(visibleItems);
  // 다시 그려진 뒤에도 같은 종목의 같은 버튼에 포커스를 둬서 연속으로 누를 수 있게.
  const movedRow = listEl.children[target];
  const btn = movedRow && movedRow.querySelector(delta < 0 ? '.watchlist-up' : '.watchlist-down');
  if (btn && !btn.disabled) btn.focus();
}

// 선택된 종목들에 같은 요청을 병렬로 보내고, 끝나면 목록을 한 번만 다시 불러온다.
async function applyToCodes(codes, buildRequest) {
  await flushOrderSave();
  const token = await getIdToken();
  const results = await Promise.allSettled(
    codes.map((code) =>
      fetch(`/api/watchlist/${code}`, buildRequest(token)).then((res) => {
        if (!res.ok) throw new Error(String(res.status));
      })
    )
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed) alert(`${codes.length}개 중 ${failed}개 종목 처리에 실패했습니다.`);
  await loadWatchlist();
}

function removeStocks(codes) {
  return applyToCodes(codes, (token) => ({
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }));
}

function moveStocks(codes, group) {
  return applyToCodes(codes, (token) => ({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ group }),
  }));
}

function setEditMode(on) {
  if (!on) flushOrderSave();
  editMode = on;
  selectedCodes.clear();
  editToggleBtn.setAttribute('aria-pressed', String(on));
  editToggleBtn.title = on ? '편집 완료' : '관심종목 편집';
  editBarEl.hidden = !on;
  renderWatchlist(visibleItems);
}

function updateEditBar() {
  const count = selectedCodes.size;
  selectedCountEl.textContent = `${count}개 선택`;
  selectAllEl.checked = visibleItems.length > 0 && count === visibleItems.length;
  selectAllEl.indeterminate = count > 0 && count < visibleItems.length;
  selectAllEl.disabled = visibleItems.length === 0;
  bulkMoveSelect.disabled = count === 0;
  bulkRemoveBtn.disabled = count === 0;
}

// 일괄 작업 중에는 편집 바를 잠가 중복 요청을 막는다.
async function runBulk(task) {
  editBarEl.classList.add('busy');
  try {
    await task();
  } finally {
    editBarEl.classList.remove('busy');
  }
}

editToggleBtn.addEventListener('click', () => setEditMode(!editMode));

selectAllEl.addEventListener('change', () => {
  selectedCodes.clear();
  if (selectAllEl.checked) visibleItems.forEach((item) => selectedCodes.add(item.code));
  renderWatchlist(visibleItems);
});

bulkMoveSelect.addEventListener('change', () => {
  const group = Number(bulkMoveSelect.value);
  bulkMoveSelect.value = '';
  if (!group || !selectedCodes.size) return;
  runBulk(() => moveStocks([...selectedCodes], group));
});

bulkRemoveBtn.addEventListener('click', () => {
  if (!selectedCodes.size) return;
  const codes = [...selectedCodes];
  if (!confirm(`선택한 ${codes.length}개 종목을 관심종목에서 삭제할까요?`)) return;
  runBulk(() => removeStocks(codes));
});

async function loadWatchlist() {
  const token = await getIdToken();
  try {
    const res = await fetch('/api/watchlist', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('요청 실패');
    const data = await res.json();
    allItems = data.items || [];
    renderGroupTabs(groupTabsEl, (group) => {
      selectedCodes.clear();
      visibleItems = allItems.filter((item) => (item.group || 1) === group);
      renderWatchlist(visibleItems);
    });
  } catch (err) {
    listEl.innerHTML = '<li class="calendar-empty">관심종목을 불러오지 못했습니다.</li>';
  }
}

function renderWatchlist(items) {
  listEl.innerHTML = '';
  listEl.classList.toggle('editing', editMode);
  if (editMode) updateEditBar();
  if (!items.length) {
    listEl.innerHTML = '<li class="calendar-empty">이 그룹에 추가된 종목이 없습니다. 위에서 검색해 추가해보세요.</li>';
    return;
  }

  items.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = `watchlist-item ${DIRECTION_CLASS[item.direction] || 'flat'}`;

    if (editMode) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'watchlist-check';
      checkbox.checked = selectedCodes.has(item.code);
      checkbox.setAttribute('aria-label', `${item.name || item.code} 선택`);
      li.classList.toggle('selected', checkbox.checked);

      const sync = () => {
        if (checkbox.checked) selectedCodes.add(item.code);
        else selectedCodes.delete(item.code);
        li.classList.toggle('selected', checkbox.checked);
        updateEditBar();
      };
      checkbox.addEventListener('change', sync);
      // 편집 중에는 행 아무 곳이나 눌러도 선택이 토글되도록.
      li.addEventListener('click', (e) => {
        if (e.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        sync();
      });
      li.appendChild(checkbox);
    }

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

    li.appendChild(name);
    li.appendChild(price);

    if (editMode) {
      const reorder = document.createElement('span');
      reorder.className = 'watchlist-reorder';
      [['watchlist-up', '▲', '위로', -1], ['watchlist-down', '▼', '아래로', 1]].forEach(([cls, label, verb, delta]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = cls;
        btn.textContent = label;
        btn.setAttribute('aria-label', `${item.name || item.code} ${verb} 이동`);
        btn.disabled = delta < 0 ? index === 0 : index === items.length - 1;
        btn.addEventListener('click', (e) => {
          e.stopPropagation(); // 행 클릭(선택 토글)으로 번지지 않게
          moveItem(index, delta);
        });
        reorder.appendChild(btn);
      });
      li.appendChild(reorder);
    }

    listEl.appendChild(li);
  });
}

const minDisplayTime = new Promise((resolve) => setTimeout(resolve, 1500));
Promise.all([initialAuth, minDisplayTime]).finally(hideLoadingOverlay);
