'use strict';
// Scripts and styles from the `extras` folder in settings.json, loaded last and in order.

for (const href of cfg.extras?.css || []) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}
for (const src of cfg.extras?.js || []) {
  const script = document.createElement('script');
  script.src = src;
  script.async = false;
  script.onerror = () => r7.log('warn', 'extras.load', { session: cfg.session, src });
  document.body.appendChild(script);
}
