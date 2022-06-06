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
} from "https://deno.land/x/pgsql_ast_parser@10.2.0/mod.ts";
import { TableName, Tables } from "./mock-schema.ts";

type KeysOf<T extends TableName> = Tables[T]["keys"];
type ColumnsOf<T extends TableName> = Tables[T]["columns"];
type AssociationsOf<T extends TableName> = Tables[T]["associations"];

type ReturningOptions<T extends TableName> = (keyof ColumnsOf<T>)[];

type Returning<T extends TableName> = (
  options: ReturningOptions<T>,
) => StatementBuilder<T>;

type SeedBuilder = {
  table: TableName;
  statement:
    | SelectStatement
    | InsertStatement
    | UpdateStatement
    | WithStatement;
  toSql: () => string;
};

type StatementBuilder<T extends TableName> = SeedBuilder & {
  returning: Returning<T>;
};

type InsertBuilder = <T extends TableName>(
  table: T,
) => (values: ColumnsOf<T>) => StatementBuilder<T>;

type UpsertBuilder = <T extends TableName>(
  table: T,
) => (
  insertValues: ColumnsOf<T>,
  updateValues?: ColumnsOf<T>,
) => StatementBuilder<T>;

type UpdateBuilder = <T extends TableName>(
  table: T,
) => (
  keyValues: KeysOf<T>,
  setValues: ColumnsOf<T>,
) => StatementBuilder<T>;

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

const insert: InsertBuilder = (table) =>
  (valueMap) => {
    const columns = Object.keys(valueMap).map((k) => ({ name: k }));
    const values = [
      Object.values(valueMap).map((
        value,
      ) => (typeof value === "string"
        ? { value, type: "string" }
        : (typeof value === "object" && "returnType" in value)
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
    const seedBuilder = {
      table,
      toSql: () => toSql.statement(statement),
      statement,
    };
    return addReturning(seedBuilder);
  };

const upsert: UpsertBuilder = (table) => {
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
};

const update: UpdateBuilder = (table) =>
  (keyValues, setValues) => {
    const binaryOp = (op: string) =>
      (left: Expr, right: Expr) =>
        (
          {
            "type": "binary",
            left,
            right,
            op,
          }
        ) as Expr;
    const eq = (name: string, value: string) =>
      binaryOp("=")({ "type": "ref", name }, {
        "type": "string",
        value,
      }) as Expr;
    const and = binaryOp("AND");
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
      "where": Object.keys(keyValues).reduce(
        (previousValue, currentValue) => {
          const currentEquality = eq(
            currentValue,
            String(
              (keyValues as Record<string, unknown>)[currentValue],
            ),
          );
          return (
            ("type" in previousValue)
              ? and(previousValue as Expr, currentEquality)
              : currentEquality
          );
        },
        {},
      ) as Expr,
    };
    const seedBuilder = {
      table,
      statement,
      toSql: () => toSql.statement(statement),
    };
    return addReturning(seedBuilder);
  };

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

export { insert, insertWith, update, upsert };
