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
import type { DotnetFormatterHost } from './dotnetFormatter';

export type FormattingEngine = 'legacy' | 'dotnet';

export class SqlFormattingProvider implements DocumentFormattingEditProvider {
    private dotnetFallbackNotified = false;

    constructor(
        private readonly getStyle: () => LoadedStyle | undefined,
        private readonly getEngine: () => FormattingEngine = () => 'dotnet',
        private readonly dotnet?: DotnetFormatterHost,
    ) {}

    async provideDocumentFormattingEdits(
        document: TextDocument,
        _options: FormattingOptions,
        token: CancellationToken,
    ): Promise<TextEdit[]> {
        const style = this.getStyle();
        if (!style) {
            window.showInformationMessage(
                'SQL Prompt: no formatting style active. Run "SQL Prompt: Select Formatting Style" to choose one.',
            );
            return [];
        }

        const text = document.getText();
        let formatted: string | undefined;

        if (this.getEngine() === 'dotnet' && this.dotnet) {
            try {
                const result = await this.dotnet.format(text, style.options);
                if (!result.ok) {
                    // Come SQL Prompt: uno script con errori di sintassi non viene formattato
                    const first = result.errors[0];
                    window.showWarningMessage(
                        first
                            ? `SQL Prompt: the script has a syntax error at line ${first.line}, column ${first.column} (${first.message}). The document was left unchanged.`
                            : 'SQL Prompt: the script could not be parsed. The document was left unchanged.',
                    );
                    return [];
                }
                formatted = result.text;
            } catch (err: any) {
                // Motore .NET non disponibile: si ripiega sul formatter TypeScript
                console.error(`[SQL Prompt] .NET formatter unavailable: ${err?.stack ?? err}`);
                if (!this.dotnetFallbackNotified) {
                    this.dotnetFallbackNotified = true;
                    window.showWarningMessage(
                        `SQL Prompt: the .NET formatting engine is unavailable (${err?.message ?? err}); using the built-in formatter.`,
                    );
                }
            }
        }
        if (token.isCancellationRequested) return [];

        if (formatted === undefined) {
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
