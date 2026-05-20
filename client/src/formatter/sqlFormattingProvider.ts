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
            formatted = format(text, mapToFormatterOptions(style.options));
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
