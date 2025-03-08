import { EventStore, QueryStore } from "applesauce-core";
import { createRxForwardReq, createRxNostr, noopVerifier } from "rx-nostr";
import {
  BLOSSOM_SERVER_LIST_KIND,
  getBlossomServersFromList,
  getProfileContent,
  getTagValue,
  getZapPayment,
  getZapSender,
  unixNow,
} from "applesauce-core/helpers";
import {
  debounceTime,
  filter,
  interval,
  lastValueFrom,
  map,
  merge,
  tap,
} from "rxjs";
import { kinds, verifyEvent } from "nostr-tools";
import {
  LOOKUP_RELAYS,
  MIN_ZAP_AMOUNT,
  NSITE_KEY,
  NSITE_PUBKEY,
  RELAYS,
  ZAP_KEY,
} from "./env";
import { BlossomClient, getBlobSha256 } from "blossom-client-sdk";
import { multiServerUpload } from "blossom-client-sdk/actions/multi-server";
import { ReplaceableLoader, RequestLoader } from "applesauce-loaders";
import { SimpleSigner } from "applesauce-signers";
import { npubEncode } from "nostr-tools/nip19";

import { NIP_05_PATH, NSITE_KIND } from "./const";

const signer = new SimpleSigner(NSITE_KEY);

const eventStore = new EventStore();
const queryStore = new QueryStore(eventStore);

eventStore.verifyEvent = verifyEvent;

const rxNostr = createRxNostr({
  verifier: noopVerifier,
});
rxNostr.setDefaultRelays(RELAYS);

const replaceableLoader = new ReplaceableLoader(rxNostr, {
  lookupRelays: LOOKUP_RELAYS,
});
replaceableLoader.subscribe((packet) =>
  eventStore.add(packet.event, packet.from),
);

const requestLoader = new RequestLoader(queryStore);
requestLoader.replaceableLoader = replaceableLoader;

console.log(`Listening on ${RELAYS.join(", ")}`);
const req = createRxForwardReq("zaps");
rxNostr
  .use(req)
  .subscribe((packet) => eventStore.add(packet.event, packet.from));

const oneMonth = 60 * 60 * 24 * 30;

// fetch zaps in last 30 days
req.emit({
  kinds: [kinds.Zap],
  "#p": [ZAP_KEY],
  // all zaps since 30 days ago
  since: unixNow() - oneMonth,
});

// fetch profile events for every zap sender
eventStore.filters({ kinds: [kinds.Zap] }).subscribe((zap) => {
  const sender = getZapSender(zap);
  replaceableLoader.next({ pubkey: sender, kind: 0, relays: RELAYS });
});

// load servers and mailboxes for nsite key
replaceableLoader.next({ kind: kinds.RelayList, pubkey: NSITE_PUBKEY });
replaceableLoader.next({
  kind: BLOSSOM_SERVER_LIST_KIND,
  pubkey: NSITE_PUBKEY,
});
replaceableLoader.next({
  kind: NSITE_KIND,
  identifier: NIP_05_PATH,
  pubkey: NSITE_PUBKEY,
});

// update the /.well-known/nostr.json
merge(
  // every 10 minutes
  interval(60_000 * 10).pipe(
    tap(() => console.log(`Triggering update from 10 minute timer`)),
  ),
  // every time a new zap is seen
  eventStore.filters({ kinds: [kinds.Zap] }).pipe(
    debounceTime(10_000),
    tap(() => console.log(`Triggering update from new zap events`)),
  ),
)
  .pipe(
    // get since
    map(() => unixNow() - oneMonth),
    // get zap events from eventStore
    map((since) =>
      eventStore.database.getEventsForFilter({
        kinds: [kinds.Zap],
        "#p": [ZAP_KEY],
        since,
      }),
    ),
    // ignore empty zaps
    filter((zaps) => zaps.size > 0),
    // convert zaps into NIP-05 document
    map((zaps) => {
      console.log(`Calculating ${zaps.size} zaps`);
      const totals: Record<string, number> = {};

      for (const zap of zaps) {
        try {
          const sender = getZapSender(zap);
          const amount = getZapPayment(zap)?.amount;
          if (amount) totals[sender] = (totals[sender] ?? 0) + amount;
        } catch (error) {
          // failed to parse zap, ignore
        }
      }

      const names = Object.entries(totals)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .reduce(
          (dir, [pubkey, total]) => {
            // only include pubkeys that paid more than min sats (totals are in msat)
            if (total / 1000 < MIN_ZAP_AMOUNT) return dir;

            const metadata = eventStore.getReplaceable(0, pubkey);
            const profile = metadata && getProfileContent(metadata);
            const name = profile?.name ?? pubkey.slice(0, 8);

            if (dir[name]) return { ...dir, [pubkey.slice(0, 8)]: pubkey };
            else return { ...dir, [name]: pubkey };
          },
          {} as Record<string, string>,
        );

      console.log(`Found ${Object.keys(names).length} unique names`);

      // override root name
      names["_"] = NSITE_PUBKEY;

      return {
        names,
        relays: {},
      };
    }),
  )
  .subscribe(async (document) => {
    const npub = npubEncode(NSITE_PUBKEY);
    console.log(`Looking for blossom servers for ${npub}`);
    const serversEvent = await requestLoader.replaceable({
      kind: BLOSSOM_SERVER_LIST_KIND,
      pubkey: NSITE_PUBKEY,
    });
    const servers = getBlossomServersFromList(serversEvent);

    console.log(`Looking for mailboxes for ${npub}`);
    const mailboxes = await requestLoader.mailboxes({ pubkey: NSITE_PUBKEY });

    // create json blob
    const blob = new Blob([JSON.stringify(document, null, 2)], {
      type: "application/json",
    });
    const hash = await getBlobSha256(blob);

    // attempt to delete existing blob from serveres
    try {
      console.log("Looking for existing nsite event");
      const existing = await requestLoader.replaceable({
        kind: NSITE_KIND,
        pubkey: NSITE_PUBKEY,
        identifier: NIP_05_PATH,
      });
      const existingHash = getTagValue(existing, "x");
      if (!existingHash) throw new Error("Cant find existing hash");

      // only remove the old blob if its different
      if (existingHash !== hash) {
        // create delete auth
        const auth = await BlossomClient.createDeleteAuth(
          (d) => signer.signEvent(d),
          existingHash,
        );
        // delete existing blob from servers
        console.log(
          `Deleting existing blob (${existingHash}) from ${servers.length} servers`,
        );
        for (const server of servers)
          await BlossomClient.deleteBlob(server, existingHash, { auth });
      }
    } catch (error) {
      console.log(`Failed to remove existing ${NIP_05_PATH}`);
    }

    // create upload auth
    console.log(`Creating auth for upload`);
    const auth = await BlossomClient.createUploadAuth(
      (d) => signer.signEvent(d),
      blob,
    );

    // upload new document to servers
    console.log(`Uploading blob to ${servers.length} servers`);
    await multiServerUpload(servers, blob, { auth });

    // update nsite event
    const event = await signer.signEvent({
      kind: NSITE_KIND,
      content: "",
      tags: [
        ["d", NIP_05_PATH],
        ["x", hash],
      ],
      created_at: unixNow(),
    });

    // publish event
    console.log(`Updating nsite event with new file (${hash})`);
    await lastValueFrom(
      rxNostr.send(event, { on: { relays: mailboxes.outboxes } }),
    );
    eventStore.add(event);
  });
