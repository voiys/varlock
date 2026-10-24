// String rules shared by the `string`, `url` and `domain` data types: prefix/suffix/substring
// checks and an allowed-character set. They replace the common uses of a `matches` regex with
// plain string operations, so they cannot backtrack and say what they check in their name.
//
// Kept dependency-free (like data-types) since the frozen env boot runtime loads it.
import { ValidationError } from './errors';

const DIGITS = '0123456789';
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** named character sets accepted by `chars=` */
export const CHARS_PRESETS = {
  digits: { chars: DIGITS, label: 'digits (0-9)' },
  hex: { chars: `${DIGITS}abcdefABCDEF`, label: 'hex digits (0-9, a-f, A-F)' },
  lowercase: { chars: LOWERCASE, label: 'lowercase letters (a-z)' },
  uppercase: { chars: UPPERCASE, label: 'uppercase letters (A-Z)' },
  letters: { chars: LOWERCASE + UPPERCASE, label: 'letters (a-z, A-Z)' },
  alphanumeric: { chars: LOWERCASE + UPPERCASE + DIGITS, label: 'letters and digits' },
  base64: { chars: `${LOWERCASE + UPPERCASE + DIGITS}+/=`, label: 'base64 characters (A-Z, a-z, 0-9, +, /, =)' },
  base64url: { chars: `${LOWERCASE + UPPERCASE + DIGITS}-_`, label: 'base64url characters (A-Z, a-z, 0-9, -, _)' },
} as const;
export type CharsPreset = keyof typeof CHARS_PRESETS;
const isCharsPreset = (name: string): name is CharsPreset => Object.prototype.hasOwnProperty.call(CHARS_PRESETS, name);

/** one string, or a list of strings */
type OneOrMany = string | Array<string>;

export type StringRuleSettings = {
  /** The value must start with this string (or with one of these strings). */
  startsWith?: OneOrMany;
  /** The value must end with this string (or with one of these strings). */
  endsWith?: OneOrMany;
  /** The value must not start with this string (or with any of these strings). */
  notStartsWith?: OneOrMany;
  /** The value must not end with this string (or with any of these strings). */
  notEndsWith?: OneOrMany;
  /** The value must contain this string (or every one of these strings). */
  contains?: OneOrMany;
  /** The value must not contain this string (or any of these strings). */
  notContains?: OneOrMany;
  /**
   * The characters the value may contain: a preset name (`digits`, `hex`, `lowercase`,
   * `uppercase`, `letters`, `alphanumeric`, `base64`, `base64url`), or a list mixing preset
   * names and strings whose every character is allowed, e.g. `[digits, "-"]`.
   */
  chars?: CharsPreset | Array<string>;
};

export const STRING_RULE_KEYS = ['startsWith', 'endsWith', 'notStartsWith', 'notEndsWith', 'contains', 'notContains', 'chars'] as const satisfies ReadonlyArray<keyof StringRuleSettings>;

/**
 * Read every rule off a data type's settings. Called when the type instance is created, so
 * each setting is read even when no value is ever validated (tooling discovers a type's
 * settings by tracing which keys its factory reads).
 */
export function readStringRules(settings: Record<string, any> | undefined): StringRuleSettings {
  const rules: Record<string, any> = {};
  for (const key of STRING_RULE_KEYS) {
    const val = settings?.[key];
    if (val !== undefined && val !== null) rules[key] = val;
  }
  return rules as StringRuleSettings;
}

const quote = (str: string) => JSON.stringify(str);
const quoteList = (strs: Array<string>) => strs.map(quote).join(', ');

/** normalize a rule value to a list of strings, or return an error message */
function toStringList(key: string, val: unknown): Array<string> | string {
  if (typeof val === 'string') return val === '' ? [] : [val];
  if (Array.isArray(val) && val.every((v) => typeof v === 'string')) return val.filter((v) => v !== '');
  // an unquoted number (`notStartsWith=0`) is read as a number, so point at the quotes
  const example = typeof val === 'number' ? `, e.g. ${key}="${val}"` : '';
  return `${key} must be a string or an array of strings (quote values that look like numbers${example})`;
}

type CharsSpec = { allowed: Set<string>, description: string };

function parseCharsSetting(val: unknown): CharsSpec | string {
  const presetNames = Object.keys(CHARS_PRESETS).join(', ');
  let entries: Array<string>;
  if (typeof val === 'string') {
    // a lone string must be a preset, so a typo (`chars=hexx`) is reported rather than
    // read as the literal characters h, e and x
    if (!isCharsPreset(val)) {
      return `chars: unknown preset ${quote(val)} - use one of ${presetNames}, or a list for literal characters, e.g. chars=[${quote(val)}]`;
    }
    entries = [val];
  } else if (Array.isArray(val) && val.every((v) => typeof v === 'string')) {
    entries = val;
  } else {
    return `chars must be a preset name (${presetNames}) or an array of preset names and strings`;
  }
  if (!entries.length) return 'chars must not be an empty list';

  const allowed = new Set<string>();
  const labels: Array<string> = [];
  const literals: Array<string> = [];
  for (const entry of entries) {
    if (isCharsPreset(entry)) {
      for (const ch of CHARS_PRESETS[entry].chars) allowed.add(ch);
      labels.push(CHARS_PRESETS[entry].label);
    } else {
      for (const ch of entry) {
        if (!allowed.has(ch)) literals.push(ch);
        allowed.add(ch);
      }
    }
  }
  if (literals.length) labels.push(quoteList(literals));
  return { allowed, description: labels.join(' and ') };
}

/**
 * Check a value against the rules. `subject` names the value in messages (`Value`, `URL`,
 * `Domain`). Returns one error per failed rule; a malformed rule setting is an error too.
 */
export function checkStringRules(
  val: string,
  rules: StringRuleSettings,
  subject = 'Value',
): Array<ValidationError> {
  const errors: Array<ValidationError> = [];
  const listFor = (key: keyof StringRuleSettings): Array<string> | undefined => {
    if (rules[key] === undefined) return undefined;
    const list = toStringList(key, rules[key]);
    if (typeof list === 'string') {
      errors.push(new ValidationError(list));
      return undefined;
    }
    return list.length ? list : undefined;
  };

  const startsWith = listFor('startsWith');
  if (startsWith && !startsWith.some((s) => val.startsWith(s))) {
    errors.push(new ValidationError(startsWith.length === 1
      ? `${subject} must start with ${quote(startsWith[0])}`
      : `${subject} must start with one of ${quoteList(startsWith)}`));
  }
  const endsWith = listFor('endsWith');
  if (endsWith && !endsWith.some((s) => val.endsWith(s))) {
    errors.push(new ValidationError(endsWith.length === 1
      ? `${subject} must end with ${quote(endsWith[0])}`
      : `${subject} must end with one of ${quoteList(endsWith)}`));
  }
  const notStartsWith = listFor('notStartsWith');
  const badPrefix = notStartsWith?.find((s) => val.startsWith(s));
  if (badPrefix !== undefined) errors.push(new ValidationError(`${subject} must not start with ${quote(badPrefix)}`));

  const notEndsWith = listFor('notEndsWith');
  const badSuffix = notEndsWith?.find((s) => val.endsWith(s));
  if (badSuffix !== undefined) errors.push(new ValidationError(`${subject} must not end with ${quote(badSuffix)}`));

  for (const s of listFor('contains') ?? []) {
    if (!val.includes(s)) errors.push(new ValidationError(`${subject} must contain ${quote(s)}`));
  }
  for (const s of listFor('notContains') ?? []) {
    if (val.includes(s)) errors.push(new ValidationError(`${subject} must not contain ${quote(s)}`));
  }

  if (rules.chars !== undefined) {
    const spec = parseCharsSetting(rules.chars);
    if (typeof spec === 'string') {
      errors.push(new ValidationError(spec));
    } else {
      // positions count characters (code points), starting at 1
      let position = 0;
      for (const ch of val) {
        position++;
        if (!spec.allowed.has(ch)) {
          errors.push(new ValidationError(
            `${subject} must only contain ${spec.description}, found ${quote(ch)} at position ${position}`,
          ));
          break;
        }
      }
    }
  }
  return errors;
}
