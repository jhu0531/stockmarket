import { watchAuthState, loginWithGoogle, logout, getIdToken } from './firebase-init.js';
import { renderGroupTabs } from './group-tabs.js';

const authStatusEl = document.getElementById('auth-status');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const contentEl = document.getElementById('valuation-content');
const loginRequiredEl = document.getElementById('valuation-login-required');
const listEl = document.getElementById('valuation-list');
const groupTabsEl = document.getElementById('group-tabs');

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
      loadValuations();
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

async function loadValuations() {
  const token = await getIdToken();
  try {
    const res = await fetch('/api/watchlist', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('요청 실패');
    const data = await res.json();
    allItems = data.items || [];
    renderGroupTabs(groupTabsEl, (group) => {
      renderValuations(allItems.filter((item) => (item.group || 1) === group));
    });
  } catch (err) {
    listEl.innerHTML = '<li class="calendar-empty">적정주가를 불러오지 못했습니다.</li>';
  }
}

const VERDICT_LABEL = { UNDERVALUED: '저평가', OVERVALUED: '고평가', FAIR: '적정' };
const VERDICT_CLASS = { UNDERVALUED: 'up', OVERVALUED: 'down', FAIR: 'flat' };

function renderValuations(items) {
  listEl.innerHTML = '';

  if (!items.length) {
    listEl.innerHTML =
      '<li class="calendar-empty">이 그룹에 추가된 종목이 없습니다. <a href="/watchlist.html">관심종목</a>에서 추가해주세요.</li>';
    return;
  }

  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'valuation-item';

    if (item.error || !item.fairValue || !item.fairValue.confirmed) {
      li.innerHTML = `
        <div class="valuation-item-empty">
          <p class="valuation-toggle-name">${item.name || item.code}</p>
          <p class="valuation-empty">적정주가를 계산할 데이터가 없습니다 (적자기업이거나 실적 데이터 없음).</p>
        </div>
      `;
      listEl.appendChild(li);
      return;
    }

    const primary = item.fairValue.confirmed;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'valuation-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = `
      <span class="valuation-toggle-name">${item.name || item.code}</span>
      <span class="valuation-toggle-price">${item.currentPrice !== null ? item.currentPrice.toLocaleString() + '원' : '-'}</span>
      <span class="valuation-toggle-fair">→ ${primary.fairValue.toLocaleString()}원</span>
      ${primary.verdict ? `<span class="valuation-badge ${VERDICT_CLASS[primary.verdict]}">${VERDICT_LABEL[primary.verdict]} (${primary.gapRatio > 0 ? '+' : ''}${primary.gapRatio.toFixed(1)}%)</span>` : ''}
    `;

    const detail = document.createElement('div');
    detail.className = 'valuation-detail';
    detail.hidden = true;
    detail.appendChild(renderFairValueBlock('확정 실적(TTM) 기준', primary));
    if (item.fairValue.consensus) {
      detail.appendChild(renderFairValueBlock('컨센서스(추정) 기준', item.fairValue.consensus));
    }

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

function renderFairValueBlock(title, fv) {
  const block = document.createElement('div');
  block.className = 'valuation-block';

  const heading = document.createElement('p');
  heading.className = 'valuation-block-title';
  heading.textContent = title;
  block.appendChild(heading);

  const row = document.createElement('div');
  row.className = 'valuation-row';
  row.innerHTML = `<span class="valuation-label">적정주가</span><span class="valuation-value">${fv.fairValue.toLocaleString()}원</span>`;
  block.appendChild(row);

  if (fv.verdict) {
    const badge = document.createElement('span');
    badge.className = `valuation-badge ${VERDICT_CLASS[fv.verdict]}`;
    const sign = fv.gapRatio > 0 ? '+' : '';
    badge.textContent = `${VERDICT_LABEL[fv.verdict]} (${sign}${fv.gapRatio.toFixed(1)}%)`;
    block.appendChild(badge);
  }

  const meta = document.createElement('p');
  meta.className = 'valuation-meta';
  meta.textContent = `${fv.period} 기준 · EPS ${fv.eps.toLocaleString()}원${
    fv.roe !== null ? ` · ROE ${fv.roe}%` : ''
  }${fv.bps !== null ? ` · BPS ${fv.bps.toLocaleString()}원` : ''}`;
  block.appendChild(meta);

  return block;
}

const minDisplayTime = new Promise((resolve) => setTimeout(resolve, 1500));
Promise.all([initialAuth, minDisplayTime]).finally(hideLoadingOverlay);
