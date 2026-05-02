#!/usr/bin/env node
import { main } from '../dist/cli.js';

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
