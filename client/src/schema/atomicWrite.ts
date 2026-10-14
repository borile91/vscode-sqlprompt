/**
 * Scrittura atomica di un file: contenuto in un file temporaneo, poi rename
 * sul nome definitivo.
 *
 * Il rename sostituisce il file in un colpo solo, quindi due scritture
 * concorrenti sullo stesso file lasciano l'una o l'altra versione intera,
 * mai un JSON troncato o mescolato.
 *
 * Nessuna dipendenza da `vscode`: il file system arriva dall'esterno, così la
 * logica è testabile con `fs` di Node.
 */

/** Il minimo di file system che serve, per un identificativo di file `F`. */
export interface AtomicWriteFs<F> {
    writeFile(file: F, data: Uint8Array): Promise<void>;
    /** Deve sovrascrivere `target` se esiste già. */
    rename(source: F, target: F): Promise<void>;
    delete(file: F): Promise<void>;
}

/** Suffisso dei file temporanei, per riconoscerli (es. orfani da pulire). */
export const TEMP_FILE_SUFFIX = '.tmp';

/** Nome temporaneo univoco accanto a `fileName`: uno per ogni scrittura. */
export function tempFileName(fileName: string): string {
    const unique = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `${fileName}.${unique}${TEMP_FILE_SUFFIX}`;
}

/**
 * Scrive `data` su `temp` e poi lo rinomina in `target`.
 * In caso di errore il temporaneo viene rimosso e l'errore rilanciato.
 */
export async function writeFileAtomic<F>(
    fs: AtomicWriteFs<F>,
    target: F,
    temp: F,
    data: Uint8Array,
): Promise<void> {
    try {
        await fs.writeFile(temp, data);
        await fs.rename(temp, target);
    } catch (err) {
        try {
            await fs.delete(temp);
        } catch {
            // Già assente: nulla da pulire.
        }
        throw err;
    }
}
