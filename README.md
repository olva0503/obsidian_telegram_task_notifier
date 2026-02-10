# Telegram Tasks Notifier (Obsidian)

Send your unfinished Obsidian Tasks to Telegram and mark them complete right from Telegram.

## Features

- Sends unfinished tasks on demand, on startup, and on a schedule.
- Pulls tasks from the Tasks plugin API when available, with a vault scan fallback.
- Inline Telegram buttons to mark tasks as done.
- Create new tasks from Telegram (stored in your latest daily note) with optional due date and priority.
- Separate host and guest chat IDs; guests only see #shared tasks and add #shared tasks.
- Optional global tag filter (e.g. `#work`) to limit what gets sent.
- Task ID tagging to reliably complete tasks from Telegram.
- Optional file path and line number in messages.

## Requirements

- Obsidian 1.4.0+
- Telegram bot token (via BotFather)
- Telegram host chat ID (and optional guest chat IDs)
- Daily Notes plugin enabled (for Telegram task creation)
- (Optional) Tasks plugin for richer querying

## Installation

### Manual install

1. Build the plugin (see Development below).
2. Copy `manifest.json`, `main.js`, and `styles.css` (if present) to:
   - `<vault>/.obsidian/plugins/obsidian-telegram-tasks-notifier/`
3. Enable the plugin in Obsidian.

## Telegram setup

1. Create a bot via `@BotFather` and copy the token.
2. In Telegram, open a chat with your bot and send `/start`.
3. In Obsidian, open the plugin settings and set the bot token.
4. In Telegram, send `/start` to the bot from each chat you want to allow.
5. In Obsidian, copy chat IDs from `Requestors` into `Host chat ID` or `Guest chat IDs`.

## Configuration

All settings are in `Settings` -> `Telegram Tasks Notifier`:

- `Tasks query` (default: `not done`): Tasks plugin query to fetch tasks.
- `Global filter tag` (default: empty): Only include tasks with this tag.
- `Telegram bot token`: Your bot token.
- `Host chat ID`: Target chat ID for full access.
- `Guest chat IDs`: Comma-separated chat IDs for #shared access only.
- `Requestors`: Chat IDs that sent `/start` (editable).
- `Allowed Telegram user IDs` (default: empty): Optional list of user IDs allowed to mark tasks complete.
- `Task ID tagging mode` (default: `always`):
  - `always`: Add `#taskid/<id>` to tasks whenever they are collected.
  - `on-complete`: Add the tag only when a task is marked complete.
  - `never`: Never write tags back to files.
- `Notify on startup` (default: `true`): Send a notification when Obsidian starts.
- `Notification interval (minutes)` (default: `60`): Set to `0` to disable periodic notifications.
- `Poll Telegram updates` (default: `true`): Enable Telegram polling for actions.
- `Polling interval (seconds)` (default: `10`): Long-poll duration for updates.
- `Max tasks per notification` (default: `20`): Limit tasks per Telegram message.
- `Include file path` (default: `true`): Include file path and line number.

## Usage

Commands (Command Palette):

- `Telegram Tasks Notifier: Send unfinished tasks to Telegram`
- `Telegram Tasks Notifier: Poll Telegram updates`
- `Telegram Tasks Notifier: Detect Telegram requestor chat ID`

In Telegram:

- Tap `Done #<id>` to mark a task complete.
- Send `done <id>` to mark a task complete manually.
- Send any message to create a new task in the latest daily note.
  - Optional metadata: `due:YYYY-MM-DD` and `priority: high|medium|low|urgent` (or `p0`-`p4`).
  - Guests automatically tag new tasks with `#shared`.

## Development

Install dependencies and build:

```bash
bun install
bun run build
```

Run the dev build:

```bash
bun run dev
```

Run tests:

```bash
bun test
```

## License

MIT. See `LICENSE`.
