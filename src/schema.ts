import type { TableName, Tables } from "./mock-schema.ts";
import { associations } from "./mock-schema.ts";

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
