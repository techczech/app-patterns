// Writes src/settings-css.ts from src/settings.css, so the stylesheet is both a file and a string. Run by `bun run check`.
const updates = await Bun.file(new URL("../../updates-react/src/updates.css", import.meta.url)).text();
const css = updates + "\n" + await Bun.file(new URL("../src/settings.css", import.meta.url)).text();
const body = `// Generated from settings.css by scripts/gen-css.ts. Do not edit; edit settings.css and run \`bun run gen:css\`.
/** The window's stylesheet as a string, for a host that injects it (\`<style>{SETTINGS_CSS}</style>\`). The same text ships as \`settings.css\`. */
export const SETTINGS_CSS: string = ${JSON.stringify(css)};
`;
await Bun.write(new URL("../src/settings-css.ts", import.meta.url), body);

if (process.argv.includes("--dist")) await Bun.write(new URL("../dist/settings.css", import.meta.url), css);
