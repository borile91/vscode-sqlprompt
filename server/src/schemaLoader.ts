import * as sql from 'mssql';

export interface ColumnInfo {
  name: string;
  dataType: string;
  maxLength: number | null;
  isNullable: boolean;
  isPrimaryKey: boolean;
}

export interface TableInfo {
    /** The database this table belongs to. Populated for cross-database schemas. */
    database?: string;
  schema: string;
  name: string;
  columns: ColumnInfo[];
    foreignKeys: ForeignKeyInfo[];
}

export interface ForeignKeyMapping {
    column: string;
    referencedColumn: string;
}

export interface ForeignKeyInfo {
    name: string;
    parentSchema: string;
    parentTable: string;
    referencedSchema: string;
    referencedTable: string;
    mappings: ForeignKeyMapping[];
}

export interface ConnectionConfig {
  server: string;
  database: string;
  user?: string;
  password?: string;
  port?: number;
  trustServerCertificate?: boolean;
}

export interface RoutineParameterInfo {
    name: string;
    dataType: string;
    maxLength: number | null;
    precision: number | null;
    scale: number | null;
    isOutput: boolean;
    hasDefaultValue: boolean;
}

export interface ScalarFunctionInfo {
    schema: string;
    name: string;
    parameters: RoutineParameterInfo[];
}

export interface TableValuedFunctionInfo {
    schema: string;
    name: string;
    parameters: RoutineParameterInfo[];
}

export interface StoredProcedureInfo {
    schema: string;
    name: string;
    parameters: RoutineParameterInfo[];
}

export interface RoutineSnapshot {
    scalarFunctions: ScalarFunctionInfo[];
    tableValuedFunctions: TableValuedFunctionInfo[];
    storedProcedures: StoredProcedureInfo[];
}

export class SchemaLoader {
    private pool: sql.ConnectionPool | null = null;
    private config: ConnectionConfig | null;
    private connectionString: string | null;

    constructor(config: ConnectionConfig | string) {
        if (typeof config === "string") {
            this.connectionString = config;
            this.config = null;
        } else {
            this.config = config;
            this.connectionString = null;
        }
    }

    async connect(): Promise<void> {
        if (this.pool) {
            await this.pool.close();
            this.pool = null;
        }

        if (this.connectionString) {
            // Append TrustServerCertificate if not already present so that
            // self-signed certificates on localhost don't cause a connection failure.
            let connStr = this.connectionString;
            if (!/TrustServerCertificate\s*=/i.test(connStr)) {
                connStr += connStr.includes(';') ? ';TrustServerCertificate=true' : ';TrustServerCertificate=true';
            }
            this.pool = await sql.connect(connStr);
            return;
        }

        if (!this.config) {
            throw new Error("No connection configuration provided");
        }

        const sqlConfig: sql.config = {
            server: this.config.server,
            database: this.config.database,
            port: this.config.port || 1433,
            options: {
                encrypt: false,
                trustServerCertificate:
                    this.config.trustServerCertificate ?? true,
            },
        };

        // Use Windows Auth if no user provided
        if (this.config.user) {
            sqlConfig.user = this.config.user;
            sqlConfig.password = this.config.password || "";
        } else {
            // Windows Authentication
            sqlConfig.authentication = {
                type: "default",
                options: {
                    userName: "",
                    password: "",
                },
            };
        }

        this.pool = await sql.connect(sqlConfig);
    }

    async disconnect(): Promise<void> {
        if (this.pool) {
            await this.pool.close();
            this.pool = null;
        }
    }

    async loadSchema(): Promise<TableInfo[]> {
        if (!this.pool) {
            throw new Error("Not connected to database");
        }

        const currentDbResult = await this.pool.request().query('SELECT DB_NAME() AS current_db');
        const currentDatabase = currentDbResult.recordset[0]?.current_db as string | undefined;

        const result = await this.pool.request().query(`
            WITH schema_objects AS (
                SELECT
                    o.object_id,
                    o.schema_id,
                    o.name,
                    o.type
                FROM sys.objects o
                WHERE o.type IN ('U', 'V')
                    AND o.is_ms_shipped = 0
            )
            SELECT
                s.name AS schema_name,
                so.name AS table_name,
                c.name AS column_name,
                ty.name AS data_type,
                c.max_length,
                c.is_nullable,
                CASE WHEN so.type = 'U' AND pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key
            FROM schema_objects so
            INNER JOIN sys.schemas s ON so.schema_id = s.schema_id
            INNER JOIN sys.columns c ON so.object_id = c.object_id
            INNER JOIN sys.types ty ON c.user_type_id = ty.user_type_id
            LEFT JOIN (
                SELECT ic.object_id, ic.column_id
                FROM sys.index_columns ic
                INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                WHERE i.is_primary_key = 1
            ) pk ON so.object_id = pk.object_id AND c.column_id = pk.column_id
            ORDER BY s.name, so.name, c.column_id
        `);

        const tableMap = new Map<string, TableInfo>();

        for (const row of result.recordset) {
            const key = `${row.schema_name}.${row.table_name}`;
            if (!tableMap.has(key)) {
                tableMap.set(key, {
                    database: currentDatabase,
                    schema: row.schema_name,
                    name: row.table_name,
                    columns: [],
                    foreignKeys: [],
                });
            }

            tableMap.get(key)!.columns.push({
                name: row.column_name,
                dataType: row.data_type,
                maxLength: row.max_length,
                isNullable: row.is_nullable,
                isPrimaryKey: row.is_primary_key === 1,
            });
        }

        const fkResult = await this.pool.request().query(`
      SELECT
        fk.name AS fk_name,
        sch_parent.name AS parent_schema,
        t_parent.name AS parent_table,
        c_parent.name AS parent_column,
        sch_ref.name AS referenced_schema,
        t_ref.name AS referenced_table,
        c_ref.name AS referenced_column,
        fkc.constraint_column_id
      FROM sys.foreign_keys fk
      INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
      INNER JOIN sys.tables t_parent ON fkc.parent_object_id = t_parent.object_id
      INNER JOIN sys.schemas sch_parent ON t_parent.schema_id = sch_parent.schema_id
      INNER JOIN sys.columns c_parent ON fkc.parent_object_id = c_parent.object_id AND fkc.parent_column_id = c_parent.column_id
      INNER JOIN sys.tables t_ref ON fkc.referenced_object_id = t_ref.object_id
      INNER JOIN sys.schemas sch_ref ON t_ref.schema_id = sch_ref.schema_id
      INNER JOIN sys.columns c_ref ON fkc.referenced_object_id = c_ref.object_id AND fkc.referenced_column_id = c_ref.column_id
      ORDER BY sch_parent.name, t_parent.name, fk.name, fkc.constraint_column_id
    `);

        const fkMap = new Map<string, ForeignKeyInfo>();

        for (const row of fkResult.recordset) {
            const parentKey = `${row.parent_schema}.${row.parent_table}`;
            const table = tableMap.get(parentKey);
            if (!table) {
                continue;
            }

            const fkKey = `${parentKey}.${row.fk_name}`;
            if (!fkMap.has(fkKey)) {
                fkMap.set(fkKey, {
                    name: row.fk_name,
                    parentSchema: row.parent_schema,
                    parentTable: row.parent_table,
                    referencedSchema: row.referenced_schema,
                    referencedTable: row.referenced_table,
                    mappings: [],
                });
            }

            fkMap.get(fkKey)!.mappings.push({
                column: row.parent_column,
                referencedColumn: row.referenced_column,
            });
        }

        for (const fk of fkMap.values()) {
            const tableKey = `${fk.parentSchema}.${fk.parentTable}`;
            const table = tableMap.get(tableKey);
            if (table) {
                table.foreignKeys.push(fk);
            }
        }

        console.log(`Loaded schema: ${tableMap.size} tables`);

        return Array.from(tableMap.values());
    }

    async loadRoutines(): Promise<RoutineSnapshot> {
        if (!this.pool) {
            throw new Error("Not connected to database");
        }

        const result = await this.pool.request().query(`
      SELECT
        s.name AS schema_name,
        o.name AS routine_name,
        o.type AS object_type,
        p.parameter_id,
        p.name AS parameter_name,
        ty.name AS data_type,
        p.max_length,
        p.precision,
        p.scale,
        p.is_output,
        p.has_default_value
      FROM sys.objects o
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      LEFT JOIN sys.parameters p ON o.object_id = p.object_id AND p.parameter_id > 0
      LEFT JOIN sys.types ty ON p.user_type_id = ty.user_type_id
      WHERE o.type IN ('FN', 'FS', 'FT', 'IF', 'TF', 'P', 'PC')
        AND o.is_ms_shipped = 0
      ORDER BY s.name, o.name, p.parameter_id
    `);

        type RoutineEntry = {
            schema: string;
            name: string;
            objectType: string;
            parameters: RoutineParameterInfo[];
        };

        const routineMap = new Map<string, RoutineEntry>();

        for (const row of result.recordset) {
            const schemaName = row.schema_name as string;
            const routineName = row.routine_name as string;
            const objectType = row.object_type as string;
            const key = `${schemaName}.${routineName}::${objectType}`;

            if (!routineMap.has(key)) {
                routineMap.set(key, {
                    schema: schemaName,
                    name: routineName,
                    objectType,
                    parameters: [],
                });
            }

            if (row.parameter_name) {
                routineMap.get(key)!.parameters.push({
                    name: row.parameter_name,
                    dataType: row.data_type ?? 'unknown',
                    maxLength: typeof row.max_length === 'number' ? row.max_length : null,
                    precision: typeof row.precision === 'number' ? row.precision : null,
                    scale: typeof row.scale === 'number' ? row.scale : null,
                    isOutput: row.is_output === true || row.is_output === 1,
                    hasDefaultValue: row.has_default_value === true || row.has_default_value === 1,
                });
            }
        }

        const scalarFunctions: ScalarFunctionInfo[] = [];
        const tableValuedFunctions: TableValuedFunctionInfo[] = [];
        const storedProcedures: StoredProcedureInfo[] = [];

        for (const routine of routineMap.values()) {
            if (routine.objectType === 'FN' || routine.objectType === 'FS' || routine.objectType === 'FT') {
                scalarFunctions.push({
                    schema: routine.schema,
                    name: routine.name,
                    parameters: routine.parameters,
                });
                continue;
            }

            if (routine.objectType === 'IF' || routine.objectType === 'TF') {
                tableValuedFunctions.push({
                    schema: routine.schema,
                    name: routine.name,
                    parameters: routine.parameters,
                });
                continue;
            }

            if (routine.objectType === 'P' || routine.objectType === 'PC') {
                storedProcedures.push({
                    schema: routine.schema,
                    name: routine.name,
                    parameters: routine.parameters,
                });
            }
        }

        return { scalarFunctions, tableValuedFunctions, storedProcedures };
    }

    /**
     * Returns the T-SQL definition for views, stored procedures, and functions
     * from sys.sql_modules. Returns null for user tables (which have no sql_modules entry).
     */
    async getObjectScript(schema: string, name: string): Promise<string | null> {
        if (!this.pool) {
            throw new Error("Not connected to database");
        }

        const result = await this.pool.request()
            .input('schema', sql.NVarChar, schema)
            .input('name', sql.NVarChar, name)
            .query(`
                SELECT sm.definition
                FROM sys.sql_modules sm
                INNER JOIN sys.objects o ON sm.object_id = o.object_id
                INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                WHERE s.name = @schema AND o.name = @name
            `);

        if (result.recordset.length > 0) {
            return result.recordset[0].definition as string;
        }
        return null;
    }

    async loadDatabases(): Promise<string[]> {
        if (!this.pool) {
            throw new Error("Not connected to database");
        }

        const result = await this.pool.request().query(`
            SELECT name
            FROM sys.databases
            WHERE state_desc = 'ONLINE'
            ORDER BY name
        `);

        return result.recordset.map((row: { name: string }) => row.name);
    }

    /**
     * Loads tables and columns for a specific database using cross-database
     * sys catalog access (`[database].sys.objects` etc.).
     * Foreign keys are not loaded for cross-database schemas.
     */
    async loadSchemaForDatabase(database: string): Promise<TableInfo[]> {
        if (!this.pool) {
            throw new Error("Not connected to database");
        }

        // Escape any existing ] in the database name to prevent injection.
        const dbBracketed = '[' + database.replace(/]/g, ']]') + ']';

        const result = await this.pool.request().query(`
            SELECT
                s.name AS schema_name,
                so.name AS table_name,
                c.name AS column_name,
                ty.name AS data_type,
                c.max_length,
                c.is_nullable,
                CASE WHEN so.type = 'U' AND pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key
            FROM ${dbBracketed}.sys.objects so
            INNER JOIN ${dbBracketed}.sys.schemas s ON so.schema_id = s.schema_id
            INNER JOIN ${dbBracketed}.sys.columns c ON so.object_id = c.object_id
            INNER JOIN ${dbBracketed}.sys.types ty ON c.user_type_id = ty.user_type_id
            LEFT JOIN (
                SELECT ic.object_id, ic.column_id
                FROM ${dbBracketed}.sys.index_columns ic
                INNER JOIN ${dbBracketed}.sys.indexes i
                    ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                WHERE i.is_primary_key = 1
            ) pk ON so.object_id = pk.object_id AND c.column_id = pk.column_id
            WHERE so.type IN ('U', 'V') AND so.is_ms_shipped = 0
            ORDER BY s.name, so.name, c.column_id
        `);

        const tableMap = new Map<string, TableInfo>();

        for (const row of result.recordset) {
            const key = `${row.schema_name}.${row.table_name}`;
            if (!tableMap.has(key)) {
                tableMap.set(key, {
                    database,
                    schema: row.schema_name,
                    name: row.table_name,
                    columns: [],
                    foreignKeys: [],
                });
            }

            tableMap.get(key)!.columns.push({
                name: row.column_name,
                dataType: row.data_type,
                maxLength: row.max_length,
                isNullable: row.is_nullable,
                isPrimaryKey: row.is_primary_key === 1,
            });
        }

        console.log(`Loaded schema for [${database}]: ${tableMap.size} table(s)`);
        return Array.from(tableMap.values());
    }

    /**
     * Loads tables for all specified databases (excluding the current database,
     * which should already be loaded via `loadSchema` with full FK support).
     * Databases that fail (e.g., no permission) are silently skipped.
     */
    async loadAllDatabaseSchemas(databases: string[]): Promise<TableInfo[]> {
        console.log(`SQL Prompt: loading cross-database schemas for ${databases.length} database(s): ${databases.join(', ') || '(none)'}`);

        const results = await Promise.allSettled(
            databases.map((db) => this.loadSchemaForDatabase(db)),
        );

        const allTables: TableInfo[] = [];
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === 'fulfilled') {
                console.log(`SQL Prompt: loaded ${r.value.length} table(s) from [${databases[i]}]`);
                allTables.push(...r.value);
            } else {
                console.error(
                    `SQL Prompt: failed to load schema for [${databases[i]}]: ${(r.reason as Error)?.message ?? r.reason
                    }`,
                );
            }
        }

        console.log(`SQL Prompt: completed cross-database schema load, ${allTables.length} table(s) added`);

        return allTables;
    }
}
