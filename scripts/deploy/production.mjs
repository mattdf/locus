import { spawn } from "node:child_process";
import path from "node:path";
import { projectRoot } from "./common.mjs";

function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(projectRoot, script)], {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
  });
}

await run("scripts/deploy/gandi-dns.mjs");
await run("scripts/deploy/coolify.mjs");
await run("scripts/deploy/bootstrap.mjs");
