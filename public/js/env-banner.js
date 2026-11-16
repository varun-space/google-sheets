// Shows a "PREVIEW" bar on every page that is NOT the production URL (sheets-work.<sub>.workers.dev),
// so nobody mistakes a local or preview build for the real app. Loaded by every page, including /login.
(function () {
  const host = location.hostname;
  if (host.startsWith('sheets-work.')) return; // production: no banner
  const label = host === 'localhost' || host === '127.0.0.1' ? 'LOCAL DEV' : 'PREVIEW';
  const bar = document.createElement('div');
  bar.className = 'env-banner';
  bar.textContent = `🧪 ${label} build: test version, not the live app · ${host}`;
  const add = () => {
    document.body.prepend(bar);
    // common.js prepends the header later; keep the bar above it.
    new MutationObserver(() => { if (document.body.firstChild !== bar) document.body.prepend(bar); })
      .observe(document.body, { childList: true });
  };
  document.body ? add() : document.addEventListener('DOMContentLoaded', add);
})();
