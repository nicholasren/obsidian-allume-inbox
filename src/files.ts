export function readLocalFile(path: string, maxBytes: number): Promise<Uint8Array> {
  return Promise.reject(new Error(`not implemented: ${path} ${maxBytes}`));
}
