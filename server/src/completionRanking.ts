/**
 * Ranking of schema-object completions.
 *
 * The old ranking was a pair of string prefixes: FK-related tables in group
 * `0`, everything else in group `1`, alphabetical within each. On a database
 * with a couple of thousand tables that means the first thing offered is
 * whatever starts with `A`.
 *
 * Two things had to change for a ranking to actually be visible.
 *
 * **A real score.** Every candidate is scored from the query around the cursor
 * — how it relates to the tables already in the statement, what schema it is
 * in, how its name compares to the identifiers already written — plus how often
 * the user has picked it before.
 *
 * **A `sortText` that VS Code honours.** VS Code ranks by its own fuzzy match
 * score first and only falls back to `sortText` for items that score the same,
 * so the score has to be encoded as a total order inside one band rather than
 * spread across coarse prefixes. `sortText` is `NN_DDDD_name`: a band that
 * keeps unrelated item classes apart, then the score, zero-padded and
 * inverted so that a higher score sorts earlier, then the name to break ties
 * deterministically.
 */

import { TableInfo } from './schemaLoader';

/** What kind of thing is being offered; each kind carries its own base score. */
export type ObjectKind = 'table' | 'view' | 'tableValuedFunction' | 'cte';

/** Widest score the encoder can represent. Scores are clamped to it. */
const SCORE_CEILING = 9999;

// ── Weights ───────────────────────────────────────────────────────────────────
//
// These are ordered by how strong a signal they are, not tuned to a benchmark.
// A direct foreign key to a table already in the query outweighs everything
// else because it is very nearly a statement of intent; usage history is next,
// because what the user picked yesterday is what they usually want today.

/** Tied by a foreign key to a table in the statement, in either direction. */
const W_FK_DIRECT = 4000;
/** Reachable through one intermediate table. */
const W_FK_TWO_HOP = 1400;
/** Same schema as a table already in the statement. */
const W_SCHEMA_AFFINITY = 600;
/** Shares a name token with a table already in the statement. */
const W_TOKEN_AFFINITY = 900;
/** Ceiling for the usage-history contribution. */
const W_USAGE = 3000;
/** Ceiling for the "many tables point at this one" contribution. */
const W_HUB = 400;

/** Base score per object kind. */
const W_KIND: Record<ObjectKind, number> = {
    // A CTE is defined in this very statement, so it is almost certainly what
    // the user is reaching for.
    cte: 800,
    table: 400,
    view: 150,
    tableValuedFunction: 0,
};

/** Charged against names that look like leftovers rather than working tables. */
const P_NOISE = 2500;

/**
 * Names that are almost never what someone is typing a query against.
 *
 * A penalty, deliberately, and not a filter: a backup table is still a real
 * table and still has to be reachable — it just should not come first.
 */
const NOISE_PATTERNS: RegExp[] = [
    /(^|[_\s])(bak|backup|old|tmp|temp|copy|test|delete|deleted|obsolete)([_\s]|$)/i,
    /_(bak|backup|old|tmp|temp|copy|new)\d*$/i,
    /_\d{6,8}$/, // a date stamp: Orders_20240131
    /^z_/i,
];

/**
 * Prefixes that mark a leftover — but only when the prefix is a word of its own.
 *
 * `Templates` and `Bakeries` start with `temp` and `bak` and are perfectly
 * ordinary tables, so the prefix only counts when what follows it is not a
 * lowercase letter: `tmpImport` and `TEMP_ORDERS` qualify, `Templates` does
 * not. A case-insensitive regex cannot express that — `/i` would make the
 * lookahead ignore case too — so it is a plain check instead.
 */
const NOISE_PREFIXES = ['tmp', 'temp', 'bak', 'zz'];

function hasNoisePrefix(name: string): boolean {
    const lower = name.toLowerCase();
    return NOISE_PREFIXES.some((prefix) => {
        if (!lower.startsWith(prefix)) return false;
        const next = name.charAt(prefix.length);
        return next === '' || !/[a-z]/.test(next);
    });
}

/**
 * How many uses it takes to earn most of `W_USAGE`.
 *
 * The curve saturates, so the difference between "never used" and "used a few
 * times" is large while the difference between 20 and 40 uses is not — which is
 * how the signal actually behaves.
 */
const USAGE_HALF_LIFE = 3;

// ── Inputs ────────────────────────────────────────────────────────────────────

export interface RankingInputs {
    /** Tables already referenced in the statement being typed. */
    inScope: TableInfo[];
    /** Every known table, for foreign key adjacency and hub-ness. */
    tables: TableInfo[];
    /**
     * Usage score per lowercase `schema.name`, already decayed by the client.
     * Absent keys score zero.
     */
    usage?: ReadonlyMap<string, number>;
}

export interface ObjectRanker {
    /** Score for one candidate; higher is a better suggestion. */
    score(schema: string, name: string, kind: ObjectKind): number;
    /** `sortText` that makes VS Code order candidates by that score. */
    sortText(schema: string, name: string, kind: ObjectKind): string;
    /** True when at least one candidate can be told apart from the rest. */
    readonly hasContext: boolean;
}

/** Case-insensitive `schema.name` key. */
export function rankingKey(schema: string, name: string): string {
    return `${schema.toLowerCase()}.${name.toLowerCase()}`;
}

// ── Name tokens ───────────────────────────────────────────────────────────────

/**
 * Splits an identifier into comparable tokens.
 *
 * `PRESTITI_DETTAGLIO` and `OrderDetails` both have to break apart, so the split
 * handles underscores and CamelCase alike.
 *
 * Two normalisations earn their keep:
 *
 *  - **A trailing `s` is dropped** from tokens long enough to survive it. The
 *    single most common shape in a real schema is a plural parent next to a
 *    singular-prefixed child — `Orders` and `OrderLines` — and without this the
 *    two share no token at all, which is exactly backwards.
 *  - **Tokens under three characters go**. `Id`, `No` and `Cd` appear in nearly
 *    every name, so keeping them would make everything look related to
 *    everything.
 */
export function nameTokens(name: string): string[] {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .map((token) => token.toLowerCase())
        .filter((token) => token.length >= 3)
        .map((token) => (token.length >= 4 && token.endsWith('s') ? token.slice(0, -1) : token));
}

/** True when `name` matches one of the leftover-table patterns. */
export function looksLikeNoise(name: string): boolean {
    return hasNoisePrefix(name) || NOISE_PATTERNS.some((pattern) => pattern.test(name));
}

// ── Foreign key graph ─────────────────────────────────────────────────────────

/**
 * Undirected adjacency over the foreign keys, plus how many keys point at each
 * table.
 *
 * Undirected because a JOIN reads the same either way: from an order you want
 * its customer, and from a customer you want their orders.
 */
function buildForeignKeyGraph(tables: TableInfo[]): {
    adjacency: Map<string, Set<string>>;
    referencedBy: Map<string, number>;
} {
    const adjacency = new Map<string, Set<string>>();
    const referencedBy = new Map<string, number>();

    const link = (a: string, b: string) => {
        let neighbours = adjacency.get(a);
        if (!neighbours) {
            neighbours = new Set<string>();
            adjacency.set(a, neighbours);
        }
        neighbours.add(b);
    };

    for (const table of tables) {
        const from = rankingKey(table.schema, table.name);
        for (const fk of table.foreignKeys ?? []) {
            const to = rankingKey(fk.referencedSchema, fk.referencedTable);
            if (to === from) continue; // a self-reference tells us nothing
            link(from, to);
            link(to, from);
            referencedBy.set(to, (referencedBy.get(to) ?? 0) + 1);
        }
    }

    return { adjacency, referencedBy };
}

/**
 * Hop count from the tables in scope to every table within two hops.
 *
 * Two hops is the useful limit: one hop is a direct relationship, two covers
 * the junction-table case (`Orders → OrderProducts → Products`), and beyond
 * that almost every table in a normalised schema is reachable, which would make
 * the signal meaningless.
 */
function buildDistanceMap(
    adjacency: Map<string, Set<string>>,
    inScopeKeys: Set<string>,
): Map<string, number> {
    const distance = new Map<string, number>();
    if (inScopeKeys.size === 0) return distance;

    let frontier = Array.from(inScopeKeys);
    for (let hop = 1; hop <= 2 && frontier.length > 0; hop++) {
        const next: string[] = [];
        for (const key of frontier) {
            for (const neighbour of adjacency.get(key) ?? []) {
                if (inScopeKeys.has(neighbour) || distance.has(neighbour)) continue;
                distance.set(neighbour, hop);
                next.push(neighbour);
            }
        }
        frontier = next;
    }

    return distance;
}

// ── The ranker ────────────────────────────────────────────────────────────────

export function buildObjectRanker(inputs: RankingInputs): ObjectRanker {
    const { adjacency, referencedBy } = buildForeignKeyGraph(inputs.tables);

    const inScopeKeys = new Set(
        inputs.inScope.map((table) => rankingKey(table.schema, table.name)),
    );
    const distance = buildDistanceMap(adjacency, inScopeKeys);

    const inScopeSchemas = new Set(
        inputs.inScope.map((table) => table.schema.toLowerCase()),
    );
    const inScopeTokens = new Set(
        inputs.inScope.flatMap((table) => nameTokens(table.name)),
    );

    const usage = inputs.usage;

    /** The largest `referencedBy` count, so hub-ness can be scaled to it. */
    let hubCeiling = 0;
    for (const count of referencedBy.values()) {
        if (count > hubCeiling) hubCeiling = count;
    }

    const hasContext =
        inScopeKeys.size > 0 || (usage !== undefined && usage.size > 0);

    const score = (schema: string, name: string, kind: ObjectKind): number => {
        let total = W_KIND[kind];

        // A CTE has no schema, no foreign keys and no history: its base score is
        // the whole story.
        if (kind === 'cte') {
            return total;
        }

        const key = rankingKey(schema, name);

        const hops = distance.get(key);
        if (hops === 1) {
            total += W_FK_DIRECT;
        } else if (hops === 2) {
            total += W_FK_TWO_HOP;
        }

        if (inScopeSchemas.has(schema.toLowerCase())) {
            total += W_SCHEMA_AFFINITY;
        }

        if (inScopeTokens.size > 0) {
            const shared = nameTokens(name).some((token) => inScopeTokens.has(token));
            if (shared) total += W_TOKEN_AFFINITY;
        }

        if (usage) {
            const uses = usage.get(key) ?? 0;
            if (uses > 0) {
                // Saturating: 1 - 0.5^(uses / half-life).
                total += Math.round(W_USAGE * (1 - Math.pow(0.5, uses / USAGE_HALF_LIFE)));
            }
        }

        if (hubCeiling > 0) {
            const incoming = referencedBy.get(key) ?? 0;
            total += Math.round((W_HUB * incoming) / hubCeiling);
        }

        if (looksLikeNoise(name)) {
            total -= P_NOISE;
        }

        return Math.max(0, Math.min(SCORE_CEILING, total));
    };

    return {
        score,
        hasContext,
        sortText: (schema, name, kind) =>
            encodeSortText(TABLE_SOURCE_BAND, score(schema, name, kind), name),
    };
}

// ── sortText encoding ─────────────────────────────────────────────────────────

/**
 * Band for everything that can follow a table-introducing keyword.
 *
 * Tables, views, table-valued functions and CTEs compete with each other, so
 * they share one band and are separated by score alone. The bands around it
 * keep item classes that are not comparable from interleaving: `00_` for
 * databases, `01_` for the statement snippets (`ssf`, `OUTER APPLY`), which
 * stay ahead of any schema object because the user typed their exact name, and
 * `02_` for columns and values.
 *
 * The trailing letter is what puts this band after `01_`: comparing `01_` with
 * `01a`, the underscore is the lower character, so `01_snippet_ssf` still sorts
 * first — the ordering snippets had before this band existed.
 */
export const TABLE_SOURCE_BAND = '01a';

/**
 * `NN_DDDD_name`, where `DDDD` is `SCORE_CEILING - score`.
 *
 * Inverting the score is what lets a plain lexicographic sort — which is all
 * `sortText` gets — put the best candidate first. The trailing name makes the
 * order stable between two candidates that score identically, which is the
 * common case on a schema with no foreign keys.
 */
export function encodeSortText(band: string, score: number, name: string): string {
    const clamped = Math.max(0, Math.min(SCORE_CEILING, Math.round(score)));
    const inverted = String(SCORE_CEILING - clamped).padStart(4, '0');
    return `${band}_${inverted}_${name.toLowerCase()}`;
}
