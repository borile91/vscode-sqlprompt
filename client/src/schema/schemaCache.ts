/**
 * On-disk cache for the schema snapshot.
 *
 * The in-memory cache alone (a `Map` with a five minute TTL) is lost on every
 * window reload, which is exactly the situation users complain about: open VS
 * Code, open a `.sql` file, wait. Persisting the snapshot under the extension's
 * global storage turns the common case — reopening an unchanged database — into
 * one cheap catalogue query plus a file read.
 *
 * Validity is decided by `SchemaToken`, not by a TTL: an entry stays good for
 * as long as the database has not changed. `MAX_AGE_MS` only exists so that
 * abandoned entries eventually disappear.
 *
 * The snapshot is stored in its wire form, so restoring it is the same pair of
 * requests the live loader sends — no separate deserialisation path to keep in
 * step.
 */

import * as crypto from 'crypto';
import { Uri, workspace } from 'vscode';

import { WireSnapshot } from './wireFormat';
import { AtomicWriteFs, TEMP_FILE_SUFFIX, tempFileName, writeFileAtomic } from './atomicWrite';

/** `workspace.fs` nella forma richiesta dalla scrittura atomica. */
const workspaceFs: AtomicWriteFs<Uri> = {
    writeFile: (file, data) => Promise.resolve(workspace.fs.writeFile(file, data)),
    rename: (source, target) =>
        Promise.resolve(workspace.fs.rename(source, target, { overwrite: true })),
    delete: (file) => Promise.resolve(workspace.fs.delete(file)),
};

/** Un temporaneo più vecchio di così è orfano (scrittura interrotta) e va rimosso. */
const ORPHAN_TEMP_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Bumped whenever the shape of `WireSnapshot` or the packed record format
 * changes, so that entries written by an older version are ignored instead of
 * being unpacked into garbage.
 */
const CACHE_FORMAT_VERSION = 1;

/** Entries older than this are discarded on read and pruned on write. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** How many cached databases to keep before pruning the least recently written. */
const MAX_ENTRIES = 24;

/** Identity and change-detection token for one database. */
export interface SchemaToken {
    serverName: string;
    databaseName: string;
    objectCount: string;
    columnCount: string;
    /** ISO 8601 `MAX(modify_date)` over user objects, or '' when there are none. */
    maxModify: string;
}

interface CacheEntry {
    formatVersion: number;
    writtenAt: number;
    token: SchemaToken;
    snapshot: WireSnapshot;
}

/** True when both tokens describe the same database in the same state. */
export function tokensMatch(a: SchemaToken, b: SchemaToken): boolean {
    return (
        a.serverName === b.serverName &&
        a.databaseName === b.databaseName &&
        a.objectCount === b.objectCount &&
        a.columnCount === b.columnCount &&
        a.maxModify === b.maxModify
    );
}

/**
 * File name for a token's database. Server and database names can contain
 * anything a host name and an identifier allow, so they are hashed rather than
 * sanitised — the token inside the file is what actually identifies the entry.
 */
function entryFileName(token: SchemaToken): string {
    const hash = crypto
        .createHash('sha1')
        .update(`${token.serverName.toLowerCase()}\u0000${token.databaseName.toLowerCase()}`)
        .digest('hex');
    return `${hash}.json`;
}

export class SchemaDiskCache {
    private readonly directory: Uri;

    constructor(globalStorageUri: Uri) {
        this.directory = Uri.joinPath(globalStorageUri, 'schema-cache');
    }

    /**
     * Returns the cached snapshot for `token`'s database, but only if the
     * database is still in the state the entry was written for.
     *
     * Every failure path returns undefined: a missing, unreadable, truncated or
     * outdated entry is a cache miss, never an error the user should see.
     */
    async read(token: SchemaToken): Promise<WireSnapshot | undefined> {
        const file = Uri.joinPath(this.directory, entryFileName(token));

        let raw: Uint8Array;
        try {
            raw = await workspace.fs.readFile(file);
        } catch {
            return undefined;
        }

        let entry: CacheEntry;
        try {
            entry = JSON.parse(Buffer.from(raw).toString('utf8')) as CacheEntry;
        } catch {
            return undefined;
        }

        if (entry?.formatVersion !== CACHE_FORMAT_VERSION) {
            return undefined;
        }
        if (!entry.token || !tokensMatch(entry.token, token)) {
            return undefined;
        }
        if (typeof entry.writtenAt !== 'number' || Date.now() - entry.writtenAt > MAX_AGE_MS) {
            return undefined;
        }
        if (!Array.isArray(entry.snapshot?.objects)) {
            return undefined;
        }

        return entry.snapshot;
    }

    /** Stores `snapshot` for `token`'s database. Failures are logged, not thrown. */
    async write(token: SchemaToken, snapshot: WireSnapshot): Promise<void> {
        const entry: CacheEntry = {
            formatVersion: CACHE_FORMAT_VERSION,
            writtenAt: Date.now(),
            token,
            snapshot,
        };

        // Scrittura atomica (temporaneo + rename): due sync concorrenti sullo
        // stesso database non possono lasciare un JSON troncato.
        const fileName = entryFileName(token);
        try {
            await workspace.fs.createDirectory(this.directory);
            await writeFileAtomic(
                workspaceFs,
                Uri.joinPath(this.directory, fileName),
                Uri.joinPath(this.directory, tempFileName(fileName)),
                Buffer.from(JSON.stringify(entry), 'utf8'),
            );
        } catch (err: any) {
            console.error(`[SQL Prompt] schema cache write failed: ${err?.message ?? err}`);
            return;
        }

        void this.prune();
    }

    /** Drops the entry for `token`'s database, so the next sync reloads it. */
    async invalidate(token: SchemaToken): Promise<void> {
        try {
            await workspace.fs.delete(Uri.joinPath(this.directory, entryFileName(token)));
        } catch {
            // Nothing cached for this database — that is the desired end state.
        }
    }

    /**
     * Keeps the cache directory bounded: removes entries past `MAX_AGE_MS` and,
     * beyond `MAX_ENTRIES`, the least recently written ones.
     */
    private async prune(): Promise<void> {
        let names: [string, unknown][];
        try {
            names = (await workspace.fs.readDirectory(this.directory)) as [string, unknown][];
        } catch {
            return;
        }

        await this.removeOrphanTempFiles(
            names.map(([name]) => name).filter((name) => name.endsWith(TEMP_FILE_SUFFIX)),
        );

        const files = names
            .map(([name]) => name)
            .filter((name) => name.endsWith('.json'));
        if (files.length <= MAX_ENTRIES) {
            // Still worth dropping anything stale, but only when it is cheap to
            // do so; with few entries the stat calls below are the whole cost.
            if (files.length === 0) return;
        }

        const stats: Array<{ uri: Uri; mtime: number }> = [];
        for (const name of files) {
            const uri = Uri.joinPath(this.directory, name);
            try {
                const stat = await workspace.fs.stat(uri);
                stats.push({ uri, mtime: stat.mtime });
            } catch {
                // Removed underneath us; nothing to prune.
            }
        }

        const now = Date.now();
        const survivors = stats.filter((s) => now - s.mtime <= MAX_AGE_MS);
        const doomed = stats.filter((s) => now - s.mtime > MAX_AGE_MS);

        survivors.sort((a, b) => b.mtime - a.mtime);
        doomed.push(...survivors.slice(MAX_ENTRIES));

        for (const target of doomed) {
            try {
                await workspace.fs.delete(target.uri);
            } catch {
                // Best effort.
            }
        }
    }

    /**
     * Rimuove i temporanei lasciati da scritture interrotte (es. finestra chiusa
     * a metà). Quelli recenti possono appartenere a una scrittura in corso.
     */
    private async removeOrphanTempFiles(tempNames: string[]): Promise<void> {
        const now = Date.now();
        for (const name of tempNames) {
            const uri = Uri.joinPath(this.directory, name);
            try {
                const stat = await workspace.fs.stat(uri);
                if (now - stat.mtime > ORPHAN_TEMP_MAX_AGE_MS) {
                    await workspace.fs.delete(uri);
                }
            } catch {
                // Già rimosso o rinominato: nulla da fare.
            }
        }
    }
}
