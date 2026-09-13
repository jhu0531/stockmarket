document.addEventListener('DOMContentLoaded', () => {
  const menuBtn = document.getElementById('mobile-menu-btn');
  const drawer = document.getElementById('mobile-menu-drawer');
  if (!menuBtn || !drawer) return;

  menuBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    drawer.hidden = !drawer.hidden;
  });

  document.addEventListener('click', (event) => {
    if (!drawer.hidden && !drawer.contains(event.target) && event.target !== menuBtn) {
      drawer.hidden = true;
    }
  });
});
