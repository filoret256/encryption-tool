"""Ansible Vault encryptor using cryptography library."""
import hashlib
import hmac
import os

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend


class AnsibleVaultEncryptor:
    """
    Ansible Vault compatible encryptor.

    Format: $ANSIBLE_VAULT;1.1;AES256
    Key derivation: PBKDF2-HMAC-SHA256, 10000 iterations
    Encryption: AES-256-CTR
    Authentication: HMAC-SHA256
    Padding: PKCS#7 (ansible-vault uses PKCS#7, not \\r padding)
    Encoding: Double hex (binary -> hex -> ASCII hex)
    """

    SALT_SIZE = 32
    ITERATIONS = 10000
    HEADER = "$ANSIBLE_VAULT;1.1;AES256"
    LINE_WIDTH = 80

    def _derive_keys(self, password: str, salt: bytes) -> tuple:
        """Derive encryption key, HMAC key, and IV/nonce."""
        derived = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, self.ITERATIONS, dklen=80
        )
        key = derived[:32]
        hmac_key = derived[32:64]
        iv = derived[64:80]
        return iv, key, hmac_key

    def _pkcs7_pad(self, data: bytes, block_size: int = 16) -> bytes:
        """Apply PKCS#7 padding to a multiple of block_size."""
        pad_len = block_size - (len(data) % block_size)
        return data + bytes([pad_len] * pad_len)

    def _pkcs7_unpad(self, data: bytes) -> bytes:
        """Remove PKCS#7 padding. Raises ValueError on invalid padding."""
        if not data:
            raise ValueError("Empty data")
        pad_len = data[-1]
        if pad_len == 0 or pad_len > 16:
            raise ValueError(f"Invalid PKCS#7 pad byte: {pad_len}")
        if any(b != pad_len for b in data[-pad_len:]):
            raise ValueError("Invalid PKCS#7 padding")
        return data[:-pad_len]

    def _format(self, salt: bytes, mac: bytes, ciphertext: bytes) -> str:
        """Format as Ansible Vault with double hex encoding."""
        inner = (
            salt.hex() + "\n" +
            mac.hex() + "\n" +
            ciphertext.hex()
        )
        hex_twice = inner.encode("ascii").hex()
        lines = [
            hex_twice[i : i + self.LINE_WIDTH]
            for i in range(0, len(hex_twice), self.LINE_WIDTH)
        ]
        return f"{self.HEADER}\n" + "\n".join(lines)

    def _parse(self, text: str) -> tuple:
        """Parse Ansible Vault format (double hex). Returns (salt, mac, ciphertext)."""
        lines = text.strip().split("\n")
        if not lines[0].startswith("$ANSIBLE_VAULT;"):
            raise ValueError("Invalid header")
        hex_twice = "".join(lines[1:])
        inner = bytes.fromhex(hex_twice).decode("ascii")
        parts = inner.split("\n")
        if len(parts) != 3:
            raise ValueError(f"Invalid vault format: expected 3 parts, got {len(parts)}")
        return bytes.fromhex(parts[0]), bytes.fromhex(parts[1]), bytes.fromhex(parts[2])

    def encrypt(self, text: str, password: str) -> str:
        """Encrypt text using Ansible Vault format."""
        salt = os.urandom(self.SALT_SIZE)
        iv, key, hmac_key = self._derive_keys(password, salt)
        padded = self._pkcs7_pad(text.encode("utf-8"))
        cipher = Cipher(algorithms.AES(key), modes.CTR(iv), backend=default_backend())
        encryptor = cipher.encryptor()
        ciphertext = encryptor.update(padded) + encryptor.finalize()
        mac = hmac.new(hmac_key, ciphertext, hashlib.sha256).digest()
        return self._format(salt, mac, ciphertext)

    def decrypt(self, text: str, password: str) -> str:
        """Decrypt text using Ansible Vault format."""
        salt, mac, ciphertext = self._parse(text)
        iv, key, hmac_key = self._derive_keys(password, salt)
        expected_mac = hmac.new(hmac_key, ciphertext, hashlib.sha256).digest()
        if not hmac.compare_digest(mac, expected_mac):
            raise ValueError("Invalid password or corrupted data")
        cipher = Cipher(algorithms.AES(key), modes.CTR(iv), backend=default_backend())
        decryptor = cipher.decryptor()
        decrypted_padded = decryptor.update(ciphertext) + decryptor.finalize()
        return self._pkcs7_unpad(decrypted_padded).decode("utf-8")
