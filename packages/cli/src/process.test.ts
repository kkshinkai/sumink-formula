import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  it("runs a Unicode path and preserves stdout exactly", () => {
    const file = writeSource("program with 墨.sumi", "print('Hello, world!'); print(42);");
    const result = runNodeCli([file]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Hello, world!\n42\n");
    expect(result.stderr).toBe("");
  });

  it("keeps successful return values silent", () => {
    const file = writeSource("silent.sumi", "1 + 2;");
    const result = runNodeCli([file]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("reports syntax and runtime failures through the built executable", () => {
    const syntaxFile = writeSource("syntax.sumi", "(");
    const syntaxResult = runNodeCli([syntaxFile]);
    expect(syntaxResult.status).toBe(1);
    expect(syntaxResult.stderr).toContain(`${syntaxFile}:1:2 - error SF`);

    const runtimeFile = writeSource("runtime.sumi", "missing");
    const runtimeResult = runNodeCli([runtimeFile]);
    expect(runtimeResult.status).toBe(1);
    expect(runtimeResult.stderr).toContain(`${runtimeFile}:1:1 - error SF4003:`);
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
