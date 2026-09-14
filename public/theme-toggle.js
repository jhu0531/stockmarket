function getCurrentTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#14161a' : '#f5f6f8');
}

document.addEventListener('DOMContentLoaded', () => {
  const themeSwitch = document.getElementById('theme-switch');
  if (!themeSwitch) return;

  themeSwitch.checked = getCurrentTheme() === 'dark';
  themeSwitch.addEventListener('change', () => {
    applyTheme(themeSwitch.checked ? 'dark' : 'light');
  });
});
