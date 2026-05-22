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
        (style.whitespace?.newLines?.emptyLinesBetweenStatements ?? 1) + 1;

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

    if (style.whitespace?.wrapLinesLongerThan !== undefined) {
        opts.expressionWidth = style.whitespace.wrapLinesLongerThan;
    }

    // "toTable" keyword alignment implies a tabular (vertical) indentation style
    if (style.joinStatements?.join?.keywordAlignment === 'toTable') {
        opts.indentStyle = 'tabularLeft';
    }

    if (style.operators?.andOr?.alignment) {
        opts.logicalOperatorNewline =
            style.operators.andOr.alignment === 'afterOperator' ? 'after' : 'before';
    }

    return opts;
}
