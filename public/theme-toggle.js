function getCurrentTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateToggleIcons(theme) {
  const icon = theme === 'dark' ? '☀️' : '🌙';
  document.querySelectorAll('.theme-toggle-icon').forEach((el) => {
    el.textContent = icon;
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  updateToggleIcons(theme);
}

document.addEventListener('DOMContentLoaded', () => {
  updateToggleIcons(getCurrentTheme());

  document.querySelectorAll('.theme-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyTheme(getCurrentTheme() === 'dark' ? 'light' : 'dark');
    });
  });
});
