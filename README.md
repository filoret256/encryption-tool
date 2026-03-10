# Encryption Tool / Инструмент шифрования

Web application for encrypting/decrypting text using Helm and Ansible Vault compatible formats.
All DevOps needs.

Веб-приложение для шифрования и дешифрования текста в форматах, совместимых с Helm и Ansible Vault.
То что нужно для DevOps.

---

## Features / Возможности

### Encryption Tabs / Вкладки шифрования

| Tab / Вкладка | Encrypt / Шифрование | Decrypt / Дешифрование |
|---------------|---------------------|----------------------|
| **Helm** | AES-256-CBC, base64(iv+ciphertext) | Password padded to 32 bytes / Пароль дополняется до 32 байт |
| **Ansible Vault** | AES-256-CBC + HMAC-SHA256 | PBKDF2-HMAC-SHA256, 10000 итераций |

### Additional Tools / Дополнительные инструменты

- **Base64 encode/decode** — кодирование/декодирование Base64
- **Base64 with Unix line endings** — Base64 с Unix-окончаниями строк
- **File import/export** — импорт/экспорт файлов
- **Copy to clipboard** — копирование в буфер обмена
- **JSON/YAML validation** — валидация JSON/YAML
- **Find & Replace** — поиск и замена текста
- **Line numbers toggle** — переключение нумерации строк
- **Dark/Light theme** — тёмная/светлая тема
- **Word/Character count** — подсчёт слов и символов
- **Whitespace visualization** — визуализация пробельных символов

---

## Quick Start / Быстрый старт

### Local / Локально

```bash
pip install -r requirements.txt
python app.py
```

### Docker

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
| `/validate` | POST | `{text}` | `{valid, format}` |

---

## Project Structure / Структура проекта

```
.
├── app.py              # Flask application / Flask-приложение
├── crypto/
│   ├── __init__.py
│   ├── helm.py         # Helm encryptor (AES-256-CBC) / Шифратор Helm
│   └── ansible.py      # Ansible Vault encryptor (AES-256-CBC + HMAC) / Шифратор Ansible Vault
├── templates/
│   └── index.html      # Frontend UI / Пользовательский интерфейс
├── requirements.txt    # Dependencies / Зависимости
├── Dockerfile          # Docker configuration / Docker-конфигурация
├── .github/
│   └── workflows/
│       └── docker-build.yml  # CI/CD pipeline / CI/CD-пайплайн
└── README.md           # Documentation / Документация
```

---

## Technologies / Технологии

- **Backend:** Python, Flask, cryptography
- **Frontend:** HTML, CSS, Vanilla JavaScript
- **Encryption:** AES-256-CBC, AES-256-CTR, HMAC-SHA256, PBKDF2
- **Deployment:** Docker, Gunicorn
- **CI/CD:** GitHub Actions

---

## License / Лицензия

MIT
