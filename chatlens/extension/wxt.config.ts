import { defineConfig } from 'wxt';

// Rule P3: minimum permissions. Only the side panel and WhatsApp Web.
// Phase 0 needs no storage and no licence server yet.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  // No module-preload helper: it is the only network call (to the extension's
  // own files) a bundler would add, and rule P2 keeps the network check strict.
  vite: () => ({ build: { modulePreload: { polyfill: false } } }),
  manifest: {
    name: 'ChatLens Poll Checker (test build)',
    short_name: 'ChatLens',
    description:
      'See who has voted and who has not in a WhatsApp Web group poll. Reads only, never sends anything. Not affiliated with WhatsApp or Meta.',
    permissions: ['sidePanel'],
    host_permissions: ['https://web.whatsapp.com/*'],
    action: { default_title: 'Open Poll Checker' },
  },
});
