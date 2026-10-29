const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { verifyTeamToken } = require('../middleware/auth');
const { loadTeamMember, requireTeamPermission } = require('../middleware/requireTeamPermission');
const agentStatus = require('../services/agentStatus');
const inquiryService = require('../services/inquiryService');

// Internal Team API. Every route: valid internal_team token (verifyTeamToken) → member
// row re-read and must be 'approved' (loadTeamMember) → the specific page permission
// (requireTeamPermission). Data is read with the service-role client, so each route
// selects explicit columns — never `*`, never a password — and only returns what its
// own module's Admin page shows.
router.use(verifyTeamToken, loadTeamMember);

const LIST_LIMIT = 1000;

const ok = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, code, error) => res.status(code).json({ success: false, data: null, error });
const handle = (label, fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        console.error(`[team] ${label} error:`, err);
        fail(res, 500, `Failed to load ${label}.`);
    }
};

const lower = (v) => String(v || '').trim().toLowerCase();
const CLOSED_INQUIRY_STATUSES = ['completed', 'closed', 'rejected', 'cancelled'];
const countBy = (rows, key) => rows.reduce((acc, r) => {
    const k = lower(r[key]) || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
}, {});

// ── Me / dashboard ──────────────────────────────────────────

// GET /api/team/me — the member's own profile and current permissions. The frontend
// rebuilds the sidebar from this, so Admin changes show up without re-login.
router.get('/me', (req, res) => {
    ok(res, req.teamMember);
});

// GET /api/team/summary — headline counts, only for modules the member can view.
router.get('/summary', handle('summary', async (req, res) => {
    const perms = req.teamMember.permissions;
    const tasks = {};
    const count = (table, apply) => {
        let q = supabase.from(table).select('id', { count: 'exact', head: true });
        if (apply) q = apply(q);
        return q.then(({ count: c, error }) => { if (error) throw error; return c || 0; });
    };
    if (perms.agents) {
        tasks.agents = Promise.all([count('agents'), count('agents', (q) => q.ilike('status', 'pending'))])
            .then(([total, pending]) => ({ total, pending }));
    }
    if (perms.customers) tasks.customers = count('customers').then((total) => ({ total }));
    if (perms.partners) tasks.partners = count('partners').then((total) => ({ total }));
    if (perms.products) tasks.products = count('products').then((total) => ({ total }));
    if (perms.inquiries) {
        tasks.inquiries = supabase.from('inquiries').select('status').limit(10000).then(({ data, error }) => {
            if (error) throw error;
            const rows = data || [];
            return { total: rows.length, open: rows.filter((r) => !CLOSED_INQUIRY_STATUSES.includes(lower(r.status))).length };
        });
    }
    if (perms.complaints) {
        tasks.complaints = supabase.from('complaints').select('user_id, user_role, is_admin, is_read, status')
            .order('created_at', { ascending: false }).limit(5000).then(({ data, error }) => {
                if (error) throw error;
                const rows = data || [];
                const threads = new Set(rows.map((r) => `${r.user_role}:${r.user_id}`));
                return { threads: threads.size, unread: rows.filter((r) => !r.is_admin && !r.is_read).length };
            });
    }
    const keys = Object.keys(tasks);
    const values = await Promise.all(keys.map((k) => tasks[k]));
    ok(res, Object.fromEntries(keys.map((k, i) => [k, values[i]])));
}));

// ── Agents ──────────────────────────────────────────────────

const AGENT_COLUMNS = 'id, name, email, phone, territory, status, profile_photo, residential_letter, created_at, last_active';

// GET /api/team/agents?status=pending|accepted|rejected|hold
router.get('/agents', requireTeamPermission('agents', 'view'), handle('agents', async (req, res) => {
    let q = supabase.from('agents').select(AGENT_COLUMNS).order('created_at', { ascending: false }).limit(LIST_LIMIT);
    const status = lower(req.query.status);
    // Same legacy aliases as the Admin Agents page: 'active' = accepted, 'suspended' = rejected.
    if (status === 'accepted') q = q.or('status.ilike.accepted,status.ilike.active');
    else if (status === 'rejected') q = q.or('status.ilike.rejected,status.ilike.suspended');
    else if (status) q = q.ilike('status', status);
    const { data, error } = await q;
    if (error) throw error;
    ok(res, data || []);
}));

// GET /api/team/agents/:id — agent plus activity counts.
router.get('/agents/:id', requireTeamPermission('agents', 'view'), handle('agent', async (req, res) => {
    const { data: agent, error } = await supabase.from('agents').select(AGENT_COLUMNS).eq('id', req.params.id).maybeSingle();
    if (error && error.code !== '22P02') throw error;
    if (!agent) return fail(res, 404, 'Agent not found.');
    const [{ count: visits, error: vErr }, { data: inquiries, error: iErr }] = await Promise.all([
        supabase.from('visits').select('id', { count: 'exact', head: true }).eq('agent_id', agent.id),
        supabase.from('inquiries').select('status').eq('agent_id', agent.id).limit(10000),
    ]);
    if (vErr) throw vErr;
    if (iErr) throw iErr;
    ok(res, {
        ...agent,
        stats: {
            visits: visits || 0,
            inquiries: (inquiries || []).length,
            open_inquiries: (inquiries || []).filter((r) => !CLOSED_INQUIRY_STATUSES.includes(lower(r.status))).length,
            inquiries_by_status: countBy(inquiries || [], 'status'),
        },
    });
}));

// PATCH /api/team/agents/:id/status { status } — same workflow as Admin's Agents page.
router.patch('/agents/:id/status', requireTeamPermission('agents', 'edit'), handle('agent status', async (req, res) => {
    const result = await agentStatus.setAgentStatus(req.params.id, req.body?.status, req.user);
    if (!result.ok) return fail(res, result.code, result.message);
    ok(res, result.data);
}));

// ── Customers ───────────────────────────────────────────────

const CUSTOMER_COLUMNS = 'id, business_name, owner_name, email, phone, address, business_type, status, created_at';

router.get('/customers', requireTeamPermission('customers', 'view'), handle('customers', async (req, res) => {
    const { data, error } = await supabase.from('customers').select(CUSTOMER_COLUMNS)
        .order('created_at', { ascending: false }).limit(LIST_LIMIT);
    if (error) throw error;
    ok(res, data || []);
}));

router.get('/customers/:id', requireTeamPermission('customers', 'view'), handle('customer', async (req, res) => {
    const { data: customer, error } = await supabase.from('customers').select(CUSTOMER_COLUMNS).eq('id', req.params.id).maybeSingle();
    if (error && error.code !== '22P02') throw error;
    if (!customer) return fail(res, 404, 'Customer not found.');
    const [{ data: inquiries, error: iErr }, { count: units, error: uErr }] = await Promise.all([
        supabase.from('inquiries').select('id, inquiry_no, type, status, created_at')
            .eq('customer_id', customer.id).order('created_at', { ascending: false }).limit(200),
        supabase.from('inquiry_items').select('id', { count: 'exact', head: true }).eq('customer_id', customer.id),
    ]);
    if (iErr) throw iErr;
    if (uErr) throw uErr;
    ok(res, {
        ...customer,
        stats: { inquiries: (inquiries || []).length, units: units || 0, inquiries_by_status: countBy(inquiries || [], 'status') },
        // Inquiry rows are included only when the member can also open Inquiries.
        inquiries: req.teamMember.permissions.inquiries ? inquiries || [] : undefined,
    });
}));

// ── Partners ────────────────────────────────────────────────

router.get('/partners', requireTeamPermission('partners', 'view'), handle('partners', async (req, res) => {
    const [{ data: partners, error }, { data: inquiries, error: iErr }] = await Promise.all([
        supabase.from('partners').select('id, business_name, owner_name, email, phone, address, status, created_at, stickers_total')
            .order('business_name').limit(LIST_LIMIT),
        supabase.from('inquiries').select('partner_id, status').not('partner_id', 'is', null).limit(10000),
    ]);
    if (error) throw error;
    if (iErr) throw iErr;
    const stats = {};
    (inquiries || []).forEach((r) => {
        const s = (stats[r.partner_id] ||= { inquiries: 0, completed: 0, open: 0 });
        s.inquiries += 1;
        if (lower(r.status) === 'completed') s.completed += 1;
        else if (!CLOSED_INQUIRY_STATUSES.includes(lower(r.status))) s.open += 1;
    });
    ok(res, (partners || []).map((p) => ({ ...p, stats: stats[p.id] || { inquiries: 0, completed: 0, open: 0 } })));
}));

// ── Products ────────────────────────────────────────────────

// These three return exactly what the shared Admin catalog pages load (pages/admin/
// Products.jsx, CategoryProducts.jsx, AdminProductDetail.jsx via api/productCatalog.js),
// so Internal Team renders the same pages read-only. Partner data is names only.
const CATEGORY_COLUMNS = 'id, name, description, image_url, is_active, created_at, updated_at';
const PRODUCT_COLUMNS = 'id, name, description, category, category_id, image_url, is_active, model_number, cat_no, specifications, created_at, updated_at';
const isBadId = (error) => error && error.code === '22P02';

/** { [key]: count } over rows' `key` column. */
const tally = (rows, key) => (rows || []).reduce((acc, r) => {
    if (r[key]) acc[r[key]] = (acc[r[key]] || 0) + 1;
    return acc;
}, {});

// GET /api/team/products/categories — category cards + product count per category.
router.get('/products/categories', requireTeamPermission('products', 'view'), handle('product categories', async (req, res) => {
    const [{ data: categories, error }, { data: products, error: pErr }] = await Promise.all([
        supabase.from('categories').select(CATEGORY_COLUMNS).order('created_at', { ascending: true }),
        supabase.from('products').select('id, category_id').limit(10000),
    ]);
    if (error) throw error;
    if (pErr) throw pErr;
    ok(res, { categories: categories || [], productCounts: tally(products, 'category_id') });
}));

// GET /api/team/products/categories/:categoryId — one category, its products, partner count per product.
router.get('/products/categories/:categoryId', requireTeamPermission('products', 'view'), handle('category products', async (req, res) => {
    const { categoryId } = req.params;
    const [{ data: category, error }, { data: products, error: pErr }] = await Promise.all([
        supabase.from('categories').select(CATEGORY_COLUMNS).eq('id', categoryId).maybeSingle(),
        supabase.from('products').select(PRODUCT_COLUMNS).eq('category_id', categoryId).order('created_at', { ascending: true }),
    ]);
    if (error && !isBadId(error)) throw error;
    if (pErr && !isBadId(pErr)) throw pErr;
    const ids = (products || []).map((p) => p.id);
    let assignedCounts = {};
    if (ids.length) {
        const { data: assigned, error: aErr } = await supabase.from('partner_products').select('product_id').in('product_id', ids);
        if (aErr) throw aErr;
        assignedCounts = tally(assigned, 'product_id');
    }
    ok(res, { category: category || null, products: category ? products || [] : [], assignedCounts });
}));

// GET /api/team/products/items/:productId — product detail + its category + assigned partners.
router.get('/products/items/:productId', requireTeamPermission('products', 'view'), handle('product', async (req, res) => {
    const { data: product, error } = await supabase.from('products').select(PRODUCT_COLUMNS).eq('id', req.params.productId).maybeSingle();
    if (error && !isBadId(error)) throw error;
    if (!product) return ok(res, { category: null, product: null, partners: [] });
    const [{ data: category, error: cErr }, { data: partners, error: aErr }] = await Promise.all([
        product.category_id
            ? supabase.from('categories').select(CATEGORY_COLUMNS).eq('id', product.category_id).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        supabase.from('partner_products').select('assigned_at, partners(id, business_name, owner_name)')
            .eq('product_id', product.id).order('assigned_at', { ascending: false }),
    ]);
    if (cErr) throw cErr;
    if (aErr) throw aErr;
    ok(res, { category: category || null, product, partners: (partners || []).filter((r) => r.partners) });
}));

// ── Inquiries ───────────────────────────────────────────────

const INQUIRY_COLUMNS = 'id, inquiry_no, type, status, priority, created_at, updated_at, follow_up_date, scheduled_date, performed_by, is_general_inquiry, customer_id, agent_id, partner_id, notes, rejection_reason, customers(business_name), agents(name, status), partners(business_name)';

// GET /api/team/inquiries — status filtering is done here case-insensitively, like the
// Admin InquiryList (server-side ilike on status is unreliable in this setup).
router.get('/inquiries', requireTeamPermission('inquiries', 'view'), handle('inquiries', async (req, res) => {
    let q = supabase.from('inquiries').select(INQUIRY_COLUMNS).order('created_at', { ascending: false }).limit(LIST_LIMIT);
    if (req.query.type) q = q.ilike('type', String(req.query.type));
    const { data, error } = await q;
    if (error) throw error;
    const status = lower(req.query.status);
    ok(res, status ? (data || []).filter((r) => lower(r.status) === status) : data || []);
}));

router.get('/inquiries/:id', requireTeamPermission('inquiries', 'view'), handle('inquiry', async (req, res) => {
    const { data: inquiry, error } = await supabase.from('inquiries').select(INQUIRY_COLUMNS).eq('id', req.params.id).maybeSingle();
    if (error && error.code !== '22P02') throw error;
    if (!inquiry) return fail(res, 404, 'Inquiry not found.');
    const canAssign = req.teamMember.permissions.inquiries.includes('assign');
    const [{ data: items, error: itemsErr }, { data: events, error: evErr }, agentsResult] = await Promise.all([
        supabase.from('inquiry_items')
            .select('id, serial_no, type, capacity, quantity, unit, price, system, system_type, condition, status, catalog_no, brand, expiry_date, validation_mode, created_at, products(name, model_number)')
            .eq('inquiry_id', inquiry.id).order('created_at', { ascending: true }),
        supabase.from('inquiry_events').select('id, event_type, from_status, to_status, actor_role, created_at')
            .eq('inquiry_id', inquiry.id).order('created_at', { ascending: true }),
        // Assignable agents (names only) are sent only to members who can assign.
        canAssign
            ? supabase.from('agents').select('id, name, status').or('status.ilike.accepted,status.ilike.active').order('name')
            : Promise.resolve({ data: undefined, error: null }),
    ]);
    if (itemsErr) throw itemsErr;
    if (evErr) throw evErr;
    if (agentsResult.error) throw agentsResult.error;
    ok(res, { ...inquiry, items: items || [], events: events || [], assignable_agents: agentsResult.data });
}));

// PUT /api/team/inquiries/:id/assign-agent { agent_id } — same rules as Admin's endpoint.
router.put('/inquiries/:id/assign-agent', requireTeamPermission('inquiries', 'assign'), handle('agent assignment', async (req, res) => {
    const result = await inquiryService.assignAgentToCustomerRequest(req.params.id, req.body?.agent_id, req.user);
    if (!result.ok) return fail(res, result.code, result.message);
    ok(res, result.data);
}));

// ── Complaints ──────────────────────────────────────────────

const COMPLAINT_ROLES = { agent: ['agents', 'name'], partner: ['partners', 'business_name'], customer: ['customers', 'business_name'] };

// GET /api/team/complaints — threads (one per user) plus analysis counts.
router.get('/complaints', requireTeamPermission('complaints', 'view'), handle('complaints', async (req, res) => {
    const { data, error } = await supabase.from('complaints')
        .select('user_id, user_role, message, is_admin, is_bot, status, is_read, created_at')
        .order('created_at', { ascending: false }).limit(5000);
    if (error) throw error;
    const rows = data || [];

    // user_id alone is ambiguous (agent 1 and customer 1 share it), so threads are keyed by role too.
    const threads = new Map();
    rows.forEach((r) => {
        const key = `${r.user_role}:${r.user_id}`;
        if (!threads.has(key)) {
            threads.set(key, { user_id: r.user_id, user_role: r.user_role, last_message: r.message, last_at: r.created_at, status: r.status || 'open', unread: 0, messages: 0 });
        }
        const t = threads.get(key);
        t.messages += 1;
        if (!r.is_admin && !r.is_read) t.unread += 1;
    });

    // Display names only — no other customer/agent/partner data leaves this module.
    const list = [...threads.values()];
    await Promise.all(Object.entries(COMPLAINT_ROLES).map(async ([role, [table, column]]) => {
        const ids = [...new Set(list.filter((t) => t.user_role === role).map((t) => t.user_id))];
        if (ids.length === 0) return;
        const { data: people } = await supabase.from(table).select(`id, ${column}`).in('id', ids);
        const names = new Map((people || []).map((p) => [String(p.id), p[column]]));
        list.forEach((t) => { if (t.user_role === role) t.name = names.get(String(t.user_id)) || null; });
    }));

    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const userMessages = rows.filter((r) => !r.is_admin && !r.is_bot);
    ok(res, {
        threads: list,
        stats: {
            threads: list.length,
            open: list.filter((t) => lower(t.status) !== 'closed').length,
            closed: list.filter((t) => lower(t.status) === 'closed').length,
            unread: list.reduce((n, t) => n + t.unread, 0),
            by_role: countBy(list, 'user_role'),
            messages_last_30_days: userMessages.filter((r) => new Date(r.created_at).getTime() >= since).length,
            bot_replies: rows.filter((r) => r.is_bot).length,
            admin_replies: rows.filter((r) => r.is_admin && !r.is_bot).length,
        },
    });
}));

const COMPLAINT_MESSAGE_COLUMNS = 'id, message, is_admin, is_bot, status, is_read, created_at';
const COMPLAINT_SENDER_COLUMNS = 'sender_team_member_id, sender_name, sender_designation';
// sender_* come from migration 20261026100000_complaint_team_replies.sql. Postgres
// 42703 / PostgREST PGRST204 = column doesn't exist, i.e. that migration isn't applied.
const isMissingSenderColumns = (error) => error && (error.code === '42703' || error.code === 'PGRST204');
const SENDER_MIGRATION_MISSING = 'Complaint replies are not set up yet: run migration 20261026100000_complaint_team_replies.sql.';

// GET /api/team/complaints/:role/:userId — one conversation, oldest first.
router.get('/complaints/:role/:userId', requireTeamPermission('complaints', 'view'), handle('complaint thread', async (req, res) => {
    const role = lower(req.params.role);
    if (!COMPLAINT_ROLES[role]) return fail(res, 400, 'Unknown complaint role.');
    const query = (columns) => supabase.from('complaints')
        .select(columns)
        .eq('user_role', role).eq('user_id', String(req.params.userId))
        .order('created_at', { ascending: true }).limit(2000);
    let { data, error } = await query(`${COMPLAINT_MESSAGE_COLUMNS}, ${COMPLAINT_SENDER_COLUMNS}`);
    // Reading still works without the migration — there are simply no team senders yet.
    if (isMissingSenderColumns(error)) ({ data, error } = await query(COMPLAINT_MESSAGE_COLUMNS));
    if (error) throw error;
    ok(res, data || []);
}));

const MAX_REPLY_LENGTH = 4000;

// POST /api/team/complaints/:role/:userId/replies { message }
// Same complaints row shape as an Admin reply (is_admin = true: support side), plus the
// sender's identity — taken from the authenticated member (req.teamMember), never from
// the request body.
router.post('/complaints/:role/:userId/replies', requireTeamPermission('complaints', 'reply'), handle('complaint reply', async (req, res) => {
    const role = lower(req.params.role);
    const userId = String(req.params.userId);
    if (!COMPLAINT_ROLES[role]) return fail(res, 400, 'Unknown complaint role.');
    const message = String(req.body?.message || '').trim();
    if (!message) return fail(res, 400, 'Message is required.');
    if (message.length > MAX_REPLY_LENGTH) return fail(res, 400, `Message must be at most ${MAX_REPLY_LENGTH} characters.`);

    // Replies go only into conversations the user actually started.
    const { data: existing, error: threadErr } = await supabase.from('complaints')
        .select('id').eq('user_role', role).eq('user_id', userId).eq('is_admin', false).limit(1);
    if (threadErr) throw threadErr;
    if (!existing || existing.length === 0) return fail(res, 404, 'Complaint conversation not found.');

    const member = req.teamMember;
    const { data, error } = await supabase.from('complaints')
        .insert({
            user_id: userId,
            user_role: role,
            message,
            is_admin: true,
            is_bot: false,
            sender_team_member_id: member.id,
            sender_name: member.name,
            sender_designation: member.designation || null,
        })
        .select(`${COMPLAINT_MESSAGE_COLUMNS}, ${COMPLAINT_SENDER_COLUMNS}`)
        .single();
    // Never fall back to a reply without the sender — it would show up as "Admin".
    if (isMissingSenderColumns(error)) return fail(res, 503, SENDER_MIGRATION_MISSING);
    if (error) throw error;
    res.status(201).json({ success: true, data, error: null });
}));

module.exports = router;
