#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { runCli, type CliHost } from "./run-cli.js";

const host: CliHost = {
  stderrIsTTY: process.stderr.isTTY === true,
  resolvePath: (specifier, referrer) => realpathSync(
    referrer === undefined
      ? resolve(specifier)
      : resolve(dirname(referrer), specifier),
  ),
  readFile: (path) => readFileSync(path, "utf8"),
  writeStdout: (text) => {
    process.stdout.write(text);
  },
  writeStderr: (text) => {
    process.stderr.write(text);
  },
  getEnvironmentVariable: (name) => process.env[name],
};

process.exitCode = runCli(process.argv.slice(2), host);
