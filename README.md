# Last Letter

Цепочка английских слов для Discord Activity. Почему всё устроено именно так — в [DESIGN.md](DESIGN.md).

**Правила:** первый игрок выбирает букву, следующий пишет слово на неё, дальше — слово на последнюю букву предыдущего. Повторять нельзя. 15 секунд на ход. Не успел — −♥ (их 3), и новый круг начинаешь ты, выбирая букву. Последний живой побеждает. Полные правила — кнопка **!** в игре.

**Статистика** в приложении не показывается. Бот пишет в текстовый чат голосового канала, где запущена активность:
- после каждой партии — кто победил, места, сколько слов написал каждый;
- в конце дня (по умолчанию 23:59 МСК) — статистика за всё время по серверу, только в те каналы, где в этот день играли.

## Быстрый старт (без Discord)

```bash
npm install
npm run dev
```

Открой в нескольких вкладках:

```
http://localhost:5173/?name=Alice
http://localhost:5173/?name=Bob
```

Каждая вкладка — отдельный игрок. `?room=xyz` — отдельная комната, `?lang=en` — английский интерфейс.

## Тесты

```bash
npm test            # логика, статистика, сервер с реальными WebSocket и фейковым Discord API (37 тестов)
npm run typecheck
npm run build && npm run e2e   # 3 браузера играют партию до победы, скриншоты в e2e/shots/
```

Для e2e нужен Chrome (`/usr/bin/google-chrome`) или поменяй `executablePath` в `e2e/play.ts`.

## Подключение к Discord

1. [Developer Portal](https://discord.com/developers/applications) → New Application.
2. **OAuth2**: скопируй Client ID и Client Secret в `.env` (см. `.env.example`). Добавь любой Redirect URI, например `https://127.0.0.1` — Discord требует хотя бы один.
3. **Activities → Settings**: включи Activities.
4. **Activities → URL Mappings**: `/` → домен, где крутится сервер (без `https://`), например `ll.example.com`.
   Больше маппингов не нужно: аватарки сервер проксирует сам (`/avatars/...`).
5. **Bot** → Reset Token → `DISCORD_BOT_TOKEN` в `.env`.
6. **Installation** → Guild Install: scopes `applications.commands` и `bot`, права **View Channel**, **Send Messages**, **Embed Links**. Открой Install Link и добавь бота на свой сервер.
   Если на голосовом канале закрыты права — дай боту эти права на нём, иначе он не сможет писать в его чат.
7. Зайди в войс → кнопка активностей → твоё приложение.

Без `DISCORD_BOT_TOKEN` игра работает, статистика копится в `data/stats.json`, но никуда не отправляется.

### Локально через туннель

```bash
npm run dev
npx cloudflared tunnel --url http://localhost:5173
```

Полученный `*.trycloudflare.com` поставь в URL Mapping для `/`.

## Деплой на Render (бесплатно)

1. [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint** → выбери репозиторий `last-letter`. Render прочитает `render.yaml` (Docker, Free, Frankfurt).
2. Заполни `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` → Apply. Первая сборка ~3–5 мин.
3. Получишь адрес `https://last-letter-xxxx.onrender.com`. Проверка: `/api/health` → `{"ok":true,...}`.
4. В Discord Developer Portal → Activities → URL Mappings: `/` → `last-letter-xxxx.onrender.com`.
5. **Чтобы сервер не засыпал:** на [cron-job.org](https://cron-job.org) создай задачу `GET https://last-letter-xxxx.onrender.com/api/health` каждые 10 минут. Бесплатных 750 часов в месяц хватает на один сервис 24/7.

Ограничения бесплатного Render: диск временный — `data/stats.json` обнуляется при каждом новом деплое (push в `main`) и перезапуске. Если статистика должна жить вечно, нужна база данных.

## Деплой на свой сервер

Нужен хост с **WebSocket** и HTTPS. Vercel/Netlify не подойдут (serverless без постоянных соединений).

```bash
cp .env.example .env   # заполни
docker compose up -d --build
```

Сервер слушает `:3000`, статистика лежит в `./data/stats.json` (volume — переживает пересборку). HTTPS проще всего через Caddy — WebSocket проксируется автоматически:

```
ll.example.com {
    reverse_proxy localhost:3000
}
```

Без Docker: `npm ci && npm run build && npm start`.

Проверка: `curl https://ll.example.com/api/health` → `{"ok":true,...}`.

## Структура

```
src/shared/game.ts      правила, чистая логика (время и random передаются снаружи)
src/shared/text.ts      нормализация ввода, исправление русской раскладки
src/shared/protocol.ts  сообщения клиент ⇄ сервер
src/server/index.ts     HTTP + WebSocket, комнаты по instanceId активности, OAuth
src/server/stats.ts     статистика (JSON-файл), сообщения после партии и дневная сводка
src/client/             React-интерфейс
test/                   vitest: правила и сервер
e2e/play.ts             Playwright: полная партия в 3 браузерах
```

## Что можно добавить потом

- Режимы: категории слов, минимальная длина 4+, «без S в конце»
- Rich Presence: «Играет в Last Letter — 2 ♥»
- Фильтр нецензурных слов
