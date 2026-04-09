/** NATS JetStream connection for domain events */

import { connect, type JetStreamClient, type NatsConnection } from "nats.ws";

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;

/** Connect to NATS and return JetStream client */
export async function getNats(): Promise<JetStreamClient> {
  if (js) return js;

  nc = await connect({
    servers: process.env.NATS_URL ?? "ws://localhost:4222",
  });

  js = nc.jetstream();
  return js;
}

/** Gracefully close NATS connection */
export async function closeNats(): Promise<void> {
  if (nc) {
    await nc.drain();
    nc = null;
    js = null;
  }
}
