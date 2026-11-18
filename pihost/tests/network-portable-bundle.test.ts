import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';

const root = process.env.WORMHOLE_FRP_DIR ?? '/opt/wormhole/network/frp-0.72.0';

test('Linux bundle runs without the build host glibc loader', {
  skip: process.env.WORMHOLE_LINUX_BUNDLE_TEST !== '1',
}, async t => {
  for (const name of ['frpc', 'frps', 'wormhole-connector']) {
    await t.test(name, async () => {
      const bytes = await readFile(root + '/' + name);
      assert.ok(bytes.length >= 64, 'ELF64 header is complete');
      assert.deepEqual(bytes.subarray(0, 6), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]));
      assert.equal(bytes.readUInt16LE(18), 62, 'Linux x86-64 artifact');
      const offset = Number(bytes.readBigUInt64LE(32));
      const entrySize = bytes.readUInt16LE(54);
      const count = bytes.readUInt16LE(56);
      assert.ok(entrySize >= 4 && count > 0);
      assert.ok(offset + entrySize * count <= bytes.length, 'program headers fit the artifact');
      for (let i = 0; i < count; i++) {
        assert.notEqual(bytes.readUInt32LE(offset + i * entrySize), 3,
          name + ' must not require an ELF interpreter from the build host');
      }
    });
  }
});
