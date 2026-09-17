// Minimal streaming ZIP writer (deflate), written straight to disk so a large
// export never has to fit in memory.
//
// Each entry is written as: local header (sizes deferred, general-purpose bit
// 3) -> deflate data -> data descriptor. Every chunk is compressed on its own
// and ended with a sync flush, which leaves a byte-aligned, non-final block;
// a fresh compressor never refers back into earlier chunks, so the chunks
// concatenate into one valid deflate stream, closed by a final empty block.
// Limits: no ZIP64, so each entry and the archive stay under 4 GiB and 65,535
// entries (far beyond a restaurant's annual data).
import { open, type FileHandle } from 'node:fs/promises';
import { constants, crc32, deflateRawSync } from 'node:zlib';
import { bangkokParts } from '../../../shared/time.ts';

const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_DEFLATE = 8;
const LIMIT = 0xffffffff;
const CHUNK = 256 * 1024;

interface Entry { name: Buffer; crc: number; csize: number; usize: number; offset: number; time: number; date: number }

function dosDateTime(at: Date): { time: number; date: number } {
  const p = bangkokParts(at);
  return {
    time: (p.hour << 11) | (p.minute << 5) | Math.floor(p.second / 2),
    date: ((Math.max(1980, p.year) - 1980) << 9) | (p.month << 5) | p.day,
  };
}

export interface ZipWriter {
  /** Add one file from text/binary pieces (strings are UTF-8 encoded). */
  add(name: string, pieces: AsyncIterable<string | Buffer> | Iterable<string | Buffer>): Promise<{ bytes: number }>;
  close(): Promise<{ bytes: number; entries: number }>;
  abort(): Promise<void>;
}

export async function createZip(path: string): Promise<ZipWriter> {
  const fh: FileHandle = await open(path, 'w');
  const entries: Entry[] = [];
  let offset = 0;
  let closed = false;
  const { time, date } = dosDateTime(new Date());

  const write = async (buf: Buffer) => {
    if (buf.length === 0) return;
    await fh.write(buf);
    offset += buf.length;
    if (offset > LIMIT) throw new Error('export archive exceeds 4 GiB');
  };

  return {
    async add(name, pieces) {
      if (closed) throw new Error('zip already closed');
      if (entries.length >= 0xffff) throw new Error('too many zip entries');
      const nameBuf = Buffer.from(name, 'utf8');
      const entry: Entry = { name: nameBuf, crc: 0, csize: 0, usize: 0, offset, time, date };
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 6);
      header.writeUInt16LE(METHOD_DEFLATE, 8);
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(date, 12);
      // crc and sizes (14..25) stay zero: they follow in the data descriptor
      header.writeUInt16LE(nameBuf.length, 26);
      header.writeUInt16LE(0, 28);
      await write(header);
      await write(nameBuf);

      let pending: Buffer[] = [];
      let pendingBytes = 0;
      const flush = async () => {
        if (pendingBytes === 0) return;
        const raw = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        entry.crc = crc32(raw, entry.crc);
        entry.usize += raw.length;
        const out = deflateRawSync(raw, { level: 6, finishFlush: constants.Z_SYNC_FLUSH });
        entry.csize += out.length;
        await write(out);
      };
      for await (const piece of pieces as AsyncIterable<string | Buffer>) {
        const buf = typeof piece === 'string' ? Buffer.from(piece, 'utf8') : piece;
        if (buf.length === 0) continue;
        pending.push(buf);
        pendingBytes += buf.length;
        if (pendingBytes >= CHUNK) await flush();
      }
      await flush();
      const tail = deflateRawSync(Buffer.alloc(0)); // final empty block
      entry.csize += tail.length;
      await write(tail);
      if (entry.usize > LIMIT || entry.csize > LIMIT) throw new Error(`zip entry ${name} exceeds 4 GiB`);

      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(entry.crc >>> 0, 4);
      desc.writeUInt32LE(entry.csize, 8);
      desc.writeUInt32LE(entry.usize, 12);
      await write(desc);
      entries.push(entry);
      return { bytes: entry.usize };
    },

    async close() {
      if (closed) throw new Error('zip already closed');
      closed = true;
      const cdStart = offset;
      for (const e of entries) {
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(20, 6);
        h.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 8);
        h.writeUInt16LE(METHOD_DEFLATE, 10);
        h.writeUInt16LE(e.time, 12);
        h.writeUInt16LE(e.date, 14);
        h.writeUInt32LE(e.crc >>> 0, 16);
        h.writeUInt32LE(e.csize, 20);
        h.writeUInt32LE(e.usize, 24);
        h.writeUInt16LE(e.name.length, 28);
        h.writeUInt16LE(0, 30); // extra
        h.writeUInt16LE(0, 32); // comment
        h.writeUInt16LE(0, 34); // disk
        h.writeUInt16LE(0, 36); // internal attributes
        h.writeUInt32LE(0, 38); // external attributes
        h.writeUInt32LE(e.offset, 42);
        await write(h);
        await write(e.name);
      }
      const cdSize = offset - cdStart;
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(0, 4);
      end.writeUInt16LE(0, 6);
      end.writeUInt16LE(entries.length, 8);
      end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(cdSize, 12);
      end.writeUInt32LE(cdStart, 16);
      end.writeUInt16LE(0, 20);
      await write(end);
      await fh.close();
      return { bytes: offset, entries: entries.length };
    },

    async abort() {
      closed = true;
      await fh.close().catch(() => {});
    },
  };
}
