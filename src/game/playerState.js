const DEFAULT_STATUS = 'พร้อมออกล่า';
const MAX_STATUS_LENGTH = 120;
const VALID_ITEM_TIERS = ['G', 'F', 'D', 'C', 'A', 'S', 'ST', 'SP', 'OP', 'KO'];
const MAX_INVENTORY_ITEMS = 120;

const DEFAULT_STATE = {
    level: 1,
    experience: 0,
    expToNextLevel: 100,
    gold: 0,
    totalFarmSeconds: 0,
    status: DEFAULT_STATUS,
    inventory: []
};

const listeners = new Set();
let state = null;
let dirtyFields = new Set();
let syncTimer = null;
let inFlightPromise = null;
let lifecycleHandlersAttached = false;

function cloneInventory(items = []) {
    return items.map((item) => ({ ...item }));
}

function sanitizeNumeric(value, minimum, fallback) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }
    return Math.max(minimum, Math.floor(numericValue));
}

function sanitizeStatusValue(value) {
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
    const quantity = Number(rawItem.quantity);

    if (!VALID_ITEM_TIERS.includes(tier) || !label) {
        return null;
    }

    if (!Number.isFinite(quantity) || quantity < 0) {
        return null;
    }

    return {
        tier,
        label: label.slice(0, 80),
        quantity: Math.max(0, Math.floor(quantity))
    };
}

function sortInventory(items) {
    return [...items].sort((a, b) => {
        if (a.tier !== b.tier) {
            return a.tier.localeCompare(b.tier);
        }
        return a.label.localeCompare(b.label);
    });
}

function inventoriesEqual(current = [], next = []) {
    if (current.length !== next.length) {
        return false;
    }

    for (let i = 0; i < current.length; i++) {
        const curr = current[i];
        const nxt = next[i];
        if (!curr || !nxt) {
            return false;
        }
        if (curr.tier !== nxt.tier || curr.label !== nxt.label || curr.quantity !== nxt.quantity) {
            return false;
        }
    }

    return true;
}

function normalizeIncomingProfile(profile = {}) {
    const normalized = {
        ...DEFAULT_STATE
    };

    normalized.level = sanitizeNumeric(profile.level, 1, DEFAULT_STATE.level);
    normalized.experience = sanitizeNumeric(profile.experience, 0, DEFAULT_STATE.experience);
    normalized.expToNextLevel = sanitizeNumeric(profile.expToNextLevel, 1, DEFAULT_STATE.expToNextLevel);
    normalized.gold = sanitizeNumeric(profile.gold, 0, DEFAULT_STATE.gold);
    normalized.totalFarmSeconds = sanitizeNumeric(profile.totalFarmSeconds, 0, DEFAULT_STATE.totalFarmSeconds);
    normalized.status = sanitizeStatusValue(profile.status ?? DEFAULT_STATE.status);

    if (Array.isArray(profile.inventory)) {
        const items = profile.inventory
            .slice(0, MAX_INVENTORY_ITEMS)
            .map((item) => normalizeInventoryItem(item))
            .filter((item) => item !== null);
        normalized.inventory = sortInventory(items);
    } else {
        normalized.inventory = [];
    }

    return normalized;
}

function notify() {
    const snapshot = getPlayerState();
    listeners.forEach((listener) => {
        try {
            listener(snapshot);
        } catch (error) {
            console.error('[playerState] listener error', error);
        }
    });
}

function ensureLifecycleHandlers() {
    if (lifecycleHandlersAttached) {
        return;
    }

    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return;
    }

    window.addEventListener('beforeunload', () => {
        flushProfileUpdates({ suppressErrors: true, immediate: true });
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushProfileUpdates({ suppressErrors: true });
        }
    });

    lifecycleHandlersAttached = true;
}

function cancelSyncTimer() {
    if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
    }
}

export function initializePlayerState(profile) {
    state = normalizeIncomingProfile(profile);
    dirtyFields.clear();
    cancelSyncTimer();
    ensureLifecycleHandlers();
    notify();
}

export function resetPlayerState() {
    state = null;
    dirtyFields.clear();
    cancelSyncTimer();
    notify();
}

export function getPlayerState() {
    if (!state) {
        return null;
    }

    return {
        ...state,
        inventory: cloneInventory(state.inventory)
    };
}

export function subscribeToPlayerState(listener) {
    if (typeof listener !== 'function') {
        return () => {};
    }

    listeners.add(listener);

    try {
        listener(getPlayerState());
    } catch (error) {
        console.error('[playerState] listener error', error);
    }

    return () => {
        listeners.delete(listener);
    };
}

function markFieldDirty(field) {
    if (!dirtyFields) {
        dirtyFields = new Set();
    }
    dirtyFields.add(field);
}

function scheduleSync(immediate = false) {
    if (!state || !dirtyFields || dirtyFields.size === 0) {
        return;
    }

    cancelSyncTimer();

    const delay = immediate ? 0 : 2000;
    syncTimer = setTimeout(() => {
        syncTimer = null;
        flushProfileUpdates({ suppressErrors: true });
    }, delay);
}

export function updatePlayerState(partial, options = {}) {
    if (!state || !partial || typeof partial !== 'object') {
        return;
    }

    let changed = false;

    const numericFields = [
        { key: 'level', minimum: 1 },
        { key: 'experience', minimum: 0 },
        { key: 'expToNextLevel', minimum: 1 },
        { key: 'gold', minimum: 0 },
        { key: 'totalFarmSeconds', minimum: 0 }
    ];

    for (const field of numericFields) {
        if (!(field.key in partial)) {
            continue;
        }
        const sanitized = sanitizeNumeric(partial[field.key], field.minimum, state[field.key]);
        if (sanitized !== state[field.key]) {
            state[field.key] = sanitized;
            markFieldDirty(field.key);
            changed = true;
        }
    }

    if ('status' in partial) {
        const sanitizedStatus = sanitizeStatusValue(partial.status);
        if (sanitizedStatus !== state.status) {
            state.status = sanitizedStatus;
            markFieldDirty('status');
            changed = true;
        }
    }

    if ('inventory' in partial) {
        const inventoryItems = Array.isArray(partial.inventory)
            ? partial.inventory
                .slice(0, MAX_INVENTORY_ITEMS)
                .map((item) => normalizeInventoryItem(item))
                .filter((item) => item !== null)
            : [];
        const sortedInventory = sortInventory(inventoryItems);
        if (!inventoriesEqual(state.inventory, sortedInventory)) {
            state.inventory = sortedInventory;
            markFieldDirty('inventory');
            changed = true;
        }
    }

    if (!changed) {
        return;
    }

    notify();
    scheduleSync(Boolean(options.immediateSync));
}

export async function flushProfileUpdates({ immediate = false, suppressErrors = false } = {}) {
    if (immediate) {
        cancelSyncTimer();
    }

    if (!state || !dirtyFields || dirtyFields.size === 0) {
        if (inFlightPromise) {
            try {
                await inFlightPromise;
            } catch (error) {
                if (!suppressErrors) {
                    throw error;
                }
            }
        }
        return true;
    }

    if (inFlightPromise) {
        try {
            await inFlightPromise;
        } catch (error) {
            if (!suppressErrors) {
                throw error;
            }
        }

        if (!state || !dirtyFields || dirtyFields.size === 0) {
            return true;
        }
    }

    if (!state || !dirtyFields || dirtyFields.size === 0) {
        return true;
    }

    const fields = Array.from(dirtyFields);
    dirtyFields.clear();

    const payload = {};
    for (const field of fields) {
        if (!state) {
            break;
        }
        if (field === 'inventory') {
            payload.inventory = cloneInventory(state.inventory);
        } else {
            payload[field] = state[field];
        }
    }

    if (Object.keys(payload).length === 0) {
        return true;
    }

    const request = fetch('/api/profile', {
        method: 'PATCH',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    inFlightPromise = request;

    try {
        const response = await request;

        if (response.status === 401) {
            resetPlayerState();
            return false;
        }

        if (!response.ok) {
            throw new Error(`Profile sync failed: ${response.status}`);
        }

        const result = await response.json().catch(() => null);

        if (result?.profile && state) {
            state = normalizeIncomingProfile(result.profile);
            notify();
        }

        return true;
    } catch (error) {
        fields.forEach((field) => markFieldDirty(field));
        if (!suppressErrors) {
            throw error;
        }
        scheduleSync(false);
        return false;
    } finally {
        if (inFlightPromise === request) {
            inFlightPromise = null;
        }
    }
}
