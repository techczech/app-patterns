// Builds the demo to demo/dist (static files): `bun run demo:build`.
const result = await Bun.build({ entrypoints: ["./demo/index.html"], outdir: "./demo/dist", minify: false });
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`Built ${result.outputs.length} files to demo/dist`);
