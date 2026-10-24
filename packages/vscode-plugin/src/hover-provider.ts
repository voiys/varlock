/*
  Super basic "hover provider" functionality to give some hover help

  for now we'll just give info about known decorators
*/
import {
  type ExtensionContext, Hover, languages, MarkdownString,
} from 'vscode';
import { LANG_ID } from './constants';
import { deindent } from './utils/deindent';
import { findDecoratorInfo, getCommentScope } from './completion-core';

export function addHoverProvider(_context: ExtensionContext) {
  languages.registerHoverProvider(LANG_ID, {
    provideHover(document, position, _token) {
      const hoveredLine = document.lineAt(position.line);
      const lineStr = hoveredLine.text;

      // we are in a comment
      if (lineStr.trim().startsWith('#')) {
        const wordAtPos = document.getWordRangeAtPosition(position, /@?[a-z0-9]+/i);
        const hoveredText = document.getText(wordAtPos);

        if (hoveredText.startsWith('@')) {
          const decName = hoveredText.substring(1);
          const dec = findDecoratorInfo(decName, () => getCommentScope(document, position.line));
          if (dec) {
            const mds = new MarkdownString();
            mds.supportThemeIcons = true;
            mds.appendMarkdown(deindent(`
              ${dec.summary}

              ${dec.documentation}
            `));
            return new Hover(mds);
          }
        }
      }
    },
  });
}
