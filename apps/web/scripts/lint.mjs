import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx") ? [join(directory, entry.name)] : []))).flat();
}
const requestedTargets = process.argv.slice(2);
const targets = requestedTargets.length > 0 ? requestedTargets : [...await files("src"), ...await files("test")];
for (const target of targets) {
  const source = await readFile(target, "utf8");
  const parsed = ts.createSourceFile(target, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const diagnostic of parsed.parseDiagnostics) {
    const position = diagnostic.start === undefined
      ? { line: 0, character: 0 }
      : parsed.getLineAndCharacterOfPosition(diagnostic.start);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    console.error(`${target}:${position.line + 1}:${position.character + 1}: ${message}`);
  }
  if (parsed.parseDiagnostics.length > 0) process.exit(1);
}
