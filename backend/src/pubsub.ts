import { PubSub } from '@google-cloud/pubsub';

export function makePubSub(): PubSub {
  return new PubSub(); // uses Cloud Run service account (ADC)
}
