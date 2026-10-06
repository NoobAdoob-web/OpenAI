// Rule S1, enforced by the code checker: no code may press Send, simulate the
// Enter key, or call any WhatsApp send function. A build that breaks this
// MUST NOT be released.

/** WhatsApp Web functions and modules that send things. */
export const FORBIDDEN_NAMES = [
  'sendTextMsgToChat',
  'addAndSendMsgToChat',
  'sendMsgRecord',
  'sendMsgToChat',
  'sendReactionToMsg',
  'forwardMessagesToChats',
  'sendPollVote',
  'sendVote',
  'createChatAndSendMsg',
];

/** Strings that point at WhatsApp's send machinery or its Send button. */
export const FORBIDDEN_STRINGS = ['WAWebSendMsg', 'WAWebSendTextMsg', 'data-icon="send"', "data-icon='send'", 'wds-ic-send'];

const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Never send a message, press Send or simulate Enter (PID rule S1).' },
    schema: [],
    messages: {
      name: 'Rule S1: "{{name}}" sends messages and must never be used.',
      string: 'Rule S1: this points at WhatsApp\'s send machinery or Send button.',
      keyboard: 'Rule S1: simulated keyboard events (which can press Enter) are not allowed.',
      enter: 'Rule S1: the Enter key must never be simulated.',
      click: 'Rule S1: programmatic clicks are not allowed (they could press Send).',
    },
  },
  create(context) {
    return {
      Identifier(node) {
        if (FORBIDDEN_NAMES.includes(node.name)) context.report({ node, messageId: 'name', data: { name: node.name } });
      },
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (FORBIDDEN_NAMES.includes(node.value)) context.report({ node, messageId: 'name', data: { name: node.value } });
        else if (FORBIDDEN_STRINGS.some((s) => node.value.includes(s))) context.report({ node, messageId: 'string' });
        else if (node.value === 'Enter' || node.value === 'NumpadEnter') context.report({ node, messageId: 'enter' });
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'KeyboardEvent') context.report({ node, messageId: 'keyboard' });
      },
      CallExpression(node) {
        const c = node.callee;
        if (c.type === 'MemberExpression' && !c.computed && c.property.name === 'click' && node.arguments.length === 0) {
          context.report({ node, messageId: 'click' });
        }
      },
    };
  },
};

export default { rules: { 'no-send': rule } };
