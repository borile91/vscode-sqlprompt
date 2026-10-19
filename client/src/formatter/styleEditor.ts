import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Disposable, TextDocument, Uri, ViewColumn, WebviewPanel, window, workspace } from 'vscode';
import { loadStylesFromFolder, LoadedStyle } from './styleLoader';
import { applyValues, coerceValue, effectiveValues, findOption, OptionValue, STYLE_SECTIONS, styleFileName } from './styleSchema';

// Editor degli stili di formattazione (pagina "Formatting styles" come in SQL Prompt per SSMS):
// elenco degli stili della cartella, opzioni per sezione, anteprima formattata dal vivo.

export interface PreviewResult {
    text: string;
    /** Motore che ha prodotto l'anteprima. */
    engine: 'dotnet' | 'legacy';
    error?: string;
}

export interface StyleEditorHost {
    getStylesFolder(): string;
    setStylesFolder(folder: string): Thenable<void>;
    getActiveStyleName(): string;
    setActiveStyleName(name: string): Thenable<void>;
    /** Formatta l'SQL di anteprima con lo stile indicato (JSON SQL Prompt). */
    formatPreview(sql: string, style: Record<string, unknown>): Promise<PreviewResult>;
    /** Avvisa l'estensione che gli stili su disco sono cambiati. */
    stylesChanged(): Promise<void>;
}

interface WorkingStyle {
    filePath: string;
    /** JSON letto dal disco. */
    original: Record<string, unknown>;
    /** Valori modificati e non ancora salvati, per chiave. */
    changes: Record<string, OptionValue>;
}

export class StyleEditorPanel {
    private static current: StyleEditorPanel | undefined;

    private readonly disposables: Disposable[] = [];
    private styles: LoadedStyle[] = [];
    private working: WorkingStyle | undefined;
    private previewSeq = 0;
    /** Ultimo documento SQL attivo: l'anteprima può usarlo al posto dell'esempio della sezione. */
    private sqlDocument: TextDocument | undefined;

    static show(extensionUri: Uri, host: StyleEditorHost): void {
        if (StyleEditorPanel.current) {
            StyleEditorPanel.current.panel.reveal(ViewColumn.Active);
            return;
        }
        const panel = window.createWebviewPanel('sqlPromptStyleEditor', 'SQL Formatting Styles', ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [Uri.joinPath(extensionUri, 'client', 'media')],
        });
        StyleEditorPanel.current = new StyleEditorPanel(panel, extensionUri, host);
    }

    private constructor(
        private readonly panel: WebviewPanel,
        private readonly extensionUri: Uri,
        private readonly host: StyleEditorHost,
    ) {
        panel.webview.html = this.html();
        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(err => this.reportError(err)), null, this.disposables);

        // il pannello prende il fuoco: il documento SQL è quello attivo prima o uno visibile
        const active = window.activeTextEditor?.document;
        this.sqlDocument = active?.languageId === 'sql'
            ? active
            : window.visibleTextEditors.find(e => e.document.languageId === 'sql')?.document;
        window.onDidChangeActiveTextEditor(e => {
            if (e?.document.languageId !== 'sql') return;
            this.sqlDocument = e.document;
            this.postEditor();
        }, null, this.disposables);
        workspace.onDidChangeTextDocument(e => {
            if (e.document === this.sqlDocument) this.postEditor();
        }, null, this.disposables);
        workspace.onDidCloseTextDocument(d => {
            if (d !== this.sqlDocument) return;
            this.sqlDocument = undefined;
            this.postEditor();
        }, null, this.disposables);
        window.onDidChangeTextEditorSelection(e => {
            if (e.textEditor.document === this.sqlDocument) this.postEditor();
        }, null, this.disposables);
    }

    private postEditor(): void {
        const name = this.sqlDocument ? path.basename(this.sqlDocument.fileName) : '';
        this.post({ type: 'editor', name });
    }

    /** Testo del documento SQL corrente: la selezione, se c'è, altrimenti tutto il documento. */
    private editorSql(): string | undefined {
        const doc = this.sqlDocument;
        if (!doc || doc.isClosed) return undefined;
        const editor = window.visibleTextEditors.find(e => e.document === doc);
        if (editor && !editor.selection.isEmpty) return doc.getText(editor.selection);
        return doc.getText();
    }

    private dispose(): void {
        StyleEditorPanel.current = undefined;
        for (const d of this.disposables) d.dispose();
    }

    private post(message: unknown): void {
        void this.panel.webview.postMessage(message);
    }

    private reportError(err: any): void {
        const message = err?.message ?? String(err);
        console.error(`[SQL Prompt] style editor: ${err?.stack ?? message}`);
        void window.showErrorMessage(`SQL Prompt: ${message}`);
    }

    // ── messaggi dalla webview ────────────────────────────────────────────────

    private async onMessage(m: any): Promise<void> {
        switch (m?.type) {
            case 'ready':
                await this.reload(this.working?.filePath);
                this.postEditor();
                break;
            case 'chooseFolder':
                await this.chooseFolder();
                break;
            case 'select':
                if (await this.confirmDiscard()) this.select(String(m.filePath));
                else this.sendState();
                break;
            case 'change':
                this.change(String(m.key), m.value);
                break;
            case 'reset':
                this.change(String(m.key), findOption(String(m.key))?.default);
                break;
            case 'preview':
                await this.preview(String(m.sectionId), typeof m.sql === 'string' ? m.sql : undefined, m.source === 'editor');
                break;
            case 'save':
                await this.save();
                break;
            case 'revert':
                if (this.working) this.select(this.working.filePath);
                break;
            case 'new':
                await this.create(false);
                break;
            case 'duplicate':
                await this.create(true);
                break;
            case 'rename':
                await this.rename();
                break;
            case 'delete':
                await this.remove();
                break;
            case 'activate':
                await this.activate();
                break;
            case 'openJson':
                if (this.working) await window.showTextDocument(Uri.file(this.working.filePath));
                break;
        }
    }

    private async reload(selectPath?: string): Promise<void> {
        const folder = this.host.getStylesFolder();
        this.styles = folder ? await loadStylesFromFolder(folder) : [];
        const keep = selectPath && this.styles.find(s => s.filePath === selectPath);
        const active = this.styles.find(s => s.name === this.host.getActiveStyleName());
        const target = keep || active || this.styles[0];
        this.working = target
            ? { filePath: target.filePath, original: target.options as Record<string, unknown>, changes: {} }
            : undefined;
        this.post({ type: 'init', sections: STYLE_SECTIONS, folder });
        this.sendState();
    }

    private select(filePath: string): void {
        const style = this.styles.find(s => s.filePath === filePath);
        if (!style) return;
        this.working = { filePath, original: style.options as Record<string, unknown>, changes: {} };
        this.sendState();
    }

    /** Stile corrente con le modifiche non salvate applicate. */
    private currentJson(): Record<string, unknown> {
        if (!this.working) return {};
        return applyValues(this.working.original, this.working.changes);
    }

    private sendState(): void {
        const w = this.working;
        const current = this.currentJson();
        const values = effectiveValues(current);
        this.post({
            type: 'state',
            styles: this.styles.map(s => ({ name: s.name, filePath: s.filePath })),
            activeName: this.host.getActiveStyleName(),
            selected: w ? {
                filePath: w.filePath,
                name: this.nameOf(w),
                values,
                // opzioni diverse dal default: sono quelle scritte nel file
                customized: Object.keys(values).filter(k => values[k] !== findOption(k)?.default),
                dirty: this.isDirty(),
            } : undefined,
        });
    }

    private isDirty(): boolean {
        const w = this.working;
        if (!w || Object.keys(w.changes).length === 0) return false;
        return JSON.stringify(this.currentJson()) !== JSON.stringify(applyValues(w.original, {}));
    }

    private nameOf(w: WorkingStyle): string {
        const meta = w.original.metadata as { name?: string } | undefined;
        return meta?.name ?? path.basename(w.filePath, '.json');
    }

    private change(key: string, value: unknown): void {
        const option = findOption(key);
        if (!this.working || !option) return;
        const coerced = coerceValue(option, value);
        if (coerced === undefined) return;
        this.working.changes[key] = coerced;
        this.sendState();
    }

    private async preview(sectionId: string, sql: string | undefined, fromEditor: boolean): Promise<void> {
        const section = STYLE_SECTIONS.find(s => s.id === sectionId);
        if (!section) return;
        const seq = ++this.previewSeq;
        let source = sql ?? section.preview;
        if (fromEditor) {
            const text = this.editorSql();
            if (text === undefined) {
                this.post({ type: 'preview', sectionId, text: '', engine: '', error: 'Open a SQL file to preview it with this style.' });
                return;
            }
            source = text;
        }
        let result: PreviewResult;
        try {
            result = await this.host.formatPreview(source, this.currentJson());
        } catch (err: any) {
            result = { text: source, engine: 'legacy', error: err?.message ?? String(err) };
        }
        // risposta superata da una richiesta più recente
        if (seq !== this.previewSeq) return;
        this.post({ type: 'preview', sectionId, ...result });
    }

    // ── file ──────────────────────────────────────────────────────────────────

    private async save(): Promise<void> {
        const w = this.working;
        if (!w) return;
        const json = this.currentJson();
        const metadata = { ...(json.metadata as object ?? {}) } as Record<string, unknown>;
        metadata.lastModified = new Date().toISOString();
        const ordered = { metadata, ...Object.fromEntries(Object.entries(json).filter(([k]) => k !== 'metadata')) };
        await fs.promises.writeFile(w.filePath, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
        await this.host.stylesChanged();
        await this.reload(w.filePath);
        void window.setStatusBarMessage(`SQL Prompt: style "${this.nameOf(w)}" saved`, 3000);
    }

    private async confirmDiscard(): Promise<boolean> {
        const w = this.working;
        if (!w || !this.isDirty()) return true;
        const answer = await window.showWarningMessage(
            `The style "${this.nameOf(w)}" has unsaved changes.`, { modal: true }, 'Save', 'Discard');
        if (answer === 'Save') { await this.save(); return true; }
        return answer === 'Discard';
    }

    private async chooseFolder(): Promise<void> {
        const picked = await window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            openLabel: 'Use as styles folder',
        });
        if (!picked?.[0]) return;
        await this.host.setStylesFolder(picked[0].fsPath);
        await this.host.stylesChanged();
        await this.reload();
    }

    private async askName(prompt: string, value: string): Promise<string | undefined> {
        const name = await window.showInputBox({
            prompt, value,
            validateInput: v => {
                const t = v.trim();
                if (!t) return 'Enter a name';
                if (this.styles.some(s => s.name.toLowerCase() === t.toLowerCase())) return 'A style with this name already exists';
                return undefined;
            },
        });
        return name?.trim();
    }

    private async create(duplicate: boolean): Promise<void> {
        const folder = this.host.getStylesFolder();
        if (!folder) { await this.chooseFolder(); return; }
        if (!(await this.confirmDiscard())) return;
        const base = duplicate && this.working ? this.currentJson() : {};
        const name = await this.askName(duplicate ? 'Name of the copy' : 'Name of the new style',
            duplicate && this.working ? `${this.nameOf(this.working)} (copy)` : 'New style');
        if (!name) return;
        const json = { ...base, metadata: { id: crypto.randomUUID(), name, lastModified: new Date().toISOString() } };
        let filePath = path.join(folder, styleFileName(name));
        for (let i = 2; fs.existsSync(filePath); i++) filePath = path.join(folder, styleFileName(`${name} ${i}`));
        await fs.promises.writeFile(filePath, JSON.stringify(json, null, 2) + '\n', 'utf8');
        await this.host.stylesChanged();
        await this.reload(filePath);
    }

    private async rename(): Promise<void> {
        const w = this.working;
        if (!w) return;
        const oldName = this.nameOf(w);
        const name = await this.askName('New name of the style', oldName);
        if (!name || name === oldName) return;
        w.original = { ...w.original, metadata: { ...(w.original.metadata as object ?? {}), name } };
        await this.save();
        // lo stile attivo si riconosce dal nome: va aggiornato anche il riferimento
        if (this.host.getActiveStyleName() === oldName) await this.host.setActiveStyleName(name);
        this.sendState();
    }

    private async remove(): Promise<void> {
        const w = this.working;
        if (!w) return;
        const answer = await window.showWarningMessage(
            `Delete the style "${this.nameOf(w)}"? The file ${path.basename(w.filePath)} is moved to the trash.`,
            { modal: true }, 'Delete');
        if (answer !== 'Delete') return;
        await workspace.fs.delete(Uri.file(w.filePath), { useTrash: true });
        this.working = undefined;
        await this.host.stylesChanged();
        await this.reload();
    }

    private async activate(): Promise<void> {
        const w = this.working;
        if (!w) return;
        if (!(await this.confirmDiscard())) return;
        await this.host.setActiveStyleName(this.nameOf(w));
        this.sendState();
    }

    // ── HTML ──────────────────────────────────────────────────────────────────

    private html(): string {
        const webview = this.panel.webview;
        const media = Uri.joinPath(this.extensionUri, 'client', 'media');
        const script = webview.asWebviewUri(Uri.joinPath(media, 'styleEditor.js'));
        const css = webview.asWebviewUri(Uri.joinPath(media, 'styleEditor.css'));
        const nonce = crypto.randomBytes(16).toString('base64');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>SQL Formatting Styles</title>
</head>
<body>
<div id="app"><p class="loading">Loading styles…</p></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}
