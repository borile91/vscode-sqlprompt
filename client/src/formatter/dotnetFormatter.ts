import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { commands, extensions } from 'vscode';
import type { SqlPromptStyleJson } from './styleLoader';

// Motore di formattazione .NET (formatter-engine/, parser ScriptDom) eseguito come processo
// separato: una richiesta JSON per riga su stdin, una risposta per riga su stdout.

export interface DotnetFormatError {
    line: number;
    column: number;
    message: string;
}

export type DotnetFormatResult =
    | { ok: true; text: string }
    | { ok: false; errors: DotnetFormatError[] };

interface Pending {
    resolve: (r: DotnetFormatResult) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}

const RUNTIME_VERSION = '10.0';
const REQUEST_TIMEOUT_MS = 15000;

export class DotnetFormatterHost {
    private process: ChildProcessWithoutNullStreams | undefined;
    private starting: Promise<ChildProcessWithoutNullStreams> | undefined;
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    private buffer = '';

    constructor(
        private readonly extensionPath: string,
        private readonly extensionId: string,
        private readonly getDotnetPath: () => string,
    ) {}

    /** Percorso della DLL del sidecar pubblicata nel pacchetto dell'estensione. */
    get enginePath(): string {
        return path.join(this.extensionPath, 'client', 'dist', 'formatter-engine', 'SqlFormatter.Sidecar.dll');
    }

    async format(sql: string, style: SqlPromptStyleJson): Promise<DotnetFormatResult> {
        const proc = await this.ensureStarted();
        const id = this.nextId++;
        return new Promise<DotnetFormatResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('il motore .NET non ha risposto in tempo'));
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            proc.stdin.write(JSON.stringify({ id, sql, style }) + '\n');
        });
    }

    dispose(): void {
        this.failAll(new Error('motore .NET chiuso'));
        this.process?.kill();
        this.process = undefined;
        this.starting = undefined;
    }

    private ensureStarted(): Promise<ChildProcessWithoutNullStreams> {
        if (this.process && this.process.exitCode === null) return Promise.resolve(this.process);
        if (!this.starting) {
            this.starting = this.start().finally(() => (this.starting = undefined));
        }
        return this.starting;
    }

    private async start(): Promise<ChildProcessWithoutNullStreams> {
        if (!fs.existsSync(this.enginePath)) {
            throw new Error(`motore .NET non trovato in ${this.enginePath}`);
        }
        const dotnet = await this.resolveDotnet();
        const proc = spawn(dotnet, [this.enginePath], { stdio: 'pipe' });
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (chunk: string) => this.onData(chunk));
        proc.stderr.on('data', (chunk: Buffer) => console.error(`[SQL Prompt] motore .NET: ${chunk.toString()}`));
        proc.on('exit', (code) => {
            if (this.process === proc) this.process = undefined;
            this.failAll(new Error(`il motore .NET è terminato (codice ${code})`));
        });
        await new Promise<void>((resolve, reject) => {
            proc.once('spawn', () => resolve());
            proc.once('error', (err) => reject(err));
        });
        this.process = proc;
        return proc;
    }

    /**
     * Runtime .NET: percorso configurato, poi quello ottenuto dall'estensione Microsoft
     * ".NET Install Tool" (se installata), infine `dotnet` dal PATH.
     */
    private async resolveDotnet(): Promise<string> {
        const configured = this.getDotnetPath();
        if (configured) return configured;
        if (extensions.getExtension('ms-dotnettools.vscode-dotnet-runtime')) {
            try {
                const result = await commands.executeCommand<{ dotnetPath?: string }>('dotnet.acquire', {
                    version: RUNTIME_VERSION,
                    requestingExtensionId: this.extensionId,
                });
                if (result?.dotnetPath) return result.dotnetPath;
            } catch (err: any) {
                console.error(`[SQL Prompt] acquisizione del runtime .NET fallita: ${err?.message ?? err}`);
            }
        }
        return 'dotnet';
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        let newline: number;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (line) this.onResponse(line);
        }
    }

    private onResponse(line: string): void {
        let response: any;
        try {
            response = JSON.parse(line);
        } catch {
            console.error(`[SQL Prompt] risposta non valida dal motore .NET: ${line}`);
            return;
        }
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        pending.resolve(
            response.ok
                ? { ok: true, text: String(response.text ?? '') }
                : { ok: false, errors: Array.isArray(response.errors) ? response.errors : [] },
        );
    }

    private failAll(err: Error): void {
        for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(err);
            this.pending.delete(id);
        }
    }
}
