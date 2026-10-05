/** Ansible Vault and helm values inside messages.
 *
 *  The same two modules the crypto tabs use (src/crypto/), untouched: a value
 *  that was encrypted for a file can be read out of a message, and a value that
 *  is about to be sent can be wrapped the same way. Both run on WebCrypto in
 *  this page, which is the point of the whole arrangement — **the password never
 *  leaves the browser**: it is not sent to the kafka-agent, to this app's server,
 *  or to the cluster, and there is no endpoint that would take it.
 *
 *  A value that says what it is gets recognised: an Ansible Vault envelope, or
 *  the `helm:vN:` label. A bare base64 string is not: it could be a helm v1
 *  envelope or just text, and guessing would put a password prompt in front of
 *  ordinary messages. The reader can always pick the format by hand.
 */
import { ansible, helm } from "../../crypto/index.ts";

export type VaultFormat = "ansible" | "helm";

export const VAULT_FORMATS: VaultFormat[] = ["ansible", "helm"];

/** What each one is called in the page. */
export const VAULT_TEXT: Record<VaultFormat, string> = {
  ansible: "Ansible Vault",
  helm: "helm",
};

const SCHEMES = { ansible, helm };

/** Which scheme a value came from, as far as its own text says so. */
export function detectVault(text: string | null): VaultFormat | null {
  const t = (text ?? "").trim();
  if (t.startsWith("$ANSIBLE_VAULT;")) return "ansible";
  if (/^helm:v\d+:/.test(t)) return "helm";
  return null;
}

export function encryptValue(format: VaultFormat, text: string, password: string): Promise<string> {
  return SCHEMES[format].encrypt(text, password);
}

export function decryptValue(format: VaultFormat, text: string, password: string): Promise<string> {
  return SCHEMES[format].decrypt(text.trim(), password);
}
