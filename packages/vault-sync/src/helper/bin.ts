/**
 * The helper's runnable entry for Node: the commands of cli.ts, built to `dist/helper/bin.js` as one
 * self-contained file with no package imports. An app starts it as a separate process (Electron with
 * ELECTRON_RUN_AS_NODE=1, or Node); it never imports it.
 */
import { runCli } from "./cli.ts";

runCli(process.argv.slice(2));
