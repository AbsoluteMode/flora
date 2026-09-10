> На русском. English: the README covers the same ground in less detail.

# Архитектура flora

**Питч:** харнессы (Claude Code, Codex, harmonia) — интерактивные инструменты. flora превращает любой из них в вызываемый юнит с контрактом: вход (шаг + контракт верификации) → исполнение → выход (evidence, проверенный независимым верификатором). Мы даём харнессам API.

**Принципы (не нарушать):**
1. **Local-first.** Всё исполняется на машине юзера: харнессы, репо, ключи, БД. Никакого облака в критическом пути.
2. **Verifier ≠ executor.** Чеки гоняет верификатор, никогда — исполнитель. Шаг закрыт только когда все чеки зелёные. Исполнитель не ставит себе оценки.
3. **flora — фреймворк.** Ядро (`engine`, `verifier`, `adapters`, `workflow`, `state`) — библиотека с чистыми экспортами. CLI и веб — её потребители, не наоборот. Ничего веб-специфичного в ядре.

## Словарь

- **Workflow** — именованный YAML-контракт: шаги, исполнители, верификация (`examples/*.yaml`).
- **Step** — единица работы: `executor` (какой харнесс, какая модель) + `prompt`/`run` + `verify` (чеки) + `on_fail` (ретраи).
- **Executor / adapter** — способ запуска харнесса headless: `claude-code` (`claude -p`), `codex` (`codex exec`), `harmonia` (`harmonia run`), `command` (любая shell-команда). Адаптер нормализует вывод в **Evidence** `{output, exitCode, durationMs, costUsd?}`.
- **Runner reliability** (`adapters/command.ts`, база всех адаптеров). У шага два таймера, и они ловят разные
  болезни: `timeout_min` (дефолт 15) — потолок по wall-clock для разбежавшейся работы; `stall_min` (дефолт 5) —
  тишина в stdout/stderr, сбрасывается каждым чанком — для зависаний (API не отвечает, харнесс ждёт ответа).
  `0` отключает любой из них. Класс «ждёт stdin» исключён конструкцией: дети спавнятся с закрытым stdin, вопрос
  в headless-режиме получает EOF. По срабатыванию (или abort по ctrl-c) убивается **всё дерево процессов**
  (POSIX: своя process group + `kill(-pid)`; Windows: `taskkill /T /F`), evidence получает `stalled: true` /
  `timedOut: true`, ненулевой `exitCode` и пометку в хвосте вывода; дальше — обычный `on_fail.retry`.
  CPU-активность сигналом не считается: ожидание API — это легитимные 0 %.
  На Windows npm ставит CLI как `.cmd`-шимы (`codex.cmd`), которые `spawn` без shell запустить не может
  (ENOENT): раннер резолвит имя через PATH/PATHEXT, npm-шим разворачивает и запускает его JS-entry своим
  node — аргументы (многострочные промпты) не проходят через cmd.exe; прочие `.bat`/`.cmd` идут через
  cmd.exe с экранированием как у cross-spawn.
- **Usage** — адаптеры вытаскивают из вывода харнесса учёт токенов в `Evidence.usage`
  (`inputTokens / outputTokens / cachedTokens / contextTokens / totalTokens / limitPct`, всё опционально):
  claude-code — из `usage` финального кадра `stream-json` (адаптер переведён на stream-json именно ради
  stall-детекта: события льются постоянно, таймер меряет живую активность, а не редкие байты); codex —
  из `usage` события `turn.completed` (`codex exec --json`, по той же причине); harmonia и всё остальное —
  через универсальный парсер `adapters/usage.ts` (JSON-объекты usage в диалектах OpenAI / Anthropic / Gemini,
  либо текстовый футер `tokens used: N`, `input=… output=…`, `42% of … limit`). Семантика кэша нормализована:
  у Anthropic cache-read вне `input_tokens`, у OpenAI/Gemini — внутри; `contextTokens` всегда «сколько ушло
  в промпт». Веб показывает это на карточке шага. `costUsd` — как репортит харнесс: у Claude Code это его
  собственная оценка по своей таблице цен, через прокси (OpenRouter) она не совпадает со счётом; токены — честные.
- **Вывод дочерних процессов** декодируется строгим потоковым UTF-8; чанк, который им не является (cmd.exe и его
  встроенные команды пишут OEM-кодпейдж консоли — 866 на русской системе), декодируется кодпейджем консоли,
  так что в журнал не попадают кракозябры.
- **Verifier** — гоняет чеки шага (`command`: exit code/матч вывода; `artifact`: файл существует/содержит) и решает pass/fail.
- **Engine** — проходит workflow, эмитит **RunEvent**'ы (run_start / step_start / executor_output / check_result / step_result / run_end), пишет **RunRecord** в журнал.
- **Journal** — SQLite `~/.flora/flora.db`. Таблица `runs` — записи прогонов (источник правды), таблица
  `run_events` — живая лента событий (`seq` = курсор SSE, `executor_output` коалесится и хранится хвостом
  в ~64 КБ на прогон; полный вывод — в `evidence` записи). Веб читает отсюда.
- **Recorder** (`src/recorder.ts`) — сток для `onEvent`: пишет события в `run_events` и держит запись
  прогона в `runs` актуальной по ходу (`running` → шаги → финальный статус). Живёт в потребителе (CLI),
  а не в ядре: engine не знает про SQLite.
- **Viewer** — `flora serve` (дефолт `--port 4180`). Слушает только loopback, только GET, ничего не пишет:
  `GET /api/runs` — список, `GET /api/runs/:id` — полная запись, `GET /api/runs/:id/events` — SSE-стрим
  событий прогона (реконнект по `Last-Event-ID`), остальное — статика из `web/`.
  Фронт без сборки и без внешних ресурсов — `npm ci && flora serve` работает сразу и без сети.

## Data flow

Шаги передают друг другу **данные**, а не только файлы.

- **Контракт выхода** — `output: { type: json | text, schema? }`. `json`: у `command`-шага парсится весь вывод
  (если в него подмешался stderr — берётся последний JSON-блок); у агентных адаптер дошивает к промпту просьбу
  закончить ответ одним блоком ```json, движок берёт последний валидный. `schema` — JSON Schema, проверяется
  `ajv`. Невалидный output (парс / схема / больше 256 КБ) = шаг **failed**; причина — в `StepResult.outputError`,
  значение — в `StepResult.output` и в журнале. Шаг без `output:` работает как раньше.
- **Retry с фидбеком** — если упал именно контракт и есть `on_fail.retry`, в промпт следующей попытки дошивается
  `Previous attempt failed the output contract: <ошибка>. Return valid output.` (только агентным исполнителям).
- **Контекст прогона** — `params.*` + `steps.<id>.output` (у шага без контракта — его stdout).
  Подстановки `{{steps.fetch.output.items[0].id}}` работают в `prompt`, `contains`, `expect_match`; резолвер
  свой — точки и `[индекс]`, без eval. Объект подставляется как JSON. `{{task}}` — алиас `{{params.task}}`.
- **Безопасность** — `{{steps.*}}` в `run:` (шага и чека) **запрещены**: валидатор падает с понятной ошибкой.
  Данные в shell попадают только через `$FLORA_CONTEXT` — путь к JSON-файлу контекста, который движок
  переписывает перед каждым шагом (папка удаляется по завершении прогона): `jq -r '.steps.fetch.output.x'
  "$FLORA_CONTEXT"` или `require(process.env.FLORA_CONTEXT)`. `{{params.*}}` в `run:` разрешены — это
  доверенный ввод запускающего. Живой пример: `examples/data-pipeline.yaml`.

## Pre-push гейт: `flora gate`

```bash
flora gate install examples/gate-review.yaml   # пишет .git/hooks/pre-push (или core.hooksPath)
flora gate status
flora gate uninstall
```

Хук — POSIX-shell файл (git и на Windows гоняет хуки через sh из Git for Windows):
`exec node "<bin>" run "<workflow>" --cwd "<repo>" --param "remote=$1" --param "url=$2"`. `flora run` завершается
с 1, если прогон не прошёл → git отменяет push, а вывод прогона (шаги, чеки, причина) — то, что видит
пользователь. Маркер в хуке: чужой `pre-push` не затираем и не удаляем — говорим об этом. Пути в хуке абсолютные
на момент установки; `status` замечает, если flora или workflow переехали. Пример — `examples/gate-review.yaml`:
codex смотрит `git diff @{upstream}...HEAD`, отдаёт JSON-вердикт по схеме, второй шаг пропускает push только на
`REVIEW_CLEAN`.

## Изоляция чеков: `verify_in: worktree`

Верификатор по умолчанию гоняет чеки в рабочей копии — там же, где работал исполнитель, и зачёт может дать
незакоммиченный или игнорируемый git'ом файл. `verify_in: worktree` на шаге: после исполнителя движок делает
`git worktree add --detach … HEAD` и гоняет **все** чеки шага там, worktree удаляется сразу после. Что
исполнитель не закоммитил — чеки не видят; это и есть смысл («реализуй и закоммить»). Не git-репо → шаг
`failed` с подсказкой. Дефолт `cwd` — существующие контракты не меняются. У веток параллельного шага чеки и
так идут в их worktree — там поле запрещено. В записи — `verifiedIn: 'worktree'`, веб показывает фактом.

## Граф шагов: `needs`, `when`, `skipped`

```yaml
steps:
  - id: lint
    executor: { harness: command }
    run: npm run lint
  - id: test
    needs: [lint]
    …
  - id: docs
    needs: [lint]
    …
  - id: publish
    needs: [test, docs]
    when: '{{steps.test.output.ok}} == true'
    …
```

- **`needs`** — список id, объявленных **выше**: ссылаться можно только назад, поэтому цикл невозможен по
  построению. Шаг без `needs` зависит от предыдущего по списку — ровно то, что было в v0, существующие
  контракты не меняют поведения. Готовые шаги (все зависимости `passed`/`skipped`) стартуют **одновременно**,
  до `FLORA_MAX_PARALLEL`; упавший шаг — новых не стартуем, летящие дорабатывают, прогон `failed`.
- **`when`** — строка с подстановками, после них одно из: `A == B`, `A != B`, `A` (истинно, если не пусто и не
  `false`/`0`/`null`/`no`/`off`), `!A`. Никакого eval. Не выполнилось → шаг **`skipped`** (исполнитель не
  запускается, чеков и output нет, `skipReason` — условие как оно вычислилось); зависимые от него **идут**.
  В контексте у каждого завершённого шага есть `status`, так что `when: '{{steps.ship.status}} == skipped'`
  работает.
- **`$FLORA_CONTEXT`** — свой файл на шаг (`context-<id>.json`), снимок на момент старта: при одновременных
  шагах один переписываемый файл был бы гонкой.
- Порядок шагов в записи прогона — порядок в файле, не порядок завершения. Событие `step_skipped`, CLI печатает
  `– id skipped (when: …)`, веб — узел с прочерком.

## Параллельные ветки

```yaml
- id: solve
  parallel:
    require: quorum:2          # all (дефолт) | any | quorum:N
    isolation: worktree        # worktree (дефолт) | shared
    branches:
      - { title: A, executor: { harness: claude-code }, prompt: …, output: { type: json } }
      - { title: B, executor: { harness: codex },       prompt: …, output: { type: json } }
      - { title: C, executor: { harness: command },     run: … }
- id: collect
  executor: { harness: command }
  run: 'node merge.mjs'        # читает steps.solve.outputs / steps.solve.patches из $FLORA_CONTEXT
```

- У шага ровно одно из `executor` и `parallel`. Ветка — тело шага без `id` (получает `solve[0]`, `solve[1]`, …),
  без `on_fail` и без вложенных `parallel`. Ветка проходит по тем же правилам, что шаг: exit 0 + контракт + чеки.
- **Изоляция**: `worktree` — на каждую ветку `git worktree add --detach … HEAD`; ветки видят коммит, а не грязную
  рабочую копию (о ней — предупреждение в вывод шага); чеки ветки гоняются в её worktree. По завершении —
  `git add -A && git diff --cached --binary HEAD` → патч в `<flora home>/runs/<runId>/<step>-<i>.diff`
  (`null`, если ничего не изменилось), worktree удаляется. Не git-репо → шаг падает с подсказкой про
  `isolation: shared`; `shared` — все ветки в cwd, патчей нет.
- **Конкуренция**: семафор `FLORA_MAX_PARALLEL` (дефолт 3); `stall_min`/`timeout_min` каждой ветки работают
  как обычно, зависшая ветка не держит остальных.
- **Результат**: `StepResult.branches` (по порядку), `outputs` (значение или stdout прошедшей ветки, `null` у
  упавшей), `patches`; в контексте — `steps.solve.outputs` и `steps.solve.patches`, `steps.solve.output`
  у parallel-шага **нет** — только массив. Политика недобрала → `StepResult.error` с цифрами.
- **Ретрай** — `on_fail.retry` перезапускает весь parallel-шаг, свежие worktree.
- **События** — `branch_start` / `branch_result` (`stepId`, `branch`), у `executor_output` и `check_result`
  ветки поле `branch`; recorder пишет как есть, веб раскрывает parallel-шаг на подкарточки.

Пример: `examples/solve-and-collect.yaml` (три ветки, `quorum:2`, коллектор).

## Триггеры: `flora watch`

```yaml
on:
  cron: '0 9 * * 1-5'
  sentry: { org: my-org, project: backend, query: 'is:unresolved', match: 'TimeoutError', interval_sec: 60 }
  command: { run: 'node poll-inbox.mjs', interval_sec: 300 }
```

- **`flora watch [paths…]`** (дефолт `./workflows`) грузит workflow с блоком `on:` и живёт; `--once` — один цикл
  поллинга и выход. Каждое срабатывание — обычный прогон через engine + recorder, в журнале с
  `trigger: { source, id }`, веб показывает как все.
- **Cron** — свой парсер (`src/cron.ts`): пять полей, `*`, `*/n`, `a-b`, `a,b,c`; ошибка — при загрузке, а не
  в понедельник в 9:00. Шедулер — один `setTimeout` до ближайшего срабатывания, пересчёт после каждого;
  пропущенные во сне тики **не** догоняются.
- **Источники** (`src/triggers.ts`): `sentry` — issues API с токеном только из `$SENTRY_AUTH_TOKEN`, `match` —
  regexp по title/culprit, `url` для self-hosted; `command` — команда через тот же раннер, JSON-объект на
  строку = событие (его `id` — ключ дедупа), текст = одно событие, тишина = ничего. Ошибка поллинга →
  экспоненциальный бэкофф до 15 мин, в stderr.
- **Событие в контексте**: `{{event.title}}` в `prompt`/`contains`/`expect_match`, `.event` в `$FLORA_CONTEXT`;
  в `run:` запрещено тем же правилом, что и `{{steps.*}}` — текст ошибки из Sentry это недоверенный ввод.
- **Дедуп** — таблица `seen_events (source, fingerprint, workflow)` в журнале: cron — минута срабатывания,
  sentry — id issue, command — `id` события или sha256 строки. Один `INSERT OR IGNORE` — атомарно. Записи
  старше 30 дней подчищаются на старте.
- **Один прогон на workflow за раз**: cron-тик во время прогона пропускается (в лог), события встают в очередь
  (отпечаток уже записан — дублей не будет), до 100 штук.

Примеры: `examples/on-cron.yaml`, `examples/on-sentry.yaml`.

## Tools на ноду

Шаг получает ровно те инструменты, что перечислены в его `tools:` — и ничего сверх:

```yaml
tools:
  - mcp: { name: db, command: npx, args: ['-y', '@modelcontextprotocol/server-postgres', '{{db_url}}'] }
  - flora: call_workflow
    workflow: ./review.yaml
  - flora: read_context
```

- **Монтирование — родным способом харнесса** (`src/tools.ts` собирает список серверов, адаптер превращает
  его во флаги). claude-code: `--mcp-config <файл прогона> --strict-mcp-config --allowedTools mcp__<name>,…` —
  только серверы контракта, не пользовательский `~/.claude.json`, и все их тулы предодобрены (в `-p` спросить
  некого). codex: `-c 'mcp_servers.<name>={command="…",args=[…],env={…}}'` на каждый сервер. harmonia и
  `command` — валидатор отказывает явно: MCP-клиента там нет.
- **flora-native тулы — тот же `flora mcp` по stdio**, без портов: харнесс сам запускает
  `node bin/flora.mjs mcp --context <context.json> --cwd … --run <runId> --depth N --stack … --allow-workflow …`.
  `read_context(path)` читает контекст шага (`steps.fetch.output.items[0].id`); `call_workflow(workflow, params,
  cwd)` запускает вложенный прогон через тот же engine + recorder (в журнале с `parentRunId`, веб видит live)
  и возвращает вердикты, не транскрипт. Разрешены только workflow из контракта шага.
- **Рекурсия и циклы**: глубина растёт на каждом уровне, лимит `FLORA_MAX_DEPTH` (дефолт 3); стек путей
  workflow от корня — повтор пути = цикл, отказ до запуска.
- **Безопасность**: тулы только из YAML; `{{steps.*}}` в `command`/`args`/`env` сервера запрещены (это
  аргументы процесса — агент вместо этого зовёт `read_context`); env сервера — из контракта и параметров, не
  весь `process.env`.

Пример: `examples/review-with-tools.yaml` (+ `examples/review.yaml`, которого он зовёт).

## Authoring: схема контракта и `flora mcp`

- **`schema/workflow.schema.json`** — контракт как JSON Schema (draft-07): те же правила, что в
  `validateWorkflow`, в форме, которую читают редакторы (`# yaml-language-server: $schema=…` в примерах даёт
  автокомплит и подсветку ошибок) и агенты. Пишется руками; синхронность с кодом держит тест-корпус в
  `src/__tests__/mcp.test.ts`: все `examples/*.yaml` проходят оба валидатора, набор отрицательных образцов
  отвергают оба (кроме уникальности id — её схема выразить не может). Неизвестные поля отвергаются обоими:
  молча пропущенный `verfy:` — это контракт, который никогда не проверяется.
- **`flora mcp`** — MCP-сервер по stdio (`@modelcontextprotocol/sdk`), тот же бинарь: `claude mcp add flora --
  node …/bin/flora.mjs mcp`. Тулы: `describe_contract` (справка генерится из схемы — один источник),
  `validate_workflow` (ошибки с путём до поля: `steps[1].output.type`), `run_workflow` (через тот же engine +
  recorder, веб видит прогон live; возвращает вердикты, не транскрипт), `get_run`, `list_runs`. На stdout —
  только протокол; всё человеческое идёт в stderr.

## Карта кода

```
src/
  types.ts        — все контракты типов (начинай чтение отсюда)
  workflow.ts     — парс/валидация YAML, подстановка {{params}} / {{steps.*}}
  context.ts      — контекст прогона и резолвер путей для подстановок
  output.ts       — контракт выхода: извлечение JSON, лимит, ajv-схема
  contract.ts     — JSON Schema контракта: ошибки с путями, describe_contract
  tools.ts        — tools: MCP-серверы для шага (внешние + flora mcp --context)
  cron.ts         — свой cron-парсер и nextCron
  triggers.ts     — источники событий: sentry, command; бэкофф
  watch.ts        — flora watch: шедулер, поллинг, дедуп, очередь на workflow
  git.ts          — worktree / patch / prune для параллельных веток
  paths.ts        — flora home (журнал, артефакты прогонов)
  mcp/server.ts   — flora mcp: тулы для агента-автора (validate/run/get/list)
schema/           — workflow.schema.json — контракт для редакторов и агентов
  engine.ts       — цикл прогона (v0: последовательный, ретраи, abort)
  verifier.ts     — прогон чеков
  state.ts        — журнал прогонов (node:sqlite)
  adapters/       — command (база) + claude-code, codex, harmonia
  recorder.ts     — события → журнал (коалесинг вывода, подрезка хвоста, live-запись прогона)
  cli.ts          — команды flora run / runs / usage / pack / inspect / add / workflows / serve
  usage.ts        — учёт токенов и денег по шагам прогона (попытки, ветки, итог) и таблица для CLI
  bundle.ts       — бандл воркфлоу (.flora): pack / inspect / add / библиотека / разрешение ссылки для run
  analytics.ts    — что вошло / что вышло / что стоило по шагам: поток (inputsFrom), metrics, размер, usage; CSV; mermaid
  report.ts       — прогон как документ (markdown): мета, usage, аналитика с графом потока, шаги с чеками и выводом
  runfile.ts      — артефакты прогона (run.json + report.md после каждого run), export/import .flora-run
  zip.ts          — свой маленький zip (deflate, UTF-8 имена, проверка CRC) — без зависимостей
  web/server.ts   — read-only HTTP-вьювер журнала (только 127.0.0.1)
web/              — фронт вьювера: голый HTML + ES-модули, без сборки
```

## Аналитика прогона

- Движок пишет в `StepResult` три вещи: `inputsFrom` (`needs` плюс все `{{steps.<id>…}}` в шаге, его чеках и
  ветках — граф потока данных), `metrics` (числа из поля `metrics` JSON-вывода шага: `in`, `out`, что угодно)
  и `outputBytes` (размер значения по контракту). Вместе с usage это даёт `src/analytics.ts`: строка на шаг
  (откуда, in → out, время, вызовы, токены, деньги, размер), рёбра, итоги; CSV по прогонам (строка на шаг на
  прогон, BOM для Excel); mermaid-схема для отчёта. `flora analytics [id|--all] [--json|--csv]`, раздел
  Analytics в `report.md`, блок Analytics с SVG-графом во вьювере. Инструкция для авторов воркфлоу —
  `docs/analytics.ru.md`.

## Прерванные прогоны

- Пока прогон идёт, recorder раз в 15 с пишет `heartbeat_at` в строку журнала (и при каждом сохранении). Если у прогона
  статус `running`, а последний сигнал старше 90 с — процесс flora умер (убит, упал, машина выключена), и `run_end`
  уже не придёт. Такой прогон — `interrupted`: CLI (`flora run`, `flora runs`) помечает его в журнале
  (`sweepInterrupted`: статус, `finishedAt` = последний сигнал, шаг «в работе» → failed с пояснением), вьювер
  показывает то же самое на чтении, ничего не записывая (`effectiveStatus`).

## Исполнитель `api` и провайдеры

- Пятый харнесс, `api` (`src/adapters/api.ts`): один промпт → одно completion от модельного API без инструментов
  и без доступа к репозиторию — для шагов чистого суждения. В шаге: `executor: { harness: api, provider: <имя>,
  model, temperature?, max_tokens? }`, `prompt` обязателен, `tools` запрещены.
- Провайдеры (`src/providers.ts`) настраиваются на машине в `~/.flora/providers.yaml`: `base_url`
  (OpenAI-совместимый chat/completions: OpenRouter, OpenAI, Ollama, vLLM…), `api_key_env` (имя переменной с
  ключом или `none`), `cost_in_usage` (OpenRouter отдаёт цену в `usage.cost`), `headers`, `default_model`.
  Ключ живёт только в окружении; нет файла провайдеров — нет API: шаг падает с подсказкой до траты денег.
- `flora doctor` показывает провайдеров и наличие их ключей. Usage/cost из ответа идут через тот же парсер, что
  и у остальных харнессов; 429/5xx — три попытки с паузой.

## Две сущности: пайплайн и артефакт

- **Пайплайн** — файл воркфлоу (и его `.flora`-бандл): шаги, граф, параметры, проверки, контракты, ретраи и
  для каждого шага — где он выполняется (локальный харнесс, скрипт, отдельно настроенный API-провайдер).
- **Артефакт** — запись одного прогона. В `StepResult` для этого есть `prompt` (промпт как отправлен, после
  подстановок) или `command` (команда как запущена), `artifacts` — файлы, которые шаг объявил в выводе
  (`artifacts: [...]`, файлы и папки относительно cwd шага; движок копирует их в
  `~/.flora/runs/<id>/artifacts/<step>/…`, лимиты 32 MB на файл / 256 MB / 2000 файлов, отсутствующее
  пропускается). Вьювер отдаёт их как текст по `/api/runs/<id>/artifacts/<path>` (только объявленные пути),
  отчёт перечисляет, `flora export` кладёт в `.flora-run`, `flora import` восстанавливает.

## История прогона как артефакт

- Журнал (`~/.flora/flora.db`) остаётся источником истины, но после каждого `flora run` запись прогона пишется и
  файлами: `~/.flora/runs/<runId>/run.json` (запись как есть) и `report.md` (прогон как документ:
  мета, параметры, таблица usage, каждый шаг с чеками, выводом по контракту и хвостом транскрипта ≤16 KB,
  ретраи и ветки). Рядом уже лежали патчи веток. `flora run --report <файл|папка>` кладёт копию документа куда
  скажут; `flora report [id] [--out]` собирает его для любого прогона из журнала; вьювер отдаёт
  `/api/runs/<id>/report.md` (ссылка «Report ↓» на странице прогона).
- `flora export [id]` → `<workflow>-<id8>.flora-run` — zip с `run.json`, `events.jsonl` (живой лог событий),
  `report.md` и `flora-run.json` (версия формата, кто и когда). `flora import <файл>` кладёт прогон в локальный
  журнал (события — тоже), после чего `flora runs`, `flora usage`, `flora serve` показывают его как свой.
  Повторный импорт того же id — только с `--force`.

## Передача воркфлоу: бандл `.flora`

- Единица передачи — папка, в которой лежит YAML: скрипты, промты, конфиги. `flora pack <workflow.yaml>` собирает
  её в один файл `<name>.flora` — обычный zip (открывается везде) с манифестом `flora.json`: name, version,
  description, params, шаги и их харнессы, список файлов с sha256, кем и когда собран. Не берутся `.git`,
  `node_modules`, `run/`, `runs/`, `*.db`, `*.log`, `*.bak`, файлы больше 8 MB; `--include` / `--exclude` правят.
- Внутри прогона файлы достижимы через `{{workflow_dir}}` — движок подставляет каталог файла воркфлоу
  (`RunOptions.source`), поэтому одна и та же строка `run:` работает из папки, из кэша бандла и из библиотеки.
- `flora run <ref>`: файл → как есть; `*.flora` → распаковка в `~/.flora/bundles/<name>-<sha12>/` (контент-адрес,
  повторный запуск того же файла не распаковывает заново); имя → `~/.flora/workflows/<name>/` (`flora add`).
  `flora inspect` показывает манифест до запуска, `flora workflows` — библиотеку, `flora remove` — удаляет.
- Безопасность: распаковка ничего не исполняет; записи, выходящие за каталог, отвергаются; бандл с файлами,
  не совпадающими с контрольными суммами, отвергается. Команды воркфлоу выполняются только при `flora run`,
  как у любого другого воркфлоу — доверие к бандлу равно доверию к его автору.
- В схему и валидатор добавлено `description` (у воркфлоу и у параметров) — то, что человек видит в `inspect`.

## Учёт токенов и денег: `flora usage`

- Каждая попытка шага несёт `evidence.usage` (токены) и `evidence.costUsd` (деньги), если харнесс их сообщил.
  Claude Code (`total_cost_usd` + `usage` в кадре `result`), Codex (`turn.completed`) и harmonia — сами;
  `command`-шаг — когда печатает JSON-строку с объектом `usage` (`input_tokens`, `output_tokens`, `calls`,
  `cost_usd`; понимаются и диалекты OpenAI/Anthropic/Gemini) или строку вида `tokens used: 12,345 · cost: $0.42`.
  Универсальный парсер — `src/adapters/usage.ts`, `attachUsage(evidence)` — общий для command/harmonia/codex.
- Ретрай не бесплатен: движок кладёт в итоговый `StepResult.priorAttempts` лёгкий след каждой неудачной попытки
  (статус, длительность, usage, cost — без вывода). Ветки `parallel`-шага считаются по своим `evidence`.
- `src/usage.ts` сводит запись прогона в строки по шагам (`attempts`, `calls`, `input`, `output`, `total`, `cost`)
  и итог. Шаг, который ничего не сообщил, — прочерки, а не нули: «0 токенов» журнал подтвердить не может.
- `flora usage [run-id] [--json]` печатает эту таблицу (по умолчанию последний прогон, префикс id достаточен),
  `flora usage --all [--limit N]` — по строке на прогон. Вьювер показывает ту же таблицу на странице прогона.

## Диагностика: `flora doctor` и подсказки в упавших шагах

Харнессы отказывают до начала работы по трём причинам: не установлен, не залогинен, не может прочитать свой
конфиг (codex 0.121 не стартует вообще, если в `~/.codex/config.toml` есть непонятное ему поле — например,
`service_tier = "default"` вместо `fast`/`flex`). Раньше это выглядело как «шаг failed» и транскрипт.

- **`flora doctor`** (`src/doctor.ts`) — строка на зависимость и харнесс: node ≥ 22.5, git (для worktree),
  claude-code (`claude --version` + `claude auth status` — JSON с `loggedIn`), codex (`codex --version` +
  `codex login status` — грузит конфиг и первым делом сообщает ошибку в нём, с файлом и строкой), harmonia,
  журнал. Все пробы бесплатные — модель не вызывается. Токен из окружения (`ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`+`ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`) засчитывается как готовность. Выход 1, если
  что-то обязательное сломано.
- **Подсказки в шаге** (`explainFailure`): если исполнитель упал и в его выводе узнаваемая причина — бинарь не
  найден, «Not logged in», «Error loading config» — движок кладёт человеческую фразу с починкой в
  `StepResult.error`; CLI печатает её как `✗ …`, веб показывает на карточке. Транскрипт остаётся в evidence.

## E2E на настоящих агентах

`examples/e2e/` — семь контрактов, которые гоняют flora против живых моделей через OpenRouter (Claude Code
через `ANTHROPIC_BASE_URL`, Codex через приватный `CODEX_HOME`, любые модели из `command`-шагов): контракты и
data flow, оба харнесса headless, tools с `read_context`/`call_workflow`, параллель трёх агентов с патчами,
`watch --once`, авторинг через смонтированный `flora mcp`. Переменные окружения и команды — в
`examples/e2e/README.md`; весь набор стоит меньше доллара. Гонять после правок движка, адаптеров, tools,
watch или parallel.

## Как работать

```bash
npm ci
npm test                # 7 тестов должны быть зелёными до и после твоих правок
npx tsc --noEmit        # типы — обязательная проверка перед коммитом
npm run flora -- run examples/hello.yaml --cwd /tmp
```

Правила PR: ветка от `main`, PR с описанием, тесты на новое поведение, `npm test` + `tsc` зелёные. Мержим squash'ем после ревью.

## Где мы (issues — источник правды)

Первый срез закрыт целиком — `v0.1.0`:

- **#1–#3** — вьювер прогонов поверх журнала, live через SSE.
- **#4** — data flow: `output`-контракт, `{{steps.<id>.output.*}}`, `$FLORA_CONTEXT`.
- **#5** — надёжность Runner: stall-детект, kill дерева, usage-метрики.
- **#6** — tools на ноду: MCP-серверы в харнесс, `read_context` / `call_workflow`.
- **#7** — триггеры: `flora watch` (cron, sentry, command).
- **#8** — авторинг агентом: `flora mcp` + JSON Schema контракта.
- **#9** — параллельные ветки + коллектор.
- **#27–#29** — граф шагов (`needs`/`when`/`skipped`), изоляция чеков (`verify_in: worktree`), pre-push гейт.
- Плюс `flora doctor`, e2e-стенд на живых агентах (`examples/e2e/`), CI на Linux/macOS/Windows,
  устанавливаемый пакет.

Дальше — баги и апдейты по запросу. Из известного и не сделанного: чеки `llm-judge` и `human` (гейт с
участием человека) — их нет, и дизайна на них тоже; появится потребность — заводим issue с дизайном в
комментах, как раньше.
