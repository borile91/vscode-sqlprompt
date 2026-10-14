import type { RoutineSnapshot, TableInfo } from './schemaLoader';

export type AlterObjectKind = 'procedure' | 'view' | 'function';

export interface ModuleName {
  schema: string;
  name: string;
}

/**
 * Oggetti di un tipo presi dallo snapshot del server, per l'ALTER scaffolding
 * in modalità connessione diretta (senza connectionSharing il client non può
 * interrogare sys.objects).
 *
 * Le viste di altri database (caricate a richiesta) sono escluse: `database` è
 * quello connesso, se noto.
 */
export function listModulesFromSnapshot(
  kind: AlterObjectKind,
  tables: readonly TableInfo[],
  routines: RoutineSnapshot,
  database?: string,
): ModuleName[] {
  let modules: ModuleName[];
  if (kind === 'view') {
    const db = database?.toLowerCase();
    modules = tables
      .filter((t) => t.isView && (!db || !t.database || t.database.toLowerCase() === db))
      .map((t) => ({ schema: t.schema, name: t.name }));
  } else if (kind === 'procedure') {
    modules = routines.storedProcedures.map((p) => ({ schema: p.schema, name: p.name }));
  } else {
    modules = [...routines.scalarFunctions, ...routines.tableValuedFunctions].map((f) => ({
      schema: f.schema,
      name: f.name,
    }));
  }
  const seen = new Set<string>();
  return modules
    .filter((m) => {
      const key = `${m.schema.toLowerCase()}.${m.name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
}
