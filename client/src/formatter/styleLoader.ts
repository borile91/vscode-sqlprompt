import * as fs from 'fs';
import * as path from 'path';

export interface SqlPromptStyleJson {
    metadata?: {
        name?: string;
    };
    casing?: {
        reservedKeywords?: 'uppercase' | 'lowercase' | 'preserveCase';
        builtInFunctions?: 'uppercase' | 'lowercase' | 'preserveCase';
        builtInDataTypes?: 'uppercase' | 'lowercase' | 'preserveCase';
        useObjectDefinitionCase?: boolean;
    };
    lists?: {
        placeCommasBeforeItems?: boolean;
        alignComments?: boolean;
        alignAliases?: boolean;
        addSpaceBeforeComma?: boolean;
        addSpaceAfterComma?: boolean;
        placeFirstItemOnNewLines?: 'never' | 'always' | 'wrap' | 'whenLong' | 'ifLongerThanMaxLineLength';
        placeSubsequentItemsOnNewLines?: 'never' | 'always' | 'wrap' | 'whenLong' | 'ifLongerThanMaxLineLength';
        alignSubsequentItemsWithFirstItem?: boolean;
        alignClauseItems?: boolean;
        alignItemsAcrossClauses?: boolean;
        alignItemsToTabStops?: boolean;
        commaAlignment?: 'toStatement' | 'beforeItem' | 'toList';
    };
    parentheses?: {
        collapseParenthesesShorterThan?: number;
        addSpacesInsideParentheses?: boolean;
    };
    whitespace?: {
        numberOfSpacesInTabs?: number;
        spacesOrTabs?: 'onlySpaces' | 'onlyTabs' | 'spacesAndTabs';
        wrapLongLines?: boolean;
        wrapLinesLongerThan?: number;
        whiteSpaceBeforeSemiColon?: 'none' | 'spaceBefore' | 'newLineBefore';
        newLines?: {
            emptyLinesBetweenStatements?: number;
            emptyLinesAfterBatchSeparator?: number;
            preserveExistingEmptyLinesBetweenStatements?: boolean;
            preserveExistingEmptyLinesAfterBatchSeparator?: boolean;
        };
    };
    operators?: {
        andOr?: {
            alignment?: 'toFirstListItem' | 'beforeOperator' | 'afterOperator';
        };
        between?: {
            placeOnNewLine?: boolean;
        };
        in?: {
            placeFirstValueOnNewLine?: 'always' | 'never' | 'ifMultiple';
            placeSubsequentValuesOnNewLines?: 'always' | 'never' | 'ifMultiple';
            addSpaceAroundInContents?: boolean;
        };
    };
    dml?: {
        collapseStatementsShorterThan?: number;
        collapseSubqueriesShorterThan?: number;
    };
    ddl?: {
        parenthesisStyle?: string;
        overrideParenthesesForCreateAlter?: boolean;
        indentClauses?: boolean;
        indentContents?: boolean;
        indentParenthesesContents?: boolean;
        placeClosingParenthesisOnNewLine?: boolean;
        placeFirstProcedureParameterOnNewLine?: 'always' | 'never' | 'ifMultiple';
        placeConstraintColumnsOnNewLines?: string;
        firstDefinitionBreakType?: 'always' | 'never' | 'whenLong';
        placeFirstDefinitionOnNewLine?: boolean;
        collapseStatementsShorterThan?: number;
        collapseShortStatements?: boolean;
        breakOnConstraints?: boolean;
        constraintColumnsBreakType?: 'never' | 'always' | 'whenLong';
        verticallyAlignDataTypes?: boolean;
        verticallyAlignColumnDefinitions?: boolean;
        openingParenthesisAlignment?: string;
        openingParenthesisBreakType?: string;
        closingParenthesisAlignment?: string;
        contentsBreakType?: string;
    };
    controlFlow?: {
        indentBeginAndEndKeywords?: boolean;
        indentContentsOfStatements?: boolean;
        collapseStatementsShorterThan?: number;
        collapseShortStatements?: boolean;
    };
    cte?: {
        asAlignment?: 'indented' | 'aligned';
    };
    variables?: {
        alignDataTypesAndValues?: boolean;
        placeAssignedValueOnNewLineIfLongerThanMaxLineLength?: boolean;
    };
    joinStatements?: {
        join?: {
            keywordAlignment?: string;
            indentJoinTable?: boolean;
        };
        on?: {
            placeOnNewLine?: boolean;
            keywordAlignment?: string;
            conditionAlignment?: string;
        };
    };
    insertStatements?: {
        columns?: {
            parenthesisStyle?: string;
            indentContents?: boolean;
            placeSubsequentColumnsOnNewLines?: 'never' | 'always' | 'whenLong' | 'ifLongerThanMaxLineLength';
        };
        values?: {
            parenthesisStyle?: string;
            indentContents?: boolean;
        };
    };
    functionCalls?: {
        placeArgumentsOnNewLines?: 'always' | 'never' | 'ifLong';
    };
    caseExpressions?: {
        placeExpressionOnNewLine?: boolean;
        placeFirstWhenOnNewLine?: 'always' | 'never' | 'ifInputExpression';
        whenAlignment?: string;
        alignElseToWhen?: boolean;
        placeElseOnNewLine?: boolean;
        placeEndOnNewLine?: boolean;
        endAlignment?: string;
        expressionAlignment?: string;
        placeThenOnNewLine?: boolean;
        collapseCaseExpressionsShorterThan?: number;
        collapseShortCaseExpressions?: boolean;
    };
}

export interface LoadedStyle {
    name: string;
    filePath: string;
    options: SqlPromptStyleJson;
}

export async function loadStylesFromFolder(folderPath: string): Promise<LoadedStyle[]> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    } catch {
        return [];
    }

    const results: LoadedStyle[] = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
            continue;
        }

        const filePath = path.join(folderPath, entry.name);
        try {
            const raw = await fs.promises.readFile(filePath, 'utf8');
            const parsed = JSON.parse(raw) as SqlPromptStyleJson;
            const name = parsed.metadata?.name ?? path.basename(entry.name, '.json');
            results.push({ name, filePath, options: parsed });
        } catch {
            // Skip unreadable or unparseable files
        }
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
}
