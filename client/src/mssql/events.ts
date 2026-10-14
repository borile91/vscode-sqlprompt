/** Eventi e disposable minimi, senza dipendenza da `vscode`. */

import { Disposable, Event } from './mssqlApi';

/** Un `Event<void>` minimale, senza `vscode`. */
export class SimpleEmitter {
    private readonly listeners = new Set<() => unknown>();

    readonly event: Event<void> = (listener) => {
        const wrapped = () => listener(undefined);
        this.listeners.add(wrapped);
        return { dispose: () => this.listeners.delete(wrapped) };
    };

    fire(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch {
                // Un listener che fallisce non ferma gli altri.
            }
        }
    }

    clear(): void {
        this.listeners.clear();
    }
}

/** Chiude una lista di disposable ignorando gli errori. */
export function disposeAll(disposables: Disposable[]): void {
    for (const d of disposables.splice(0)) {
        try {
            d.dispose();
        } catch {
            // Ignora.
        }
    }
}
