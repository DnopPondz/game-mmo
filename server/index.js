import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const PORT = Number(process.env.PORT || 4173);
const databaseUrl = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

const SESSION_COOKIE_NAME = 'cd_session';
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7; // 7 days

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, '../dist');

const baseDbUrl = databaseUrl ? databaseUrl.replace('libsql://', 'https://') : null;
const pipelineUrl = baseDbUrl ? new URL('/v2/pipeline', baseDbUrl).toString() : null;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonResponse(res, statusCode, payload, additionalHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...corsHeaders,
        ...additionalHeaders
    });
    res.end(body);
}

function sqlEscape(value) {
    return `'${value.replace(/'/g, "''")}'`;
}

async function executeSql(sql) {
    if (!pipelineUrl || !authToken) {
        throw new Error('Database connection is not configured');
    }

    const response = await fetch(pipelineUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            requests: [
                {
                    type: 'execute',
                    stmt: { sql }
                }
            ]
        })
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        const message = payload?.message || 'Database request failed';
        throw new Error(message);
    }

    const result = payload?.results?.[0]?.result;

    if (!result) {
        throw new Error('Unexpected database response');
    }

    if (result.error) {
        const message = result.error?.message || 'Database error';
        const error = new Error(message);
        error.code = result.error?.code;
        throw error;
    }

    const columns = result.cols?.map((col) => col.name) ?? [];
    const rows = (result.rows ?? []).map((row) => {
        const record = {};
        row.forEach((value, index) => {
            record[columns[index]] = value?.value ?? null;
        });
        return record;
    });

    return {
        rows,
        rowsAffected: Number(result.rows_affected ?? 0)
    };
}

async function ensureSchema() {
    if (!pipelineUrl || !authToken) {
        console.warn('[server] TURSO_DATABASE_URL หรือ TURSO_AUTH_TOKEN ไม่ถูกตั้งค่า, ปิดใช้งาน API');
        return;
    }

    await executeSql(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            username TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )
    `);

    await executeSql(`
        CREATE TABLE IF NOT EXISTS user_profiles (
            user_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            level INTEGER NOT NULL DEFAULT 1,
            experience INTEGER NOT NULL DEFAULT 0,
            gold INTEGER NOT NULL DEFAULT 2500,
            total_farm_seconds INTEGER NOT NULL DEFAULT 0,
            rarity_focus TEXT NOT NULL DEFAULT 'S',
            combat_power INTEGER NOT NULL DEFAULT 1200,
            last_login TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    await executeSql(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    await executeSql(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`);
}

function validateRegistration({ username, email, password }) {
    const errors = {};

    if (!username || typeof username !== 'string' || username.trim().length < 3) {
        errors.username = 'กรุณากรอกชื่อผู้เล่นอย่างน้อย 3 ตัวอักษร';
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || typeof email !== 'string' || !emailRegex.test(email)) {
        errors.email = 'รูปแบบอีเมลไม่ถูกต้อง';
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
        errors.password = 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร';
    }

    return errors;
}

function validateLogin({ identifier, password }) {
    const errors = {};

    if (!identifier || typeof identifier !== 'string' || identifier.trim().length === 0) {
        errors.identifier = 'กรุณากรอกอีเมลหรือชื่อผู้เล่น';
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
        errors.password = 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร';
    }

    return errors;
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = await new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (err, derived) => {
            if (err) {
                reject(err);
            } else {
                resolve(derived);
            }
        });
    });

    return `${salt}:${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
    if (!storedHash || !storedHash.includes(':')) {
        return false;
    }

    const [salt, hashed] = storedHash.split(':');

    const derivedKey = await new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (err, derived) => {
            if (err) {
                reject(err);
            } else {
                resolve(derived);
            }
        });
    });

    const storedBuffer = Buffer.from(hashed, 'hex');
    if (storedBuffer.length !== derivedKey.length) {
        return false;
    }

    return crypto.timingSafeEqual(storedBuffer, derivedKey);
}

function hashSessionToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function buildSessionCookie(token, { maxAge = SESSION_DURATION_SECONDS, expired = false } = {}) {
    const encodedValue = encodeURIComponent(token ?? '');
    const parts = [`${SESSION_COOKIE_NAME}=${encodedValue}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];

    if (expired) {
        parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'Max-Age=0');
    } else {
        parts.push(`Max-Age=${maxAge}`);
    }

    if (process.env.NODE_ENV === 'production') {
        parts.push('Secure');
    }

    return parts.join('; ');
}

function clearSessionCookieHeader() {
    return buildSessionCookie('', { expired: true });
}

function createSessionCookieHeader(token) {
    return buildSessionCookie(token, { maxAge: SESSION_DURATION_SECONDS });
}

function parseCookies(req) {
    const header = req.headers.cookie;
    if (!header) {
        return {};
    }

    return header.split(';').reduce((acc, part) => {
        const [name, ...rest] = part.trim().split('=');
        acc[name] = decodeURIComponent(rest.join('='));
        return acc;
    }, {});
}

async function createSession(userId) {
    const token = crypto.randomBytes(48).toString('hex');
    const hashed = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000).toISOString();

    await executeSql(`DELETE FROM sessions WHERE user_id = ${sqlEscape(userId)}`);

    await executeSql(`
        INSERT INTO sessions (id, user_id, expires_at)
        VALUES (${sqlEscape(hashed)}, ${sqlEscape(userId)}, ${sqlEscape(expiresAt)})
    `);

    return { token, expiresAt, hashed };
}

async function getSessionFromRequest(req) {
    const cookies = parseCookies(req);
    const rawToken = cookies[SESSION_COOKIE_NAME];
    if (!rawToken) {
        return null;
    }

    const hashed = hashSessionToken(rawToken);
    const nowIso = new Date().toISOString();

    const result = await executeSql(`
        SELECT id, user_id, expires_at
        FROM sessions
        WHERE id = ${sqlEscape(hashed)} AND expires_at > ${sqlEscape(nowIso)}
        LIMIT 1
    `);

    const sessionRow = result.rows?.[0];
    if (!sessionRow) {
        return null;
    }

    return {
        token: rawToken,
        hashed,
        userId: sessionRow.user_id,
        expiresAt: sessionRow.expires_at
    };
}

async function destroySession(hashedToken) {
    if (!hashedToken) return;
    await executeSql(`DELETE FROM sessions WHERE id = ${sqlEscape(hashedToken)}`);
}

async function fetchSessionPayload(userId) {
    const result = await executeSql(`
        SELECT
            u.id,
            u.username,
            u.email,
            u.created_at,
            p.display_name,
            p.level,
            p.experience,
            p.gold,
            p.total_farm_seconds,
            p.rarity_focus,
            p.combat_power,
            p.last_login
        FROM users u
        INNER JOIN user_profiles p ON p.user_id = u.id
        WHERE u.id = ${sqlEscape(userId)}
        LIMIT 1
    `);

    const row = result.rows?.[0];
    if (!row) {
        return null;
    }

    return {
        user: {
            id: row.id,
            username: row.username,
            email: row.email,
            createdAt: row.created_at
        },
        profile: {
            displayName: row.display_name,
            level: Number(row.level ?? 0),
            experience: Number(row.experience ?? 0),
            gold: Number(row.gold ?? 0),
            totalFarmSeconds: Number(row.total_farm_seconds ?? 0),
            rarityFocus: row.rarity_focus,
            combatPower: Number(row.combat_power ?? 0),
            lastLogin: row.last_login
        }
    };
}

async function registerHandler(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        return res.end();
    }

    try {
        if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST, OPTIONS', ...corsHeaders });
            return res.end();
        }

        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });

        await new Promise((resolve, reject) => {
            req.on('end', resolve);
            req.on('error', reject);
        });

        let payload;
        try {
            payload = body ? JSON.parse(body) : {};
        } catch (error) {
            return jsonResponse(res, 400, {
                success: false,
                message: 'รูปแบบข้อมูลไม่ถูกต้อง'
            });
        }

        const { username, email, password } = payload;
        const validationErrors = validateRegistration({ username, email, password });

        if (Object.keys(validationErrors).length > 0) {
            return jsonResponse(res, 400, {
                success: false,
                errors: validationErrors
            });
        }

        if (!pipelineUrl || !authToken) {
            return jsonResponse(res, 503, {
                success: false,
                message: 'เซิร์ฟเวอร์ยังไม่พร้อมให้บริการ ลองอีกครั้งภายหลัง'
            });
        }

        const hashedPassword = await hashPassword(password);
        const normalizedUsername = username.trim();
        const normalizedEmail = email.trim().toLowerCase();

        try {
            const insertResult = await executeSql(`
                INSERT INTO users (username, email, password)
                VALUES (${sqlEscape(normalizedUsername)}, ${sqlEscape(normalizedEmail)}, ${sqlEscape(hashedPassword)})
                RETURNING id, username, email, created_at
            `);

            const newUser = insertResult.rows?.[0];

            if (!newUser?.id) {
                throw new Error('Failed to create user');
            }

            await executeSql(`
                INSERT INTO user_profiles (user_id, display_name)
                VALUES (${sqlEscape(newUser.id)}, ${sqlEscape(normalizedUsername)})
            `);

            return jsonResponse(res, 201, {
                success: true,
                user: {
                    id: newUser.id,
                    username: newUser.username,
                    email: newUser.email,
                    createdAt: newUser.created_at
                }
            });
        } catch (error) {
            if (error.message?.includes('UNIQUE') || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                return jsonResponse(res, 409, {
                    success: false,
                    message: 'ชื่อผู้เล่นหรืออีเมลถูกใช้งานแล้ว'
                });
            }

            throw error;
        }
    } catch (error) {
        console.error('[server] register error', error);
        return jsonResponse(res, 500, {
            success: false,
            message: 'ไม่สามารถลงทะเบียนได้ในขณะนี้'
        });
    }
}

async function loginHandler(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        return res.end();
    }

    try {
        if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST, OPTIONS', ...corsHeaders });
            return res.end();
        }

        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });

        await new Promise((resolve, reject) => {
            req.on('end', resolve);
            req.on('error', reject);
        });

        let payload;
        try {
            payload = body ? JSON.parse(body) : {};
        } catch (error) {
            return jsonResponse(res, 400, {
                success: false,
                message: 'รูปแบบข้อมูลไม่ถูกต้อง'
            });
        }

        const { identifier, password } = payload;
        const validationErrors = validateLogin({ identifier, password });

        if (Object.keys(validationErrors).length > 0) {
            return jsonResponse(res, 400, {
                success: false,
                errors: validationErrors
            });
        }

        if (!pipelineUrl || !authToken) {
            return jsonResponse(res, 503, {
                success: false,
                message: 'เซิร์ฟเวอร์ยังไม่พร้อมให้บริการ ลองอีกครั้งภายหลัง'
            });
        }

        const normalizedIdentifier = identifier.trim().toLowerCase();
        const userResult = await executeSql(`
            SELECT id, username, email, password
            FROM users
            WHERE lower(username) = ${sqlEscape(normalizedIdentifier)}
               OR lower(email) = ${sqlEscape(normalizedIdentifier)}
            LIMIT 1
        `);

        const user = userResult.rows?.[0];

        if (!user) {
            return jsonResponse(res, 401, {
                success: false,
                message: 'ไม่พบบัญชีผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'
            });
        }

        const passwordValid = await verifyPassword(password, user.password);

        if (!passwordValid) {
            return jsonResponse(res, 401, {
                success: false,
                message: 'ไม่พบบัญชีผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'
            });
        }

        const session = await createSession(user.id);
        await executeSql(`
            UPDATE user_profiles
            SET last_login = ${sqlEscape(new Date().toISOString())}
            WHERE user_id = ${sqlEscape(user.id)}
        `);

        const sessionPayload = await fetchSessionPayload(user.id);

        if (!sessionPayload) {
            await destroySession(session.hashed);
            return jsonResponse(res, 500, {
                success: false,
                message: 'ไม่สามารถสร้างเซสชันได้'
            }, {
                'Set-Cookie': clearSessionCookieHeader()
            });
        }

        return jsonResponse(res, 200, {
            success: true,
            session: sessionPayload
        }, {
            'Set-Cookie': createSessionCookieHeader(session.token)
        });
    } catch (error) {
        console.error('[server] login error', error);
        return jsonResponse(res, 500, {
            success: false,
            message: 'ไม่สามารถเข้าสู่ระบบได้ในขณะนี้'
        });
    }
}

async function logoutHandler(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        return res.end();
    }

    try {
        if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST, OPTIONS', ...corsHeaders });
            return res.end();
        }

        let session = null;
        try {
            session = await getSessionFromRequest(req);
        } catch (error) {
            console.error('[server] logout session lookup failed', error);
        }

        if (session?.hashed) {
            await destroySession(session.hashed);
        }

        return jsonResponse(res, 200, {
            success: true
        }, {
            'Set-Cookie': clearSessionCookieHeader()
        });
    } catch (error) {
        console.error('[server] logout error', error);
        return jsonResponse(res, 500, {
            success: false,
            message: 'ออกจากระบบไม่สำเร็จ'
        }, {
            'Set-Cookie': clearSessionCookieHeader()
        });
    }
}

async function sessionHandler(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        return res.end();
    }

    try {
        if (req.method !== 'GET') {
            res.writeHead(405, { Allow: 'GET, OPTIONS', ...corsHeaders });
            return res.end();
        }

        if (!pipelineUrl || !authToken) {
            return jsonResponse(res, 503, {
                success: false,
                message: 'เซิร์ฟเวอร์ยังไม่พร้อมให้บริการ'
            });
        }

        const session = await getSessionFromRequest(req);

        if (!session) {
            return jsonResponse(res, 401, {
                success: false,
                message: 'ยังไม่ได้เข้าสู่ระบบ'
            }, {
                'Set-Cookie': clearSessionCookieHeader()
            });
        }

        const sessionPayload = await fetchSessionPayload(session.userId);

        if (!sessionPayload) {
            await destroySession(session.hashed);
            return jsonResponse(res, 401, {
                success: false,
                message: 'ข้อมูลเซสชันไม่ถูกต้อง'
            }, {
                'Set-Cookie': clearSessionCookieHeader()
            });
        }

        return jsonResponse(res, 200, {
            success: true,
            session: sessionPayload
        });
    } catch (error) {
        console.error('[server] session error', error);
        return jsonResponse(res, 500, {
            success: false,
            message: 'ไม่สามารถตรวจสอบเซสชันได้'
        });
    }
}

async function serveStatic(req, res, pathname) {
    try {
        const filePath = path.join(distPath, pathname === '/' ? 'index.html' : pathname);
        const fileStats = await stat(filePath);

        if (fileStats.isDirectory()) {
            return serveStatic(req, res, path.join(pathname, 'index.html'));
        }

        const file = await readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(file);
    } catch (error) {
        if (pathname !== '/') {
            const indexFile = await readFile(path.join(distPath, 'index.html'));
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(indexFile);
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
    }
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/register') {
        return registerHandler(req, res);
    }

    if (url.pathname === '/api/login') {
        return loginHandler(req, res);
    }

    if (url.pathname === '/api/logout') {
        return logoutHandler(req, res);
    }

    if (url.pathname === '/api/session') {
        return sessionHandler(req, res);
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        return res.end();
    }

    return serveStatic(req, res, url.pathname);
});

ensureSchema()
    .then(() => {
        server.listen(PORT, () => {
            console.log(`[server] listening on http://localhost:${PORT}`);
        });
    })
    .catch((error) => {
        console.error('[server] failed to initialize database', error);
        server.listen(PORT, () => {
            console.log(`[server] listening on http://localhost:${PORT}`);
        });
    });
