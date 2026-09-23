# Деплой базы доноров (funding.html + Worker) — инструкция для владельца

Код написан и протестирован локально (`wrangler dev --persist-to`, без облачного аккаунта).
Всё, что ниже, требует твоего Cloudflare-аккаунта — это делаешь ты сам, я не могу залогиниться
за тебя.

## Что уже сделано

- `funding.html` — страница поиска по базе (стиль `shared.css`, тизер без токена, полный
  доступ по коду).
- `worker/src/index.js` — единый Worker: отдаёт статику сайта **и** API `/api/search`,
  `/api/admin/tokens` (выдача/список/отзыв кодов доступа).
- `admin.html` — добавлена вкладка «🔑 Токены доступа» (выдать код, посмотреть, отозвать).
- `wrangler.jsonc` — конфиг Worker'а (взят за основу из PR #1 `cloudflare-workers-and-pages[bot]`,
  расширен под KV + API). PR #1 сам **не смержен** — можно закрыть его после первого деплоя,
  он был просто заготовкой.
- Данные базы (468 записей из `БД_2026_v2.xlsx`) сконвертированы в JSON скриптом
  `funding-db/work/scripts/build_funding_json.py` → `funding-db/work/data/funding_full.json`.
  Этот файл **не** лежит в репозитории сайта (иначе теряется весь смысл пэйвола) — он
  загружается прямо в Cloudflare KV командой ниже.

## Шаг 1. Установить Wrangler и залогиниться

```bash
cd azatisrail
npm install
npx wrangler login
```

Откроется браузер — авторизуйся в своём Cloudflare-аккаунте (том же, где привязан домен
azatisrail.cc через Cloudflare-прокси).

## Шаг 2. Создать два KV-неймспейса

```bash
npx wrangler kv namespace create FUNDING_KV
npx wrangler kv namespace create TOKENS_KV
```

Каждая команда выведет что-то вроде:
```
{ binding = "FUNDING_KV", id = "abcd1234..." }
```

Открой `wrangler.jsonc` и замени `REPLACE_ME_FUNDING_KV_ID` / `REPLACE_ME_TOKENS_KV_ID`
на реальные `id` из вывода.

## Шаг 3. Задать секрет админ-токена

Это пароль, которым `admin.html` авторизуется в API выдачи кодов (отдельно от
`ADMIN_PASSWORD`, который просто открывает саму панель в браузере — тот же принцип,
что и GitHub-токен в `admin.html`, но для другого API).

```bash
npx wrangler secret put ADMIN_TOKEN
```

Введи любую длинную случайную строку и сохрани её — она понадобится один раз, чтобы
вставить в поле «API-токен админки» на вкладке «Токены доступа» в `admin.html` (хранится
только в браузере, в localStorage, как и GitHub-токен).

## Шаг 4. Загрузить базу доноров в KV

```bash
npx wrangler kv key put --binding=FUNDING_KV records \
  --path="C:\Users\user\Documents\Connect4Pro\funding-db\work\data\funding_full.json" \
  --remote
```

Флаг `--remote` обязателен — без него запись уйдёт в локальную тестовую копию, а не в
настоящий Cloudflare.

Когда база обновится в Excel (новые доноры, правки) — просто заново прогони
`build_funding_json.py`, а потом эту команду ещё раз. Перезаливка полностью заменяет
старые данные новыми.

## Шаг 5. Задеплоить Worker

```bash
npx wrangler deploy
```

Wrangler выдаст `*.workers.dev` адрес — на нём уже можно проверить всё вживую
(поиск, /admin.html, выдача токена) до подключения основного домена.

## Шаг 6. Подключить домен azatisrail.cc к Worker'у

Домен уже проксируется через Cloudflare (CNAME на GitHub Pages сейчас). Нужно **заменить**
источник трафика с GitHub Pages на этот Worker:

1. В Cloudflare Dashboard → выбери зону `azatisrail.cc` → **Workers Routes** (или на
   странице самого Worker'а → **Settings → Domains & Routes** → **Add Custom Domain**)
   → укажи `azatisrail.cc` (и `www.azatisrail.cc`, если используется).
2. Это добавит domain routing прямо на Worker — статические файлы (`index.html` и т.д.)
   Worker сам отдаёт через `env.ASSETS`, так что ничего на GitHub Pages менять не нужно,
   но с этого момента реальный трафик идёт через Worker, а не через GitHub Pages напрямую.
3. GitHub Pages можно оставить включённым как есть (Worker просто перехватывает домен) —
   или отключить в настройках репозитория, если хочешь, чтобы domain routing был чище.
   Не обязательно для работы.

## Шаг 7. Проверить

- `https://azatisrail.cc/funding.html` — поиск работает, без кода видно 6 из N результатов.
- В `admin.html` на вкладке «Токены доступа» вставь `ADMIN_TOKEN` из шага 3, выдай тестовый
  код, вставь его в поле «Код доступа» на `funding.html` — должно открыться `visibleTotal`,
  равное настоящему числу совпадений, без ограничения в 6.

## Дальше (не блокирует первую версию)

- **Выбор способа оплаты** (ИП+FreedomPay или без ИП+USDT через NOWPayments) — когда решишь,
  скажи, и настроим автоматическую выдачу токена по вебхуку вместо ручной через `admin.html`.
- **PR #1** (`cloudflare-workers-and-pages[bot]`) можно закрыть без мержа — его
  `wrangler.jsonc` уже заменён более полной версией в этой ветке.
- **Подстраницы** (консультанты, курсы, гайд, «Инвесторы КР» отдельной страницей, FAQ) —
  обсуждались в брифе, не начаты, список — на твоё решение.
