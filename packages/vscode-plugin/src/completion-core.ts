import {
  type DataTypeInfo, type DecoratorInfo, ITEM_DECORATORS, ROOT_DECORATORS,
} from './intellisense-catalog';

type LineDocument = {
  lineCount: number;
  lineAt(line: number): { text: string };
};

const CONFIG_ITEM_PATTERN = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=/;
const DIVIDER_PATTERN = /^\s*#\s*(?:---+|===+)(?:\s|$)/;
const DECORATOR_PATTERN = /@([A-Za-z][\w-]*)/g;

/**
 * Each pair of decorators varlock rejects together, from the catalog's `incompatibleWith` (varlock
 * declares a pair on one side or both). Listed once per pair, both pairs and members in catalog order.
 */
export const INCOMPATIBLE_DECORATOR_PAIRS: Array<[string, string]> = (() => {
  const decorators = [...ROOT_DECORATORS, ...ITEM_DECORATORS];
  const position = new Map(decorators.map((decorator, index) => [decorator.name, index]));
  const pairs = new Map<string, [string, string]>();
  for (const decorator of decorators) {
    for (const other of decorator.incompatibleWith ?? []) {
      const pair = [decorator.name, other].sort((a, b) => position.get(a)! - position.get(b)!) as [string, string];
      pairs.set(pair.join(' '), pair);
    }
  }
  return [...pairs.values()];
})();

const INCOMPATIBLE_DECORATORS = new Map<string, Set<string>>();
for (const [left, right] of INCOMPATIBLE_DECORATOR_PAIRS) {
  for (const [name, other] of [[left, right], [right, left]]) {
    if (!INCOMPATIBLE_DECORATORS.has(name)) INCOMPATIBLE_DECORATORS.set(name, new Set());
    INCOMPATIBLE_DECORATORS.get(name)!.add(other);
  }
}

function stripInlineComment(value: string) {
  let quote: '"' | '\'' | '' = '';

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (char === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }

  return value.trim();
}

export function getDecoratorCommentPrefix(lineText: string) {
  const match = lineText.match(/^\s*#\s*(@.*)$/);
  if (!match) return undefined;

  const commentText = match[1];

  return stripInlineComment(commentText);
}

function splitArgs(input: string) {
  const parts: Array<string> = [];
  let current = '';
  let quote: '"' | '\'' | '' = '';
  let depth = 0;

  for (const char of input) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(') {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ')') {
      depth = Math.max(depth - 1, 0);
      current += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      const value = current.trim();
      if (value) parts.push(value);
      current = '';
      continue;
    }

    current += char;
  }

  const value = current.trim();
  if (value) parts.push(value);
  return parts;
}

export function isInHeader(document: LineDocument, lineNumber: number) {
  for (let line = lineNumber + 1; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text.trim();
    if (!text) break;
    if (DIVIDER_PATTERN.test(text)) break;
    if (CONFIG_ITEM_PATTERN.test(text)) return false;
    if (!text.startsWith('#')) break;
  }

  for (let line = 0; line < lineNumber; line += 1) {
    if (CONFIG_ITEM_PATTERN.test(document.lineAt(line).text)) return false;
  }

  return true;
}

export function getCommentScope(document: LineDocument, lineNumber: number) {
  return isInHeader(document, lineNumber) ? 'header' : 'item';
}

/**
 * Looks a decorator up by name, preferring the scope the cursor is in. Some names exist in both
 * scopes with different meanings (`@proxy` is a detached rule in the header and an attached one on an item).
 * The scope is only asked for in that case, since working it out scans the lines above the cursor.
 */
export function findDecoratorInfo(name: string, getScope: () => 'header' | 'item'): DecoratorInfo | undefined {
  const root = ROOT_DECORATORS.find((decorator) => decorator.name === name);
  const item = ITEM_DECORATORS.find((decorator) => decorator.name === name);
  if (root && item) return getScope() === 'header' ? root : item;
  return root ?? item;
}

export function getExistingDecoratorNames(
  document: LineDocument,
  lineNumber: number,
  commentPrefix: string,
) {
  const names = new Set<string>();

  if (isInHeader(document, lineNumber)) {
    for (let line = 0; line < lineNumber; line += 1) {
      const text = document.lineAt(line).text.trim();
      if (CONFIG_ITEM_PATTERN.test(text)) break;
      if (!text.startsWith('#')) continue;

      const decoratorCommentPrefix = getDecoratorCommentPrefix(text);
      if (!decoratorCommentPrefix) continue;

      for (const match of decoratorCommentPrefix.matchAll(DECORATOR_PATTERN)) {
        names.add(match[1]);
      }
    }
  } else {
    for (let line = lineNumber - 1; line >= 0; line -= 1) {
      const text = document.lineAt(line).text.trim();
      if (!text.startsWith('#')) break;

      const decoratorCommentPrefix = getDecoratorCommentPrefix(text);
      if (!decoratorCommentPrefix) continue;

      for (const match of decoratorCommentPrefix.matchAll(DECORATOR_PATTERN)) {
        names.add(match[1]);
      }
    }
  }

  for (const match of commentPrefix.matchAll(DECORATOR_PATTERN)) {
    names.add(match[1]);
  }

  return names;
}

export function filterAvailableDecorators(
  decorators: Array<DecoratorInfo>,
  existingDecoratorNames: Set<string>,
) {
  return decorators.filter((decorator) => {
    if (!decorator.isFunction && existingDecoratorNames.has(decorator.name)) return false;

    const incompatible = INCOMPATIBLE_DECORATORS.get(decorator.name);
    if (!incompatible) return true;

    return ![...incompatible].some((name) => existingDecoratorNames.has(name));
  });
}

export function splitEnumArgs(input: string) {
  return splitArgs(input).map((value) => value.replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
}

export function getEnumValuesFromPrecedingComments(document: LineDocument, lineNumber: number) {
  for (let line = lineNumber - 1; line >= 0; line -= 1) {
    const text = document.lineAt(line).text.trim();
    if (!text.startsWith('#')) break;

    const decoratorCommentPrefix = getDecoratorCommentPrefix(text);
    if (!decoratorCommentPrefix) continue;

    const match = decoratorCommentPrefix.match(/@type=enum\((.*)\)/);
    if (match) return splitEnumArgs(match[1]);
  }

  return undefined;
}

export function getTypeOptionDataType(dataTypes: Array<DataTypeInfo>, commentPrefix: string) {
  const match = commentPrefix.match(/(^|\s)@type=([A-Za-z][\w-]*)\([^#)]*$/);
  if (!match) return undefined;
  return dataTypes.find((dataType) => dataType.name === match[2]);
}
