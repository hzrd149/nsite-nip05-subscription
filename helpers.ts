import { hexToBytes } from "@noble/hashes/utils";
import { getPubkeyFromDecodeResult, isHexKey } from "applesauce-core/helpers";
import { nip19 } from "nostr-tools";

export function normalizeToPubkey(str: string): string {
  if (isHexKey(str)) return str;
  else {
    const decode = nip19.decode(str);
    const pubkey = getPubkeyFromDecodeResult(decode);
    if (!pubkey) throw new Error(`Cant find pubkey in ${decode.type}`);
    return pubkey;
  }
}

export function normalizeToSecretKey(str: string): Uint8Array {
  if (isHexKey(str)) return hexToBytes(str);
  else {
    const decode = nip19.decode(str);
    if (decode.type !== "nsec")
      throw new Error(`Cant get secret key from ${decode.type}`);
    return decode.data;
  }
}
