import type { Rule } from 'eslint';
export const FORBIDDEN_NAMES: string[];
export const FORBIDDEN_STRINGS: string[];
declare const plugin: { rules: { 'no-send': Rule.RuleModule } };
export default plugin;
