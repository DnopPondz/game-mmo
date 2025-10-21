const API_ENDPOINT = '/api/register';

function toggleOverlay(overlay, shouldShow) {
    if (!overlay) return;
    overlay.classList.toggle('hidden', !shouldShow);
    overlay.classList.toggle('flex', shouldShow);
    if (shouldShow) {
        overlay.focus({ preventScroll: false });
    }
}

function updateStatus(messageContainer, type, message) {
    if (!messageContainer) return;

    if (!message) {
        messageContainer.classList.add('hidden');
        messageContainer.textContent = '';
        messageContainer.dataset.state = '';
        return;
    }

    messageContainer.dataset.state = type;
    messageContainer.textContent = message;
    messageContainer.classList.remove('hidden');
}

function clearFieldErrors(errorElements) {
    Object.values(errorElements).forEach((element) => {
        if (!element) return;
        element.textContent = '';
        element.classList.add('hidden');
    });
}

function showFieldErrors(errorElements, errors) {
    Object.entries(errors).forEach(([field, message]) => {
        const element = errorElements[field];
        if (!element) return;
        element.textContent = message;
        element.classList.remove('hidden');
    });
}

export default function setupRegisterForm() {
    const overlay = document.getElementById('register-overlay');
    const openButtons = document.querySelectorAll('[data-open-register]');
    const closeButtons = document.querySelectorAll('[data-close-register]');
    const form = document.getElementById('register-form');
    const submitButton = form?.querySelector('button[type="submit"]');
    const messageContainer = form?.querySelector('[data-register-status]');
    const errorElements = {
        username: form?.querySelector('[data-error-for="username"]'),
        email: form?.querySelector('[data-error-for="email"]'),
        password: form?.querySelector('[data-error-for="password"]')
    };

    if (!overlay || !form) {
        return;
    }

    openButtons.forEach((button) => {
        button.addEventListener('click', () => toggleOverlay(overlay, true));
    });

    document.addEventListener('auth:show-register', () => {
        toggleOverlay(overlay, true);
    });

    closeButtons.forEach((button) => {
        button.addEventListener('click', () => toggleOverlay(overlay, false));
    });

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            toggleOverlay(overlay, false);
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !overlay.classList.contains('hidden')) {
            toggleOverlay(overlay, false);
        }
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearFieldErrors(errorElements);
        updateStatus(messageContainer, '', '');

        const formData = new FormData(form);
        const payload = {
            username: formData.get('username')?.toString().trim() ?? '',
            email: formData.get('email')?.toString().trim() ?? '',
            password: formData.get('password')?.toString() ?? ''
        };

        submitButton?.setAttribute('disabled', 'true');
        submitButton?.classList.add('opacity-70', 'cursor-not-allowed');
        submitButton?.setAttribute('data-loading', 'true');

        try {
            const response = await fetch(API_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify(payload)
            });

            const result = await response.json().catch(() => ({ success: false }));

            if (!response.ok) {
                if (result?.errors) {
                    showFieldErrors(errorElements, result.errors);
                }

                const message =
                    result?.message ||
                    'ไม่สามารถลงทะเบียนได้ กรุณาตรวจสอบข้อมูลและลองใหม่อีกครั้ง';
                updateStatus(messageContainer, 'error', message);
                return;
            }

            form.reset();
            updateStatus(
                messageContainer,
                'success',
                'ลงทะเบียนสำเร็จ! ตรวจสอบอีเมลเพื่อยืนยันบัญชีและเริ่มผจญภัย'
            );

            setTimeout(() => {
                toggleOverlay(overlay, false);
                updateStatus(messageContainer, '', '');
                document.dispatchEvent(
                    new CustomEvent('auth:registration-success', {
                        detail: { user: result?.user }
                    })
                );
            }, 1600);
        } catch (error) {
            updateStatus(
                messageContainer,
                'error',
                'ระบบเกิดข้อผิดพลาดชั่วคราว กรุณาลองใหม่อีกครั้งในภายหลัง'
            );
        } finally {
            submitButton?.removeAttribute('disabled');
            submitButton?.classList.remove('opacity-70', 'cursor-not-allowed');
            submitButton?.removeAttribute('data-loading');
        }
    });
}
