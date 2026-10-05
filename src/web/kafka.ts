/** Build entry for the kafka tab.
 *
 *  Bundled separately to public/kafka.js and imported the first time the tab
 *  is opened, for the reason code.ts gives: a visitor who came to decrypt a
 *  string should not download a Kafka browser. The filename is fixed (no
 *  --splitting) so server.ts can embed it into the standalone binary.
 */
export { mountKafkaTab } from "./kafka/index.ts";
export type { KafkaContext, KafkaTab } from "./kafka/index.ts";
