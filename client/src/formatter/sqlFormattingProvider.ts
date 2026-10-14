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
import { formatSqlText } from './formatPipeline';
import { describeFormattingRisk } from './formatGuard';

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
            formatted = formatSqlText(text, style.options);
        } catch (err: any) {
            // Il documento resta invariato, ma l'errore va reso visibile:
            // altrimenti il comando sembrerebbe semplicemente non fare nulla.
            const message = err?.message ?? String(err);
            console.error(`[SQL Prompt] formatting failed: ${err?.stack ?? message}`);
            window.showErrorMessage(
                `SQL Prompt: formatting failed (${message}). The document was left unchanged.`,
            );
            return [];
        }

        // Formatting is cosmetic: it must never be able to break the query.
        // If the result altered anything beyond whitespace and casing, one of
        // the regex passes matched where it should not have — leave the
        // document exactly as it is and say so, instead of applying an edit
        // that may not compile.
        const risk = describeFormattingRisk(text, formatted);
        if (risk) {
            window.showWarningMessage(
                `SQL Prompt: formatting cancelled — the result would have altered the query (${risk}). ` +
                'The document was left unchanged.',
            );
            return [];
        }

        const fullRange = new Range(
            document.lineAt(0).range.start,
            document.lineAt(document.lineCount - 1).range.end,
        );
        return [TextEdit.replace(fullRange, formatted)];
    }
}
