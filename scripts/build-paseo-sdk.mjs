import { build } from "esbuild";
import { builtinModules } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "server", "vendor");
for (const name of ["client", "protocol", "relay"]) {
  const manifest = JSON.parse(await readFile(join(root, "node_modules", "@getpaseo", name, "package.json"), "utf8"));
  if (manifest.version !== "0.15.4") throw new Error(`Expected @getpaseo/${name}@0.15.4, got ${manifest.version}`);
}
await mkdir(destination, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ["scripts/paseo-sdk-entry.ts"],
  outfile: "server/vendor/paseo-sdk.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  minify: true,
  external: ["zod", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
  // The pure JavaScript ws implementation is sufficient; no optional native addon.
  define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' },
  legalComments: "eof",
  metafile: true,
  banner: { js: "// Generated from @getpaseo/client, protocol and relay 0.15.4. Run npm run build:sdk to rebuild.\n// License and attribution: THIRD_PARTY_NOTICES.md. Do not edit this generated file." },
});
await writeFile(join(destination, "paseo-sdk.meta.json"), `${JSON.stringify(result.metafile, null, 2)}\n`);
const packages = [...new Set(Object.keys(result.metafile.inputs).flatMap((input) => {
  const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  return match ? [match[1]] : [];
}))].sort();
console.log(`Built Paseo SDK 0.15.4. Bundled packages: ${packages.join(", ")}. External runtime package: zod (Paseo supplied).`);
