import {
    CancellationToken,
    DocumentFormattingEditProvider,
    FormattingOptions,
    Range,
    TextDocument,
    TextEdit,
    window,
} from 'vscode';
import { format } from 'sql-formatter';
import type { LoadedStyle } from './styleLoader';
import { mapToFormatterOptions } from './formatOptionsMapper';
import { applyControlFlowIndentation } from './controlFlowFormatter';
import { applyKeywordRePadding } from './keywordPaddingFormatter';
import { applyLeadingCommaFormat } from './listFormatter';
import { applySemicolonFormatting } from './semicolonFormatter';
import { applyJoinOnFormatting } from './joinFormatter';
import { applyCaseFormatting } from './caseFormatter';
import { applyDdlFormatting } from './ddlFormatter';

export class SqlFormattingProvider implements DocumentFormattingEditProvider {
    constructor(private readonly getStyle: () => LoadedStyle | undefined) {}

    provideDocumentFormattingEdits(
        document: TextDocument,
        _options: FormattingOptions,
        _token: CancellationToken,
    ): TextEdit[] {
        const style = this.getStyle();
        if (!style) {
            window.showInformationMessage(
                'SQL Prompt: no formatting style active. Run "SQL Prompt: Select Formatting Style" to choose one.',
            );
            return [];
        }

        const text = document.getText();
        let formatted: string;
        try {
            const tabWidth = style.options.whitespace?.numberOfSpacesInTabs ?? 4;
            formatted = format(text, mapToFormatterOptions(style.options));
            formatted = applyKeywordRePadding(formatted);
            formatted = applyLeadingCommaFormat(formatted, style.options);
            formatted = applyJoinOnFormatting(formatted, style.options, tabWidth);
            formatted = applyCaseFormatting(formatted, style.options, tabWidth);
            formatted = applyDdlFormatting(formatted, style.options);
            formatted = applyControlFlowIndentation(formatted, style.options, tabWidth);
            formatted = applySemicolonFormatting(formatted, style.options);
        } catch {
            return [];
        }

        const fullRange = new Range(
            document.lineAt(0).range.start,
            document.lineAt(document.lineCount - 1).range.end,
        );
        return [TextEdit.replace(fullRange, formatted)];
    }
}
