// Proves the S1 code check catches every way of sending we know about.
import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import noSend from '../lint-rules/no-send.js';

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } }).run('no-send', noSend.rules['no-send'], {
  valid: [
    'chrome.runtime.sendMessage({ type: "x" })',
    'window.postMessage({}, "https://web.whatsapp.com")',
    'el.addEventListener("click", f)',
    'const t = "Send reminder"',
  ],
  invalid: [
    { code: 'mod.sendTextMsgToChat(chat, "hi")', errors: [{ messageId: 'name' }] },
    { code: 'addAndSendMsgToChat(chat, msg)', errors: [{ messageId: 'name' }] },
    { code: 'require("WAWebSendMsgChatAction")', errors: [{ messageId: 'string' }] },
    { code: 'mod["sendMsgRecord"](x)', errors: [{ messageId: 'name' }] },
    { code: 'document.querySelector(\'span[data-icon="send"]\')', errors: [{ messageId: 'string' }] },
    { code: 'box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))', errors: [{ messageId: 'keyboard' }, { messageId: 'enter' }] },
    { code: 'button.click()', errors: [{ messageId: 'click' }] },
  ],
});
