import { Database } from "bun:sqlite";
import { ledgerDbPath, SQLITE_OPEN_READWRITE } from "../../src/ledger/store.js";

// Holds an exclusive writer briefly so the integrity gate must wait for another
// connection instead of misreporting a healthy ledger as corrupt.
const agentDir = process.argv[2];
if (!agentDir) throw new Error("integrity-held-writer requires an agent directory");
const database = new Database(ledgerDbPath(agentDir), SQLITE_OPEN_READWRITE);
try {
  database.exec("PRAGMA locking_mode=EXCLUSIVE");
  database.exec("BEGIN EXCLUSIVE");
  console.log("held");
  await Bun.sleep(250);
  database.exec("ROLLBACK");
} finally {
  database.close();
}
