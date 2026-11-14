import { promises as fsp } from "fs";

/** The largest attachment copied into the vault. */
export const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024;

/** Read a file Allume put on disk for a card. Refuses devices, folders and huge files. */
export async function readLocalFile(path: string, maxBytes = MAX_ATTACHMENT_BYTES): Promise<Uint8Array> {
  const st = await fsp.stat(path);
  if (!st.isFile()) throw new Error(`${path} is not a file`);
  if (st.size > maxBytes) {
    throw new Error(`${path} is too large to copy (${st.size} bytes, limit ${maxBytes})`);
  }
  return new Uint8Array(await fsp.readFile(path));
}
