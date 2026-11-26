# SoundBridge — быстрый старт (по-русски)

Цель: включаешь музыку во вкладке Chrome → жмёшь **Share Audio** → бот заходит в
голосовой канал Discord → друзья слышат именно то, что играет во вкладке.

Сначала всё запускаем **на своём ПК** (сервер на localhost). Когда заработает —
переносим сервер на Oracle.

## Что нужно

* Node.js **22.12+** (`node -v`), Git, Chrome 116+.

## 1. Бот в Discord (5 минут)

1. <https://discord.com/developers/applications> → **New Application** → `SoundBridge`.
2. **General Information** → скопируй **Application ID** → это `DISCORD_CLIENT_ID`.
3. Вкладка **Bot** → **Reset Token** → скопируй → это `DISCORD_TOKEN` (никому не показывай).
   **Public Bot** выключи. Привилегированные интенты не нужны.
4. Пригласи бота (замени `YOUR_APP_ID`):
   `https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=3146752`
5. В Discord: Настройки → Расширенные → **Режим разработчика**. ПКМ по серверу →
   **Копировать ID сервера** → `DISCORD_GUILD_ID`. ПКМ по себе → **Копировать ID** →
   `ALLOWED_USER_IDS`.

## 2. Сервер на ПК

```powershell
git clone https://github.com/GeekyKrank/audiobridge.git soundbridge
cd soundbridge
git checkout ccr-db9dfb71-7eamay
npm install
npm run gen-token                     # скопируй строку — это ACCESS_TOKEN
Copy-Item .env.example server/.env
notepad server/.env                   # заполни DISCORD_*, ALLOWED_USER_IDS, ACCESS_TOKEN
npm run deploy-commands
npm run dev
```

В логе должно быть: `Listening on http://127.0.0.1:8787` и `Logged in as SoundBridge#...`.

## 3. Расширение

1. `chrome://extensions` → **Режим разработчика** → **Загрузить распакованное** →
   папка `extension`.
2. Закрепи значок SoundBridge.
3. Нажми на значок → откроются настройки:
   * Server URL: `http://localhost:8787`
   * Access token: тот же `ACCESS_TOKEN`
   * **Test connection** → «Connected…» → **Save**.

## 4. Проверка

1. Зайди в голосовой канал в Discord.
2. Открой SoundCloud, включи трек.
3. **На этой вкладке** нажми значок SoundBridge → **Share Audio** (или **Alt+Shift+S**).
4. Бот заходит в канал, друзья слышат музыку, ты тоже продолжаешь её слышать.

Дальше пройди по списку из [testing.md](testing.md): пауза, перемотка, следующий
трек, закрытие вкладки, обрыв интернета, `/stop`, игра в Deadlock.

Важно: Chrome разрешает захват вкладки только после того, как ты открыл SoundBridge
**на этой вкладке** (значок, Alt+Shift+S или ПКМ → «Share / stop sharing this tab»).
Это правило Chrome, обойти нельзя.

## 5. Перенос на Oracle

Подробно: [deployment.md](deployment.md). Коротко:

```bash
ssh ubuntu@<IP>
git clone https://github.com/GeekyKrank/audiobridge.git soundbridge
cd soundbridge && git checkout ccr-db9dfb71-7eamay
sudo bash deploy/inspect-server.sh          # только чтение: пришли вывод мне
```

Потом: бесплатный домен на duckdns.org → открыть порты 80/443 в Security List Oracle →
`sudo DOMAIN=твоё-имя.duckdns.org bash deploy/install.sh` → заполнить
`/opt/soundbridge/server/.env` → запустить скрипт ещё раз. В расширении поменять
Server URL на `https://твоё-имя.duckdns.org`.

Не запускай бота одновременно на ПК и на сервере (один токен — один бот).

## Если что-то не так

Скопируй мне:
* вывод `npm run dev` (или `journalctl -u soundbridge -n 100` на сервере),
* текст ошибки из попапа,
* что делал перед этим.
