function header() {
  return `// Automatically generated by PASTA`;
}

function generatePgCatalog() {
  return `${header()}
import { ExprCall } from "https://deno.land/x/pgsql_ast_parser@10.2.0/mod.ts";

type UUIDFunctionCall = ExprCall & { returnType: "uuid" };
type TimestampFunctionCall = ExprCall & { returnType: "timestamp" };
type JSONValue =
  | string
  | number
  | boolean
  | { [x: string]: JSONValue }
  | Array<JSONValue>;

const uuid = () => (
  {
    "type": "call",
    "function": { "name": "gen_random_uuid" },
    "args": [],
    "returnType": "uuid",
  } as UUIDFunctionCall
);

const now = () => (
  {
    "type": "call",
    "function": { "name": "now" },
    "args": [],
    "returnType": "timestamp",
  } as TimestampFunctionCall
);

export type { JSONValue, TimestampFunctionCall };
export { now, uuid };
`;
}

function generateSchema() {
  return `${header()}
import type { TableName, Tables } from "./custom-schema.ts";
import { associations } from "./custom-schema.ts";

type KeysOf<T extends TableName> = Tables[T]["keys"];
type ColumnsOf<T extends TableName> = Tables[T]["columns"];
type AssociationsOf<T extends TableName> = Tables[T]["associations"];

type MxNAssociation = {
  kind: "MxN";
  table: TableName;
  associativeTable: TableName;
  fks: Record<string, [string, string]>;
};

type NAssociation = {
  kind: "MxN";
  table: TableName;
  associativeTable: TableName;
  fks: Record<string, [string, string]>;
};

type Association =
  | NAssociation
  | MxNAssociation;

type Associations = Record<TableName, null | Record<string, Association>>;

export type {
  Association,
  Associations,
  AssociationsOf,
  ColumnsOf,
  KeysOf,
  MxNAssociation,
  NAssociation,
  TableName,
  Tables,
};
export { associations };
`;
}

function generateStatementBuilder() {
  return `${header()}
import {
  astMapper,
  Expr,
  InsertStatement,
  Name,
  SelectStatement,
  Statement,
  toSql,
  UpdateStatement,
  WithStatement,
} from "https://deno.land/x/pgsql_ast_parser@11.0.0/mod.ts";
import {
  associations,
  AssociationsOf,
  ColumnsOf,
  KeysOf,
  MxNAssociation,
  TableName,
} from "./schema.ts";

type SeedBuilder = {
  table: TableName;
  statement:
    | SelectStatement
    | InsertStatement
    | UpdateStatement
    | WithStatement;
  toSql: () => string;
};

type ReturningOptions<T extends TableName> = (keyof ColumnsOf<T>)[];
type StatementBuilder<T extends TableName> = SeedBuilder & {
  returning: (options: ReturningOptions<T>) => StatementBuilder<T>;
};
type InsertBuilder<T extends TableName> = StatementBuilder<T> & {
  associate: (associationMap: AssociationsOf<T>) => InsertBuilder<T>;
};
type SelectBuilder<T extends TableName> = StatementBuilder<T> & {
  where: (whereMap: ColumnsOf<T>) => SelectBuilder<T>;
  unique: (whereMap: KeysOf<T>) => SelectBuilder<T>;
};

const binaryOp = (op: string) => (left: Expr, right: Expr) =>
  (
    {
      "type": "binary",
      left,
      right,
      op,
    }
  ) as Expr;

const refExpr = (name: string) => ({ "type": "ref", name }) as Expr;
const stringExpr = (value: string) => ({ "type": "string", value }) as Expr;

const eqList = (valuesMap: Record<string, unknown>) =>
  binaryOp("=")({
    type: "list",
    expressions: Object.keys(valuesMap).map((k) => refExpr(k)),
  }, {
    type: "list",
    expressions: Object.values(valuesMap).map((v) => stringExpr(String(v))),
  }) as Expr;

function addReturning<T extends TableName>(builder: SeedBuilder) {
  const returningMapper = (columnNames: Name[]) =>
    astMapper((_map) => ({
      with: (t) => {
        if (t.in.type === "insert") {
          return {
            ...t,
            in: {
              ...t.in,
              returning: columnNames.map((c) => ({
                expr: { type: "ref", name: c.name },
              })),
            },
          };
        }
      },
      insert: (t) => {
        if (t.insert) {
          return {
            ...t,
            returning: columnNames.map((c) => ({
              expr: { type: "ref", name: c.name },
            })),
          };
        }
      },
    }));

  const returning = function (
    options: ReturningOptions<T>,
  ): StatementBuilder<T> {
    const returningColumns = options.map((c) => ({
      name: c,
    } as Name));
    const statementWithReturning = returningMapper(returningColumns)
      .statement(
        builder.statement,
      )! as InsertStatement;
    const seedBuilder = {
      table: builder.table,
      statement: statementWithReturning,
      toSql: () => toSql.statement(statementWithReturning),
    };
    return addReturning(seedBuilder);
  };
  return { ...builder, returning };
}

function addAssociate<T extends TableName>(
  builder: StatementBuilder<T>,
): InsertBuilder<T> {
  const builderWithMxNAssociation = (
    association: MxNAssociation,
    associatedValues: Record<string, unknown>,
  ) => {
    const { fks, associativeTable } = association;
    const associativeValues = Object.keys(fks).reduce(
      (previousValue, currentValue) => {
        previousValue[currentValue] = {
          "type": "ref",
          "table": {
            "name": fks[currentValue][0],
          },
          "name": fks[currentValue][1],
        };
        return previousValue;
      },
      {} as Record<string, unknown>,
    );
    const returningFksAssociation = Object.values(fks).filter((
      [fkTable],
    ) => (fkTable == association.table))
      .map(([_, fkColumn]) => (fkColumn));

    const returningFksBuilder = Object.values(fks).filter((
      [fkTable],
    ) => (fkTable == builder.table))
      .map(([_, fkColumn]) => (fkColumn));

    const withStatement = insertWith(
      insert(association.table)(
        // deno-lint-ignore no-explicit-any
        associatedValues as any,
      ).returning(
        returningFksAssociation as ReturningOptions<
          typeof association.table
        >,
      ),
    )(
      insertWith(
        builder.returning(
          returningFksBuilder as ReturningOptions<typeof builder.table>,
        ),
      )(
        // deno-lint-ignore no-explicit-any
        insert(associativeTable)(associativeValues as any),
      ),
    );
    return withStatement as InsertBuilder<T>;
  };

  const associate = (associationMap: AssociationsOf<T>) => {
    for (
      const [associated, associatedValues] of Object.entries(associationMap)
    ) {
      const association = associations[builder.table]?.[associated];
      if (association?.kind == "MxN") {
        return builderWithMxNAssociation(association, associatedValues);
      }
    }
  };
  return { ...builder, associate } as InsertBuilder<T>;
}

function insert<T extends TableName>(
  table: T,
): (
  valueMap: ColumnsOf<T>,
) => InsertBuilder<T> {
  return function (valueMap) {
    const columns = Object.keys(valueMap).map((k) => ({ name: k }));
    const values = [
      Object.values(valueMap).map((
        value,
      ) => (typeof value === "string"
        ? { value, type: "string" }
        : (typeof value === "object" && value !== null &&
            ("returnType" in value ||
              ("type" in value && value["type"] == "ref")))
        ? value
        : { value: JSON.stringify(value), type: "string" })
      ),
    ] as Expr[][];
    const statement: InsertStatement = {
      "type": "insert",
      "into": { "name": table },
      "insert": {
        "type": "values",
        values,
      },
      columns,
    };
    return addAssociate<T>(addReturning<T>({
      table,
      toSql: () => toSql.statement(statement),
      statement,
    }));
  };
}

function upsert<T extends TableName>(table: T): (
  insertValues: ColumnsOf<T>,
  updateValues?: ColumnsOf<T>,
) => StatementBuilder<T> {
  const onConflictMapper = (conflictValues: Record<string, unknown>) =>
    astMapper((_map) => ({
      insert: (t) => {
        if (t.insert) {
          return {
            ...t,
            onConflict: {
              "do": {
                "sets": Object.keys(conflictValues).map((k) => ({
                  "column": { "name": k },
                  "value": {
                    "type": "string",
                    "value": String(conflictValues[k]),
                  },
                })),
              },
            },
          };
        }
      },
    }));

  return (insertValues, updateValues) => {
    const { statement } = insert(table)(insertValues);
    const withOnConflict = onConflictMapper(updateValues || insertValues)
      .statement(statement)! as InsertStatement;
    const seedBuilder = {
      table,
      toSql: () => toSql.statement(statement),
      statement: withOnConflict,
    };
    return addReturning(seedBuilder);
  };
}

function update<T extends TableName>(table: T): (
  keyValues: KeysOf<T>,
  setValues: ColumnsOf<T>,
) => StatementBuilder<T> {
  return (keyValues, setValues) => {
    const statement: Statement = {
      "type": "update",
      "table": { "name": table },
      "sets": Object.keys(setValues).map((k) => ({
        "column": { "name": k },
        "value": {
          "type": "string",
          "value": String((setValues as Record<string, unknown>)[k]),
        },
      })),
      "where": eqList(keyValues),
    };
    const seedBuilder = {
      table,
      statement,
      toSql: () => toSql.statement(statement),
    };
    return addReturning(seedBuilder);
  };
}

function insertWith<T1 extends TableName>(context: StatementBuilder<T1>) {
  return function <T2 extends TableName>(insert: StatementBuilder<T2>) {
    const statement: WithStatement = insert.statement.type === "with"
      ? {
        ...insert.statement,
        "bind": [...insert.statement.bind, {
          "alias": { "name": context.table },
          "statement": context.statement,
        }],
      }
      : {
        "type": "with",
        "bind": [{
          "alias": { "name": context.table },
          "statement": context.statement,
        }],
        "in": insert.statement,
      };
    const seedBuilder = {
      statement,
      table: insert.table,
      toSql: () => toSql.statement(statement),
    };

    return addReturning<T2>(seedBuilder);
  };
}

function addSelectReturning<T extends TableName>(builder: SeedBuilder) {
  const returningMapper = (columnNames: Name[]) =>
    astMapper((_map) => ({
      selection: (s) => ({
        ...s,
        columns: columnNames.map((c) => ({
          expr: { type: "ref", name: c.name },
        })),
      }),
    }));

  const returning = function (
    options: ReturningOptions<T>,
  ): StatementBuilder<T> {
    const returningColumns = options.map((c) => ({
      name: c,
    } as Name));
    const statementWithReturning = returningMapper(returningColumns)
      .statement(
        builder.statement,
      )! as SelectStatement;
    const seedBuilder = {
      table: builder.table,
      statement: statementWithReturning,
      toSql: () => toSql.statement(statementWithReturning),
    };
    return addSelectReturning(seedBuilder);
  };
  return { ...builder, returning };
}

function addWhere<T extends TableName>(builder: StatementBuilder<T>) {
  const whereMapper = (columns: ColumnsOf<T>) =>
    astMapper((_map) => ({
      selection: (s) => ({
        ...s,
        where: eqList(columns),
      }),
    }));

  const where = function (
    whereMap: ColumnsOf<T>,
  ): StatementBuilder<T> {
    const statementWithWhere = whereMapper(whereMap)
      .statement(
        builder.statement,
      )! as SelectStatement;
    const seedBuilder = {
      table: builder.table,
      statement: statementWithWhere,
      toSql: () => toSql.statement(statementWithWhere),
    };
    return addSelectReturning(seedBuilder);
  };
  return { ...builder, where } as SelectBuilder<T>;
}

function addUnique<T extends TableName>(builder: StatementBuilder<T>) {
  const whereMapper = (columns: KeysOf<T>) =>
    astMapper((_map) => ({
      selection: (s) => ({
        ...s,
        where: eqList(columns),
      }),
    }));

  const unique = function (
    whereMap: KeysOf<T>,
  ): StatementBuilder<T> {
    const statementWithWhere = whereMapper(whereMap)
      .statement(
        builder.statement,
      )! as SelectStatement;
    const seedBuilder = {
      table: builder.table,
      statement: statementWithWhere,
      toSql: () => toSql.statement(statementWithWhere),
    };
    return addSelectReturning(seedBuilder);
  };
  return { ...builder, unique } as SelectBuilder<T>;
}

function select<T extends TableName>(table: T): () => SelectBuilder<T> {
  return function () {
    const statement: Statement = {
      "columns": [],
      "from": [{ "type": "table", "name": { "name": table } }],
      "type": "select",
    };
    const seedBuilder = {
      statement,
      table: table,
      toSql: () => toSql.statement(statement),
    };

    return addUnique<T>(addWhere<T>(addSelectReturning<T>(seedBuilder)));
  };
}

export { insert, insertWith, select, update, upsert };
export type { SeedBuilder, StatementBuilder };
`;
}

function generateTransaction() {
  return `
import postgres from "https://deno.land/x/postgresjs@v3.2.4/mod.js";
import type { SeedBuilder } from "./statement-builder.ts";

function connection(uri: string) {
  const sql = postgres(uri);
  return sql;
}

async function transaction(statement: SeedBuilder) {
  const uri = Deno.env.get("DATABASE_URL");
  if (!uri) {
    throw new Error("Please set DATABASE_URL to use database access functions");
  }
  const sql = postgres(uri);
  const r = await sql.unsafe(statement.toSql());
  await sql.end({ timeout: 5 });
  return r;
}

async function transactionReturning(statement: SeedBuilder) {
  const r = await transaction(statement);
  if (r.length === 0) {
    throw new Error(
      "Statement" + statement.toSql() + " did not return any rows",
    );
  }
  return r;
}

const db = {
  transaction,
  transactionReturning,
};

export { connection, db, transaction, transactionReturning };
`;
}

export {
  generatePgCatalog,
  generateSchema,
  generateStatementBuilder,
  generateTransaction,
};
