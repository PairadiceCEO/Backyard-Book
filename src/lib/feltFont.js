// The craps felt is lettered in Oswald (uppercase, 500–700). It is loaded from Google Fonts the first time a craps table
// opens, not for the whole app: two preconnects and one stylesheet (display=swap, so the lettering shows at once in the
// fallback font and swaps when Oswald arrives). The links stay in <head> afterwards (the browser caches the font), and
// asking again adds nothing.

export const FELT_FONT_HREF = 'https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&display=swap';

export function ensureFeltFont() {
  if (typeof document === 'undefined' || document.head.querySelector('link[data-felt-font]')) return;
  const add = (attrs) => {
    const link = document.createElement('link');
    for (const [name, value] of Object.entries(attrs)) link.setAttribute(name, value);
    link.setAttribute('data-felt-font', '');
    document.head.appendChild(link);
  };
  add({ rel: 'preconnect', href: 'https://fonts.googleapis.com' });
  add({ rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' });
  add({ rel: 'stylesheet', href: FELT_FONT_HREF });
}
