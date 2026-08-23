/* ═══════════════════════════════════════════════════════════════════════════
   Router.

   The previous `showView` called `scrollIntoView` and set a hash, and the CSS
   rule meant to hide the other views (`.view.focused { }`) was empty. Every
   section was therefore visible at once: the sidebar was decoration over a
   single infinite-scroll page, which is why a refusal notice on the approval
   panel read as a stray line of text nine sections down.
   ═══════════════════════════════════════════════════════════════════════════ */

import { VIEWS } from './store.mjs';

const views = document.querySelectorAll('.view[data-view]');
const navItems = document.querySelectorAll('.nav-item[data-view]');

export function renderView(state, reach) {
  const active = VIEWS.includes(state.view) ? state.view : 'project';
  for (const view of views) view.hidden = view.dataset.view !== active;
  for (const item of navItems) {
    const name = item.dataset.view;
    const status = reach[name] || { reachable: true };
    item.classList.toggle('active', name === active);
    item.classList.toggle('locked', !status.reachable);
    item.setAttribute('aria-current', name === active ? 'page' : 'false');
    /* A step you cannot take yet should say why. Silence reads as a bug. */
    if (status.reachable) item.removeAttribute('title');
    else item.title = status.reason;
    item.dataset.reachable = String(status.reachable);
  }
  if (window.location.hash.slice(1) !== active) {
    history.replaceState(null, '', `#${active}`);
  }
}

export function initRouter(onNavigate) {
  for (const item of navItems) {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      onNavigate(item.dataset.view);
    });
  }
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.slice(1);
    if (VIEWS.includes(hash)) onNavigate(hash);
  });
  const initial = window.location.hash.slice(1);
  return VIEWS.includes(initial) ? initial : 'project';
}
