/** Encryption, where the files actually are.
 *
 *  The product is "encryption plus an editor with git", and until now the two
 *  halves did not know about each other: encrypting a file you had open meant
 *  selecting it, copying, switching tabs, pasting, typing a password,
 *  encrypting, copying back, switching back, pasting, saving. That is the main
 *  path of the person this tool is for — editing `group_vars/*` with secrets in
 *  it — and it ran entirely through the clipboard.
 *
 *  Two shapes matter, and only the first was ever supported:
 *
 *    - the whole file as one vault envelope, which is `ansible-vault encrypt`;
 *    - one *value* inside a YAML file, tagged `!vault |`, which is
 *      `ansible-vault encrypt_string` — and in practice the common one, because
 *      a `values.yaml` with one secret in it should stay readable.
 *
 *  Passwords are asked for per operation and never kept. There is nowhere to
 *  keep one that would not be worse than asking again.
 */
import { ansible, helm } from "../../crypto/index.ts";

export type Scheme = "ansible" | "helm";

export const VAULT_HEADER = "$ANSIBLE_VAULT;";

/** Is this whole document an Ansible Vault envelope?
 *
 *  Checked against the first non-blank line, because a file written by the CLI
 *  has the header first and nothing before it. */
export function isVaultFile(text: string): boolean {
  const first = text.split("\n").find((l) => l.trim().length > 0);
  return first?.trimStart().startsWith(VAULT_HEADER) === true;
}

/** The `!vault |` block for one YAML value.
 *
 *  `indent` is the indentation of the *key* the value belongs to; the envelope
 *  sits two spaces deeper, which is what `ansible-vault encrypt_string`
 *  produces and what the YAML parser needs to read it back as one scalar. */
export function vaultBlock(envelope: string, indent: number): string {
  const pad = " ".repeat(indent + 2);
  return `!vault |\n${envelope
    .split("\n")
    .map((l) => pad + l)
    .join("\n")}`;
}

/** Pull the envelope back out of a `!vault |` block.
 *
 *  Returns null when the text is not one — the caller then knows to say so
 *  rather than handing arbitrary text to the decryptor and reporting its
 *  complaint about a missing header. */
export function unwrapVaultBlock(text: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.includes("!vault"));
  if (start === -1) return null;
  const body = lines.slice(start + 1);
  const envelope = body
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
  return envelope.startsWith(VAULT_HEADER) ? envelope : null;
}

/** How much whitespace the line the selection starts on is indented by. */
export function indentOfLine(line: string): number {
  return /^[ \t]*/.exec(line)![0].length;
}

export const schemes: Record<Scheme, { encrypt(t: string, p: string): Promise<string>; decrypt(t: string, p: string): Promise<string> }> = {
  ansible,
  helm,
};

/** A label for messages, so "encrypted" says which of the two it was. */
export const schemeName: Record<Scheme, string> = {
  ansible: "Ansible Vault",
  helm: "helm-encrypt",
};
