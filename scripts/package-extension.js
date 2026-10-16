#!/usr/bin/env node

/**
 * Deterministic zip of the unpacked MV3 extension (dist/extension/).
 *
 * Output: dist/2048-ai-solver-extension.zip
 *
 * Determinism: entries are sorted by path, every entry carries a fixed DOS
 * timestamp (1980-01-01 00:00:00, overridable via SOURCE_DATE_EPOCH), fixed
 * mode 0644, and no extra fields — so two builds of the same dist/extension
 * produce byte-identical zips. Run `node scripts/build-phase0.js` first.
 *
 * Usage: node scripts/package-extension.js
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const rootDir = path.resolve(__dirname, "..");
const extensionDir = path.join(rootDir, "dist", "extension");
const outputPath = path.join(rootDir, "dist", "2048-ai-solver-extension.zip");

// ---- deterministic timestamp ------------------------------------------------
// DOS timestamps cannot represent years before 1980; default to 1980-01-01.
const SOURCE_DATE_EPOCH = Number(process.env.SOURCE_DATE_EPOCH || 315532800); // 1980-01-01T00:00:00Z
const epoch = new Date(SOURCE_DATE_EPOCH * 1000);
const dosTime =
  ((epoch.getUTCHours() << 11) | (epoch.getUTCMinutes() << 5) | (epoch.getUTCSeconds() / 2)) & 0xffff;
const dosDate =
  (((epoch.getUTCFullYear() - 1980) << 9) | ((epoch.getUTCMonth() + 1) << 5) | epoch.getUTCDate()) & 0xffff;

// ---- crc32 -------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// ---- zip writing ---------------------------------------------------------------

function collectFiles(dir, base) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...collectFiles(abs, rel));
    } else {
      files.push({ abs, rel });
    }
  }
  return files;
}

function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  files.forEach(({ abs, rel }) => {
    const data = fs.readFileSync(abs);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(rel, "utf8");
    const crc = crc32(data);
    const useDataDescriptor = false;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, name, compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // central directory signature
    dir.writeUInt16LE(20 | (3 << 8), 4); // version made by: unix, 2.0
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 8); // flags
    dir.writeUInt16LE(8, 10); // method
    dir.writeUInt16LE(dosTime, 12);
    dir.writeUInt16LE(dosDate, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk number
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38); // external attrs: regular file, 0644
    dir.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([dir, name]));

    offset += 30 + name.length + compressed.length;
  });

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

function main() {
  if (!fs.existsSync(extensionDir)) {
    console.error(
      "dist/extension/ does not exist. Run `node scripts/build-phase0.js` first."
    );
    process.exitCode = 1;
    return;
  }

  const files = collectFiles(extensionDir, "").sort((a, b) => (a.rel < b.rel ? -1 : 1));
  if (files.length === 0) {
    console.error("dist/extension/ is empty; nothing to package.");
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const zip = buildZip(files);
  fs.writeFileSync(outputPath, zip);

  console.log(
    `Packaged ${files.length} files -> ${path.relative(rootDir, outputPath)} ` +
      `(${(zip.length / 1024).toFixed(1)} KiB, deterministic: sorted entries, fixed timestamps)`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("Packaging failed:", error);
    process.exitCode = 1;
  }
}

module.exports = { buildZip, crc32, collectFiles };
