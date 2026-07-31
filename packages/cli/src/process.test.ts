import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cliEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
let temporaryDirectory = "";

beforeAll(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "sumi-cli-test-"));
});

afterAll(() => {
  if (temporaryDirectory !== "") {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

describe("built sumi process", () => {
  it.each([
    ["hello.sumi", "Hello, world!\n"],
    ["closures.sumi", "44\n100\n"],
    ["mutual-recursion.sumi", "true\ntrue\nC\nright\n"],
    [
      "tree-processing.sumi",
      "16\n"
      + "{\"kind\": \"branch\", \"left\": {\"kind\": \"branch\", \"left\": "
      + "{\"kind\": \"leaf\", \"value\": 30}, \"right\": {\"kind\": \"leaf\", \"value\": 50}}, "
      + "\"right\": {\"kind\": \"leaf\", \"value\": 80}}\n",
    ],
    [
      "dictionary-keys.sumi",
      "array key\ndictionary key\nboolean key\nnull\n"
      + "{[[1, {\"name\": \"Ada\"}]]: \"new\", \"middle\": 0}\nsame closure\nnull\n",
    ],
    ["trailing-blocks.sumi", "42\nyes\nAda\nnull\n{}\n"],
    ["modules.sumi", "42\npx\n[6, 8]\n2\n"],
  ])("runs the repository example %s", (name, expectedOutput) => {
    const result = runNodeCli([join(workspaceRoot, "examples", name)]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expectedOutput);
    expect(result.stderr).toBe("");
  });

  it("runs a Unicode path and preserves stdout exactly", () => {
    const file = writeSource("program with 墨.sumi", "print('Hello, world!'); print(42);");
    const result = runNodeCli([file]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Hello, world!\n42\n");
    expect(result.stderr).toBe("");
  });

  it("keeps successful programs without print silent", () => {
    const file = writeSource("silent.sumi", "1 + 2;");
    const result = runNodeCli([file]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("loads relative File Modules and locates cross-file runtime errors", () => {
    writeSource("math.sumi", "export fn twice(value) = value * 2;");
    const main = writeSource(
      "modules.sumi",
      "import {twice} from './math.sumi'; print(twice(21));",
    );
    const success = runNodeCli([main]);
    expect(success.status).toBe(0);
    expect(success.stdout).toBe("42\n");
    expect(success.stderr).toBe("");

    const broken = writeSource("broken.sumi", "export let value = 1();");
    const brokenMain = writeSource(
      "broken-main.sumi",
      "import {value} from './broken.sumi'; print(value);",
    );
    const failure = runNodeCli([brokenMain]);
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toContain(
      `${realpathSync(broken)}:1:20 - error SF4008: Only function values can be called.`,
    );
  });

  it("reports front-end and runtime failures through the built executable", () => {
    const lexicalFile = writeSource("lexical.sumi", "@;");
    const lexicalResult = runNodeCli([lexicalFile]);
    expect(lexicalResult.status).toBe(1);
    expect(lexicalResult.stderr).toContain(`${realpathSync(lexicalFile)}:1:1 - error SF1000:`);

    const syntaxFile = writeSource("syntax.sumi", "(");
    const syntaxResult = runNodeCli([syntaxFile]);
    expect(syntaxResult.status).toBe(1);
    expect(syntaxResult.stderr).toContain(`${realpathSync(syntaxFile)}:1:2 - error SF`);

    const resolverFile = writeSource("resolver.sumi", "let value = 1; let value = 2;");
    const resolverResult = runNodeCli([resolverFile]);
    expect(resolverResult.status).toBe(1);
    expect(resolverResult.stderr).toContain(`${realpathSync(resolverFile)}:1:20 - error SF3000:`);

    const runtimeFile = writeSource("runtime.sumi", "1();");
    const runtimeResult = runNodeCli([runtimeFile]);
    expect(runtimeResult.status).toBe(1);
    expect(runtimeResult.stderr).toContain(`${realpathSync(runtimeFile)}:1:1 - error SF4008:`);
  });

  it("reports missing files and invalid invocation with distinct statuses", () => {
    const missing = runNodeCli([join(temporaryDirectory, "missing.sumi")]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("error: Cannot read");

    const usage = runNodeCli([]);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("Usage: sumi [--] <file.sumi>");
  });

  it("is exposed from the workspace through pnpm exec", () => {
    const file = writeSource("workspace-bin.sumi", "print('workspace bin');");
    const result = spawnSync("pnpm", ["exec", "sumi", file], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: withoutColor(process.env),
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("workspace bin\n");
    expect(result.stderr).toBe("");
  });
});

function writeSource(name: string, source: string): string {
  const path = join(temporaryDirectory, name);
  writeFileSync(path, source, "utf8");
  return path;
}

function runNodeCli(arguments_: readonly string[]) {
  return spawnSync(process.execPath, [cliEntry, ...arguments_], {
    encoding: "utf8",
    env: withoutColor(process.env),
  });
}

function withoutColor(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const path = environment["PATH"] === undefined
    ? undefined
    : `${join(workspaceRoot, "node_modules", ".bin")}${delimiter}${environment["PATH"]}`;
  return { ...environment, FORCE_COLOR: undefined, NO_COLOR: "1", PATH: path };
}
