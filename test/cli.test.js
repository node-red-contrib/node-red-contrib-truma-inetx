import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('CLI help documents get and bluetooth backend selection', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['./bin/truma-inetx.js', '--help']);

  assert.match(stdout, /get/);
  assert.match(stdout, /--bluetooth <backend>/);
  assert.match(stdout, /--debug/);
});

test('CLI no longer exposes read command', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ['./bin/truma-inetx.js', 'read']),
    (error) => {
      assert.match(String(error), /unknown command 'read'/i);
      return true;
    }
  );
});
