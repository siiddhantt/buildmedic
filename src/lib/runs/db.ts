import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { schemaSql } from "./schema";

let db: Database.Database | null = null;

export function getDb() {
  if (db) return db;

  const dbPath =
    process.env.BUILDMEDIC_DB_PATH ??
    path.join(process.cwd(), ".buildmedic", "buildmedic.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(schemaSql);

  return db;
}
