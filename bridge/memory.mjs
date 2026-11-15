/**
 * Memory MCP — structured long-term memory in SQLite.
 *
 * Not a transcript. Nothing here was whispered by the conversation on its way
 * by; it is what the user (or the router, on an explicit "remember that…")
 * chose to put down. That is the whole design: memory must be explicit, so the
 * only writes are saves from memory_save / project_save / task_create, and a
 * delete goes through the spoken-confirmation gate in server.mjs like every
 * other destructive action.
 *
 * Two families of memory, one table each:
 *
 *   memory  — durable facts ("I prefer Celsius", "fast response time is a
 *             priority"), categorised and weighted by importance.
 *   projects — the user's main project work: name, description, status,
 *             technologies, priority — plus project_tasks, the open and done
 *             work inside each. Answers "what am I working on".
 *
 * Tools: memory_save, memory_search, memory_get, memory_update, memory_delete,
 *        project_save, project_get, project_search, project_update,
 *        project_delete, task_create, task_update, task_list, task_delete.
 */

import { db, one, many, nowMs } from './db.mjs'

const STATUSES = new Set(['active', 'paused', 'done', 'archived'])
const TASK_STATUSES = new Set(['todo', 'doing', 'done', 'blocked'])
const PRIORITIES = new Set(['low', 'medium', 'high'])
const CATEGORIES = new Set(['general', 'personal', 'work', 'project', 'preference', 'command'])
const MAX_CONTENT = 4000

function cleanText(v, what) {
  const s = String(v ?? '').trim()
  if (!s) throw new Error(`A ${what} is needed.`)
  if (s.length > MAX_CONTENT) throw new Error(`That ${what} is too long.`)
  return s
}

function cleanCategory(v) {
  const c = String(v ?? 'general').trim().toLowerCase()
  return CATEGORIES.has(c) ? c : 'general'
}

function cleanStatus(v, set, fallback) {
  const s = String(v ?? '').trim().toLowerCase()
  return set.has(s) ? s : fallback
}

function cleanPriority(v) {
  const p = String(v ?? 'medium').trim().toLowerCase()
  return PRIORITIES.has(p) ? p : 'medium'
}

function projectId(name) {
  const row = one('SELECT id FROM projects WHERE lower(name) = lower(?)', String(name).trim())
  if (!row) throw new Error(`No project named "${String(name).trim()}" is saved.`)
  return row.id
}

function formatMemory(m) {
  return `#${m.id} [${m.category}/imp ${m.importance}] ${m.content}`
}

function formatProject(p) {
  const tech = p.technologies ? ` — ${p.technologies}` : ''
  const desc = p.description ? `\n   ${p.description}` : ''
  const tasks = many("SELECT * FROM project_tasks WHERE project_id = ? ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at", p.id)
    .filter((t) => t.status !== 'done')
    .slice(0, 8)
  const done = one('SELECT COUNT(*) AS n FROM project_tasks WHERE project_id = ? AND status = ?', p.id, 'done')?.n ?? 0
  const open = tasks.length
  const taskLines = open ? '\n   open tasks: ' + tasks.map((t) => `#${t.id} ${t.task}`).join(' | ') : ''
  const doneLine = done ? ` (${done} done)` : ''
  return `${p.name} [${p.status}/${p.priority}]${tech} — ${open} open${doneLine}${desc}${taskLines}`
}

/** Programmatic "what are my projects" for the fast router. Never throws. */
export function listProjects() {
  const rows = many('SELECT * FROM projects ORDER BY updated_at DESC LIMIT 20')
  if (!rows.length) return 'I have no projects saved yet.'
  const out = []
  for (const p of rows) {
    const tasks = many('SELECT * FROM project_tasks WHERE project_id = ? AND status != ? ORDER BY created_at LIMIT 5', p.id, 'done')
    const done = one('SELECT COUNT(*) AS n FROM project_tasks WHERE project_id = ? AND status = ?', p.id, 'done')?.n ?? 0
    const open = tasks.length
    const line = `${p.name.length > 0 ? p.name.charAt(0).toUpperCase() + p.name.slice(1) : p.name} (${open} open${done ? `, ${done} done` : ''})`
    const first = tasks[0]
    out.push(first ? `${line} — e.g. ${first.task}` : line)
  }
  return out.join('\n')
}

/** Programmatic "my main project is X" for the fast router. Never throws. */
export function saveProject(name) {
  const clean = String(name ?? '').trim().replace(/[.'"]$/, '')
  if (!clean) return null
  if (clean.length > 120) throw new Error('That project name is too long.')
  const exists = one('SELECT id FROM projects WHERE lower(name) = lower(?)', clean)
  if (exists) {
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowMs(), exists.id)
    return `Project "${clean}" is already saved.`
  }
  db.prepare('INSERT INTO projects (name, description, status, technologies, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(clean, '', 'active', '', 'medium', nowMs(), nowMs())
  return `Saved project "${clean}".`
}

export function memoryServer() {
  const tools = []
  const tool = (t) => tools.push(t)

  /** Saves are explicit by design — see the header. */
  tool({
    name: 'memory_save',
    description:
      'Store a durable fact the user asked you to remember. Use ONLY when they ' +
      'explicitly say "remember that …" or hand you a standing fact — never save ' +
      'conversation by itself. Refuses secrets.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact, e.g. "Fast response time is a priority."' },
        category: { type: 'string', enum: [...CATEGORIES], description: 'What the fact is about (default general).' },
        importance: { type: 'number', description: '1–5, how much it should be weighed (default 1).' },
      },
      required: ['content'],
    },
    handler: async (args) => {
      const content = cleanText(args?.content, 'memory')
      if (/password|secret|token|pin|credential/i.test(content) && content.length < 512) {
        throw new Error('That looks like a secret — I do not store credentials.')
      }
      const id = db
        .prepare('INSERT INTO memory (category, content, importance, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(cleanCategory(args?.category), content, Math.min(5, Math.max(1, Number(args?.importance) || 1)), 'user', nowMs(), nowMs())
        .lastInsertRowid
      return `Remembered (${id}): ${content}`
    },
  })

  tool({
    name: 'memory_search',
    description:
      'Search remembered facts and project memory by a few words. Use when the ' +
      'user asks "what did I tell you", "do you remember…", "what am I working on".',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to match against facts and projects.' } },
      required: ['query'],
    },
    handler: async (args) => {
      const q = cleanText(args?.query, 'search')
      const like = `%${q}%`
      const mem = many('SELECT * FROM memory WHERE content LIKE ? OR category LIKE ? ORDER BY importance DESC, updated_at DESC LIMIT 12', like, like)
      const proj = many('SELECT * FROM projects WHERE name LIKE ? OR description LIKE ? OR technologies LIKE ? ORDER BY updated_at DESC LIMIT 8', like, like, like)
      const out = []
      if (mem.length) out.push('MEMORY\n' + mem.map(formatMemory).join('\n'))
      if (proj.length) out.push('PROJECTS\n' + proj.map(formatProject).join('\n'))
      return out.length ? out.join('\n\n') : `Nothing remembered matches "${q}".`
    },
  })

  tool({
    name: 'memory_get',
    description: 'Read one remembered fact by its id (from memory_search / memory_list).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The fact id.' } },
      required: ['id'],
    },
    handler: async (args) => {
      const m = one('SELECT * FROM memory WHERE id = ?', Number(args?.id) || 0)
      if (!m) throw new Error('No memory with that id.')
      return formatMemory(m)
    },
  })

  tool({
    name: 'memory_list',
    description: 'All remembered facts, newest first, or by category.',
    inputSchema: {
      type: 'object',
      properties: { category: { type: 'string', description: 'Optional category filter.' } },
      required: [],
    },
    handler: async (args) => {
      const rows = args?.category
        ? many('SELECT * FROM memory WHERE category = ? ORDER BY importance DESC, updated_at DESC LIMIT 50', cleanCategory(args.category))
        : many('SELECT * FROM memory ORDER BY importance DESC, updated_at DESC LIMIT 50')
      if (!rows.length) return 'Nothing is remembered yet.'
      return rows.map(formatMemory).join('\n')
    },
  })

  tool({
    name: 'memory_update',
    description: 'Change a remembered fact (its content, category or importance).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        content: { type: 'string' },
        importance: { type: 'number' },
        category: { type: 'string' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const id = Number(args?.id) || 0
      const cur = one('SELECT * FROM memory WHERE id = ?', id)
      if (!cur) throw new Error('No memory with that id.')
      const content = args?.content !== undefined ? cleanText(args.content, 'content') : cur.content
      const category = args?.category !== undefined ? cleanCategory(args.category) : cur.category
      const importance = args?.importance !== undefined ? Math.min(5, Math.max(1, Number(args.importance) || 1)) : cur.importance
      db.prepare('UPDATE memory SET content = ?, category = ?, importance = ?, updated_at = ? WHERE id = ?')
        .run(content, category, importance, nowMs(), id)
      return `Updated memory ${id}.`
    },
  })

  tool({
    name: 'memory_delete',
    description:
      'Delete a remembered fact. DESTRUCTIVE — announce it and confirm with the ' +
      'user before calling; the bridge will require a spoken yes anyway.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: async (args) => {
      const id = Number(args?.id) || 0
      const res = db.prepare('DELETE FROM memory WHERE id = ?').run(id)
      if (!res.changes) throw new Error('No memory with that id.')
      return `Forgotten memory ${id}.`
    },
  })

  tool({
    name: 'project_save',
    description:
      'Save or update a project the user cares about — "remember that Jarvis is ' +
      'one of my main projects". Name is the key; later saves with the same name ' +
      'update it. Explicit only.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name, e.g. "Jarvis".' },
        details: { type: 'string', description: 'What the project is about.' },
        status: { type: 'string', enum: [...STATUSES] },
        technologies: { type: 'string', description: 'Comma-separated, e.g. "Node.js, SQLite, WebSocket".' },
        priority: { type: 'string', enum: [...PRIORITIES] },
      },
      required: ['name'],
    },
    handler: async (args) => {
      const name = cleanText(args?.name, 'project name')
      const exists = one('SELECT * FROM projects WHERE lower(name) = lower(?)', name)
      const status = cleanStatus(args?.status, STATUSES, exists?.status ?? 'active')
      const fields = {
        details: args?.details !== undefined ? String(args.details).trim() : (exists?.description ?? ''),
        technologies: args?.technologies !== undefined ? String(args.technologies).trim() : (exists?.technologies ?? ''),
        priority: args?.priority !== undefined ? cleanPriority(args.priority) : (exists?.priority ?? 'medium'),
      }
      if (exists) {
        db.prepare('UPDATE projects SET description = ?, technologies = ?, status = ?, priority = ?, updated_at = ? WHERE id = ?')
          .run(fields.details, fields.technologies, status, fields.priority, nowMs(), exists.id)
        return `Updated project "${name}".`
      }
      db.prepare('INSERT INTO projects (name, description, status, technologies, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(name, fields.details, status, fields.technologies, fields.priority, nowMs(), nowMs())
      return `Saved project "${name}".`
    },
  })

  tool({
    name: 'project_get',
    description: 'One project with its open and done tasks.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Project name.' } },
      required: ['name'],
    },
    handler: async (args) => {
      const p = one('SELECT * FROM projects WHERE lower(name) = lower(?)', String(args?.name ?? '').trim())
      if (!p) throw new Error(`No project named "${String(args?.name ?? '').trim()}" is saved.`)
      return formatProject(p)
    },
  })

  tool({
    name: 'project_search',
    description: 'Find saved projects by name/description/technology.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    handler: async (args) => {
      const q = cleanText(args?.query, 'search')
      const like = `%${q}%`
      const rows = many('SELECT * FROM projects WHERE name LIKE ? OR description LIKE ? OR technologies LIKE ? ORDER BY updated_at DESC LIMIT 12', like, like, like)
      if (!rows.length) return `No projects match "${q}".`
      return rows.map(formatProject).join('\n')
    },
  })

  tool({
    name: 'project_update',
    description: 'Change a saved project\'s fields. Pass only what changes.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        details: { type: 'string' },
        status: { type: 'string', enum: [...STATUSES] },
        technologies: { type: 'string' },
        priority: { type: 'string', enum: [...PRIORITIES] },
      },
      required: ['name'],
    },
    handler: async (args) => {
      const name = cleanText(args?.name, 'project name')
      const id = projectId(name)
      const cur = one('SELECT * FROM projects WHERE id = ?', id)
      const status = cleanStatus(args?.status, STATUSES, cur.status)
      db.prepare('UPDATE projects SET description = ?, technologies = ?, status = ?, priority = ?, updated_at = ? WHERE id = ?')
        .run(
          args?.details !== undefined ? String(args.details).trim() : cur.description,
          args?.technologies !== undefined ? String(args.technologies).trim() : cur.technologies,
          status,
          args?.priority !== undefined ? cleanPriority(args.priority) : cur.priority,
          nowMs(),
          id,
        )
      return `Updated project "${name}".`
    },
  })

  tool({
    name: 'project_delete',
    description:
      'Delete a project and its tasks. DESTRUCTIVE — confirm out loud with the ' +
      'user first; the bridge requires a spoken yes.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: async (args) => {
      const id = projectId(args?.name)
      db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      return `Deleted the project "${String(args?.name).trim()}".`
    },
  })

  tool({
    name: 'task_create',
    description:
      'Add a task to a saved project. Use for "add a task to Jarvis: fix weather ' +
      'latency" and similar.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        task: { type: 'string' },
        status: { type: 'string', enum: [...TASK_STATUSES] },
        priority: { type: 'string', enum: [...PRIORITIES] },
        notes: { type: 'string' },
      },
      required: ['project', 'task'],
    },
    handler: async (args) => {
      const id = projectId(args?.project)
      const task = cleanText(args?.task, 'task')
      const tid = db
        .prepare('INSERT INTO project_tasks (project_id, task, status, priority, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, task, cleanStatus(args?.status, TASK_STATUSES, 'todo'), cleanPriority(args?.priority), String(args?.notes ?? '').trim(), nowMs(), nowMs())
        .lastInsertRowid
      return `Added task #${tid} to "${String(args?.project).trim()}": ${task}`
    },
  })

  tool({
    name: 'task_list',
    description: 'Open tasks for one project, or everything open across projects.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Optional project name.' },
        status: { type: 'string', description: 'Optional status filter (default open tasks).' },
      },
      required: [],
    },
    handler: async (args) => {
      const status = args?.status ? cleanStatus(args.status, TASK_STATUSES, 'todo') : null
      const project = args?.project ? String(args.project).trim() : null
      const whereProj = project ? 'p.name = ? AND ' : ''
      const whereStatus = status === null ? 't.status != ?' : 't.status = ?'
      const binds = []
      if (project) binds.push(project)
      binds.push(status === null ? 'done' : status)
      const rows = many(
        `SELECT t.*, p.name AS project FROM project_tasks t JOIN projects p ON p.id = t.project_id
         WHERE ${whereProj}${whereStatus} ORDER BY t.created_at LIMIT 40`,
        ...binds,
      )
      if (!rows.length) return 'No open tasks.'
      return rows.map((t) => `#${t.id} [${t.project}] ${t.task} (${t.priority}, ${t.status})`).join('\n')
    },
  })

  tool({
    name: 'task_update',
    description:
      'Change a task — mark done, change priority, add notes. Use for "mark the ' +
      'MCP task complete".',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        status: { type: 'string', enum: [...TASK_STATUSES] },
        priority: { type: 'string', enum: [...PRIORITIES] },
        notes: { type: 'string' },
        task: { type: 'string' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const id = Number(args?.id) || 0
      const cur = one('SELECT * FROM project_tasks WHERE id = ?', id)
      if (!cur) throw new Error('No task with that id.')
      if (args?.status !== undefined && !TASK_STATUSES.has(String(args.status).toLowerCase())) {
        throw new Error('Use status: todo, doing, done or blocked.')
      }
      const status = args?.status !== undefined ? String(args.status).toLowerCase() : cur.status
      db.prepare('UPDATE project_tasks SET task = ?, status = ?, priority = ?, notes = ?, updated_at = ?, completed_at = CASE WHEN ? = ? THEN ? ELSE completed_at END WHERE id = ?')
        .run(
          args?.task !== undefined ? cleanText(args.task, 'task') : cur.task,
          status,
          args?.priority !== undefined ? cleanPriority(args.priority) : cur.priority,
          args?.notes !== undefined ? String(args.notes).trim() : cur.notes,
          status, 'done', nowMs(),
          id,
        )
      return `Task #${id} is now ${status}.`
    },
  })

  tool({
    name: 'task_delete',
    description: 'Delete a task. DESTRUCTIVE — confirm before calling.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: async (args) => {
      const id = Number(args?.id) || 0
      const res = db.prepare('DELETE FROM project_tasks WHERE id = ?').run(id)
      if (!res.changes) throw new Error('No task with that id.')
      return `Deleted task #${id}.`
    },
  })

  return { tools }
}

export const memoryCategories = [...CATEGORIES]