# Промт: подключить ollaya (модель laya) к проекту

Вставь промт ниже в Claude Code в другом проекте. Замени значения в `<...>`.

Результат теста в проекте encryption-tool (2026-10-02): `laya` выбирает model и effort на уровне случайного угадывания. Поэтому промт делает `ollaya` подсказкой и добавляет шаг проверки точности.

````text
Добавь в этот проект подсказку выбора model и effort через ollaya (модель laya).

Исходные данные:
- Адрес сервера: OLLAYA_HOST=<192.168.56.1:11435>
- Допустимые модели (только последние версии): Haiku <4.5> (<claude-haiku-4-5-20251001>),
  Sonnet <5.5> (<claude-sonnet-5-5>), Opus <5.5> (<claude-opus-5-5>)
- Рискованные темы проекта: <например: криптография, ключи, секреты, аутентификация,
  конкурентность, миграции данных>
- Язык задач: <русский>

Шаг 1. Проверь окружение.
- Выполни `ollaya --version`. Если команда не найдена, остановись и сообщи мне.
- Проверь сервер: GET http://<OLLAYA_HOST>/api/tags. Должны быть модели laya:latest,
  laya:multilingual, laya:en. Если их нет, остановись и сообщи мне.
- Используй переменную OLLAYA_HOST. Переменная OLLAMA_HOST не подходит:
  команда ждёт ответ от сервера по умолчанию и зависает.
- Не запускай `ollaya serve`. Сервер уже работает отдельно.
- Запускай `ollaya` через Bash. В PowerShell кавычки JSON ломаются.

Шаг 2. Создай файл `ollaya-questions.json` в корне проекта. Не используй каталог `.claude`:
он часто указан в .gitignore. Пресет `router` не подходит: он не возвращает model и effort.
Поле `criteria` вопроса типа `score` — это список, а не объект.

{
  "model": {
    "type": "choice",
    "instructions": "Which latest Claude model (Haiku 4.5, Sonnet 5.5, Opus 5.5) is best for `request`?",
    "criteria": {
      "haiku": "Haiku 4.5, simple: lookup, rename, typo, one-line fix, small doc or config edit, commit",
      "sonnet": "Sonnet 5.5, balanced: typical feature, bug fix, writing tests, refactor of a few files",
      "opus": "Opus 5.5, complex: architecture, cryptography, security-sensitive code, concurrency, hard debugging, large multi-file design"
    }
  },
  "effort": {
    "type": "choice",
    "instructions": "How much reasoning effort does `request` need?",
    "criteria": {
      "low": "simple: obvious change, little reasoning",
      "medium": "normal: several steps, some reasoning",
      "high": "hard: long multi-step reasoning, high risk, or specialist knowledge"
    }
  },
  "difficulty": {
    "type": "score",
    "instructions": "How hard is `request` for a language model?",
    "criteria": [
      "trivial: a lookup or one-liner",
      "easy: short answer, no reasoning",
      "moderate: several steps",
      "hard: long multi-step reasoning or specialist knowledge"
    ]
  }
}

Шаг 3. Проверь точность laya на задачах этого проекта. Сделай это до записи правил.
- Напиши 20 задач проекта на языке из исходных данных: 6 тривиальных (haiku/low),
  8 обычных (sonnet/medium или sonnet/low), 6 рискованных (opus/high).
  Эталонный ответ для каждой задачи выбери сам, до запуска laya.
- Напиши скрипт в каталоге scratchpad. Скрипт запускает для каждой задачи:
  OLLAYA_HOST=<host> ollaya run laya --format json --questions @ollaya-questions.json "<задача>"
  Скрипт берёт из ответа answers.model.choice, answers.effort.choice и confidence.
  Скрипт считает: точность model, точность effort, точность обоих, число рискованных задач,
  которые laya выбрала ниже opus, число тривиальных задач, которые laya выбрала выше haiku.
- Для сравнения посчитай базовую линию «всегда sonnet/medium».
- Покажи мне таблицу результатов.
- Не используй английский текст задач: он идёт на модель laya:en и даёт перекос в opus.

Шаг 4. Добавь в CLAUDE.md проекта (создай файл, если его нет) раздел «Выбор модели и effort»:

1. Команду запуска из шага 3 и правило: пиши текст задачи на языке проекта, запускай через Bash.
2. Поля ответа: answers.model.choice, answers.effort.choice, answers.difficulty.score (0–3),
   confidence (0–1).
3. Подраздел «Точность laya»: дата, результаты шага 3 в цифрах и вывод. Если точность
   не лучше базовой линии, напиши: «ollaya — только подсказка. Не доверяй ей без проверки.»
4. Подраздел «Правила решения». Выбор делает Claude. Порядок:
   - Рискованная задача (<рискованные темы проекта>): opus и high.
   - Тривиальная задача (commit, опечатка, переименование, правка комментария или конфига,
     список файлов, форматирование, неиспользуемый импорт): haiku и low.
   - Остальные задачи: sonnet и medium. Логирование, обновление зависимости, объяснение кода:
     sonnet и low.
   - ollaya не может понизить выбор Claude. Если ollaya выбрала выше, найди причину.
     Повышай выбор, только если находишь реальный риск.
   - Если Claude не уверен, он выбирает ступень выше.
   - Claude сообщает model и effort одной строкой. Если выбор отличается от ollaya,
     он называет причину.
   Если шаг 3 показал высокую точность (оба верно не ниже 80% и ни одной пропущенной
   рискованной задачи), можно разрешить: «при confidence 0,8 и выше используй ответ ollaya».
5. Подраздел «Допустимые модели»: таблица (haiku, sonnet, opus → версия → ID).
   Запрети старые версии (Sonnet и Opus ниже текущей, Haiku ниже 4.5).
   При выходе новой версии обнови таблицу и критерии в ollaya-questions.json.
6. Подраздел «Применение»:
   - model применяй к субагентам (параметр model инструмента Agent): псевдоним
     haiku|sonnet|opus или точный ID.
   - model и effort текущей сессии меняет только пользователь (/model). Если выбор отличается
     от текущего, а задача крупная, предложи пользователю сменить их.
   - Если ollaya недоступен или вернул ошибку, сообщи об этом пользователю.
     Правила решения работают и без ollaya.
   - ollaya даёт подсказку для model и effort. ollaya не является моделью Claude.
   - Если точность ollaya вырастет (новая модель или схема), повтори тест и обнови подраздел
     «Точность laya».

Шаг 5. Сделай commit только с файлами ollaya-questions.json и CLAUDE.md.
Сообщение: «Add ollaya model/effort hints and decision rules». Не добавляй другие файлы.
````
