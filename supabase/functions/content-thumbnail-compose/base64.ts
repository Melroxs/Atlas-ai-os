// ---------------------------------------------------------------------------
// Atlas — deterministic thumbnail compositor: base64 utilities
//
// A single, dependency-free base64 decoder shared by the asset loaders and the
// background validator. `atob` is a global on Deno and on Node. The loop is
// deliberate: `TextDecoder`-style bulk APIs vary between runtimes, and this
// produces byte-identical output everywhere.
//
// This module never logs, never throws on hostile input on its own, and never
// touches the network.
// ---------------------------------------------------------------------------

/** Decode a base64 string into raw bytes. Throws only on malformed base64. */
export function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
