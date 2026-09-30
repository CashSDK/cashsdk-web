// The release tag must be v<version>, and every package must carry that version.
import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? "";
const version = tag.replace(/^v/, "");
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`Not a release tag: ${tag}`);
for (const name of ["cashsdk-web", "cashsdk-react", "cashsdk-node"]) {
  const pkg = JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8"));
  if (pkg.version !== version) throw new Error(`${name} is ${pkg.version}, the tag says ${version}`);
}
console.log(`All three packages are ${version}.`);
