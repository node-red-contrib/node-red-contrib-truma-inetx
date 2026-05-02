#!/usr/bin/env node
import { main } from '../dist/cli.js';

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
