import { spawn } from 'child_process';

const children = [];
let shuttingDown = false;

function register(child, label) {
    children.push(child);
    child.on('exit', (code, signal) => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        const reason = signal ? `${label} exited due to signal ${signal}` : `${label} exited with code ${code}`;
        console.log(`[dev] ${reason}`);
        stopAll(signal ? 1 : code ?? 0);
    });
}

function spawnProcess(command, args, label, options = {}) {
    const child = spawn(command, args, {
        stdio: 'inherit',
        shell: process.platform === 'win32',
        ...options
    });

    child.on('error', (error) => {
        console.error(`[dev] ${label} failed to start`, error);
        stopAll(1);
    });

    register(child, label);
    return child;
}

function stopAll(exitCode = 0) {
    if (!shuttingDown) {
        shuttingDown = true;
    }

    for (const child of children) {
        if (!child.killed) {
            child.kill('SIGTERM');
        }
    }

    process.exitCode = exitCode;

    setTimeout(() => {
        process.exit(exitCode);
    }, 50);
}

process.on('SIGINT', () => {
    console.log('\n[dev] received SIGINT, shutting down...');
    stopAll(0);
});

process.on('SIGTERM', () => {
    console.log('\n[dev] received SIGTERM, shutting down...');
    stopAll(0);
});

async function runTelemetry() {
    try {
        await new Promise((resolve, reject) => {
            const child = spawn('node', ['log.js', 'dev'], {
                stdio: 'inherit',
                shell: process.platform === 'win32'
            });

            child.on('exit', () => resolve());
            child.on('error', reject);
        });
    } catch (error) {
        console.warn('[dev] telemetry hook failed, continuing without it');
    }
}

async function main() {
    await runTelemetry();

    spawnProcess('node', ['server/index.js', '--dev'], 'backend');
    spawnProcess('vite', ['--config', 'vite/config.dev.mjs'], 'vite');

    await new Promise(() => {});
}

main().catch((error) => {
    console.error('[dev] unexpected error', error);
    stopAll(1);
});
