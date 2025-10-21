import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { MongoClient } from 'mongodb';

const SESSION_COOKIE_NAME = 'cd_session';
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7; // 7 days

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, '../dist');

const projectRoot = path.resolve(__dirname, '..');

function applyEnvValue(key, rawValue) {
    if (!key) {
        return;
    }

    let value = rawValue.trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
        process.env[key] = value;
        return;
    }

    if (process.env[key] === value) {
        return;
    }

    process.env[key] = value;
}

function loadEnvFile(relativePath) {
    const resolvedPath = path.resolve(projectRoot, relativePath);

    if (!existsSync(resolvedPath)) {
        return false;
    }

    try {
        const contents = readFileSync(resolvedPath, 'utf-8');
        const lines = contents.split(/\r?\n/);

        for (const line of lines) {
            if (!line || line.trim().startsWith('#')) {
                continue;
            }

            const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);

            if (!match) {
                continue;
            }

            const [, key, rawValue] = match;
            applyEnvValue(key, rawValue ?? '');
        }

        return true;
    } catch (error) {
        console.warn(`[server] ไม่สามารถโหลดไฟล์ environment ${relativePath}:`, error.message);
        return false;
    }
}

// Load environment variables from standard local files before reading them.
const envSources = ['.env.local', '.env'];
for (const source of envSources) {
    loadEnvFile(source);
}

const PORT = Number(process.env.PORT || 4173);
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'chronicle_depths';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

let mongoClient = null;
let dbPromise = null;

async function connectToDatabase() {
    if (!MONGODB_URI) {
        throw new Error('MONGODB_URI is not configured');
    }

    if (!dbPromise) {
        dbPromise = (async () => {
            const client = new MongoClient(MONGODB_URI, {
                serverSelectionTimeoutMS: 5000
            });

            try {
                await client.connect();
                mongoClient = client;
                return client.db(MONGODB_DB_NAME);
            } catch (error) {
                await client.close().catch(() => {});
                throw error;
            }
        })();

        dbPromise.catch(() => {
            dbPromise = null;
        });
    }

    return dbPromise;
}

async function getCollections() {
    const db = await connectToDatabase();
    return {
        db,
        users: db.collection('users'),
        profiles: db.collection('user_profiles'),
        sessions: db.collection('sessions')
    };
}

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

function normalizeLower(value) {
    return value.trim().toLowerCase();
}

function normalizeDisplay(value) {
    return value.trim();
}

async function ensureSchema() {
    if (!MONGODB_URI) {
        console.warn('[server] MONGODB_URI ไม่ถูกตั้งค่า, ปิดใช้งาน API');
        return;
    }

    try {
        const { users, profiles, sessions } = await getCollections();

        await Promise.all([
            users.createIndex({ usernameLower: 1 }, { unique: true }),
            users.createIndex({ emailLower: 1 }, { unique: true }),
            profiles.createIndex({ userId: 1 }, { unique: true }),
            sessions.createIndex({ userId: 1 }),
            sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
        ]);
    } catch (error) {
        console.error('[server] failed to ensure MongoDB schema', error);
        throw error;
    }
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
    const { sessions } = await getCollections();
    const token = crypto.randomBytes(48).toString('hex');
    const hashed = hashSessionToken(token);
    const expiresAtDate = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000);

    await sessions.deleteMany({ userId });
    await sessions.insertOne({
        _id: hashed,
        userId,
        expiresAt: expiresAtDate,
        createdAt: new Date()
    });

    return { token, expiresAt: expiresAtDate.toISOString(), hashed };
}

async function getSessionFromRequest(req) {
    const cookies = parseCookies(req);
    const rawToken = cookies[SESSION_COOKIE_NAME];
    if (!rawToken) {
        return null;
    }

    const hashed = hashSessionToken(rawToken);
    const { sessions } = await getCollections();
    const sessionDoc = await sessions.findOne({ _id: hashed, expiresAt: { $gt: new Date() } });

    if (!sessionDoc) {
        return null;
    }

    return {
        token: rawToken,
        hashed,
        userId: sessionDoc.userId,
        expiresAt: sessionDoc.expiresAt instanceof Date ? sessionDoc.expiresAt.toISOString() : sessionDoc.expiresAt
    };
}

async function destroySession(hashedToken) {
    if (!hashedToken) return;
    const { sessions } = await getCollections();
    await sessions.deleteOne({ _id: hashedToken });
}

async function fetchSessionPayload(userId) {
    const { users, profiles } = await getCollections();

    const [userDoc, profileDoc] = await Promise.all([
        users.findOne({ _id: userId }),
        profiles.findOne({ userId })
    ]);

    if (!userDoc || !profileDoc) {
        return null;
    }

    return {
        user: {
            id: userDoc._id,
            username: userDoc.username,
            email: userDoc.email,
            createdAt: userDoc.createdAt
        },
        profile: {
            displayName: profileDoc.displayName,
            level: Number(profileDoc.level ?? 0),
            experience: Number(profileDoc.experience ?? 0),
            gold: Number(profileDoc.gold ?? 0),
            totalFarmSeconds: Number(profileDoc.totalFarmSeconds ?? 0),
            rarityFocus: profileDoc.rarityFocus,
            combatPower: Number(profileDoc.combatPower ?? 0),
            lastLogin: profileDoc.lastLogin ?? null
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

        let collections;
        try {
            collections = await getCollections();
        } catch (error) {
            console.error('[server] register database unavailable', error);
            return jsonResponse(res, 503, {
                success: false,
                message: 'เซิร์ฟเวอร์ยังไม่พร้อมให้บริการ ลองอีกครั้งภายหลัง'
            });
        }

        const { users, profiles } = collections;

        const hashedPassword = await hashPassword(password);
        const normalizedUsername = normalizeDisplay(username);
        const normalizedEmail = normalizeLower(email);
        const usernameLower = normalizedUsername.toLowerCase();
        const emailLower = normalizedEmail;
        const userId = crypto.randomUUID();
        const nowIso = new Date().toISOString();

        try {
            await users.insertOne({
                _id: userId,
                username: normalizedUsername,
                usernameLower,
                email: normalizedEmail,
                emailLower,
                password: hashedPassword,
                createdAt: nowIso,
                updatedAt: nowIso
            });

            await profiles.insertOne({
                userId,
                displayName: normalizedUsername,
                level: 1,
                experience: 0,
                gold: 2500,
                totalFarmSeconds: 0,
                rarityFocus: 'S',
                combatPower: 1200,
                lastLogin: null
            });
        } catch (error) {
            if (error?.code === 11000) {
                return jsonResponse(res, 409, {
                    success: false,
                    message: 'ชื่อผู้เล่นหรืออีเมลถูกใช้งานแล้ว'
                });
            }

            try {
                await users.deleteOne({ _id: userId });
            } catch (cleanupError) {
                console.warn('[server] failed to cleanup user after registration error', cleanupError);
            }

            throw error;
        }

        return jsonResponse(res, 201, {
            success: true,
            user: {
                id: userId,
                username: normalizedUsername,
                email: normalizedEmail,
                createdAt: nowIso
            }
        });
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

        let collections;
        try {
            collections = await getCollections();
        } catch (error) {
            console.error('[server] login database unavailable', error);
            return jsonResponse(res, 503, {
                success: false,
                message: 'เซิร์ฟเวอร์ยังไม่พร้อมให้บริการ ลองอีกครั้งภายหลัง'
            });
        }

        const { users, profiles } = collections;
        const normalizedIdentifier = normalizeLower(identifier);

        const user = await users.findOne({
            $or: [{ usernameLower: normalizedIdentifier }, { emailLower: normalizedIdentifier }]
        });

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

        const session = await createSession(user._id);

        await profiles.updateOne(
            { userId: user._id },
            { $set: { lastLogin: new Date().toISOString() } }
        );

        const sessionPayload = await fetchSessionPayload(user._id);

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

        if (!MONGODB_URI) {
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

async function shutdown() {
    if (mongoClient) {
        try {
            await mongoClient.close();
        } catch (error) {
            console.warn('[server] failed to close MongoDB client', error);
        }
    }
    server.close(() => process.exit(0));
}

['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.once(signal, () => {
        shutdown();
    });
});
