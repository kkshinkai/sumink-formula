#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { runCli, type CliHost } from "./run-cli.js";

const host: CliHost = {
  stderrIsTTY: process.stderr.isTTY === true,
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
