// Fails the build if any em dash sneaks into UI copy or blog content.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const bad = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css|html|md)$/.test(name) && readFileSync(p, "utf8").includes("—")) bad.push(p);
  }
};
walk("src");
walk("public");
if (bad.length) {
  console.error("Em dashes found in:\n" + bad.join("\n"));
  process.exit(1);
}
console.log("No em dashes found.");
