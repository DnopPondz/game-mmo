import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const PORT = Number(process.env.PORT || 4173);
const databaseUrl = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, '../dist');

const baseDbUrl = databaseUrl ? databaseUrl.replace('libsql://', 'https://') : null;
const pipelineUrl = baseDbUrl ? new URL('/v2/pipeline', baseDbUrl).toString() : null;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonResponse(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...corsHeaders
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

            return jsonResponse(res, 201, {
                success: true,
                user: {
                    id: newUser?.id,
                    username: newUser?.username,
                    email: newUser?.email,
                    createdAt: newUser?.created_at
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
