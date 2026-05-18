import * as sql from 'mssql';

export interface ColumnInfo {
  name: string;
  dataType: string;
  maxLength: number | null;
  isNullable: boolean;
  isPrimaryKey: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
}

export interface ConnectionConfig {
  server: string;
  database: string;
  user?: string;
  password?: string;
  port?: number;
  trustServerCertificate?: boolean;
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

        const result = await this.pool.request().query(`
      SELECT 
        s.name AS schema_name,
        t.name AS table_name,
        c.name AS column_name,
        ty.name AS data_type,
        c.max_length,
        c.is_nullable,
        CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key
      FROM sys.tables t
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      INNER JOIN sys.columns c ON t.object_id = c.object_id
      INNER JOIN sys.types ty ON c.user_type_id = ty.user_type_id
      LEFT JOIN (
        SELECT ic.object_id, ic.column_id
        FROM sys.index_columns ic
        INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.is_primary_key = 1
      ) pk ON c.object_id = pk.object_id AND c.column_id = pk.column_id
      ORDER BY s.name, t.name, c.column_id
    `);

        const tableMap = new Map<string, TableInfo>();

        for (const row of result.recordset) {
            const key = `${row.schema_name}.${row.table_name}`;
            if (!tableMap.has(key)) {
                tableMap.set(key, {
                    schema: row.schema_name,
                    name: row.table_name,
                    columns: [],
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

        console.log(`Loaded schema: ${tableMap.size} tables`);

        return Array.from(tableMap.values());
    }
}
