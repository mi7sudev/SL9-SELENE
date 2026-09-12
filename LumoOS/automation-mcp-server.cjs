// LumoOS Automation MCP Server
//
// A custom MCP server that gives the Lumo agent automation capabilities:
// - Create scheduled tasks (cron-like triggers)
// - Create one-time reminders
// - Manage a simple task/todo list
// - Make HTTP requests (webhooks, API calls)
// - Store/retrieve key-value data (persistent memory)
//
// This runs as a stdio MCP server, spawned by lumo-server.cjs's MCP manager.
// All data is stored in a JSON file in the Lumo data directory.
//
// Tools exposed:
//   1. create_scheduled_task — create a recurring automation (cron schedule)
//   2. create_reminder — create a one-time reminder at a specific time
//   3. list_tasks — list all tasks/reminders/automations
//   4. complete_task — mark a task as done
//   5. delete_task — delete a task/reminder/automation
//   6. http_request — make an HTTP GET/POST/PUT/DELETE request (webhooks, APIs)
//   7. store_data — store a key-value pair (persistent memory across conversations)
//   8. retrieve_data — retrieve stored data by key
//   9. list_data — list all stored keys
//  10. send_webhook — send a webhook payload to a URL
//
// The cron scheduler runs in-process: every minute it checks for due tasks
// and fires them (HTTP webhook, notification, etc.).

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DATA_FILE = process.env.LUMO_AUTOMATION_DATA || path.join(process.env.LUMO_DATA_DIR || '/home/z/my-project/LumoOS/data', 'automation.json');

// Load data
function loadData() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
        return { tasks: [], data: {}, log: [] };
    }
}

function saveData(data) {
    try {
        fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('[automation] Failed to save data:', e.message);
    }
}

function logEvent(data, event) {
    data.log = data.log || [];
    data.log.push({ ...event, timestamp: new Date().toISOString() });
    if (data.log.length > 100) data.log = data.log.slice(-100);
}

// Simple HTTP request function
function makeRequest(method, url, headers, body) {
    return new Promise((resolve) => {
        try {
            const parsed = new URL(url);
            const lib = parsed.protocol === 'https:' ? https : http;
            const reqBody = body ? JSON.stringify(body) : null;
            const opts = {
                method: method.toUpperCase(),
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                headers: {
                    'Content-Type': 'application/json',
                    ...(headers || {}),
                    ...(reqBody ? { 'Content-Length': Buffer.byteLength(reqBody) } : {}),
                },
                timeout: 15000,
            };
            const req = lib.request(opts, (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    resolve({ status: res.statusCode, headers: res.headers, body: data.slice(0, 2000) });
                });
            });
            req.on('error', (e) => resolve({ error: e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timed out (15s)' }); });
            if (reqBody) req.write(reqBody);
            req.end();
        } catch (e) {
            resolve({ error: e.message });
        }
    });
}

// Cron scheduler: checks every minute for due tasks
function startScheduler() {
    setInterval(async () => {
        const data = loadData();
        const now = Date.now();
        let changed = false;

        for (const task of data.tasks) {
            if (task.status !== 'active') continue;

            if (task.type === 'reminder' && task.scheduledFor) {
                const due = new Date(task.scheduledFor).getTime();
                if (due <= now && !task.lastFired) {
                    task.lastFired = new Date().toISOString();
                    task.status = 'completed';
                    changed = true;
                    logEvent(data, { type: 'reminder_fired', taskId: task.id, title: task.title });
                    // Fire webhook if configured
                    if (task.webhookUrl) {
                        makeRequest('POST', task.webhookUrl, {}, { event: 'reminder', task });
                    }
                    console.log(`[automation] Reminder fired: ${task.title}`);
                }
            }

            if (task.type === 'automation' && task.cron) {
                // Simple cron: check if the current minute matches
                // Format: "every N minutes" or "every day at HH:MM"
                const lastRun = task.lastFired ? new Date(task.lastFired).getTime() : 0;
                const shouldFire = checkCron(task.cron, now, lastRun);
                if (shouldFire) {
                    task.lastFired = new Date().toISOString();
                    task.runCount = (task.runCount || 0) + 1;
                    changed = true;
                    logEvent(data, { type: 'automation_fired', taskId: task.id, title: task.title, runCount: task.runCount });
                    // Fire webhook if configured
                    if (task.webhookUrl) {
                        makeRequest('POST', task.webhookUrl, {}, { event: 'automation', task, runCount: task.runCount });
                    }
                    // Execute HTTP action if configured
                    if (task.action && task.action.url) {
                        const result = await makeRequest(task.action.method || 'GET', task.action.url, task.action.headers, task.action.body);
                        logEvent(data, { type: 'automation_action_result', taskId: task.id, result: { status: result.status, error: result.error } });
                    }
                    console.log(`[automation] Automation fired: ${task.title} (run #${task.runCount})`);
                }
            }
        }

        if (changed) saveData(data);
    }, 60000); // Check every minute
}

// Simple cron matcher
function checkCron(cron, now, lastRun) {
    const date = new Date(now);
    const minutesSinceLast = lastRun > 0 ? Math.floor((now - lastRun) / 60000) : 999;

    // "every N minutes"
    let m = cron.match(/^every (\d+) minutes?$/i);
    if (m) return minutesSinceLast >= parseInt(m[1]);

    // "every day at HH:MM"
    m = cron.match(/^every day at (\d{1,2}):(\d{2})$/i);
    if (m) {
        const hour = parseInt(m[1]);
        const min = parseInt(m[2]);
        return date.getHours() === hour && date.getMinutes() === min && minutesSinceLast > 60;
    }

    // "every hour"
    if (/^every hour$/i.test(cron)) return minutesSinceLast >= 60;

    // "every Monday/Tuesday/etc at HH:MM"
    m = cron.match(/^every (\w+) at (\d{1,2}):(\d{2})$/i);
    if (m) {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const dayIdx = days.indexOf(m[1].toLowerCase());
        if (dayIdx === -1) return false;
        return date.getDay() === dayIdx && date.getHours() === parseInt(m[2]) && date.getMinutes() === parseInt(m[3]) && minutesSinceLast > 60;
    }

    return false;
}

// Generate unique ID
function genId() {
    return 'task-' + Math.random().toString(36).slice(2, 12);
}

// Create the MCP server
const server = new Server(
    { name: 'lumo-automation', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'create_scheduled_task',
            description: 'Create a recurring automation that fires on a schedule. The automation can make HTTP requests (webhooks, API calls) when it fires. Use this when the user wants to automate something on a schedule (e.g. "every day at 9am check my stock portfolio", "every Monday send a summary email").',
            inputSchema: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Human-readable name for this automation' },
                    cron: { type: 'string', description: 'Schedule in natural language: "every 5 minutes", "every hour", "every day at 09:00", "every Monday at 08:30"' },
                    webhookUrl: { type: 'string', description: 'Optional: URL to POST to when the automation fires' },
                    action: {
                        type: 'object',
                        description: 'Optional: HTTP action to execute when the automation fires',
                        properties: {
                            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
                            url: { type: 'string', description: 'The URL to call' },
                            headers: { type: 'object', description: 'HTTP headers' },
                            body: { type: 'object', description: 'JSON body for POST/PUT' },
                        },
                    },
                    description: { type: 'string', description: 'What this automation does' },
                },
                required: ['title', 'cron'],
            },
        },
        {
            name: 'create_reminder',
            description: 'Create a one-time reminder at a specific date/time. Use this when the user says "remind me to...", "schedule a reminder for...", etc.',
            inputSchema: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'What to remind about' },
                    scheduledFor: { type: 'string', description: 'ISO 8601 date-time (e.g. "2026-01-15T09:00:00") or relative time like "in 2 hours", "tomorrow at 3pm", "next Monday"' },
                    webhookUrl: { type: 'string', description: 'Optional: URL to POST to when the reminder fires' },
                    description: { type: 'string', description: 'Additional details' },
                },
                required: ['title', 'scheduledFor'],
            },
        },
        {
            name: 'create_task',
            description: 'Create a task/todo item. Use this when the user says "make me a task", "add to my todo list", "create a task to...".',
            inputSchema: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Task title' },
                    description: { type: 'string', description: 'Task details' },
                    priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Priority level' },
                    dueDate: { type: 'string', description: 'Optional due date (ISO 8601)' },
                },
                required: ['title'],
            },
        },
        {
            name: 'list_tasks',
            description: 'List all tasks, reminders, and automations. Returns active, completed, and pending items.',
            inputSchema: {
                type: 'object',
                properties: {
                    filter: { type: 'string', enum: ['all', 'active', 'completed', 'tasks', 'reminders', 'automations'], description: 'Filter by type or status' },
                },
            },
        },
        {
            name: 'complete_task',
            description: 'Mark a task, reminder, or automation as completed.',
            inputSchema: {
                type: 'object',
                properties: {
                    taskId: { type: 'string', description: 'The task ID to complete' },
                },
                required: ['taskId'],
            },
        },
        {
            name: 'delete_task',
            description: 'Delete a task, reminder, or automation permanently.',
            inputSchema: {
                type: 'object',
                properties: {
                    taskId: { type: 'string', description: 'The task ID to delete' },
                },
                required: ['taskId'],
            },
        },
        {
            name: 'http_request',
            description: 'Make an HTTP request to any URL. Use this for webhooks, API calls, fetching data from web services, etc. This enables the agent to interact with any web API (send emails via API, create calendar events via API, post to Slack via webhook, etc.).',
            inputSchema: {
                type: 'object',
                properties: {
                    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP method' },
                    url: { type: 'string', description: 'The URL to request' },
                    headers: { type: 'object', description: 'HTTP headers (e.g. Authorization, Content-Type)' },
                    body: { type: 'object', description: 'JSON body for POST/PUT/PATCH requests' },
                },
                required: ['method', 'url'],
            },
        },
        {
            name: 'store_data',
            description: 'Store a key-value pair that persists across conversations. Use this to remember user preferences, API keys (encrypted), configuration, or any data the agent needs to recall later.',
            inputSchema: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Unique key (e.g. "user_timezone", "slack_webhook_url", "calendar_api_key")' },
                    value: { type: 'string', description: 'The value to store' },
                },
                required: ['key', 'value'],
            },
        },
        {
            name: 'retrieve_data',
            description: 'Retrieve a previously stored value by key.',
            inputSchema: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'The key to look up' },
                },
                required: ['key'],
            },
        },
        {
            name: 'list_data',
            description: 'List all stored data keys.',
            inputSchema: {
                type: 'object',
                properties: {},
            },
        },
        {
            name: 'send_notification',
            description: 'Create a notification that will be shown to the user. Use this when the agent needs to alert the user about something (e.g. "Your automation ran successfully", "Reminder: Meeting in 10 minutes").',
            inputSchema: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Notification title' },
                    message: { type: 'string', description: 'Notification body' },
                    type: { type: 'string', enum: ['info', 'success', 'warning', 'error'], description: 'Notification type' },
                },
                required: ['title', 'message'],
            },
        },
    ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const data = loadData();

    try {
        switch (name) {
            case 'create_scheduled_task': {
                const task = {
                    id: genId(),
                    type: 'automation',
                    title: args.title,
                    description: args.description || '',
                    cron: args.cron,
                    webhookUrl: args.webhookUrl || null,
                    action: args.action || null,
                    status: 'active',
                    createdAt: new Date().toISOString(),
                    lastFired: null,
                    runCount: 0,
                };
                data.tasks.push(task);
                saveData(data);
                return { content: [{ type: 'text', text: `✅ Automation created: "${task.title}"\nSchedule: ${task.cron}\nID: ${task.id}\nStatus: active\n${task.action ? `Action: ${task.action.method} ${task.action.url}` : 'No action configured'}` }] };
            }

            case 'create_reminder': {
                // Parse relative time
                let scheduledFor = args.scheduledFor;
                if (/^in /i.test(scheduledFor)) {
                    const m = scheduledFor.match(/in (\d+) (minute|hour|day|week)s?/i);
                    if (m) {
                        const num = parseInt(m[1]);
                        const unit = m[2].toLowerCase();
                        const ms = num * (unit === 'minute' ? 60000 : unit === 'hour' ? 3600000 : unit === 'day' ? 86400000 : 604800000);
                        scheduledFor = new Date(Date.now() + ms).toISOString();
                    }
                } else if (/^tomorrow at /i.test(scheduledFor)) {
                    const m = scheduledFor.match(/tomorrow at (\d{1,2}):(\d{2})\s*(am|pm)?/i);
                    if (m) {
                        const tomorrow = new Date();
                        tomorrow.setDate(tomorrow.getDate() + 1);
                        tomorrow.setHours(parseInt(m[1]) + (m[3] && m[3].toLowerCase() === 'pm' ? 12 : 0));
                        tomorrow.setMinutes(parseInt(m[2]));
                        scheduledFor = tomorrow.toISOString();
                    }
                }

                const reminder = {
                    id: genId(),
                    type: 'reminder',
                    title: args.title,
                    description: args.description || '',
                    scheduledFor,
                    webhookUrl: args.webhookUrl || null,
                    status: 'active',
                    createdAt: new Date().toISOString(),
                    lastFired: null,
                };
                data.tasks.push(reminder);
                saveData(data);
                return { content: [{ type: 'text', text: `✅ Reminder created: "${reminder.title}"\nScheduled for: ${new Date(scheduledFor).toLocaleString()}\nID: ${reminder.id}` }] };
            }

            case 'create_task': {
                const task = {
                    id: genId(),
                    type: 'task',
                    title: args.title,
                    description: args.description || '',
                    priority: args.priority || 'medium',
                    dueDate: args.dueDate || null,
                    status: 'active',
                    createdAt: new Date().toISOString(),
                    completedAt: null,
                };
                data.tasks.push(task);
                saveData(data);
                return { content: [{ type: 'text', text: `✅ Task created: "${task.title}"\nPriority: ${task.priority}\nID: ${task.id}${task.dueDate ? `\nDue: ${new Date(task.dueDate).toLocaleString()}` : ''}` }] };
            }

            case 'list_tasks': {
                const filter = args.filter || 'all';
                let tasks = data.tasks;
                if (filter === 'active') tasks = tasks.filter(t => t.status === 'active');
                if (filter === 'completed') tasks = tasks.filter(t => t.status === 'completed');
                if (filter === 'tasks') tasks = tasks.filter(t => t.type === 'task');
                if (filter === 'reminders') tasks = tasks.filter(t => t.type === 'reminder');
                if (filter === 'automations') tasks = tasks.filter(t => t.type === 'automation');

                if (tasks.length === 0) return { content: [{ type: 'text', text: 'No items found.' }] };

                const lines = tasks.map(t => {
                    const icon = t.type === 'task' ? '📋' : t.type === 'reminder' ? '⏰' : '🔄';
                    const status = t.status === 'completed' ? '✅' : t.status === 'active' ? '🔵' : '⚫';
                    return `${icon} ${status} [${t.id}] ${t.title}${t.cron ? ` (${t.cron})` : ''}${t.scheduledFor ? ` → ${new Date(t.scheduledFor).toLocaleString()}` : ''}${t.runCount ? ` (ran ${t.runCount}x)` : ''}`;
                });
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            }

            case 'complete_task': {
                const task = data.tasks.find(t => t.id === args.taskId);
                if (!task) return { content: [{ type: 'text', text: `❌ Task not found: ${args.taskId}` }] };
                task.status = 'completed';
                task.completedAt = new Date().toISOString();
                saveData(data);
                return { content: [{ type: 'text', text: `✅ Completed: "${task.title}"` }] };
            }

            case 'delete_task': {
                const idx = data.tasks.findIndex(t => t.id === args.taskId);
                if (idx === -1) return { content: [{ type: 'text', text: `❌ Task not found: ${args.taskId}` }] };
                const deleted = data.tasks.splice(idx, 1)[0];
                saveData(data);
                return { content: [{ type: 'text', text: `🗑️ Deleted: "${deleted.title}"` }] };
            }

            case 'http_request': {
                const result = await makeRequest(args.method, args.url, args.headers, args.body);
                const statusText = result.status ? `HTTP ${result.status}` : 'Error';
                const bodyText = result.body ? result.body.slice(0, 500) : result.error || 'No response body';
                logEvent(data, { type: 'http_request', method: args.method, url: args.url, status: result.status });
                saveData(data);
                return { content: [{ type: 'text', text: `${statusText}\n${bodyText}` }] };
            }

            case 'store_data': {
                data.data[args.key] = args.value;
                saveData(data);
                return { content: [{ type: 'text', text: `✅ Stored: ${args.key} = ${args.value.slice(0, 100)}${args.value.length > 100 ? '...' : ''}` }] };
            }

            case 'retrieve_data': {
                const value = data.data[args.key];
                return { content: [{ type: 'text', text: value !== undefined ? value : `❌ Key not found: ${args.key}` }] };
            }

            case 'list_data': {
                const keys = Object.keys(data.data);
                if (keys.length === 0) return { content: [{ type: 'text', text: 'No stored data.' }] };
                return { content: [{ type: 'text', text: keys.map(k => `🔑 ${k}: ${String(data.data[k]).slice(0, 50)}...`).join('\n') }] };
            }

            case 'send_notification': {
                logEvent(data, { type: 'notification', title: args.title, message: args.message, notifType: args.type || 'info' });
                saveData(data);
                return { content: [{ type: 'text', text: `✅ Notification queued: "${args.title}"` }] };
            }

            default:
                return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
        }
    } catch (e) {
        return { content: [{ type: 'text', text: `❌ Error: ${e.message}` }] };
    }
});

// Start the server
const transport = new StdioServerTransport();
server.connect(transport).then(() => {
    console.log('[automation] Lumo Automation MCP server started');
    startScheduler();
}).catch((e) => {
    console.error('[automation] Failed to start:', e.message);
    process.exit(1);
});
