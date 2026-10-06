import tseslint from 'typescript-eslint';
import noSend from './lint-rules/no-send.js';

export default tseslint.config(
  { ignores: ['.output/**', '.wxt/**', 'node_modules/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    plugins: { chatlens: noSend },
    rules: {
      'chatlens/no-send': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // These files define or test the forbidden list itself, or drive the panel as a user would.
    files: ['lint-rules/**', 'scripts/**', 'tests/no-send.test.ts', 'tests/e2e/**'],
    rules: { 'chatlens/no-send': 'off' },
  },
  {
    // Only the adapter may touch WhatsApp internals.
    files: ['**/*.{ts,tsx}'],
    ignores: ['adapter/**', 'entrypoints/page-reader.content.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='require'] Literal[value=/^WAWeb/]",
          message: 'Only extension/adapter/ may touch WhatsApp internals.',
        },
      ],
      'no-restricted-imports': ['error', { patterns: [{ regex: '(^|/)adapter/(?!index$|polls$)', message: 'Import the adapter only through adapter/index.' }] }],
    },
  },
);
