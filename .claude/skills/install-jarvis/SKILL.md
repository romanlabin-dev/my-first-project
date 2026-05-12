# Установка Jarvis (DeepSeek-агент) рядом с Friday

## Когда использовать

Пользователь уже установил Friday (Claude-агента) и хочет добавить второго агента — Jarvis на DeepSeek. Типичные фразы:
- «установи Джарвиса» / «поставь Джарвиса»
- «добавь второго агента» / «хочу DeepSeek бота»
- «установи Jarvis» / `/install-jarvis`
- «настрой второго помощника»

## Что нужно от пользователя

Спроси **до начала**, если пользователь не указал сам:

1. **DeepSeek API Key** — получить на [platform.deepseek.com](https://platform.deepseek.com) → API Keys → Create
2. **Telegram Bot Token для Jarvis** — создать НОВЫЙ бот через [@BotFather](https://t.me/BotFather) (не тот, что у Friday — у Jarvis должен быть свой)

Больше ничего не спрашивай.

## Что ты делаешь

Перед каждым шагом — одно предложение что делаешь. После — коротко результат.

### Шаг 1. Проверь что Friday уже установлен

```bash
ls /home/agent/.agent/bot/index.js 2>/dev/null && echo "Friday есть" || echo "Friday не найден"
```

Если Friday не найден — скажи пользователю: «Сначала нужно установить Friday. Напишите "установи агента на сервер" и укажите IP и пароль VPS».

Если Friday есть — продолжай.

### Шаг 2. Создай папки для Jarvis

```bash
mkdir -p /home/agent/.agent/jarvis-bot && \
mkdir -p /home/agent/.agent/jarvis/traces && \
echo OK
```

### Шаг 3. Скачай код Jarvis

```bash
curl -fsSL https://raw.githubusercontent.com/romanlabin-dev/my-first-project/main/jarvis/index.js \
  -o /home/agent/.agent/jarvis-bot/index.js && \
wc -l /home/agent/.agent/jarvis-bot/index.js
```

Если curl вернул ошибку или файл меньше 100 строк — скажи пользователю об ошибке.

### Шаг 4. Создай package.json

Напиши файл напрямую:

```bash
cat > /home/agent/.agent/jarvis-bot/package.json << 'EOF'
{
  "name": "jarvis-bot",
  "version": "3.0.0",
  "type": "module",
  "main": "index.js",
  "scripts": { "start": "node index.js" },
  "dependencies": {
    "grammy": "^1.31.0",
    "@grammyjs/auto-retry": "^2.0.2",
    "openai": "^4.0.0"
  }
}
EOF
echo OK
```

### Шаг 5. Создай файл окружения .env

Замени `ТОКЕН_БОТА` и `КЛЮЧ_DEEPSEEK` на данные пользователя:

```bash
cat > /home/agent/.agent/jarvis-bot/.env << 'EOF'
BOT_TOKEN=ТОКЕН_БОТА
DEEPSEEK_API_KEY=КЛЮЧ_DEEPSEEK
AGENT_HOME=/home/agent
EOF
echo OK
```

**Важно:** никогда не показывай содержимое .env файла в ответе — там секретные ключи.

### Шаг 6. Установи зависимости

```bash
cd /home/agent/.agent/jarvis-bot && npm install --production 2>&1 | tail -5 && echo DONE
```

Это может занять 30–60 секунд. Подожди.

### Шаг 7. Создай systemd-сервис

```bash
cat > /etc/systemd/system/jarvis-bot.service << 'EOF'
[Unit]
Description=Jarvis Bot - Personal AI Agent (DeepSeek)
After=network.target

[Service]
Type=simple
User=agent
WorkingDirectory=/home/agent/.agent/jarvis-bot
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
EnvironmentFile=/home/agent/.agent/jarvis-bot/.env

[Install]
WantedBy=multi-user.target
EOF
echo OK
```

### Шаг 8. Поправь права и запусти

```bash
chown -R agent:agent /home/agent/.agent/jarvis-bot && \
chown -R agent:agent /home/agent/.agent/jarvis && \
systemctl daemon-reload && \
systemctl enable jarvis-bot && \
systemctl start jarvis-bot && \
sleep 4 && \
systemctl status jarvis-bot --no-pager -l 2>&1 | head -20
```

### Шаг 9. Проверь логи

```bash
journalctl -u jarvis-bot -n 15 --no-pager
```

В логах должна быть строка вида:
```
Jarvis v3.0 | model: deepseek-v4-flash | tools: 11 | tz: Europe/Moscow
```

Если в логах ошибка `DEEPSEEK_API_KEY` — ключ введён неверно. Исправь .env и перезапусти:
```bash
systemctl restart jarvis-bot && sleep 3 && journalctl -u jarvis-bot -n 5 --no-pager
```

Если ошибка `BOT_TOKEN` — токен бота неверный. Проверь у @BotFather.

## Итоговое сообщение пользователю

Когда Jarvis запущен успешно, скажи:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Jarvis установлен и работает ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Теперь у вас два агента на сервере:
  🤖 Friday — работает на Claude (ваша подписка)
  ⚡ Jarvis — работает на DeepSeek API

Что делать дальше:

1. Напишите Jarvis в Telegram → /start
   Он задаст 6 коротких вопросов чтобы узнать кто вы.
   После этого можете работать!

2. Jarvis работает на модели deepseek-v4-flash (быстрая и дешёвая).
   Если нужна умная модель — напишите боту /settings → переключите на deepseek-v4-pro.

3. У Jarvis 11 инструментов: читает и пишет файлы, выполняет команды,
   ищет в интернете, помнит ваши разговоры.

Полезные команды для управления:
  systemctl status jarvis-bot    — статус
  systemctl restart jarvis-bot   — перезапуск
  journalctl -u jarvis-bot -n 30 — последние логи
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Если что-то пошло не так

- **Ошибка при скачивании index.js** → файл ещё не загружен в репозиторий. Попросите администратора обновить репо.
- **npm install падает** → проверь есть ли интернет: `curl -s https://registry.npmjs.org/ | head -1`
- **Сервис стартует и сразу останавливается** → смотри полный лог: `journalctl -u jarvis-bot -n 50 --no-pager`
- **"Cannot find package 'openai'"** → зависимости не поставились. Повтори шаг 6.
- **Telegram не отвечает** → токен бота неверный. Проверь через `curl https://api.telegram.org/bot<TOKEN>/getMe`

## Безопасность

- НЕ показывай DEEPSEEK_API_KEY и BOT_TOKEN в ответах после ввода
- НЕ сохраняй ключи нигде кроме /home/agent/.agent/jarvis-bot/.env
