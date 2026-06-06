# Encryption Tool / Инструмент шифрования

Web application for encrypting/decrypting text using Helm and Ansible Vault compatible formats.
All DevOps needs.

Веб-приложение для шифрования и дешифрования текста в форматах, совместимых с Helm и Ansible Vault.
То что нужно для DevOps.

---

## Features / Возможности

### Encryption Tabs / Вкладки шифрования

| Tab / Вкладка | Scheme / Схема | Wire format / Формат |
|---------------|---------------|----------------------|
| **Helm** | PBKDF2-HMAC-SHA256 (10000) → AES-256-CBC + PKCS#7 | `base64(salt[16] + iv[16] + ciphertext)` |
| **Ansible Vault** | PBKDF2-HMAC-SHA256 (10000) → AES-256-CTR + HMAC-SHA256 | `$ANSIBLE_VAULT;1.1;AES256` (interoperable with the `ansible-vault` CLI) |

### Additional Tools / Дополнительные инструменты

- **Base64 encode/decode** — кодирование/декодирование Base64
- **Base64 with Unix line endings** — Base64 с Unix-окончаниями строк
- **File import/export** — импорт/экспорт файлов
- **Copy to clipboard** — копирование в буфер обмена
- **Live YAML validity highlighting** — inline-подсветка ошибок YAML (CodeMirror lint)
- **Find & Replace** — поиск и замена текста
- **Line numbers toggle** — переключение нумерации строк
- **Dark/Light theme** — тёмная/светлая тема
- **Word/Character count** — подсчёт слов и символов
- **Whitespace visualization** — визуализация пробельных символов

---

## Quick Start / Быстрый старт

### Local (Bun) / Локально

```bash
bun install
bun run build      # bundle the CodeMirror frontend -> public/
bun run dev        # or: bun run start
```

### Standalone binary / Автономный бинарник

Compile a single self-contained executable with the frontend assets embedded —
no Bun or source files needed to run it:

```bash
bun run build      # bundle the CodeMirror frontend -> public/
bun run compile    # -> ./server (embeds public/ + index.html)
./server           # serves on :5000
```

### Docker

Multi-stage build: Bun compiles the binary, which then runs in a minimal
`debian:bookworm-slim` image (just the executable).

```bash
docker build -t encryption-tool .
docker run -p 5000:5000 encryption-tool
```

Open http://localhost:5000 / Откройте http://localhost:5000

---

## API Endpoints / API эндпоинты

| Endpoint / Эндпоинт | Method / Метод | Body / Тело запроса | Response / Ответ |
|---------------------|----------------|---------------------|------------------|
| `/helm/encrypt` | POST | `{text, password}` | `{result}` |
| `/helm/decrypt` | POST | `{text, password}` | `{result}` |
| `/ansible/encrypt` | POST | `{text, password}` | `{result}` |
| `/ansible/decrypt` | POST | `{text, password}` | `{result}` |

---

## Project Structure / Структура проекта

```
.
├── src/
│   ├── server.ts       # Bun HTTP server (4 crypto endpoints, embeds static assets)
│   ├── crypto/
│   │   ├── helm.ts     # Helm encryptor (PBKDF2 + AES-256-CBC)
│   │   ├── ansible.ts  # Ansible Vault encryptor (AES-256-CTR + HMAC)
│   │   ├── pkcs7.ts    # PKCS#7 padding
│   │   └── index.ts
│   └── web/            # CodeMirror frontend (index.html, main.ts, editor.ts, yaml-lint.ts, style.css)
├── package.json
└── Dockerfile          # multi-stage: compile binary -> debian-bookworm-slim
```

---

## Technologies / Технологии

- **Backend:** Bun + TypeScript (`Bun.serve`, `node:crypto`)
- **Frontend:** CodeMirror 6, TypeScript
- **Encryption:** AES-256-CBC, AES-256-CTR, HMAC-SHA256, PBKDF2
- **Deployment:** standalone compiled binary on `debian:bookworm-slim`

---

## License / Лицензия

MIT
