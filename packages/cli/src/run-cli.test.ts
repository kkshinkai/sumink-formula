import { describe, expect, it } from "vitest";

import { ExitStatus, helpText, runCli, type CliHost } from "./run-cli.js";

describe("runCli", () => {
  it("runs every statement, preserves print order, and leaves the program result silent", () => {
    const host = new FakeHost({
      "program.sumi": "print('first'); print('second'); 42;",
    });

    expect(runCli(["program.sumi"], host)).toBe(ExitStatus.Success);
    expect(host.stdout).toBe("first\nsecond\n");
    expect(host.stderr).toBe("");
  });

  it("writes nothing for a successful program without print", () => {
    const host = new FakeHost({ "silent.sumi": "1 + 2;" });

    expect(runCli(["silent.sumi"], host)).toBe(ExitStatus.Success);
    expect(host.stdout).toBe("");
    expect(host.stderr).toBe("");
  });

  it("executes source with line and nested block comments", () => {
    const host = new FakeHost({
      "comments.sumi": [
        "// before",
        "let answer = /* outer /* nested */ outer */ 42;",
        "print(answer); // after",
      ].join("\n"),
    });

    expect(runCli(["comments.sumi"], host)).toBe(ExitStatus.Success);
    expect(host.stdout).toBe("42\n");
    expect(host.stderr).toBe("");
  });

  it("prints structured values and reports functions deterministically", () => {
    const host = new FakeHost({
      "values.sumi": "print([1, {name: 'Ada'}]); print((value) -> value);",
    });

    expect(runCli(["values.sumi"], host)).toBe(ExitStatus.Success);
    expect(host.stdout).toBe("[1, {\"name\": \"Ada\"}]\n<function/1>\n");
  });

  it("makes print a strict one-argument function that returns nil", () => {
    const host = new FakeHost({
      "return.sumi": "print(print('inner'));",
    });

    expect(runCli(["return.sumi"], host)).toBe(ExitStatus.Success);
    expect(host.stdout).toBe("inner\nnil\n");

    const arityHost = new FakeHost({ "arity.sumi": "print();" });
    expect(runCli(["arity.sumi"], arityHost)).toBe(ExitStatus.ProgramError);
    expect(arityHost.stderr).toContain("error SF4009: Expected 1 arguments, but received 0.");
  });

  it("does not evaluate a program with front-end diagnostics", () => {
    const host = new FakeHost({ "invalid.sumi": "print('not written'); (" });

    expect(runCli(["invalid.sumi"], host)).toBe(ExitStatus.ProgramError);
    expect(host.stdout).toBe("");
    expect(host.stderr).toMatch(/^invalid\.sumi:1:\d+ - error SF2\d{3}:/u);
  });

  it("reports a common unsupported operator once without cascading", () => {
    const host = new FakeHost({
      "operator.sumi": "fn fib(x) = if (x == 0 || x == 1) 1 else fib(x - 1) + fib(x - 2); print('Hello, meow');",
    });

    expect(runCli(["operator.sumi"], host)).toBe(ExitStatus.ProgramError);
    expect(host.stdout).toBe("");
    expect(host.stderr).toMatch(
      /^operator\.sumi:1:\d+ - error SF2007: '\|\|' is not a logical operator\. Use 'or' instead\.\n$/u,
    );
  });

  it("reports a missing statement terminator at the next token", () => {
    const host = new FakeHost({
      "terminator.sumi": "let value = 1 let other = 2;",
    });

    expect(runCli(["terminator.sumi"], host)).toBe(ExitStatus.ProgramError);
    expect(host.stderr).toContain("error SF2004: Expected ';' after the statement.");
  });

  it("retains output produced before a later runtime error", () => {
    const host = new FakeHost({
      "runtime.sumi": "print('written');\nmissing;",
    });

    expect(runCli(["runtime.sumi"], host)).toBe(ExitStatus.ProgramError);
    expect(host.stdout).toBe("written\n");
    expect(host.stderr).toBe(
      "runtime.sumi:2:1 - error SF4003: No value was provided for external binding 'missing'.\n",
    );
  });

  it("reports file failures without treating them as internal failures", () => {
    const host = new FakeHost();

    expect(runCli(["missing.sumi"], host)).toBe(ExitStatus.ProgramError);
    expect(host.stdout).toBe("");
    expect(host.stderr).toContain("error: Cannot read 'missing.sumi': File not found: missing.sumi");
  });

  it("reports usage errors on stderr and help on stdout", () => {
    const usageHost = new FakeHost();
    expect(runCli([], usageHost)).toBe(ExitStatus.UsageError);
    expect(usageHost.stdout).toBe("");
    expect(usageHost.stderr).toBe(`error: Expected one .sumi source file.\n\n${helpText}`);

    const helpHost = new FakeHost();
    expect(runCli(["--help"], helpHost)).toBe(ExitStatus.Success);
    expect(helpHost.stdout).toBe(helpText);
    expect(helpHost.stderr).toBe("");
  });

  it("uses TTY color unless NO_COLOR disables it and lets NO_COLOR win", () => {
    const ttyHost = new FakeHost({}, { stderrIsTTY: true });
    expect(runCli([], ttyHost)).toBe(ExitStatus.UsageError);
    expect(ttyHost.stderr).toContain("\u001b[31merror\u001b[0m");

    const forcedHost = new FakeHost({}, { environment: { FORCE_COLOR: "1" } });
    expect(runCli([], forcedHost)).toBe(ExitStatus.UsageError);
    expect(forcedHost.stderr).toContain("\u001b[31merror\u001b[0m");

    const disabledHost = new FakeHost({}, {
      stderrIsTTY: true,
      environment: { FORCE_COLOR: "1", NO_COLOR: "" },
    });
    expect(runCli([], disabledHost)).toBe(ExitStatus.UsageError);
    expect(disabledHost.stderr).not.toContain("\u001b[");
  });

  it("converts an unexpected host failure to the internal-error status", () => {
    const host = new FakeHost();
    host.getEnvironmentVariable = () => {
      throw new Error("environment unavailable");
    };

    expect(runCli([], host)).toBe(ExitStatus.InternalError);
    expect(host.stderr).toBe("Internal CLI error: environment unavailable\n");
  });
});

class FakeHost implements CliHost {
  public readonly stderrIsTTY: boolean;
  public stdout = "";
  public stderr = "";
  readonly #files: Readonly<Record<string, string>>;
  readonly #environment: Readonly<Record<string, string | undefined>>;

  public constructor(
    files: Readonly<Record<string, string>> = {},
    options: {
      readonly environment?: Readonly<Record<string, string | undefined>>;
      readonly stderrIsTTY?: boolean;
    } = {},
  ) {
    this.#files = files;
    this.#environment = options.environment ?? {};
    this.stderrIsTTY = options.stderrIsTTY ?? false;
  }

  public readFile = (path: string): string => {
    if (!Object.hasOwn(this.#files, path)) {
      throw new Error(`File not found: ${path}`);
    }
    return this.#files[path] ?? "";
  };

  public writeStdout = (text: string): void => {
    this.stdout += text;
  };

  public writeStderr = (text: string): void => {
    this.stderr += text;
  };

  public getEnvironmentVariable = (name: string): string | undefined => this.#environment[name];
}
