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
| **helm** | PBKDF2-HMAC-SHA256 (600000) → AES-256-GCM | `helm:v2:` + `base64(salt[16] + iv[12] + ciphertext + tag[16])`. The older `base64(salt[16] + iv[16] + ciphertext)` (AES-256-CBC, 10000 rounds, no authentication) is still decrypted, never written |
| **code** | — | Editor over a local folder, backed by the system `git` |
| **kafka** | — | Browser for Kafka clusters — topics, messages, consumer groups — through a local `kafka-agent` |

### Encryption tabs / Вкладки шифрования

- **Client-side crypto (WebCrypto)** — шифрование в самой странице, пароль не покидает браузер
- **Off the main thread** — the vault's double hex runs in a Web Worker (`public/crypto-worker.js`),
  so a 10 MB buffer neither freezes the tab nor eats its memory; a megabyte-scale value is seconds of
  work and the page stays usable. Where the worker cannot start, the work falls back to the page
  itself. One action per tab at a time, and the buttons say what is running. Text over **16 million
  characters** is refused with a message rather than attempted — the envelope is the input's hex a
  second time, so that is where a tab runs out of memory
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
- **⤓ code-agent** — кнопка в ряду вкладок сразу после `code` (только на этой вкладке): готовый бинарник
  агента под вашу ОС, команда запуска с уже подставленным origin и SHA-256

---

## The local code-agent / Локальный агент

A browser tab cannot spawn a process, so "use the git installed in the OS" necessarily
means a small helper running on the user's machine. That helper is **the same binary**
in a second mode.

Браузер не может запускать процессы, поэтому «использовать git, установленный в ОС»
требует небольшого локального процесса. Это **тот же самый бинарник**, второй режим.

```bash
# point it at a folder — the binary can live anywhere
code-agent ~/work/my-project
# or run it inside one / или просто в нужной папке
code-agent
#   in dev / в деве:
bun run code-agent -- ~/work/my-project
```

Передавать папку аргументом удобнее, чем копировать бинарник в каждый проект:
один скачанный агент обслуживает любой репозиторий.

It prints a `ws://127.0.0.1:5001/ws?token=…` URL — paste it into the code tab
(`connect…`). The tab remembers it.

The code-agent takes the **first free port in 5001-5010**, so a second folder in a
second tab needs no flag: start another code-agent and it lands on 5002. That range
is not arbitrary — it is exactly what the page's `connect-src` permits (see
`CODE_AGENT_PORTS` below), and a port outside it is refused by the browser before a
packet leaves, which from the tab looks the same as a code-agent that never started.
`--port` still pins one explicitly, and the code-agent says so on stderr if that port
falls outside the range.

Агент сам занимает первый свободный порт из 5001-5010 — для второй папки флаг
не нужен. Порт вне диапазона браузер не пропустит: его запрещает `connect-src`
страницы, если приложение не запущено с `CODE_AGENT_PORTS`.

> **Why a loopback URL works from a page served by a cloud host.** `127.0.0.1` is
> resolved by the browser, on the machine the browser is running on — the page's
> JavaScript executes there, so the socket goes to the user's own code-agent and the
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

- **the code-agent copies it** as it starts, through the platform's own clipboard
  tool (`clip`, `pbcopy`, `wl-copy`/`xclip`/`xsel`), and says so in the banner.
  Only when stdout is a terminal — piped output belongs to a script, not to
  someone about to paste — and never with `--no-clipboard`;
- **the tab takes it**: paste anywhere on the code tab and it connects. The
  `connect…` dialog also prefills from the clipboard where the browser permits
  reading it, falling back to the last URL used.

A paste is only acted on when it is the code-agent's own URL — a loopback host, the
`/ws` path, a token — and only while no code-agent is connected and the caret is not
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

### Getting the code-agent / Как получить агента

The app itself normally runs in a container, and a code-agent there would be
pointless: it would expose the pod's filesystem rather than yours, and its
loopback is not your browser's. So the image carries cross-compiled code-agents and
hands them out — **⤓ code-agent**, in the tab strip right after `code`, shown only on the code tab.

Само приложение обычно работает в контейнере, где агент бессмысленен — он открыл
бы файловую систему пода, а не вашу. Поэтому образ несёт кросс-собранные
бинарники и раздаёт их: кнопка **⤓ code-agent** в ряду вкладок сразу после `code`, видна только на
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
bun run code-agents:build                      # all five, ~14 MB, into dist/code-agents
bun run code-agents:build --targets linux-x64  # or just one
bun run code-agents:build --runtime bun        # the TypeScript code-agent instead (~166 MB)
```

The code-agent that ships is the Go program in `code-agent-go/` — same protocol, about a
twelfth of the size, because a Bun binary has to embed the whole runtime. Both
implementations are kept working and are tested against each other; see
[Two code-agents](#two-code-agents--два-агента).

Агент, который раздаётся, — это Go-программа в `code-agent-go/`: тот же протокол и
в двенадцать раз меньше, потому что бинарник Bun несёт в себе весь рантайм.

Code-agents are versioned and users keep them, so a tab and its code-agent drift apart on
their own. The capability badge compares the two and says so, instead of letting
the mismatch surface later as an unexplained protocol error.

### Two code-agents / Два агента

There are two implementations of the same code-agent, and that is deliberate.

`src/code-agent/` is the TypeScript one — the reference, and what `bun run code-agent`
starts while you work on it. `code-agent-go/` is the Go port, and it is what gets
built, packed and handed to users, because a compiled Bun binary embeds the
whole JavaScript runtime: 25–40 MB per platform against roughly 3 MB.

Two implementations of one protocol usually means two subtly different
protocols. What keeps that from happening here is that neither has its own test
suite. `bun run code-agent:smoke` starts both, drives both over a real WebSocket with
the same requests, and then **compares their replies field for field** — not just
that both passed, but that both returned the same JSON, down to the wording of a
"file not found". A drift in a `git status` parser or a missing `null` fails the
run and names the first differing byte.

That is also how the port paid for itself early: comparing the two turned up a
crash in the *TypeScript* code-agent, where a rejected argument (`git.checkout` with a
ref beginning with `-`) threw synchronously and killed the process — a denial of
service reachable with exactly the input the validation existed to catch.

Две реализации одного протокола обычно расходятся. Здесь этого не происходит
потому, что у них нет отдельных тестов: `bun run code-agent:smoke` поднимает обе,
гоняет одни и те же запросы и сравнивает ответы побайтно.

The Go code-agent needs a toolchain only to build; users get a static binary that
needs nothing. Set `GO_BIN` if your Go is unpacked somewhere off `PATH`. Without
any Go at all, the smoke suite says so and runs the TypeScript half.

### Security / Безопасность

The code-agent is a filesystem bridge, so five things gate it:

1. binds **`127.0.0.1` only** — never reachable from the network;
2. a **token** is required on every connection;
3. the **`Origin` header** is checked against an allowlist. Allowed by default:
   the web app's own default port (`http://localhost:5000`, `http://127.0.0.1:5000`)
   and nothing else. A request with **no** `Origin` is refused unless
   `--allow-no-origin` says otherwise — a browser always sends one, so a missing
   `Origin` is never the app;
4. the **`Host` header** must name this code-agent: `127.0.0.1`, `localhost` or `[::1]`
   on its own port. This is what stops DNS rebinding, where a name the attacker
   controls resolves to `127.0.0.1` and the request arrives here under it;
5. every path is confined to the workspace — lexical checks plus a `realpath` test, so
   a symlink inside the folder cannot point out of it.

One client at a time. The code-agent takes a single connection and refuses the rest
while it is held — so it is always clear which page has the folder — and says so
on stderr: `client connected … locked`, `refused a second client`,
`client disconnected … unlocked`. A second tab is told the code-agent is busy rather
than left guessing why it will not connect. `--allow-multiple` lifts the limit
for the case where two panes onto one folder is the point.

Two ceilings keep one connection from being the whole machine: a file write is
refused above the 4 MB that a read would return anyway, and the ops that spawn a
child process — every `git.*` and `search` — are capped at four at a time per
connection. Past that they queue, so search-as-you-type is a wait rather than a
process per keystroke.

Git is spawned with an argv array (never a shell) and `GIT_TERMINAL_PROMPT=0`.
Credentials are never handled by this app: the system credential helper and your SSH
code-agent do that, so no token ever reaches the browser or the server.

> **Deployment note.** To reach a code-agent from a UI hosted elsewhere, each user runs
> `enc-tool code-agent --allow-origin https://your-host`, or sets `ENC_TOOL_ALLOW_ORIGIN`
> once instead of passing the flag every time. Any page from that origin can then
> talk to that user's code-agent — trusting the server means trusting it with your working
> directory. Without either, only the app's own default port on `localhost` connects.
>
> Serving the app on some other local port? Name it: `--allow-origin http://localhost:3000`.
> Every refusal is logged to the code-agent's stderr with the flag that would permit it,
> because a rejected connection looks identical to a stopped code-agent from the browser.

---

## Kafka tab and the local kafka-agent / Вкладка kafka и локальный агент

The **kafka** tab browses and reads Kafka clusters: brokers and their settings, topics,
messages, consumer groups and their lag. Like the code tab it needs a small program on
your machine — a page cannot open a Kafka connection with TLS stores and SCRAM
logins — and it is built the same way: a Go binary (`kafka-agent`) that listens on
loopback, a token, an Origin allowlist, one page at a time.

Вкладка **kafka** просматривает кластеры Kafka: брокеры и их настройки, топики,
сообщения, consumer groups и их lag. Как и code, она работает через небольшой агент
на вашей машине (`kafka-agent`, Go, loopback, токен, allowlist по Origin).

**Every connection setting lives with the agent:** bootstrap servers, key and trust
stores and their passwords, SCRAM logins. No key, store or password ever reaches the
page. The page names a *cluster* from the agent's own configuration and nothing else, so
it cannot point the agent at a host nobody configured. The one thing of a connection the
page can read is what an error says about it, and that may name a broker's address —
never a secret. **A cluster is read-only unless you say
otherwise.** Every operation the agent has is marked *read* or *write*, and a write on a
read-only cluster is refused inside the agent with the code `READ_ONLY`, before anything is
sent to a broker — the page only reflects it (a `read-only` / `writable` tag on the cluster).
`readOnly: false` on a cluster, or `--allow-write` for every cluster whose configuration
says nothing, lifts it; an explicit `readOnly: true` is kept even under `--allow-write`.
What a writable cluster can do: **send a message**, **create** and **delete a topic**, **change a topic's
settings**, **add partitions**, **delete records below an offset**, **reset a consumer group's offsets** and
**delete a consumer group** (all below).
**Every write — done, failed or refused — leaves one line on the agent's stderr**
(`kafka-agent: write time=… cluster=dev op=topics.delete topic=orders result=ok messages=6`):
cluster, operation, what it acted on, result. Never a message's key, value or headers, never a
setting's value, never an error's text — only its code.
**A password for an Ansible Vault or helm envelope around a message's value goes nowhere:**
the value is opened and wrapped inside this page, by the same modules the ansible and helm
tabs use, and no endpoint of the agent or of this app would accept such a password.

**Все настройки подключения — у агента, страница их не видит:** bootstrap-серверы,
key/trust store и пароли к ним, SCRAM-логины. Страница называет только имя кластера из
конфигурации агента. **Кластер только для чтения, пока не сказано иное.** Каждая операция
агента помечена как чтение или запись; запись на кластере с `readOnly` (по умолчанию)
отклоняется в самом агенте с кодом `READ_ONLY` — до обращения к брокеру. Снимают запрет
`readOnly: false` у кластера или `--allow-write` для всех кластеров, у которых `readOnly`
не задан; явный `readOnly: true` флаг не отменяет. На записываемом кластере можно
**отправить сообщение**, **создать** и **удалить топик**, **изменить настройки топика**, **добавить партиции**,
**удалить записи до оффсета**, **сбросить офсеты группы** и **удалить consumer group** (ниже).
**Каждая запись — выполненная, неудачная или отклонённая — оставляет одну строку в stderr агента**
(`kafka-agent: write time=… cluster=dev op=topics.delete topic=orders result=ok messages=6`):
кластер, операция, цель, результат. Без ключей, значений и заголовков сообщений, без значений настроек,
без текста ошибок — только их код.
**Пароль от конверта ansible-vault или helm вокруг значения сообщения не уходит никуда:**
значение открывается и заворачивается в самой странице, теми же модулями, что и вкладки
ansible и helm; ни агент, ни сервер приложения такого пароля не принимают.

### What the tab does / Что умеет вкладка

- **Clusters** — state of each (`connected`, `unreachable`, `tls failed`, `login failed`),
  with the reason worded in terms of the setting to change, cluster id, controller,
  Kafka version
- **Brokers** — address, rack, controller; every broker setting, with sensitive
  values masked (the agent never reads them out)
- **Topics** — a virtual list (thousands are fine), internal topics hidden by default;
  partitions with leader, replicas, in-sync replicas, offsets and size; topic settings
- **Messages** — newest / oldest / from an offset / from a time, one partition or all,
  a limit; a **filter** (substring or regular expression, with or without case) applied
  *by the agent*, so it can look through far more than it sends; keys and values read
  as text, JSON (formatted), hex or base64; headers; a value over 256 KiB arrives cut
  off, and **load full message** fetches the rest (up to 8 MiB)
- **Values in an envelope** (ansible-vault, helm) — a value that says what it is (`$ANSIBLE_VAULT;…`
  or `helm:v2:…`) offers **decrypt** in the message header: the password is asked for and the value is
  opened **in this page**, with the same modules the crypto tabs use, so the password is never sent to
  the agent, to this app's server or to the cluster. The plaintext replaces the ciphertext on screen —
  with a tag and a **close it** button that puts the stored value back — and is dropped as soon as
  another message is selected. A value cut off at 256 KiB is not offered: half an envelope cannot be
  authenticated. A bare base64 value is not guessed at either (it could be the old helm format or just
  text); the format can be picked by hand in the dialog
- **ACLs** (K-44) — an **acls** view: every ACL the login may see, grouped by principal, with the
  resource, its name, the pattern (literal, prefixed, match), the operation, the permission (a `deny`
  row is marked) and the host. Two filters above the table — by principal and by resource — and the side
  panel is the index of principals, with the number of ACLs each has; clicking one filters by it. Read
  only: this agent has no op that creates or deletes an ACL. The listing asks for any pattern, so a
  prefixed or wildcard ACL is in it — a listing that hides ACLs would be worse than none
- **Schemas** (K-43, K-47) — a **schemas** view beside clusters, topics, consumers and brokers: the
  registry's subjects, and for the one that is opened its versions (with each version's schema id and
  format), its own compatibility level and mode (or the registry's, when it has none of its own), and
  the text of a version. **compare** on any version opens a diff of it against the one on screen — the
  same diff component the code tab uses, side by side or inline — so what changed between two versions
  is read, not hunted for. A cluster with no registry says so here rather than showing an empty list.
  Where the cluster may be changed, **new version…** (and `+ new` in the subject list) registers a
  schema: a subject, its format, its text, and the schemas it is written in terms of. **check** asks the
  registry whether it would take it — `schemas.check`, a read, so it is allowed on a read-only cluster —
  and the refusal, when it comes, is the registry's own words about which field does not fit. The level
  control in the subject's header holds it to `NONE`, `BACKWARD`, `BACKWARD_TRANSITIVE`, `FORWARD`,
  `FORWARD_TRANSITIVE`, `FULL` or `FULL_TRANSITIVE`, or back to the registry's default
- **Values that carry a schema** (K-42) — a value whose first byte is the Confluent magic byte is read
  with the schema it names, without being asked: the agent asks the cluster's Schema Registry for that
  schema id and decodes the payload — **Avro**, **Protobuf** (with the message indexes, so a .proto with
  several messages works, and nested ones too) or **JSON Schema** — into JSON, which is what the viewer
  then shows. A tag says which schema it was and where it is registered (`orders-value v3`, or just the
  id when the registry does not say), choosing another reading in the select above the value (`text`, `hex`, `base64`) puts the stored bytes back, and a payload that
  cannot be read leaves the value on screen with the reason under it. The schemas are read from the
  registry once and kept for the connection, so a topic of a thousand schema-encoded messages is one
  registry read. Nothing is guessed: a value that does not start with the magic byte is shown as it is
- **Live** — follow a topic from where it ends now: new messages appear at the top as
  they are written, **pause** holds them back while you read (they are kept), the list is
  a 5000-message window, and a topic faster than the page can show is thinned to its
  newest messages with the number dropped stated. Leaving the tab stops it
- **Save messages** (K-46) — `save .jsonl` in a topic's message bar writes what the list holds as a
  JSON Lines file: one message per line, oldest first within each partition, and every line names the
  topic, partition, offset, time and how its key, value and headers were written — as the viewer reads
  them (text, JSON, hex or base64, each one named) or as the bytes are (base64, what the topic holds).
  A value the agent cut at 256 KiB is marked, and the dialog says how many were. The file is made in
  the page and handed to the browser as a download; the messages were already here, nothing is asked
  of the agent, and a message whose value is not text survives the trip
- **Consumers** — groups with state, members and their partitions, lag per partition
- **Output** — the status bar's `output` button (or `Ctrl+J`) opens a log of what the agent
  and the clusters said: connections, each cluster's answer, every failure with the whole
  message, the result of a config reload. A toast is one line for a moment; this stays
- **Keyboard** — `Ctrl+P` goes to a topic or consumer group by name, `Ctrl+Shift+P` lists every
  command, `Alt+1`…`Alt+6` switch the side list, `Alt+R` asks the cluster again. In a list the
  arrow keys, `PageUp/PageDown`, `Home/End` move a cursor and `Enter` opens the row; `↓` in a
  filter steps into its list, `Esc` clears it. In the message list the arrows read through the
  messages. On a narrow window the tab stacks and the message table drops its time column
- **Send a message** (writable clusters only) — the `send…` button in a topic's message bar: a
  partition (automatic, or a chosen one), a key, a value in an editor, headers; each as text with an
  encoding — `string`, `json` (checked before it is sent) or `base64` (for bytes that are not text) — or a
  tombstone for no value. The value can be **wrapped** as an Ansible Vault or helm envelope before it is
  sent (the value's format list offers the two envelopes): that happens in this page, so the agent and the cluster see the envelope only
  and the password goes nowhere. The answer is the partition and offset it landed at, with **show in the
  viewer** to read it back. The dialog names the cluster it is about. When the cluster has a Schema Registry
  that answers, the value — and the key — can also be written **with a schema** (K-45): a subject and a
  version, the latest by default. What is typed is then JSON, and the agent serializes it in that schema's own
  format — Avro binary, a Protobuf message, or the JSON of a JSON Schema — with the schema's id in front of the
  bytes, so what lands on the topic is what every other client of that registry expects. A value that does not
  fit the schema is refused before anything is written, and the refusal names the field
- **Delete a topic** (writable clusters only) — the `delete topic` button: the dialog names the cluster and
  says how many messages the topic holds now, and asks for the topic's name to be typed. The agent asks for
  the name again with the request and deletes nothing without it; internal topics (`__consumer_offsets` and
  the like) are never deleted
- **Create a topic** (writable clusters only) — `+ new` above the topic list: name, partitions, replication
  factor, `retention.ms`, `cleanup.policy`, `min.insync.replicas` and any other setting as `name=value` lines.
  **check** asks the cluster whether it would create it (`validateOnly`) and creates nothing; **create** asks
  the same first and only then creates, and opens the new topic
- **Reset a group's offsets** (writable clusters only) — `reset offsets…` on a consumer group: to the
  beginning, the end, a point in time, an offset, or shifted by N messages; for the whole topic or chosen
  partitions. The dialog **previews** what would change (was → will be, and the lag before and after) and
  **apply** works only on exactly what was previewed. Only for a group with no running consumers — a running
  one is refused, naming its clients, because the broker would let them commit over the reset
- **Change a topic's settings** (writable clusters only) — `change settings…` in the config pane: the settings
  the topic holds are listed with their values, each with a tick that takes it back to the cluster's default,
  plus a field for one the cluster was never told. **preview** asks the agent for the difference (was →
  will be) and has the cluster check the settings with `ValidateOnly`; **apply** writes exactly what was
  previewed (incremental alter: every setting the dialog does not name is left alone)
- **Add partitions** (writable clusters only) — `add partitions…` on the partitions pane: the number the topic
  should have *afterwards*, as the Kafka CLI takes it. **check** asks the cluster (`validateOnly`) and adds
  nothing; the dialog warns that Kafka never takes partitions away and that the partition a key goes to
  changes with the count
- **Delete records** (writable clusters only) — `delete records…` on the partitions pane: one partition and the
  offset below which the records go (`-1` for everything it holds), with what that removes worked out from the
  log's start and end. The topic's name is typed to confirm, and the agent asks for the name again with the
  request; the end of the partition does not move, so a consumer that starts now begins after the deleted
  records
- **Delete a consumer group** (writable clusters only) — `delete group…` on a group in state `Empty`: the
  dialog says how many committed offsets go with it, and the name is typed to confirm. A group with running
  consumers is refused before the cluster is asked, naming them; nothing in the topics themselves is touched
- Reading joins **no consumer group** and commits nothing, so looking at a topic cannot
  start a rebalance in somebody's application

### Running it / Запуск

The `⤓ kafka-agent` button next to the tab hands over the right build for your
platform, with the command to run and the checksum (see *Getting the code-agent* — the
mechanism is the same). Or, from a checkout:

```bash
kafka-agent --config kafka-agent.yaml
bun run kafka-agent -- --config kafka-agent.yaml     # in dev
```

It prints a `ws://127.0.0.1:5011/ws?token=…` URL and copies it to the clipboard; press
**connect** on the kafka tab and it is taken from there — or paste it anywhere on the tab.
(The code tab works the same way: the agent copies, the button takes.) The agent takes the
**first free port in 5011-5020** (the code-agent has 5001-5010, so the port alone says which
agent a URL belongs to, and a kafka URL pasted on the code tab does nothing).

```
--config <file>         clusters from a YAML file. Without it, and without a cluster on the
                        command line, the agent reads ./kafka-agent.yaml, then
                        <user config dir>/enc-tool/kafka-agent.yaml
--bootstrap <hosts>     one more cluster from the command line: host:port,…
--properties <file>     its settings from a Java client.properties — the file
                        kafka-console-consumer takes with --consumer.config
-X <key>=<value>        one Java client property, repeatable; wins over --properties
--name <name>           that cluster's name (default: the first broker's host)
--allow-write           let the agent change clusters: every cluster whose configuration does
                        not say readOnly. A cluster's own readOnly: true still wins
--port <n>              pin the loopback port (default: first free in 5011-5020)
--token <str>           fixed token — prefer KAFKA_AGENT_TOKEN, --token shows in the process list
--allow-origin <url>    origin allowed to connect, repeatable
--allow-no-origin       also accept clients that send no Origin (curl, scripts)
--allow-multiple        serve more than one page at once (default: one)
--no-clipboard          do not copy the URL on startup
```

`ENC_TOOL_ALLOW_ORIGIN` (shared with the code-agent) and `KAFKA_AGENT_TOKEN` are read
from the environment. The token variable is the agent's own, not `ENC_TOOL_TOKEN`: two
agents on one token would let a URL meant for one open the other.

**The two agents do not describe themselves alike, on purpose.** The code-agent answers
`code-agent.info` with `codeAgent: "enc-tool"`; the kafka-agent answers `agent.info` with
`agent: "kafka-agent"`. The first shape is older and is kept as it is: a page cached from before
the kafka tab asks `code-agent.info`, and an alias would only add a second name to a protocol
that already works. What the page needs from either is two lines in `AgentSpec`
(`src/web/agent-client.ts`): the name of the info op and a `check` that refuses another agent's
reply. A third agent should take the kafka-agent's shape (`agent.info`, an `agent` field naming
itself, its own token variable) — the one a general client would be written against.

### Configuring clusters / Настройка кластеров

Settings come from three places and are reduced to the same **Java client property
keys**, so a setting means the same thing wherever it was written:
a `client.properties` file < `kafka-agent.yaml` < `-X` on the command line.

```yaml
# kafka-agent.yaml
clusters:
  - name: prod
    bootstrap: [kafka1:9093, kafka2:9093]
    properties: ./prod.client.properties      # an existing Java client.properties
  - name: dev
    bootstrap: localhost:9094
    readOnly: false                           # lets the agent change this cluster (default: true)
    security:
      protocol: SASL_SSL
      tls:
        truststore: { location: ./truststore.jks, password: "${TS_PASS}" }
        keystore:   { location: ./client.p12, type: PKCS12, password: "${KS_PASS}" }
        # or PEM files:  ca: ca.pem   cert: client.pem   key: client.key
        # verifyHostname: false                # skip only the name check, not the chain
      sasl: { mechanism: SCRAM-SHA-512, username: app, password: "${file:~/.kafka/dev.pass}" }
    schemaRegistry:                           # optional: a registry beside the cluster
      url: https://registry.example.com:8081
      username: app
      password: "${REGISTRY_PASS}"
      tls:                                    # its own stores; the cluster's are its own
        truststore: { location: ./registry-ca.pem }
        # cert: client.pem   key: client.key  # when the registry wants a client certificate
        # verifyHostname: false
```

`schemaRegistry` (K-41) is a service of its own beside the cluster — Confluent's Schema
Registry, or anything speaking the same REST API. It has its own URL, its own basic-auth
login and its own stores, and none of them are the cluster's: a registry may be https while
the brokers are plaintext, and a mistake in one is reported against the setting that has
it (`schemaRegistry.tls.truststore.location`). The password follows the same rules as every
other secret (`${ENV}`, `${file:…}`), and a login in the URL is refused — the agent prints
URLs, and a password in one would end up in a message. With `http` the TLS settings are
ignored, with a warning. The cluster view shows what the registry said about itself
(`schemas.status`: mode, default compatibility, how many subjects) or, when it would not
answer, the reason in its own words — an unreachable registry holds up nothing else about
the cluster. A message's value is read with the schema it names (`messages.decode`, K-42):
the schemas are cached in the agent for the life of the connection, and the decoders (Avro,
Protobuf, JSON Schema) never run on bytes the value does not claim. Writing is the other
direction (K-45): a send may name a subject and a version, and the agent serializes the
JSON with that schema and puts its id in the header — a value that does not fit is refused
before anything reaches the topic. A named version is read once and kept for the
connection; the latest is asked for every time, because registering a version moves it.
The registry's own writes are the schema browser's (K-47): a new version of a subject, and
the compatibility level it is held to. Both are writes, so a read-only cluster refuses
them before anything leaves the agent — the registry is a service beside the cluster, but
the operator's switch is the cluster's. The compatibility a subject is checked against
before a registration is the registry's decision, so its message is what is shown.

Kinds of connection:

| `security.protocol` | What it needs |
|---|---|
| `PLAINTEXT` | nothing |
| `SSL` | a truststore (or the system CAs); a keystore if the broker asks for a client certificate (mTLS) |
| `SASL_PLAINTEXT` | `SCRAM-SHA-256` or `SCRAM-SHA-512`, a user and a password |
| `SASL_SSL` | both of the above |

Store formats — **PEM, PKCS12 and JKS** — are told apart by the file's own bytes, not by
`ssl.*.type` or an extension (a JKS renamed `.p12` still opens). A JKS key may have a password
of its own (`ssl.key.password`). Not supported, and refused at startup with a message that
says what to do instead: SASL `PLAIN`, Kerberos, OAuth and AWS MSK IAM; JCEKS stores;
encrypted PEM keys (put the key in a PKCS12 keystore). A Java `client.properties` may
carry keys that mean nothing here (`acks`, `group.id`): they are ignored with a note.

Secrets need not sit in the file: `${NAME}` / `${env:NAME}` is an environment variable,
`${file:/path}` the contents of a file, `$${` a literal `${`. An unset variable or
unreadable file is an error, never an empty password. Relative paths are relative to
the file that names them, not to where the agent was started.

**Mistakes are found at startup, and they name the place**:
`kafka-agent.yaml:4: security.sasl.password: ${PASS}: environment variable PASS is not
set`. The stores are opened then too, so a wrong password is seen when the agent starts,
not when somebody opens the tab. A misspelt key in the YAML is an error, not silently
ignored.

**File permissions** (Unix): the agent warns, once, when the config, a properties file, a
keystore, a key or a `${file:…}` secret can be read by other users, with the `chmod 600`
that fixes it. On Windows mode bits say nothing about access, and there is no warning.

**Reloading:** **Reload the agent's config** in the toolbar's `agent…` menu (or the command palette, or
the `config.reload` op) reads the files again with the same flags. Only a sound configuration replaces the running one — a file with
a typo leaves the agent exactly as it was and says where the typo is. Clusters that did not
change keep their connections; new, removed and changed ones take effect at once, in every
open page.

### Environment (server) / Переменные сервера

| Variable | Meaning |
|----------|---------|
| `KAFKA_AGENT_DIR` | where the archives and `kafka-agents.json` live (default: `/usr/local/share/enc-tool/kafka-agents`, then `dist/kafka-agents`) |
| `KAFKA_AGENT_DOWNLOAD_BASE` | serve the archives from a mirror rather than from this image |
| `KAFKA_AGENT_PORTS` | loopback ports the kafka tab may connect to (default: `5011-5020`) — same rules as `CODE_AGENT_PORTS` |

Build args: `KAFKA_AGENT_TARGETS`, like `CODE_AGENT_TARGETS`. Archives are built with
`bun scripts/build-code-agents.ts --agent kafka` and signed the same way.

### Trying it without a broker / Без брокера

```bash
bun run kafka-agent:pki                      # test certificates, stores and configs → kafka-agent-go/testdata/pki
docker compose -f kafka-agent-go/testdata/compose.yaml up -d   # one broker, four listeners
kafka-agent --config kafka-agent-go/testdata/pki/kafka-agent.yaml
kafka-agent-go/testdata/verify.sh            # kafka-console-consumer with each client.properties, on the stand's machine

cd kafka-agent-go && go run ./cmd/devstand -dir /tmp/stand -live   # no Docker, no Java
kafka-agent --config /tmp/stand/kafka-agent.yaml
```

`cmd/devstand` starts three fake clusters (plaintext, mTLS, SCRAM) with topics,
messages, consumer groups and — with `-live` — a writer for the live view. The tests use
the same fake brokers (franz-go's `kfake`, real protocol, not real Kafka); the Docker
stand is for checking against a real broker (run by hand, not in CI). On another machine
start it with `KAFKA_HOST=<that machine's address>`; the certificates are issued for
`localhost`, so over such an address set `verifyHostname: false` for the SSL clusters.

```bash
ACL_HOST=192.168.56.111 ACL_ADMIN_PASSWORD=… ACL_APP_PASSWORD=… \
  docker compose -f kafka-agent-go/testdata/compose-acl.yaml up -d   # a second broker, with ACLs
ACL_HOST=… ACL_ADMIN_PASSWORD=… ACL_APP_PASSWORD=… ACL_STORE_PASSWORD=changeit \
  bun run kafka-agent:smoke --config kafka-agent-go/testdata/acl/kafka-agent.yaml \
    --writes --writes-cluster acl-admin --denied-cluster acl-app --acl-expect 9
```

`testdata/compose-acl.yaml` is a stand of its own: its own ports (19192 SASL_PLAINTEXT,
19193 SASL_SSL), its own compose project (`name: kafka-acl`, so that starting it cannot
recreate the other stand's container), and an authorizer with two logins — `admin`, a super
user, and `app`, which may do everything to a topic and a group but may not create a topic.
It shares the certificates `cmd/testpki` writes. `--denied-cluster <name>` in the smoke is
what uses it: creating a topic there has to come back as the broker's own refusal
(`Authorization failed.`), word for word. The same smoke run over `--writes-cluster
acl-admin-ssl` checks the same thing through SASL_SSL. `--acl-expect <n>` says how many ACLs
that cluster has (the seed writes nine): the listing has to bring back at least that many,
with a topic ACL and a group ACL among them, so a listing that silently dropped one is a
failure rather than a smaller table.

The seed takes the two passwords from the environment and only ever used them to create the
SCRAM logins. If they are lost, set them again over the internal listener, which the seed
itself uses as the super user `ANONYMOUS`:

```bash
docker exec kafka-acl-kafka-1 /opt/kafka/bin/kafka-configs.sh --bootstrap-server localhost:9090 \
  --alter --add-config "SCRAM-SHA-512=[password=<new>]" --entity-type users --entity-name app
```

`bun run kafka-agent:test` runs the agent's tests. `bun run kafka-agent:smoke` builds the agent, starts
`cmd/devstand` and talks to it over the WebSocket as the browser does — the front door's refusals, every
connection kind, reading, the live tail and its cancel, and the write ops. Every write op is checked to be
refused with `READ_ONLY` first; then a create / send / read back / change the settings / add a partition /
delete records / delete cycle runs on a topic the test makes and removes itself, and on the devstand — whose
data is thrown away — so do the offset reset (including its `timestamp` target) and the group's deletion.
`--stand compose` or `--config <file>` points it at another stand, where the agent stays read-only unless
`--writes` (with `--writes-cluster <name>`) asks for the cycle to run. A stand that is not the devstand gets
no offset reset unless `--writes-group <name>` names a group that already has commits: making one needs a
Kafka client, and this script has none
(`kafka-console-consumer --bootstrap-server <broker> --topic <topic> --group <name> --from-beginning
--max-messages 1` is the quickest way). That group's offsets are moved and the group is then deleted, so
point it at one you are willing to lose. `bun run licenses` regenerates the
Go dependencies' licences into `THIRD-PARTY-LICENSES.md` (`bun run audit` checks it).

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
bun run code-agents:build # optional: -> dist/code-agents, offered by the code tab
./server             # serves on :5000
./server code-agent       # the local filesystem + git bridge
```

The code-agent archives stay on disk rather than being embedded — folding another
14 MB of executables into the executable that serves them helps nobody. Without them the
download button simply does not appear.

### Docker

Multi-stage build: Bun compiles the server binary, a second stage borrows the Go
toolchain from the official image and cross-compiles all five code-agents from that
one Linux image (`CGO_ENABLED=0`, so no target SDK is involved), and both land in
a minimal `debian:bookworm-slim` image.

```bash
docker build -t encryption-tool .
docker run -p 5000:5000 encryption-tool
```

The code-agents add about 3 MB each, so which ones ship is still a build argument —
and they are copied in before the server binary, as the slower-changing layer
that should stay cached when only the app changes.

```bash
# only what your users actually run
docker build --build-arg CODE_AGENT_TARGETS=windows-x64,darwin-arm64 -t encryption-tool .

# none at all, serving them from a mirror instead
docker build --build-arg CODE_AGENT_TARGETS= -t encryption-tool .
docker run -p 5000:5000 -e CODE_AGENT_DOWNLOAD_BASE=https://artifacts.internal/enc-tool encryption-tool
```

Cross-compilation fetches each target's runtime from Bun's CDN, so that stage
needs network access.

**Base images are pinned by digest** (`image:tag@sha256:…` in the `Dockerfile`), so
a build pulls what was reviewed, not what a tag has come to mean. A pin never moves
on its own, so update them on purpose — `bun scripts/pin-images.ts` reports which
are behind (exit code 1, fit for a scheduled job) and `--write` rewrites them.

**A mirror can carry the files while the image carries the checksums.** Put the
`code-agents.json` from your own build in `CODE_AGENT_DIR` with no archives beside it and set
`CODE_AGENT_DOWNLOAD_BASE`: the code tab links to the mirror and shows the manifest's
SHA-256 and size. The checksum then comes from the build that made the image, not
from the host that serves the download, so a swapped mirror cannot vouch for
itself. Without `code-agents.json` the tab still links to the mirror, but claims no
checksum for files it has not seen.

**Releases can be signed.** Checksums protect against corruption and, with the
arrangement above, against a swapped mirror; they do not say who made the list. A
signature does:

```bash
bun scripts/release-key.ts --out ~/keys/enc-tool          # once: Ed25519 key pair
bun scripts/build-code-agents.ts --sign-key ~/keys/enc-tool.pem # writes SHA256SUMS.sig
bun scripts/verify-release.ts --key ~/keys/enc-tool.pub.pem dist/code-agents
```

Users without bun verify the same signature with OpenSSL 1.1.1 or later and
`sha256sum`, and need nothing from this repository:

```bash
openssl pkeyutl -verify -pubin -inkey enc-tool.pub.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig
sha256sum --check --ignore-missing SHA256SUMS
```

What this does not settle, and cannot from inside the repository: where the
private key lives, and how users come to trust the public one. A public key fetched
from the same place as the download proves nothing the download did not — publish it
(or its fingerprint) somewhere else, and keep the private key off the build host
and out of the image. The binaries themselves are still not Authenticode-signed or
notarized, so Windows SmartScreen and macOS Gatekeeper will still warn; that needs
a certificate and an Apple developer account.

| Variable | Meaning |
|----------|---------|
| `CODE_AGENT_DIR` | where the archives and `code-agents.json` live (default: `/usr/local/share/enc-tool/code-agents`, then `dist/code-agents`) |
| `CODE_AGENT_DOWNLOAD_BASE` | serve the archives from a mirror rather than from this image |
| `CODE_AGENT_PORTS` | loopback ports the code tab may connect to — ports and `low-high` ranges, comma-separated (default: `5001-5010`) |

The kafka-agent has variables of its own (`KAFKA_AGENT_DIR`, `KAFKA_AGENT_DOWNLOAD_BASE`,
`KAFKA_AGENT_PORTS`) — see *Kafka tab and the local kafka-agent*.

`CODE_AGENT_PORTS` is what `connect-src` in the CSP permits, and the code-agent binds the
first free port in the same range, so the two agree out of the box and several
folders can be open at once. If your users start code-agents with `--port` outside
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
  stale-while-revalidate; cross-origin requests pass straight through (the code-agent
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

A chip in the header reports what is actually available — local code-agent, git, ripgrep,
live watching, secure context, installed-as-app — with the reason and the fix for
anything missing. Controls that need a missing capability are disabled and marked.

Значок в шапке показывает, что реально доступно, и почему чего-то нет. Кнопки,
требующие недоступной возможности, гаснут с пометкой.

---

## HTTP routes / HTTP-маршруты

The server does no cryptography. Encryption runs in the page, so a password never
reaches it; earlier versions also exposed `POST /helm/*` and `POST /ansible/*` for API
clients, and those are gone — they were unauthenticated, ran a key derivation per
request, and were the one place a password could have crossed the network. Use the
`ansible-vault` CLI, or import `src/crypto/` directly.

Сервер ничего не шифрует: шифрование идёт в странице, пароль до сервера не доходит.
Эндпоинты `POST /helm/*` и `POST /ansible/*` удалены: они были без аутентификации,
считали KDF на каждый запрос и были единственным местом, где пароль мог уйти по сети.

Static routes: `/`, `/public/*`, `/sw.js`, `/manifest.webmanifest`.

Code-agent distribution:

| Endpoint / Эндпоинт | Method | Response / Ответ |
|---------------------|--------|------------------|
| `/code-agent/downloads` | GET | `{version, builds[]}` — platform, size and SHA-256 of each published code-agent |
| `/code-agent/download/<file>` | GET | the archive itself; only names present in `code-agents.json` are served |
| `/kafka-agent/downloads` | GET | the same, for the kafka-agent |
| `/kafka-agent/download/<file>` | GET | the archive itself; only names present in `kafka-agents.json` are served — and never a code-agent archive |

---

## Multi-user isolation / Изоляция пользователей

Nothing is shared between users, by construction rather than by convention:

- **crypto** runs in the page — plaintext and passwords never reach the server;
- **the server** keeps no state, no session and no cookie — there is nothing for two
  requests to share;
- **the code tab** talks only to the user's own loopback code-agent, jailed to one folder,
  and the CSP pins `connect-src` to that code-agent's port — not to loopback at large,
  which would be a channel to every other service on the machine;
- **the kafka tab** talks only to the user's own loopback kafka-agent, on ports of its own
  (5011-5020, named in `connect-src` like the code-agent's), and the page never learns a
  bootstrap server, a store or a password — it names a cluster from the agent's
  configuration and nothing else;
- **the download routes** resolve a request only against the names in `code-agents.json`
  and `kafka-agents.json`, so nothing else on that directory's path is reachable through
  them, and neither agent's route serves the other's archives;
- every response carries a strict **CSP**: `script-src 'self'`, nothing remote, and
  no `'unsafe-inline'` in any directive. The one `<style>` the app creates at
  runtime — CodeMirror mounting its themes — is admitted by a per-request nonce
  the shell carries; `connect-src` reaches the code-agent's port and nothing else on
  loopback. Alongside it: `nosniff`, `no-referrer`, COOP, CORP, `X-Frame-Options`,
  HSTS and a `Permissions-Policy`; crypto responses are `Cache-Control: no-store`.
  All of them are stamped on the way out of the request handler, so a route cannot
  be added without them. HSTS carries no `includeSubDomains`: TLS is terminated by
  whatever proxy runs in front, and the app has no cookie a sibling host could reach.

The CSP matters because the code-agent's token lives in `localStorage`: script injection on
this origin would otherwise be script injection into someone's working directory.

Проверяется тестами `bun run isolation:smoke` и `bun run download:smoke`, а не
декларацией.

---

## Testing / Тесты

Every suite spawns real processes — a real server, a real code-agent, a real `git` — against
throwaway repositories. Ни один не использует моки.

```bash
bun run crypto:smoke      # WebCrypto ports interoperate with the previous node:crypto code, and the worker that runs them
bun run agent-client:smoke # an agent request that is never answered ends by its deadline, and the panel recovers
bun run isolation:smoke   # 60 concurrent users, jail escapes, loopback binding, CSP
bun run code-agent:smoke       # both code-agents, same checks, replies diffed against each other
bun run code-agent:test        # the Go code-agent's unit tests (WebSocket codec, RFC 6455 vector)
bun run protocol:check    # the two protocol definitions still describe the same wire
bun run git:smoke         # staging, commits, branches, merge/rebase/revert/reset, conflicts
bun run graph:smoke       # commit-graph lane layout and its SVG output
bun run search:smoke      # modifiers, globs, cancellation, preserve case, engine parity
bun run pwa:smoke         # manifest, icon sizes read from the PNG header, worker scope
bun run download:smoke    # archive formats read back, both agents' download routes, origin allowlist
bun run kafka-agent:test  # the kafka-agent against an in-process Kafka: TLS/mTLS, SCRAM, topics, messages, tail, reload, writes
bun run kafka-agent:smoke # a built agent over the WebSocket: front door, every connection kind, reading, tail, writes
bun run kafka-web:smoke   # the kafka tab's own words: a saved JSON Lines message, a reference line, a compatibility level
bun run agent-kit:test    # the front door both agents share: token, Origin, Host, WebSocket
bun run licenses -- --check   # THIRD-PARTY-LICENSES.md matches the Go modules that are linked
bunx tsc --noEmit
```

---

## Project Structure / Структура проекта

```
.
├── src/
│   ├── server.ts          # Bun HTTP server; `server code-agent` starts the bridge instead
│   ├── version.ts         # stated once; the code-agent and the tab compare it
│   ├── crypto/            # WebCrypto — runs in both Bun and the browser
│   │   ├── helm.ts        # PBKDF2 + AES-256-GCM (reads the legacy CBC format)
│   │   ├── ansible.ts     # PBKDF2 + AES-256-CTR + HMAC-SHA256
│   │   ├── pkcs7.ts       # PKCS#7 padding
│   │   ├── bytes.ts       # hex/base64/utf8, constant-time compare
│   │   └── index.ts
│   ├── code-agent/             # local filesystem + git bridge (loopback WebSocket)
│   │   ├── main.ts        # server, auth, origin allowlist, op dispatch
│   │   ├── jail.ts        # path containment (lexical + realpath)
│   │   ├── proc.ts        # argv-only spawn, line streaming
│   │   ├── fs-ops.ts      # readdir/read/write/move/delete
│   │   ├── git.ts         # porcelain=v2, for-each-ref, --raw --numstat parsing
│   │   ├── git-write.ts   # staging, commits, branches, merge/rebase, remotes
│   │   ├── search.ts      # ripgrep with a `git ls-files` fallback
│   │   ├── watch.ts       # debounced recursive fs.watch
│   │   ├── targets.ts     # the platforms code-agents are built for; shared naming
│   │   └── protocol.ts    # wire types, shared with the browser — the definition
│   │                      # both code-agents and the browser are written against
├── agent-kit-go/               # what both agents share: WebSocket, token, Origin/Host checks, port choice
├── kafka-agent-go/             # the kafka-agent: franz-go client, config, TLS stores, SCRAM
│   ├── config.go, properties.go, jaas.go, tls.go, perm.go, reload.go
│   ├── connect.go, ops.go, ops_read.go, ops_messages.go   # cluster status and the ops
│   ├── protocol.go        # the Go side of src/kafka-agent/protocol.ts
│   ├── cmd/testpki, cmd/devstand, testdata/compose.yaml   # certificates, fake clusters, a real broker
├── code-agent-go/              # the code-agent that actually ships: same protocol, ~7 MB
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
│       ├── agent-client.ts # the socket, reconnecting, refusals — shared by both agents
│       ├── kafka.ts       # entry for the lazily-loaded kafka tab bundle
│       ├── kafka/         # model, side lists, topic/group/broker views, messages, status badge
│       ├── code/          # explorer, tabs, search, git panel, history, graph,
│       │                  # diff, conflicts, code-agent client, download panel (both agents)
│       ├── sw.ts          # service worker
│       ├── manifest.webmanifest, icons/
│       └── index.html, style.css, editor.ts, yaml-lint.ts
├── scripts/
│   ├── build-code-agents.ts    # cross-compile the code-agent and pack it for download
│   ├── protocol-check.ts  # fails the build if the two protocol files disagree
│   ├── go-toolchain.ts    # locating Go (GO_BIN), shared by build and test
│   ├── go.ts              # passthrough: `bun scripts/go.ts test ./...`
│   ├── archive.ts         # minimal tar.gz and zip writers, no dependencies
│   ├── make-icons.ts      # procedural PWA icon generator
│   ├── build-file-icons.ts # regenerate the explorer's file-type icons
│   └── *-smoke.ts         # the eight test suites
├── THIRD-PARTY-LICENSES.md
├── package.json
└── Dockerfile             # server binary + cross-compiled code-agents -> bookworm-slim
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
- **Editor backend:** the system `git` and `ripgrep`, driven by the local code-agent
- **Encryption:** AES-256-GCM, AES-256-CTR, HMAC-SHA256, PBKDF2 (+ AES-256-CBC, read-only) — via WebCrypto
- **Deployment:** standalone compiled binary on `debian:bookworm-slim`, PWA over HTTPS

### Browser support / Поддержка браузеров

Chromium and Firefox are fully supported. **WebKit/Safari** blocks `ws://127.0.0.1`
from an https page, so the code tab cannot reach a code-agent there — the capability badge
says so explicitly. Вкладки шифрования работают везде.

---

## License / Лицензия

MIT. Vendored third-party material and its notices are listed in
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).
