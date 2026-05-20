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
        addSpaceBeforeComma?: boolean;
    };
    whitespace?: {
        wrapLinesLongerThan?: number;
        newLines?: {
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
    };
    dml?: {
        collapseStatementsShorterThan?: number;
        collapseSubqueriesShorterThan?: number;
    };
    ddl?: {
        parenthesisStyle?: string;
        indentClauses?: boolean;
    };
    joinStatements?: {
        join?: {
            keywordAlignment?: string;
            indentJoinTable?: boolean;
        };
        on?: {
            keywordAlignment?: string;
            conditionAlignment?: string;
        };
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
