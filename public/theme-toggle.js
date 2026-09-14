function getCurrentTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
}

document.addEventListener('DOMContentLoaded', () => {
  const themeSwitch = document.getElementById('theme-switch');
  if (!themeSwitch) return;

  themeSwitch.checked = getCurrentTheme() === 'dark';
  themeSwitch.addEventListener('change', () => {
    applyTheme(themeSwitch.checked ? 'dark' : 'light');
  });
});
