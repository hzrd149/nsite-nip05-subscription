import { getPublicKey } from "nostr-tools";
import { normalizeToPubkey, normalizeToSecretKey } from "./helpers";

const RELAYS = process.env.RELAYS ? process.env.RELAYS.trim().split(",") : [];
const LOOKUP_RELAYS = process.env.LOOKUP_RELAYS
  ? process.env.LOOKUP_RELAYS.trim().split(",")
  : ["wss://purplepag.es"];

if (!process.env.NSITE_KEY) throw new Error("Missing NSITE_KEY");
const NSITE_KEY = normalizeToSecretKey(process.env.NSITE_KEY);
const NSITE_PUBKEY = getPublicKey(NSITE_KEY);

const ZAP_KEY = process.env.ZAP_KEY
  ? normalizeToPubkey(process.env.ZAP_KEY)
  : NSITE_PUBKEY;

const MIN_ZAP_AMOUNT = process.env.MIN_ZAP_AMOUNT
  ? parseInt(process.env.MIN_ZAP_AMOUNT)
  : 1000;

export {
  RELAYS,
  NSITE_KEY,
  NSITE_PUBKEY,
  ZAP_KEY,
  LOOKUP_RELAYS,
  MIN_ZAP_AMOUNT,
};
