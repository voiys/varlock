import { ValidationError } from './errors';
import { matchesSettingToRegExp } from './regex-like-string';

/**
 * Declarative validation for a data type, so a tool that does not run plugin code (shape mode
 * reading a plugin manifest) can still check a value and give the same error the plugin would.
 *
 * Rules are checked in order and the first one that fails is the error, which is how plugin
 * validate() functions behave (they throw on the first failed check). Check names follow the
 * options of the `string` data type. Each rule carries its own message, so it can match the
 * message the plugin's validate() gives.
 *
 * A `custom` rule stands for a check that only exists in plugin code. It must be the last rule:
 * a static check stops there, and a value that passed every rule before it is still unchecked.
 */
export type ValidationRuleCheck = | { startsWith: string }
  | { endsWith: string }
  | { includes: string }
  | { minLength: number }
  | { maxLength: number }
  | { isLength: number }
  /** a regex-like string (`/pattern/flags`) or a bare pattern, read the same way as `string(matches=...)` */
  | { matches: string };

export type ValidationRule = | (ValidationRuleCheck & { message: string, tip?: string })
  | {
    /** what the check does, for people and tools reading the rules */
    custom: string,
    /** the error it gives, when it always gives the same one */
    message?: string,
    tip?: string,
  };

const isNonEmptyString = (val: unknown) => typeof val === 'string' && val.length > 0;
const isLength = (val: unknown) => Number.isInteger(val) && (val as number) >= 0;

type Check = {
  isArg: (val: unknown) => boolean,
  /** returns the test for a value, given the rule's (valid) arg */
  prepare: (arg: any) => (val: string) => boolean,
};
const CHECKS: Record<string, Check> = {
  startsWith: { isArg: isNonEmptyString, prepare: (arg: string) => (val) => val.startsWith(arg) },
  endsWith: { isArg: isNonEmptyString, prepare: (arg: string) => (val) => val.endsWith(arg) },
  includes: { isArg: isNonEmptyString, prepare: (arg: string) => (val) => val.includes(arg) },
  minLength: { isArg: isLength, prepare: (arg: number) => (val) => val.length >= arg },
  maxLength: { isArg: isLength, prepare: (arg: number) => (val) => val.length <= arg },
  isLength: { isArg: isLength, prepare: (arg: number) => (val) => val.length === arg },
  matches: {
    isArg: (val) => {
      if (typeof val !== 'string' || !val) return false;
      try {
        matchesSettingToRegExp(val);
        return true;
      } catch {
        return false;
      }
    },
    prepare: (arg: string) => {
      const regex = matchesSettingToRegExp(arg);
      return (val) => {
        // a `g` or `y` flag would make test() stateful
        regex.lastIndex = 0;
        return regex.test(val);
      };
    },
  },
};
export const VALIDATION_RULE_CHECKS = Object.keys(CHECKS);

/** the name of the check a rule makes (`startsWith`, ...), or `custom` */
export function validationRuleCheckName(rule: ValidationRule): string {
  return Object.keys(rule).find((key) => key === 'custom' || key in CHECKS)!;
}

type PreparedRule = { rule: ValidationRule, test?: (val: string) => boolean };
/** each rule with the test it makes (none for a custom rule), worked out once per list of rules */
const preparedRules = new WeakMap<Array<ValidationRule>, Array<PreparedRule>>();
function prepareRules(rules: Array<ValidationRule>) {
  let prepared = preparedRules.get(rules);
  if (!prepared) {
    prepared = rules.map((rule) => {
      const check = validationRuleCheckName(rule);
      if (check === 'custom') return { rule };
      return { rule, test: CHECKS[check].prepare(rule[check as keyof typeof rule]) };
    });
    preparedRules.set(rules, prepared);
  }
  return prepared;
}

/** Returns a description of what is wrong with a list of rules, or undefined if it is fine */
export function findValidationRulesProblem(rules: unknown): string | undefined {
  if (!Array.isArray(rules) || !rules.length) return 'expected a non-empty array';
  for (const [i, rule] of rules.entries()) {
    const where = `rule ${i + 1}`;
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) return `${where} is not an object`;
    const checkKeys = Object.keys(rule).filter((key) => key === 'custom' || key in CHECKS);
    if (checkKeys.length !== 1) {
      return `${where} must have exactly one of ${[...VALIDATION_RULE_CHECKS, 'custom'].join(', ')}`;
    }
    const unknownKeys = Object.keys(rule).filter((key) => !checkKeys.includes(key) && key !== 'message' && key !== 'tip');
    if (unknownKeys.length) return `${where} has unknown keys: ${unknownKeys.join(', ')}`;
    const [check] = checkKeys;
    const { message, tip } = rule as Record<string, unknown>;
    if (tip !== undefined && typeof tip !== 'string') return `${where} has a "tip" that is not a string`;
    if (check === 'custom') {
      if (!isNonEmptyString(rule.custom)) return `${where} must describe its custom check`;
      if (message !== undefined && !isNonEmptyString(message)) return `${where} has a "message" that is not a string`;
      if (i !== rules.length - 1) return `${where} is custom, so it must be the last rule`;
    } else {
      if (!CHECKS[check].isArg(rule[check])) return `${where} has an unsupported value for "${check}"`;
      if (!isNonEmptyString(message)) return `${where} needs a "message"`;
    }
  }
  return undefined;
}

export type ValidationRulesResult = | { passed: true }
  /** a rule failed, and this is the error */
  | { passed: false, rule: ValidationRule, index: number, error: ValidationError }
  /** every rule before a custom one passed. The custom check only runs in plugin code */
  | { passed: 'unknown', rule: ValidationRule };

/** Checks a value against rules, stopping at the first failure. Rules only describe string values. */
export function checkValidationRules(val: unknown, rules: Array<ValidationRule>): ValidationRulesResult {
  if (typeof val !== 'string') return { passed: 'unknown', rule: rules[0] };
  for (const [index, { rule, test }] of prepareRules(rules).entries()) {
    if ('custom' in rule || !test) return { passed: 'unknown', rule };
    if (!test(val)) {
      return {
        passed: false,
        rule,
        index,
        error: new ValidationError(rule.message, rule.tip ? { tip: rule.tip } : undefined),
      };
    }
  }
  return { passed: true };
}
