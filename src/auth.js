import { createGameInstance, destroyGameInstance } from './game/main';
import { initializePlayerState, resetPlayerState, flushProfileUpdates } from './game/playerState';

const ENDPOINTS = {
    session: '/api/session',
    login: '/api/login',
    logout: '/api/logout'
};

function toggleOverlay(overlay, shouldShow) {
    if (!overlay) return;
    overlay.classList.toggle('hidden', !shouldShow);
    overlay.classList.toggle('flex', shouldShow);
    if (shouldShow) {
        overlay.focus({ preventScroll: false });
    }
}

function updateStatus(element, type, message) {
    if (!element) return;

    if (!message) {
        element.classList.add('hidden');
        element.textContent = '';
        element.dataset.state = '';
        return;
    }

    element.dataset.state = type;
    element.textContent = message;
    element.classList.remove('hidden');
}

function clearFieldErrors(elements) {
    Object.values(elements).forEach((element) => {
        if (!element) return;
        element.textContent = '';
        element.classList.add('hidden');
    });
}

function showFieldErrors(elements, errors) {
    Object.entries(errors).forEach(([field, message]) => {
        const element = elements[field];
        if (!element) return;
        element.textContent = message;
        element.classList.remove('hidden');
    });
}

function formatNumber(value) {
    return new Intl.NumberFormat('th-TH').format(Number(value || 0));
}

function formatDuration(totalSeconds = 0) {
    const seconds = Number(totalSeconds || 0);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = Math.floor(seconds % 60);
    return [hours, minutes, remaining]
        .map((value) => value.toString().padStart(2, '0'))
        .join(':');
}

function formatDate(isoDate) {
    if (!isoDate) return '—';
    try {
        const date = new Date(isoDate);
        return new Intl.DateTimeFormat('th-TH', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }).format(date);
    } catch (error) {
        return '—';
    }
}

export default function initializeAuth() {
    const loginOverlay = document.getElementById('login-overlay');
    const loginForm = document.getElementById('login-form');
    const loginStatus = loginForm?.querySelector('[data-login-status]');
    const loginSubmit = loginForm?.querySelector('button[type="submit"]');
    const loginErrorElements = {
        identifier: loginForm?.querySelector('[data-error-for="identifier"]'),
        password: loginForm?.querySelector('[data-error-for="password"]')
    };

    const privateSections = document.querySelectorAll('[data-auth-section="private"]');
    const guestSections = document.querySelectorAll('[data-auth-section="guest"]');
    const authVisibility = document.querySelectorAll('[data-auth-visible]');
    const openLoginButtons = document.querySelectorAll('[data-open-login]');
    const closeLoginButtons = document.querySelectorAll('[data-close-login]');
    const logoutButtons = document.querySelectorAll('[data-logout]');
    const switchToRegisterButtons = document.querySelectorAll('[data-switch-to-register]');

    const profileTargets = {
        displayName: document.querySelector('[data-profile-field="displayName"]'),
        username: document.querySelector('[data-profile-field="username"]'),
        email: document.querySelector('[data-profile-field="email"]'),
        level: document.querySelector('[data-profile-field="level"]'),
        experience: document.querySelector('[data-profile-field="experience"]'),
        combatPower: document.querySelector('[data-profile-field="combatPower"]'),
        farmTime: document.querySelector('[data-profile-field="farmTime"]'),
        gold: document.querySelector('[data-profile-field="gold"]'),
        rarityFocus: document.querySelector('[data-profile-field="rarityFocus"]'),
        status: document.querySelector('[data-profile-field="status"]'),
        lastLogin: document.querySelector('[data-profile-field="lastLogin"]')
    };

    const inventoryList = document.querySelector('[data-profile-inventory]');
    const inventoryPreviewLimit = Number(inventoryList?.dataset.maxItems ?? 6);

    const headerUsername = document.querySelector('[data-auth-username]');

    function renderInventory(items = []) {
        if (!inventoryList) {
            return;
        }

        inventoryList.innerHTML = '';

        if (!items || items.length === 0) {
            const emptyItem = document.createElement('li');
            emptyItem.className = 'text-xs text-white/40';
            emptyItem.textContent = inventoryList.dataset.emptyLabel || 'ยังไม่มีไอเทม';
            inventoryList.appendChild(emptyItem);
            return;
        }

        const limit = Number.isFinite(inventoryPreviewLimit) && inventoryPreviewLimit > 0
            ? Math.floor(inventoryPreviewLimit)
            : 6;

        const displayItems = items.slice(0, limit);

        displayItems.forEach((item) => {
            const row = document.createElement('li');
            row.className = 'flex items-center justify-between rounded-xl border border-white/5 bg-slate-900/60 px-3 py-2 text-xs';

            const label = document.createElement('span');
            label.className = 'font-semibold text-slate-200';
            label.textContent = `${item.tier} • ${item.label}`;

            const quantity = document.createElement('span');
            quantity.className = 'text-azure/70';
            quantity.textContent = `x${formatNumber(item.quantity)}`;

            row.appendChild(label);
            row.appendChild(quantity);

            inventoryList.appendChild(row);
        });

        if (items.length > displayItems.length) {
            const remaining = items.length - displayItems.length;
            const summary = document.createElement('li');
            summary.className = 'text-[0.65rem] uppercase tracking-[0.3em] text-white/40';
            summary.textContent = `+${formatNumber(remaining)} รายการ`;
            inventoryList.appendChild(summary);
        }
    }

    function applyAuthVisibility(isAuthenticated) {
        privateSections.forEach((section) => {
            section.classList.toggle('hidden', !isAuthenticated);
        });

        guestSections.forEach((section) => {
            section.classList.toggle('hidden', isAuthenticated);
        });

        authVisibility.forEach((element) => {
            const state = element.dataset.authVisible;
            if (state === 'authenticated') {
                element.classList.toggle('hidden', !isAuthenticated);
            } else if (state === 'guest') {
                element.classList.toggle('hidden', isAuthenticated);
            }
        });
    }

    function resetProfile() {
        Object.values(profileTargets).forEach((element) => {
            if (!element) return;
            element.textContent = element.dataset.placeholder ?? '—';
        });
        if (headerUsername) {
            headerUsername.textContent = '';
        }
        renderInventory([]);
    }

    function updateProfile(session) {
        const { user, profile } = session ?? {};
        if (!user || !profile) {
            resetProfile();
            return;
        }

        if (profileTargets.displayName) {
            profileTargets.displayName.textContent = profile.displayName || user.username;
        }
        if (profileTargets.username) {
            profileTargets.username.textContent = user.username;
        }
        if (profileTargets.email) {
            profileTargets.email.textContent = user.email;
        }
        if (profileTargets.level) {
            profileTargets.level.textContent = formatNumber(profile.level);
        }
        if (profileTargets.experience) {
            profileTargets.experience.textContent = `${formatNumber(profile.experience)} / ${formatNumber(profile.expToNextLevel)}`;
        }
        if (profileTargets.combatPower) {
            profileTargets.combatPower.textContent = formatNumber(profile.combatPower);
        }
        if (profileTargets.farmTime) {
            profileTargets.farmTime.textContent = formatDuration(profile.totalFarmSeconds);
        }
        if (profileTargets.gold) {
            profileTargets.gold.textContent = formatNumber(profile.gold);
        }
        if (profileTargets.rarityFocus) {
            profileTargets.rarityFocus.textContent = profile.rarityFocus || 'S';
        }
        if (profileTargets.status) {
            profileTargets.status.textContent = profile.status || profileTargets.status.dataset.placeholder || '—';
        }
        if (profileTargets.lastLogin) {
            profileTargets.lastLogin.textContent = formatDate(profile.lastLogin);
        }
        if (headerUsername) {
            headerUsername.textContent = user.username;
        }
        renderInventory(Array.isArray(profile.inventory) ? profile.inventory : []);
    }

    async function activateGameplay(session) {
        if (session) {
            initializePlayerState(session.profile);
            createGameInstance('game-container');
        } else {
            await flushProfileUpdates({ suppressErrors: true, immediate: true });
            destroyGameInstance();
            resetPlayerState();
        }
    }

    async function applySession(session) {
        const isAuthenticated = Boolean(session?.user && session?.profile);
        applyAuthVisibility(isAuthenticated);
        if (isAuthenticated) {
            updateProfile(session);
        } else {
            resetProfile();
        }
        await activateGameplay(isAuthenticated ? session : null);
    }

    async function fetchSession() {
        try {
            const response = await fetch(ENDPOINTS.session, {
                method: 'GET',
                credentials: 'include'
            });
            if (!response.ok) {
                throw new Error('unauthorized');
            }
            const result = await response.json();
            await applySession(result?.session ?? null);
        } catch (error) {
            await applySession(null);
        }
    }

    openLoginButtons.forEach((button) => {
        button.addEventListener('click', () => toggleOverlay(loginOverlay, true));
    });

    closeLoginButtons.forEach((button) => {
        button.addEventListener('click', () => toggleOverlay(loginOverlay, false));
    });

    loginOverlay?.addEventListener('click', (event) => {
        if (event.target === loginOverlay) {
            toggleOverlay(loginOverlay, false);
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && loginOverlay && !loginOverlay.classList.contains('hidden')) {
            toggleOverlay(loginOverlay, false);
        }
    });

    document.addEventListener('auth:show-login', () => {
        toggleOverlay(loginOverlay, true);
    });

    switchToRegisterButtons.forEach((button) => {
        button.addEventListener('click', (event) => {
            event.preventDefault();
            toggleOverlay(loginOverlay, false);
            document.dispatchEvent(new CustomEvent('auth:show-register'));
        });
    });

    logoutButtons.forEach((button) => {
        button.addEventListener('click', async () => {
            try {
                await fetch(ENDPOINTS.logout, {
                    method: 'POST',
                    credentials: 'include'
                });
            } catch (error) {
                // ignore
            } finally {
                await applySession(null);
            }
        });
    });

    loginForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearFieldErrors(loginErrorElements);
        updateStatus(loginStatus, '', '');

        const formData = new FormData(loginForm);
        const payload = {
            identifier: formData.get('identifier')?.toString().trim() ?? '',
            password: formData.get('password')?.toString() ?? ''
        };

        loginSubmit?.setAttribute('disabled', 'true');
        loginSubmit?.classList.add('opacity-70', 'cursor-not-allowed');
        loginSubmit?.setAttribute('data-loading', 'true');

        try {
            const response = await fetch(ENDPOINTS.login, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify(payload)
            });

            const result = await response.json().catch(() => ({}));

            if (!response.ok) {
                if (result?.errors) {
                    showFieldErrors(loginErrorElements, result.errors);
                }
                const message = result?.message || 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
                updateStatus(loginStatus, 'error', message);
                return;
            }

            await applySession(result?.session ?? null);
            toggleOverlay(loginOverlay, false);
            loginForm.reset();
            updateStatus(loginStatus, '', '');
        } catch (error) {
            updateStatus(loginStatus, 'error', 'เซิร์ฟเวอร์ไม่ตอบสนอง กรุณาลองใหม่อีกครั้ง');
        } finally {
            loginSubmit?.removeAttribute('disabled');
            loginSubmit?.classList.remove('opacity-70', 'cursor-not-allowed');
            loginSubmit?.removeAttribute('data-loading');
        }
    });

    document.addEventListener('auth:registration-success', (event) => {
        const username = event?.detail?.user?.username;
        if (username && loginForm) {
            const identifierField = loginForm.querySelector('input[name="identifier"]');
            if (identifierField) {
                identifierField.value = username;
            }
        }
        document.dispatchEvent(new CustomEvent('auth:show-login'));
    });

    fetchSession();
}
