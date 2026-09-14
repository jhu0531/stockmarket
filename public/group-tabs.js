const STORAGE_KEY = 'watchlistActiveGroup';

export function getActiveGroup() {
  const saved = Number(localStorage.getItem(STORAGE_KEY));
  return saved >= 1 && saved <= 5 ? saved : 1;
}

export function setActiveGroup(group) {
  localStorage.setItem(STORAGE_KEY, String(group));
}

// Renders the 1~5 group tab buttons into containerEl and wires up click
// handling. onSelect(group) is called whenever the active group changes,
// including once synchronously on first render so callers can do their
// initial filtered render without a separate call.
export function renderGroupTabs(containerEl, onSelect) {
  containerEl.innerHTML = '';

  for (let group = 1; group <= 5; group += 1) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'group-tab';
    btn.textContent = String(group);
    if (group === getActiveGroup()) btn.classList.add('active');

    btn.addEventListener('click', () => {
      setActiveGroup(group);
      containerEl.querySelectorAll('.group-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      onSelect(group);
    });

    containerEl.appendChild(btn);
  }

  onSelect(getActiveGroup());
}
