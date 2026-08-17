import {
    CancellationToken,
    DocumentFormattingEditProvider,
    FormattingOptions,
    Range,
    TextDocument,
    TextEdit,
    window,
} from 'vscode';
import type { LoadedStyle } from './styleLoader';
import { formatSql } from './formatSql';

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

        let formatted: string;
        try {
            formatted = formatSql(document.getText(), style.options);
        } catch (err) {
            // Leaving the document untouched is the right call, but staying
            // silent about it is not: the user would just see nothing happen.
            const message = err instanceof Error ? err.message : String(err);
            window.showErrorMessage(`SQL Prompt: formatting failed — ${message}`);
            return [];
        }

        const fullRange = new Range(
            document.lineAt(0).range.start,
            document.lineAt(document.lineCount - 1).range.end,
        );
        return [TextEdit.replace(fullRange, formatted)];
    }
}
