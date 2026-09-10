# Encryption Tool / Инструмент шифрования

Web application for encrypting/decrypting text using Helm and Ansible Vault compatible
formats, with a git-backed code editor. All DevOps needs.

Веб-приложение для шифрования и дешифрования текста в форматах, совместимых с Helm и
Ansible Vault, плюс редактор кода с полноценным git. То что нужно для DevOps.

Installable as a PWA. Encryption runs entirely in the browser — passwords never leave
your machine.

Ставится как PWA. Шифрование выполняется целиком в браузере — пароли никуда не уходят.

---

## Tabs / Вкладки

| Tab / Вкладка | Scheme / Схема | Wire format / Формат |
|---------------|---------------|----------------------|
| **ansible-vault** | PBKDF2-HMAC-SHA256 (10000) → AES-256-CTR + HMAC-SHA256 | `$ANSIBLE_VAULT;1.1;AES256` (interoperable with the `ansible-vault` CLI) |
| **helm** | PBKDF2-HMAC-SHA256 (10000) → AES-256-CBC + PKCS#7 | `base64(salt[16] + iv[16] + ciphertext)` |
| **code** | — | Editor over a local folder, backed by the system `git` |

### Encryption tabs / Вкладки шифрования

- **Client-side crypto (WebCrypto)** — шифрование в самой странице, пароль не покидает браузер
- **Base64 encode/decode**, в том числе с Unix-окончаниями строк
- **File import/export**, copy to clipboard
- **Live YAML validity highlighting** — inline-подсветка ошибок YAML (CodeMirror lint)
- **Find & Replace**, нумерация строк, перенос строк, визуализация пробелов
- **Dark/Light theme**, подсчёт строк/символов/байт

### Code tab / Вкладка кода

- **Explorer** — виртуализированное дерево (десятки тысяч файлов), контекстное меню,
  создание/переименование/удаление, **drag & drop**, git-декорации на файлах и папках,
  иконки типов файлов из набора Seti UI (MIT)
- **Preview tabs** — одиночный клик открывает файл «на просмотр»: такая вкладка одна
  и переиспользуется, поэтому проход по двадцати файлам не оставляет двадцати вкладок.
  Двойной клик или первая правка закрепляют её (курсив в заголовке снимается).
  Диффы из source control и истории делят тот же слот
- **Editor tabs** — вкладки открытых файлов, каждая со своим курсором, прокруткой и
  историей отмены; окончания строк файла сохраняются при записи
- **Syntax highlighting** — 18 грамматик (TS/JS/JSX, JSON, YAML, CSS, HTML, Markdown,
  Python, Rust, Go, XML, SQL, C/C++, Java, PHP, shell, TOML, ini/properties, Dockerfile)
- **Project search & replace** — ripgrep (или встроенный обход), потоковая выдача
  результатов, `match case`, `whole word`, `regex`, **`preserve case`**, include/exclude
  по глобам, отбрасывание отдельных совпадений перед заменой
- **Source control** — статус, стейджинг, коммиты, amend, ветки, checkout, merge,
  **rebase**, **revert**, **reset**, cherry-pick, stash, fetch/pull/push с прогрессом
- **History** — лог с графом веток (свой lane-рендерер), детали коммита с файлами и
  `+n −m`, контекстное меню (revert, cherry-pick, reset, ветка отсюда)
- **Diff** — side-by-side и inline на `@codemirror/merge`; git-диффы (`index → рабочая
  копия`, `HEAD → index`, коммит против родителя, `Compare with HEAD`) и сравнение
  двух произвольных файлов через `Select for compare`
- **Merge conflicts** — маркеры git подсвечиваются прямо в редакторе, над каждым
  регионом кнопки `accept current` / `accept incoming` / `accept both`, затем
  `save & mark resolved`
- **Live file watching** — дерево и открытые файлы обновляются при изменениях на диске
- **Get agent** — кнопка рядом с вкладками (только на этой вкладке): готовый бинарник
  агента под вашу ОС, команда запуска с уже подставленным origin и SHA-256

---

## The local agent / Локальный агент

A browser tab cannot spawn a process, so "use the git installed in the OS" necessarily
means a small helper running on the user's machine. That helper is **the same binary**
in a second mode.

Браузер не может запускать процессы, поэтому «использовать git, установленный в ОС»
требует небольшого локального процесса. Это **тот же самый бинарник**, второй режим.

```bash
# point it at a folder — the binary can live anywhere
enc-tool-agent ~/work/my-project
# or run it inside one / или просто в нужной папке
enc-tool-agent
#   in dev / в деве:
bun run agent -- ~/work/my-project
```

Передавать папку аргументом удобнее, чем копировать бинарник в каждый проект:
один скачанный агент обслуживает любой репозиторий.

It prints a `ws://127.0.0.1:5001/ws?token=…` URL — paste it into the code tab
(`connect…`). The tab remembers it.

The agent takes the **first free port in 5001-5010**, so a second folder in a
second tab needs no flag: start another agent and it lands on 5002. That range
is not arbitrary — it is exactly what the page's `connect-src` permits (see
`AGENT_PORTS` below), and a port outside it is refused by the browser before a
packet leaves, which from the tab looks the same as an agent that never started.
`--port` still pins one explicitly, and the agent says so on stderr if that port
falls outside the range.

Агент сам занимает первый свободный порт из 5001-5010 — для второй папки флаг
не нужен. Порт вне диапазона браузер не пропустит: его запрещает `connect-src`
страницы, если приложение не запущено с `AGENT_PORTS`.

> **Why a loopback URL works from a page served by a cloud host.** `127.0.0.1` is
> resolved by the browser, on the machine the browser is running on — the page's
> JavaScript executes there, so the socket goes to the user's own agent and the
> server never takes part. Installing the app as a PWA changes none of this: it is
> the same engine and the same network stack, only a different window.
>
> `127.0.0.1` считается «potentially trustworthy», поэтому `ws://` с https-страницы
> не блокируется как mixed content — в Chromium и Firefox. Chrome дополнительно
> шлёт preflight Private Network Access, и агент отвечает на него
> `Access-Control-Allow-Private-Network: true`. **WebKit/Safari** запрещает такие
> соединения — там вкладка code не заработает, и значок возможностей об этом
> говорит прямо.

```
[folder]                folder to expose, as the first argument
--root <dir>            the same thing as a flag (default: current directory)
--port <n>              pin the loopback port (default: the first free port
                        in 5001-5010, the range the page may connect to)
--token <str>           fixed access token (default: random, printed at startup)
--allow-origin <url>    origin allowed to connect, repeatable
                        (http://localhost:5000 and http://127.0.0.1:5000 are
                        allowed by default — the web app's own port)
--allow-no-origin       also accept clients that send no Origin header at all
--allow-multiple        serve more than one client at once (default: one)
--no-clipboard          do not copy the URL to the clipboard on startup
```

### Getting the URL across / Как перенести URL

The token is new on every run, so that one line would otherwise be selected with
the mouse every single time. Two halves meet in the middle:

- **the agent copies it** as it starts, through the platform's own clipboard
  tool (`clip`, `pbcopy`, `wl-copy`/`xclip`/`xsel`), and says so in the banner.
  Only when stdout is a terminal — piped output belongs to a script, not to
  someone about to paste — and never with `--no-clipboard`;
- **the tab takes it**: paste anywhere on the code tab and it connects. The
  `connect…` dialog also prefills from the clipboard where the browser permits
  reading it, falling back to the last URL used.

A paste is only acted on when it is the agent's own URL — a loopback host, the
`/ws` path, a token — and only while no agent is connected and the caret is not
in a field or in the editor. Anything else is left to paste where it was aimed.

Токен новый при каждом запуске, поэтому агент сам кладёт URL в буфер обмена, а
вкладка подхватывает его из вставки — `Ctrl+V` в любом месте вкладки `code`.

> The URL is a credential. Putting it on the clipboard makes it readable by any
> process on the machine, and Windows Cloud Clipboard or macOS Universal
> Clipboard may sync it to your other devices — `--no-clipboard` turns that off.
>
> URL — это учётные данные: в буфере обмена его видит любой процесс.

**Requires:** `git` on `PATH`. **Optional:** `ripgrep` — без него поиск использует
более медленный встроенный обход.

### Getting the agent / Как получить агента

The app itself normally runs in a container, and an agent there would be
pointless: it would expose the pod's filesystem rather than yours, and its
loopback is not your browser's. So the image carries cross-compiled agents and
hands them out — **⤓ get agent**, beside the tabs, shown only on the code tab.

Само приложение обычно работает в контейнере, где агент бессмысленен — он открыл
бы файловую систему пода, а не вашу. Поэтому образ несёт кросс-собранные
бинарники и раздаёт их: кнопка **⤓ get agent** рядом с вкладками, видна только на
вкладке code.

The panel picks the archive for your platform, states its size and SHA-256, and
shows the commands to run it — with this deployment's origin already substituted
into `--allow-origin`, which is the one flag that is easy to get wrong.

| Platform | Archive | Download |
|----------|---------|----------|
| Windows x64 | `.zip` | 38 MB |
| macOS Apple Silicon | `.tar.gz` | 24 MB |
| macOS Intel | `.tar.gz` | 27 MB |
| Linux x64 / arm64 | `.tar.gz` | 35 MB each |

An archive rather than a bare binary on purpose: a file saved by a browser
arrives without the executable bit on macOS and Linux, so `tar` — which keeps
mode `0755` — is what stands between the user and `permission denied`. It also
keeps macOS from quarantining the binary, since unpacking with `tar` in a
terminal does not propagate the flag the way Finder does. The binaries are
unsigned, so Windows SmartScreen may still warn on first run.

Build them yourself with:

```bash
bun run agents:build                      # all five, ~14 MB, into dist/agents
bun run agents:build --targets linux-x64  # or just one
bun run agents:build --runtime bun        # the TypeScript agent instead (~166 MB)
```

The agent that ships is the Go program in `agent-go/` — same protocol, about a
twelfth of the size, because a Bun binary has to embed the whole runtime. Both
implementations are kept working and are tested against each other; see
[Two agents](#two-agents--два-агента).

Агент, который раздаётся, — это Go-программа в `agent-go/`: тот же протокол и
в двенадцать раз меньше, потому что бинарник Bun несёт в себе весь рантайм.

Agents are versioned and users keep them, so a tab and its agent drift apart on
their own. The capability badge compares the two and says so, instead of letting
the mismatch surface later as an unexplained protocol error.

### Two agents / Два агента

There are two implementations of the same agent, and that is deliberate.

`src/agent/` is the TypeScript one — the reference, and what `bun run agent`
starts while you work on it. `agent-go/` is the Go port, and it is what gets
built, packed and handed to users, because a compiled Bun binary embeds the
whole JavaScript runtime: 25–40 MB per platform against roughly 3 MB.

Two implementations of one protocol usually means two subtly different
protocols. What keeps that from happening here is that neither has its own test
suite. `bun run agent:smoke` starts both, drives both over a real WebSocket with
the same requests, and then **compares their replies field for field** — not just
that both passed, but that both returned the same JSON, down to the wording of a
"file not found". A drift in a `git status` parser or a missing `null` fails the
run and names the first differing byte.

That is also how the port paid for itself early: comparing the two turned up a
crash in the *TypeScript* agent, where a rejected argument (`git.checkout` with a
ref beginning with `-`) threw synchronously and killed the process — a denial of
service reachable with exactly the input the validation existed to catch.

Две реализации одного протокола обычно расходятся. Здесь этого не происходит
потому, что у них нет отдельных тестов: `bun run agent:smoke` поднимает обе,
гоняет одни и те же запросы и сравнивает ответы побайтно.

The Go agent needs a toolchain only to build; users get a static binary that
needs nothing. Set `GO_BIN` if your Go is unpacked somewhere off `PATH`. Without
any Go at all, the smoke suite says so and runs the TypeScript half.

### Security / Безопасность

The agent is a filesystem bridge, so five things gate it:

1. binds **`127.0.0.1` only** — never reachable from the network;
2. a **token** is required on every connection;
3. the **`Origin` header** is checked against an allowlist. Allowed by default:
   the web app's own default port (`http://localhost:5000`, `http://127.0.0.1:5000`)
   and nothing else. A request with **no** `Origin` is refused unless
   `--allow-no-origin` says otherwise — a browser always sends one, so a missing
   `Origin` is never the app;
4. the **`Host` header** must name this agent: `127.0.0.1`, `localhost` or `[::1]`
   on its own port. This is what stops DNS rebinding, where a name the attacker
   controls resolves to `127.0.0.1` and the request arrives here under it;
5. every path is confined to the workspace — lexical checks plus a `realpath` test, so
   a symlink inside the folder cannot point out of it.

One client at a time. The agent takes a single connection and refuses the rest
while it is held — so it is always clear which page has the folder — and says so
on stderr: `client connected … locked`, `refused a second client`,
`client disconnected … unlocked`. A second tab is told the agent is busy rather
than left guessing why it will not connect. `--allow-multiple` lifts the limit
for the case where two panes onto one folder is the point.

Two ceilings keep one connection from being the whole machine: a file write is
refused above the 4 MB that a read would return anyway, and the ops that spawn a
child process — every `git.*` and `search` — are capped at four at a time per
connection. Past that they queue, so search-as-you-type is a wait rather than a
process per keystroke.

Git is spawned with an argv array (never a shell) and `GIT_TERMINAL_PROMPT=0`.
Credentials are never handled by this app: the system credential helper and your SSH
agent do that, so no token ever reaches the browser or the server.

> **Deployment note.** To reach an agent from a UI hosted elsewhere, each user runs
> `enc-tool agent --allow-origin https://your-host`, or sets `ENC_TOOL_ALLOW_ORIGIN`
> once instead of passing the flag every time. Any page from that origin can then
> talk to that user's agent — trusting the server means trusting it with your working
> directory. Without either, only the app's own default port on `localhost` connects.
>
> Serving the app on some other local port? Name it: `--allow-origin http://localhost:3000`.
> Every refusal is logged to the agent's stderr with the flag that would permit it,
> because a rejected connection looks identical to a stopped agent from the browser.

---

## Quick Start / Быстрый старт

### Local (Bun) / Локально

```bash
bun install
bun run build      # bundle the frontend -> public/ (main.js, code.js, sw.js, main.css)
bun run dev        # or: bun run start
```

### Standalone binary / Автономный бинарник

Compile a single self-contained executable with every asset embedded — no Bun or source
files needed to run it:

```bash
bun run build
bun run compile      # -> ./server (embeds public/, index.html, manifest, icons)
bun run agents:build # optional: -> dist/agents, offered by the code tab
./server             # serves on :5000
./server agent       # the local filesystem + git bridge
```

The agent archives stay on disk rather than being embedded — folding another
14 MB of executables into the executable that serves them helps nobody. Without them the
download button simply does not appear.

### Docker

Multi-stage build: Bun compiles the server binary, a second stage borrows the Go
toolchain from the official image and cross-compiles all five agents from that
one Linux image (`CGO_ENABLED=0`, so no target SDK is involved), and both land in
a minimal `debian:bookworm-slim` image.

```bash
docker build -t encryption-tool .
docker run -p 5000:5000 encryption-tool
```

The agents add about 3 MB each, so which ones ship is still a build argument —
and they are copied in before the server binary, as the slower-changing layer
that should stay cached when only the app changes.

```bash
# only what your users actually run
docker build --build-arg AGENT_TARGETS=windows-x64,darwin-arm64 -t encryption-tool .

# none at all, serving them from a mirror instead
docker build --build-arg AGENT_TARGETS= -t encryption-tool .
docker run -p 5000:5000 -e AGENT_DOWNLOAD_BASE=https://artifacts.internal/enc-tool encryption-tool
```

Cross-compilation fetches each target's runtime from Bun's CDN, so that stage
needs network access.

| Variable | Meaning |
|----------|---------|
| `AGENT_DIR` | where the archives and `agents.json` live (default: `/usr/local/share/enc-tool/agents`, then `dist/agents`) |
| `AGENT_DOWNLOAD_BASE` | serve the archives from a mirror rather than from this image |
| `AGENT_PORTS` | loopback ports the code tab may connect to — ports and `low-high` ranges, comma-separated (default: `5001-5010`) |

`AGENT_PORTS` is what `connect-src` in the CSP permits, and the agent binds the
first free port in the same range, so the two agree out of the box and several
folders can be open at once. If your users start agents with `--port` outside
5001-5010, list those ports here — otherwise the browser refuses the connection
before it is made, and the code tab says which port was blocked and which ones
are allowed. A value that is not a port or a range stops the server at startup
rather than being ignored, and the list is capped at 64 ports because every one
of them is written out in the header on every response.

Open http://localhost:5000 / Откройте http://localhost:5000

---

## PWA

Installable and works offline. `bun run icons` regenerates the icon set procedurally.

- `manifest.webmanifest` + 192/512/maskable icons and an `apple-touch-icon` for iOS
- service worker: network-first for the shell **and for scripts and styles**, with
  the cache as the offline fallback; icons and the manifest are
  stale-while-revalidate; cross-origin requests pass straight through (the agent
  lives on another origin)
- the cache is keyed by the app version, so a release drops the previous one and
  the worker itself changes — which is what raises the update bar
- updates never swap under a running session — a bar offers `reload` when a new
  version is waiting

> Assets have fixed names, since the compiled binary embeds them by path. Serving
> them stale-while-revalidate therefore meant a returning user could run the new
> `index.html` against the previous bundle for a load — and because `sw.js` itself
> had not changed, no new worker installed and no update bar appeared, so the
> mismatch was silent. Scripts and styles now follow the shell instead.
- **HTTPS is required** for the service worker; `localhost` counts as secure

**Offline:** оболочка и вкладки шифрования работают полностью без сети (крипто на
WebCrypto), вкладка code — пока запущен локальный агент.

### Capability badge / Значок возможностей

A chip in the header reports what is actually available — local agent, git, ripgrep,
live watching, secure context, installed-as-app — with the reason and the fix for
anything missing. Controls that need a missing capability are disabled and marked.

Значок в шапке показывает, что реально доступно, и почему чего-то нет. Кнопки,
требующие недоступной возможности, гаснут с пометкой.

---

## API Endpoints / API эндпоинты

The UI no longer uses these — encryption happens in the page. They remain for API
clients. Вкладки шифрования их не вызывают; эндпоинты оставлены для API-клиентов.

| Endpoint / Эндпоинт | Method / Метод | Body / Тело запроса | Response / Ответ |
|---------------------|----------------|---------------------|------------------|
| `/helm/encrypt` | POST | `{text, password}` | `{result}` |
| `/helm/decrypt` | POST | `{text, password}` | `{result}` |
| `/ansible/encrypt` | POST | `{text, password}` | `{result}` |
| `/ansible/decrypt` | POST | `{text, password}` | `{result}` |

Static routes: `/`, `/public/*`, `/sw.js`, `/manifest.webmanifest`.

Agent distribution:

| Endpoint / Эндпоинт | Method | Response / Ответ |
|---------------------|--------|------------------|
| `/agent/downloads` | GET | `{version, builds[]}` — platform, size and SHA-256 of each published agent |
| `/agent/download/<file>` | GET | the archive itself; only names present in `agents.json` are served |

---

## Multi-user isolation / Изоляция пользователей

Nothing is shared between users, by construction rather than by convention:

- **crypto** runs in the page — plaintext and passwords never reach the server;
- **the server** keeps no state, no session and no cookie — there is nothing for two
  requests to share;
- **the code tab** talks only to the user's own loopback agent, jailed to one folder,
  and the CSP pins `connect-src` to that agent's port — not to loopback at large,
  which would be a channel to every other service on the machine;
- **the download route** resolves a request only against the names in `agents.json`,
  so nothing else on that directory's path is reachable through it;
- every response carries a strict **CSP**: `script-src 'self'`, nothing remote, and
  no `'unsafe-inline'` in any directive. The one `<style>` the app creates at
  runtime — CodeMirror mounting its themes — is admitted by a per-request nonce
  the shell carries; `connect-src` reaches the agent's port and nothing else on
  loopback. Alongside it: `nosniff`, `no-referrer`, COOP, CORP, `X-Frame-Options`,
  HSTS and a `Permissions-Policy`; crypto responses are `Cache-Control: no-store`.
  All of them are stamped on the way out of the request handler, so a route cannot
  be added without them. HSTS carries no `includeSubDomains`: TLS is terminated by
  whatever proxy runs in front, and the app has no cookie a sibling host could reach.

The CSP matters because the agent's token lives in `localStorage`: script injection on
this origin would otherwise be script injection into someone's working directory.

Проверяется тестами `bun run isolation:smoke` и `bun run download:smoke`, а не
декларацией.

---

## Testing / Тесты

Every suite spawns real processes — a real server, a real agent, a real `git` — against
throwaway repositories. Ни один не использует моки.

```bash
bun run crypto:smoke      # WebCrypto ports interoperate with the previous node:crypto code
bun run isolation:smoke   # 60 concurrent users, jail escapes, loopback binding, CSP
bun run agent:smoke       # both agents, same checks, replies diffed against each other
bun run agent:test        # the Go agent's unit tests (WebSocket codec, RFC 6455 vector)
bun run protocol:check    # the two protocol definitions still describe the same wire
bun run git:smoke         # staging, commits, branches, merge/rebase/revert/reset, conflicts
bun run graph:smoke       # commit-graph lane layout and its SVG output
bun run search:smoke      # modifiers, globs, cancellation, preserve case, engine parity
bun run pwa:smoke         # manifest, icon sizes read from the PNG header, worker scope
bun run download:smoke    # archive formats read back, download route, origin allowlist
bunx tsc --noEmit
```

---

## Project Structure / Структура проекта

```
.
├── src/
│   ├── server.ts          # Bun HTTP server; `server agent` starts the bridge instead
│   ├── version.ts         # stated once; the agent and the tab compare it
│   ├── crypto/            # WebCrypto — runs in both Bun and the browser
│   │   ├── helm.ts        # PBKDF2 + AES-256-CBC
│   │   ├── ansible.ts     # PBKDF2 + AES-256-CTR + HMAC-SHA256
│   │   ├── pkcs7.ts       # PKCS#7 padding
│   │   ├── bytes.ts       # hex/base64/utf8, constant-time compare
│   │   └── index.ts
│   ├── agent/             # local filesystem + git bridge (loopback WebSocket)
│   │   ├── main.ts        # server, auth, origin allowlist, op dispatch
│   │   ├── jail.ts        # path containment (lexical + realpath)
│   │   ├── proc.ts        # argv-only spawn, line streaming
│   │   ├── fs-ops.ts      # readdir/read/write/move/delete
│   │   ├── git.ts         # porcelain=v2, for-each-ref, --raw --numstat parsing
│   │   ├── git-write.ts   # staging, commits, branches, merge/rebase, remotes
│   │   ├── search.ts      # ripgrep with a `git ls-files` fallback
│   │   ├── watch.ts       # debounced recursive fs.watch
│   │   ├── targets.ts     # the platforms agents are built for; shared naming
│   │   └── protocol.ts    # wire types, shared with the browser — the definition
│   │                      # both agents and the browser are written against
├── agent-go/              # the agent that actually ships: same protocol, ~7 MB
│   ├── main.go            # CLI, startup banner, capability probes
│   ├── server.go          # HTTP + WebSocket, auth, origin allowlist, op table
│   ├── ws.go              # RFC 6455 server, hand-written, no dependency
│   ├── ws_test.go         # frame codec and the handshake known-answer vector
│   ├── jail.go, fsops.go, git.go, gitwrite.go, search.go, watch.go
│   └── protocol.go        # the Go side of protocol.ts, kept honest by
│                          # `bun run protocol:check`
│   └── web/
│       ├── main.ts        # crypto tabs, capability badge, service-worker lifecycle
│       ├── code.ts        # entry for the lazily-loaded code tab bundle
│       ├── code/          # explorer, tabs, search, git panel, history, graph,
│       │                  # diff, conflicts, agent client, download panel
│       ├── sw.ts          # service worker
│       ├── manifest.webmanifest, icons/
│       └── index.html, style.css, editor.ts, yaml-lint.ts
├── scripts/
│   ├── build-agents.ts    # cross-compile the agent and pack it for download
│   ├── protocol-check.ts  # fails the build if the two protocol files disagree
│   ├── go-toolchain.ts    # locating Go (GO_BIN), shared by build and test
│   ├── go.ts              # passthrough: `bun scripts/go.ts test ./...`
│   ├── archive.ts         # minimal tar.gz and zip writers, no dependencies
│   ├── make-icons.ts      # procedural PWA icon generator
│   ├── build-file-icons.ts # regenerate the explorer's file-type icons
│   └── *-smoke.ts         # the eight test suites
├── THIRD-PARTY-LICENSES.md
├── package.json
└── Dockerfile             # server binary + cross-compiled agents -> bookworm-slim
```

Two icon sets, kept apart on purpose. `src/web/code/icons.ts` is the activity
rail and the toolbar, drawn for this project. `src/web/code/file-icons.ts` is the
file-type icons in the explorer, **generated** from [Seti UI](https://github.com/jesseweed/seti-ui)
(MIT) by `bun run icons:files` — the generator reads that theme's own palette and
extension mapping, so what you see matches VS Code's "Seti" rather than a guess.
The licence travels with them in `THIRD-PARTY-LICENSES.md`.

---

## Technologies / Технологии

- **Backend:** Bun + TypeScript (`Bun.serve`, WebCrypto)
- **Frontend:** CodeMirror 6 (+ `@codemirror/merge`), TypeScript, no framework
- **Editor backend:** the system `git` and `ripgrep`, driven by the local agent
- **Encryption:** AES-256-CBC, AES-256-CTR, HMAC-SHA256, PBKDF2 — via WebCrypto
- **Deployment:** standalone compiled binary on `debian:bookworm-slim`, PWA over HTTPS

### Browser support / Поддержка браузеров

Chromium and Firefox are fully supported. **WebKit/Safari** blocks `ws://127.0.0.1`
from an https page, so the code tab cannot reach an agent there — the capability badge
says so explicitly. Вкладки шифрования работают везде.

---

## License / Лицензия

MIT. Vendored third-party material and its notices are listed in
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).
