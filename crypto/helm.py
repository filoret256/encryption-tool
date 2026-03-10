"""Helm chart compatible encryptor (AES-256-CBC + PKCS7)."""
import base64
import os

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend


class HelmEncryptor:
    """
    Helm-compatible encryptor.

    Key        : password zero-padded to 32 bytes
    Algorithm  : AES-256-CBC + PKCS7 padding
    Wire format: base64(iv[16] + ciphertext)
    """

    _IV_SIZE = 16
    _KEY_SIZE = 32

    def _derive_key(self, password: str) -> bytes:
        return password.encode().ljust(self._KEY_SIZE, b"\x00")

    def _pkcs7_pad(self, data: bytes) -> bytes:
        n = 16 - (len(data) % 16)
        return data + bytes([n] * n)

    def _pkcs7_unpad(self, data: bytes) -> bytes:
        if not data:
            raise ValueError("Empty data")
        n = data[-1]
        if not (1 <= n <= 16) or data[-n:] != bytes([n] * n):
            raise ValueError("Invalid PKCS7 padding")
        return data[:-n]

    def _aes_cbc(self, key: bytes, iv: bytes, data: bytes, *, encrypt: bool) -> bytes:
        cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
        ctx = cipher.encryptor() if encrypt else cipher.decryptor()
        return ctx.update(data) + ctx.finalize()

    # ------------------------------------------------------------------ #
    # Public API                                                           #
    # ------------------------------------------------------------------ #

    def encrypt(self, text: str, password: str) -> str:
        iv = os.urandom(self._IV_SIZE)
        key = self._derive_key(password)
        ciphertext = self._aes_cbc(key, iv, self._pkcs7_pad(text.encode()), encrypt=True)
        return base64.b64encode(iv + ciphertext).decode()

    def decrypt(self, text: str, password: str) -> str:
        raw = base64.b64decode(text)
        if len(raw) < self._IV_SIZE + 16 or (len(raw) - self._IV_SIZE) % 16:
            raise ValueError("Invalid encrypted data")
        iv, ciphertext = raw[:self._IV_SIZE], raw[self._IV_SIZE:]
        key = self._derive_key(password)
        return self._pkcs7_unpad(self._aes_cbc(key, iv, ciphertext, encrypt=False)).decode()
