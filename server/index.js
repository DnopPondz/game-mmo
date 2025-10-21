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

function buildCorsHeaders(req) {
    const origin = req.headers.origin;
    const headers = {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (origin) {
        headers['Access-Control-Allow-Credentials'] = 'true';
        headers['Vary'] = 'Origin';
    }

    return headers;
}

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

function jsonResponse(req, res, statusCode, payload, additionalHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...buildCorsHeaders(req),
        ...additionalHeaders
    });
    res.end(body);
}

const VALID_ITEM_TIERS = new Set(['G', 'F', 'D', 'C', 'A', 'S', 'ST', 'SP', 'OP', 'KO']);
const DEFAULT_STATUS = 'พร้อมออกล่า';
const MAX_STATUS_LENGTH = 120;
const MAX_INVENTORY_ITEMS = 120;

function sanitizeStatus(value) {
    if (typeof value !== 'string') {
        return DEFAULT_STATUS;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return DEFAULT_STATUS;
    }

    return trimmed.slice(0, MAX_STATUS_LENGTH);
}

function normalizeInventoryItem(rawItem) {
    if (!rawItem || typeof rawItem !== 'object') {
        return null;
    }

    const tier = typeof rawItem.tier === 'string' ? rawItem.tier.trim().toUpperCase() : '';
    const label = typeof rawItem.label === 'string' ? rawItem.label.trim() : '';
    const quantityNumber = Number(rawItem.quantity);

    if (!VALID_ITEM_TIERS.has(tier) || !label) {
        return null;
    }

    if (!Number.isFinite(quantityNumber) || quantityNumber < 0) {
        return null;
    }

    const quantity = Math.max(0, Math.floor(quantityNumber));

    return {
        tier,
        label: label.slice(0, 80),
        quantity
    };
}

function normalizeProfileDocument(profileDoc, fallbackDisplayName = '') {
    if (!profileDoc) {
        return null;
    }

    const rawLevel = Number(profileDoc.level);
    const rawExperience = Number(profileDoc.experience);
    const rawExpToNext = Number(profileDoc.expToNextLevel);
    const rawGold = Number(profileDoc.gold);
    const rawCombatPower = Number(profileDoc.combatPower);
    const rawFarmSeconds = Number(profileDoc.totalFarmSeconds);

    const inventory = Array.isArray(profileDoc.inventory)
        ? profileDoc.inventory
            .map(normalizeInventoryItem)
            .filter((item) => item !== null)
        : [];

    const lastLoginValue = profileDoc.lastLogin instanceof Date
        ? profileDoc.lastLogin.toISOString()
        : profileDoc.lastLogin ?? null;

    const updatedAtValue = profileDoc.updatedAt instanceof Date
        ? profileDoc.updatedAt.toISOString()
        : profileDoc.updatedAt ?? null;

    return {
        displayName: typeof profileDoc.displayName === 'string' && profileDoc.displayName.trim()
            ? normalizeDisplay(profileDoc.displayName)
            : fallbackDisplayName,
        level: Number.isFinite(rawLevel) ? Math.max(1, Math.floor(rawLevel)) : 1,
        experience: Number.isFinite(rawExperience) ? Math.max(0, Math.floor(rawExperience)) : 0,
        expToNextLevel: Number.isFinite(rawExpToNext) ? Math.max(1, Math.floor(rawExpToNext)) : 100,
        gold: Number.isFinite(rawGold) ? Math.max(0, Math.floor(rawGold)) : 0,
        totalFarmSeconds: Number.isFinite(rawFarmSeconds) ? Math.max(0, Math.floor(rawFarmSeconds)) : 0,
        rarityFocus: typeof profileDoc.rarityFocus === 'string' && profileDoc.rarityFocus.trim()
            ? profileDoc.rarityFocus.trim().slice(0, 8)
            : 'S',
        combatPower: Number.isFinite(rawCombatPower) ? Math.max(0, Math.floor(rawCombatPower)) : 0,
        status: sanitizeStatus(profileDoc.status),
        inventory,
        lastLogin: lastLoginValue,
        updatedAt: updatedAtValue
    };
}

function parseProfileUpdatePayload(payload) {
    const updates = {};
    const errors = {};

    if (!payload || typeof payload !== 'object') {
        errors.payload = 'ข้อมูลไม่ถูกต้อง';
        return { updates, errors };
    }

    const numericRules = [
        { field: 'level', minimum: 1 },
        { field: 'experience', minimum: 0 },
        { field: 'expToNextLevel', minimum: 1 },
        { field: 'gold', minimum: 0 },
        { field: 'totalFarmSeconds', minimum: 0 }
    ];

    for (const rule of numericRules) {
        if (!(rule.field in payload)) {
            continue;
        }

        const numericValue = Number(payload[rule.field]);
        if (!Number.isFinite(numericValue) || numericValue < rule.minimum) {
            errors[rule.field] = 'ค่าต้องเป็นตัวเลขที่ถูกต้อง';
            continue;
        }

        updates[rule.field] = Math.max(rule.minimum, Math.floor(numericValue));
    }

    if ('status' in payload) {
        if (typeof payload.status !== 'string' || !payload.status.trim()) {
            errors.status = 'สถานะต้องเป็นข้อความ';
        } else {
            updates.status = sanitizeStatus(payload.status);
        }
    }

    if ('inventory' in payload) {
        if (!Array.isArray(payload.inventory)) {
            errors.inventory = 'รูปแบบคลังไอเทมไม่ถูกต้อง';
        } else {
            const sanitizedItems = [];
            for (const rawItem of payload.inventory.slice(0, MAX_INVENTORY_ITEMS)) {
                const normalized = normalizeInventoryItem(rawItem);
                if (!normalized) {
                    errors.inventory = 'รูปแบบคลังไอเทมไม่ถูกต้อง';
                    break;
                }
                sanitizedItems.push(normalized);
            }

            if (!errors.inventory) {
                updates.inventory = sanitizedItems;
            }
        }
    }

    return { updates, errors };
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

    const normalizedProfile = normalizeProfileDocument(profileDoc, userDoc.username);

    if (!normalizedProfile) {
        return null;
    }

    return {
        user: {
            id: userDoc._id,
            username: userDoc.username,
            email: userDoc.email,
            createdAt: userDoc.createdAt
        },
        profile: normalizedProfile
    };
}

async function registerHandler(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...buildCorsHeaders(req), 'Content-Length': 0 });
        return res.end();
    }

    try {
        if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST, OPTIONS', ...buildCorsHeaders(req) });
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
            return jsonResponse(req, res, 400, {
                success: false,
                message: 'รูปแบบข้อมูลไม่ถูกต้อง'
            });
        }

        const { username, email, password } = payload;
        const validationErrors = validateRegistration({ username, email, password });

        if (Object.keys(validationErrors).length > 0) {
            return jsonResponse(req, res, 400, {
                success: false,
                errors: validationErrors
            });
        }

        let collections;
        try {
            collections = await getCollections();
        } catch (error) {
            console.error('[server] register database unavailable', error);
            return jsonResponse(req, res, 503, {
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
                expToNextLevel: 100,
                gold: 2500,
                totalFarmSeconds: 0,
                rarityFocus: 'S',
                combatPower: 1200,
                status: DEFAULT_STATUS,
                inventory: [],
                lastLogin: null,
                createdAt: nowIso,
                updatedAt: nowIso
            });
        } catch (error) {
            if (error?.code === 11000) {
                return jsonResponse(req, res, 409, {
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

        return jsonResponse(req, res, 201, {
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
        return jsonResponse(req, res, 500, {
            success: false,
            message: 'ไม่สามารถลงทะเบียนได้ในขณะนี้'
        });
    }
}

async function loginHandler(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...buildCorsHeaders(req), 'Content-Length': 0 });
        return res.end();
    }

    try {
        if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST, OPTIONS', ...buildCorsHeaders(req) });
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
            return jsonResponse(req, res, 400, {
                success: false,
                message: 'รูปแบบข้อมูลไม่ถูกต้อง'
            });
        }

        const { identifier, password } = payload;
        const validationErrors = validateLogin({ identifier, password });

        if (Object.keys(validationErrors).length > 0) {
            return jsonResponse(req, res, 400, {
                success: false,
                errors: validationErrors
            });
        }

        let collections;
        try {
            collections = await getCollections();
        } catch (error) {
            console.error('[server] login database unavailable', error);
            return jsonResponse(req, res, 503, {
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
            return jsonResponse(req, res, 401, {
                success: false,
                message: 'ไม่พบบัญชีผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'
            });
        }

        const passwordValid = await verifyPassword(password, user.password);

        if (!passwordValid) {
            return jsonResponse(req, res, 401, {
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
            return jsonResponse(req, res, 500, {
                success: false,
                message: 'ไม่สามารถสร้างเซสชันได้'
            }, {
                'Set-Cookie': clearSessionCookieHeader()
            });
        }

        return jsonResponse(req, res, 200, {
            success: true,
            session: sessionPayload
        }, {
            'Set-Cookie': createSessionCookieHeader(session.token)
        });
    } catch (error) {
        console.error('[server] login error', error);
        return jsonResponse(req, res, 500, {
            success: false,
            message: 'ไม่สามารถเข้าสู่ระบบได้ในขณะนี้'
        });
    }
}

async function logoutHandler(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...buildCorsHeaders(req), 'Content-Length': 0 });
        return res.end();
    }

    try {
        if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST, OPTIONS', ...buildCorsHeaders(req) });
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

        return jsonResponse(req, res, 200, {
            success: true
        }, {
            'Set-Cookie': clearSessionCookieHeader()
        });
    } catch (error) {
        console.error('[server] logout error', error);
        return jsonResponse(req, res, 500, {
            success: false,
            message: 'ออกจากระบบไม่สำเร็จ'
        }, {
            'Set-Cookie': clearSessionCookieHeader()
        });
    }
}

async function sessionHandler(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...buildCorsHeaders(req), 'Content-Length': 0 });
        return res.end();
    }

    try {
        if (req.method !== 'GET') {
            res.writeHead(405, { Allow: 'GET, OPTIONS', ...buildCorsHeaders(req) });
            return res.end();
        }

        if (!MONGODB_URI) {
            return jsonResponse(req, res, 503, {
                success: false,
                message: 'เซิร์ฟเวอร์ยังไม่พร้อมให้บริการ'
            });
        }

        const session = await getSessionFromRequest(req);

        if (!session) {
            return jsonResponse(req, res, 401, {
                success: false,
                message: 'ยังไม่ได้เข้าสู่ระบบ'
            }, {
                'Set-Cookie': clearSessionCookieHeader()
            });
        }

        const sessionPayload = await fetchSessionPayload(session.userId);

        if (!sessionPayload) {
            await destroySession(session.hashed);
            return jsonResponse(req, res, 401, {
                success: false,
                message: 'ข้อมูลเซสชันไม่ถูกต้อง'
            }, {
                'Set-Cookie': clearSessionCookieHeader()
            });
        }

        return jsonResponse(req, res, 200, {
            success: true,
            session: sessionPayload
        });
    } catch (error) {
        console.error('[server] session error', error);
        return jsonResponse(req, res, 500, {
            success: false,
            message: 'ไม่สามารถตรวจสอบเซสชันได้'
        });
    }
}

async function profileHandler(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...buildCorsHeaders(req), 'Content-Length': 0 });
        return res.end();
    }

    if (req.method !== 'GET' && req.method !== 'PATCH') {
        res.writeHead(405, { Allow: 'GET, PATCH, OPTIONS', ...buildCorsHeaders(req) });
        return res.end();
    }

    let session = null;

    try {
        session = await getSessionFromRequest(req);
    } catch (error) {
        console.error('[server] profile session lookup failed', error);
    }

    if (!session) {
        return jsonResponse(req, res, 401, {
            success: false,
            message: 'ยังไม่ได้เข้าสู่ระบบ'
        }, {
            'Set-Cookie': clearSessionCookieHeader()
        });
    }

    if (req.method === 'GET') {
        try {
            const payload = await fetchSessionPayload(session.userId);

            if (!payload) {
                return jsonResponse(req, res, 404, {
                    success: false,
                    message: 'ไม่พบโปรไฟล์'
                });
            }

            return jsonResponse(req, res, 200, {
                success: true,
                profile: payload.profile
            });
        } catch (error) {
            console.error('[server] profile fetch error', error);
            return jsonResponse(req, res, 500, {
                success: false,
                message: 'ไม่สามารถดึงข้อมูลโปรไฟล์ได้'
            });
        }
    }

    let body = '';
    req.on('data', (chunk) => {
        body += chunk;
    });

    try {
        await new Promise((resolve, reject) => {
            req.on('end', resolve);
            req.on('error', reject);
        });
    } catch (error) {
        console.error('[server] profile update stream error', error);
        return jsonResponse(req, res, 500, {
            success: false,
            message: 'ไม่สามารถอัปเดตโปรไฟล์ได้'
        });
    }

    let payload;
    try {
        payload = body ? JSON.parse(body) : {};
    } catch (error) {
        return jsonResponse(req, res, 400, {
            success: false,
            message: 'รูปแบบข้อมูลไม่ถูกต้อง'
        });
    }

    const { updates, errors } = parseProfileUpdatePayload(payload);

    if (Object.keys(errors).length > 0) {
        return jsonResponse(req, res, 400, {
            success: false,
            errors
        });
    }

    if (Object.keys(updates).length === 0) {
        return jsonResponse(req, res, 400, {
            success: false,
            message: 'ไม่มีข้อมูลสำหรับอัปเดต'
        });
    }

    let collections;
    try {
        collections = await getCollections();
    } catch (error) {
        console.error('[server] profile update database unavailable', error);
        return jsonResponse(req, res, 503, {
            success: false,
            message: 'เซิร์ฟเวอร์ยังไม่พร้อมให้บริการ ลองอีกครั้งภายหลัง'
        });
    }

    const { profiles } = collections;

    try {
        const updatePayload = {
            ...updates,
            updatedAt: new Date().toISOString()
        };

        const result = await profiles.updateOne({ userId: session.userId }, { $set: updatePayload });

        if (!result.matchedCount) {
            return jsonResponse(req, res, 404, {
                success: false,
                message: 'ไม่พบโปรไฟล์'
            });
        }

        const payload = await fetchSessionPayload(session.userId);

        if (!payload) {
            return jsonResponse(req, res, 404, {
                success: false,
                message: 'ไม่พบโปรไฟล์'
            });
        }

        return jsonResponse(req, res, 200, {
            success: true,
            profile: payload.profile
        });
    } catch (error) {
        console.error('[server] profile update error', error);
        return jsonResponse(req, res, 500, {
            success: false,
            message: 'ไม่สามารถอัปเดตโปรไฟล์ได้'
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

    if (url.pathname === '/api/profile') {
        return profileHandler(req, res);
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...buildCorsHeaders(req), 'Content-Length': 0 });
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
