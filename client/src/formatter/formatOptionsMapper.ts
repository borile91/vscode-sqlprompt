import type { FormatOptionsWithLanguage } from 'sql-formatter';
import type { SqlPromptStyleJson } from './styleLoader';

function mapCasing(value: string | undefined): 'upper' | 'lower' | 'preserve' {
    if (value === 'uppercase') { return 'upper'; }
    if (value === 'lowercase') { return 'lower'; }
    return 'preserve';
}

export function mapToFormatterOptions(style: SqlPromptStyleJson): FormatOptionsWithLanguage {
    const tabWidth = style.whitespace?.numberOfSpacesInTabs ?? 4;
    const useTabs = style.whitespace?.spacesOrTabs === 'onlyTabs';
    const linesBetweenQueries =
        style.whitespace?.newLines?.emptyLinesBetweenStatements ?? 1;

    const opts: FormatOptionsWithLanguage = {
        language: 'tsql',
        tabWidth,
        useTabs,
        linesBetweenQueries,
    };

    if (style.casing) {
        opts.keywordCase = mapCasing(style.casing.reservedKeywords);
        opts.functionCase = mapCasing(style.casing.builtInFunctions);
        opts.dataTypeCase = mapCasing(style.casing.builtInDataTypes);
    }

    if (style.whitespace?.wrapLongLines === false) {
        // Prevent sql-formatter from wrapping: use a very large expression width.
        // The wrapLinesLongerThan value is still used by custom post-processors
        // (e.g. placeSubsequentItemsOnNewLines: "ifLongerThanMaxLineLength") but
        // sql-formatter itself should not expand expressions.
        opts.expressionWidth = 9999;
    } else if (style.whitespace?.wrapLinesLongerThan !== undefined) {
        opts.expressionWidth = style.whitespace.wrapLinesLongerThan;
    }

    // "toTable" keyword alignment implies a tabular (vertical) indentation style,
    // but only when leading-comma layout is also requested (the two features work
    // together to produce the vertically-aligned style).
    if (style.joinStatements?.join?.keywordAlignment === 'toTable' && style.lists?.placeCommasBeforeItems === true) {
        opts.indentStyle = 'tabularLeft';
    }

    if (style.operators?.andOr?.alignment) {
        opts.logicalOperatorNewline =
            style.operators.andOr.alignment === 'afterOperator' ? 'after' : 'before';
    }

    return opts;
}
