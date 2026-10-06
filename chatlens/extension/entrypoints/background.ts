// The coordinator. In Phase 0 it only makes the toolbar icon open the side
// panel. On any tab other than WhatsApp Web, the panel shows "Open WhatsApp Web".
// It never touches WhatsApp (rule S2). Licence checks arrive in Phase 4.

export default defineBackground(() => {
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
