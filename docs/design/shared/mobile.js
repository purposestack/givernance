/**
 * Givernance — Mobile Sidebar Toggle
 */
(function () {
  if (typeof window === 'undefined') return;

  var overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  document.body.appendChild(overlay);

  var hamburger = document.createElement('button');
  hamburger.className = 'topbar-hamburger';
  hamburger.setAttribute('aria-label', 'Ouvrir le menu');
  hamburger.setAttribute('type', 'button');
  hamburger.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';

  var topbar = document.querySelector('.topbar');
  if (topbar) {
    topbar.insertBefore(hamburger, topbar.firstChild);
  }

  var sidebar = document.querySelector('.sidebar');

  function openSidebar() {
    if (!sidebar) return;
    sidebar.classList.add('is-open');
    overlay.classList.add('is-visible');
    document.body.style.overflow = 'hidden';
    hamburger.setAttribute('aria-label', 'Fermer le menu');
  }

  function closeSidebar() {
    if (!sidebar) return;
    sidebar.classList.remove('is-open');
    overlay.classList.remove('is-visible');
    document.body.style.overflow = '';
    hamburger.setAttribute('aria-label', 'Ouvrir le menu');
  }

  hamburger.addEventListener('click', function () {
    if (sidebar && sidebar.classList.contains('is-open')) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  overlay.addEventListener('click', closeSidebar);

  if (sidebar) {
    var navLinks = sidebar.querySelectorAll('a, .nav-item');
    navLinks.forEach(function (link) {
      link.addEventListener('click', function () {
        setTimeout(closeSidebar, 100);
      });
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSidebar();
  });
})();
