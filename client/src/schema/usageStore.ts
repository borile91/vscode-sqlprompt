/**
 * What the user actually picks, remembered across sessions.
 *
 * Context tells the ranker which tables are *related* to the query; it cannot
 * tell it which tables this person works in every day. On a schema of two
 * thousand tables that second signal is the stronger one, and it is only
 * available by watching what gets accepted.
 *
 * The store lives on the extension host because that is the side with
 * `globalState`. The language server gets a decayed snapshot of it whenever it
 * changes, and does the ranking from there.
 *
 * Counts are kept per database rather than per server or globally: `dbo.Orders`
 * in EasyStock and in EasyMexs are different tables, and letting one teach the
 * ranker about the other would be worse than knowing nothing.
 */

import { Memento } from 'vscode';

const STORAGE_KEY = 'sqlPrompt.completionUsage';

/**
 * A use counts for half as much once this long has passed.
 *
 * Long enough that a table used steadily over a month keeps its place, short
 * enough that last quarter's project stops crowding out this one.
 */
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** Objects kept per database. The tail of the distribution is worth nothing. */
const MAX_ENTRIES_PER_DATABASE = 400;

/** Databases kept. Beyond this, the least recently used one is dropped. */
const MAX_DATABASES = 20;

interface UsageEntry {
    /** Accepted this many times. */
    n: number;
    /** Last accepted at this epoch millisecond. */
    t: number;
}

type DatabaseUsage = Record<string, UsageEntry>;
type UsageStore = Record<string, DatabaseUsage>;

/** Cache key for one database, matching the schema cache's identity. */
export function usageDatabaseKey(serverName: string, databaseName: string): string {
    return `${serverName.toLowerCase()}::${databaseName.toLowerCase()}`;
}

/** Case-insensitive `schema.name`, matching the server's `rankingKey`. */
export function usageObjectKey(schema: string, name: string): string {
    return `${schema.toLowerCase()}.${name.toLowerCase()}`;
}

export class CompletionUsageStore {
    private store: UsageStore;

    constructor(private readonly state: Memento) {
        this.store = { ...(state.get<UsageStore>(STORAGE_KEY) ?? {}) };
    }

    /**
     * Records one accepted completion.
     *
     * `objectKey` is trusted to be normalised already: it comes back from the
     * completion item the language server built, not from user input.
     */
    record(databaseKey: string, objectKey: string): void {
        const database = this.store[databaseKey] ?? {};
        const existing = database[objectKey];

        database[objectKey] = {
            n: (existing?.n ?? 0) + 1,
            t: Date.now(),
        };
        this.store[databaseKey] = database;
    }

    /**
     * The decayed score per object for one database, ready for the ranker.
     *
     * Decay is applied here rather than being written back into the counts, so
     * that a long gap between sessions weakens a table's standing without ever
     * destroying the history behind it.
     */
    scores(databaseKey: string): Array<[string, number]> {
        const database = this.store[databaseKey];
        if (!database) return [];

        const now = Date.now();
        const entries: Array<[string, number]> = [];

        for (const [objectKey, entry] of Object.entries(database)) {
            if (typeof entry?.n !== 'number' || typeof entry?.t !== 'number') continue;

            const age = Math.max(0, now - entry.t);
            const score = entry.n * Math.pow(0.5, age / HALF_LIFE_MS);
            // Below this a table has effectively not been used: sending it
            // would only grow the payload.
            if (score >= 0.05) {
                entries.push([objectKey, score]);
            }
        }

        return entries;
    }

    /**
     * Persists the store, pruning it first.
     *
     * Pruning on the way out keeps `globalState` from growing without bound
     * across every database a developer ever opens, and it is the only place
     * that needs to walk the whole store.
     */
    async persist(): Promise<void> {
        this.prune();
        await this.state.update(STORAGE_KEY, this.store);
    }

    private prune(): void {
        const now = Date.now();

        for (const [databaseKey, database] of Object.entries(this.store)) {
            const ranked = Object.entries(database)
                .filter(([, entry]) => typeof entry?.n === 'number' && typeof entry?.t === 'number')
                .sort((a, b) => {
                    const scoreOf = (entry: UsageEntry) =>
                        entry.n * Math.pow(0.5, Math.max(0, now - entry.t) / HALF_LIFE_MS);
                    return scoreOf(b[1]) - scoreOf(a[1]);
                })
                .slice(0, MAX_ENTRIES_PER_DATABASE);

            if (ranked.length === 0) {
                delete this.store[databaseKey];
                continue;
            }
            this.store[databaseKey] = Object.fromEntries(ranked);
        }

        const databaseKeys = Object.keys(this.store);
        if (databaseKeys.length <= MAX_DATABASES) return;

        /** The most recent use in a database, as its recency. */
        const lastUsed = (database: DatabaseUsage) =>
            Object.values(database).reduce((latest, entry) => Math.max(latest, entry.t), 0);

        databaseKeys
            .sort((a, b) => lastUsed(this.store[b]) - lastUsed(this.store[a]))
            .slice(MAX_DATABASES)
            .forEach((key) => delete this.store[key]);
    }
}
