// Gives each end-to-end run an empty data directory.
import { mkdirSync, rmSync } from "node:fs";

const dir = process.env.DATA_DIR;
if (!dir || !dir.startsWith("test-results")) throw new Error("e2e-reset only clears a DATA_DIR under test-results/");
rmSync(dir, { recursive: true, force: true });
mkdirSync(`${dir}/workspace`, { recursive: true });
